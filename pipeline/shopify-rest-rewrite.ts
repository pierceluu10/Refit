import { existsSync, readFileSync } from 'node:fs';
import {
  getNamedType,
  getNullableType,
  isEnumType,
  isInterfaceType,
  isListType,
  isObjectType,
  parse,
  validate,
  type GraphQLSchema,
  type GraphQLType,
} from 'graphql';
import ts from 'typescript-compiler';
import type { ShopifyScan } from './shopify-analysis.ts';
import type { SourceEdit } from './types.ts';

// REST Admin → GraphQL Admin rewrites (docs/SHOPIFY-REST.md). A REST call is rewritten only when its
// request matches a rule (data/shopify-rest-graphql.json, quoted from Shopify's REST and GraphQL
// references, or a rule the model proposed and Refit checked), Refit traces every response field
// the code reads, and the rule produces each of them. The call becomes an async function evaluated
// in place that sends the GraphQL document through the same client and returns the REST response
// shape, so the code reading it is unchanged. Every rewrite ships [Needs review].

export type RestConvert = 'gid-number' | 'lowercase' | 'join-comma';

export interface RestField {
  graphql: string;
  convert?: RestConvert;
  fields?: Record<string, RestField>;
}

export interface RestRule {
  id: string;
  method: string;
  path: string;
  resource?: { class: string; operation: string };
  kind: 'single' | 'list' | 'count';
  envelope: string;
  root: string;
  // An argument the request supplies (`from`), or a constant GraphQL literal (`value`).
  arguments?: Record<string, { from?: string; type?: string; gid?: string; value?: string }>;
  fields: Record<string, RestField>;
  rest?: { url: string; quote: string };
  graphql?: { url: string; quote: string };
  checkedAt?: string;
  notes?: string[];
  origin?: 'documented' | 'ai';
}

const RULES_FILE = new URL('../data/shopify-rest-graphql.json', import.meta.url);

export function loadShopifyRestRules(): RestRule[] {
  if (!existsSync(RULES_FILE)) return [];
  const table = JSON.parse(readFileSync(RULES_FILE, 'utf8')) as {
    formatVersion: number;
    rules: RestRule[];
  };
  if (table.formatVersion !== 1) throw new Error('data/shopify-rest-graphql.json: unknown format');
  return table.rules.map((rule) => ({ ...rule, origin: rule.origin ?? 'documented' }));
}

// One piece of a request: literal text, or a JavaScript expression (source text).
type Part = { text: string } | { expression: string };

interface RestRequest {
  method: string;
  path: Part[];
  query: Map<string, Part[]>;
}

type Transport =
  | { kind: 'fetch'; prefix: Part[]; options?: ts.ObjectLiteralExpression }
  | { kind: 'axios'; prefix: Part[]; receiver: string; config?: ts.ObjectLiteralExpression }
  | { kind: 'remix'; admin: string }
  | { kind: 'client'; factory: string; session: string; declaration?: ts.VariableStatement }
  | { kind: 'resource-remix'; admin: string; operation: string }
  | { kind: 'resource'; factory: string; session: string; operation: string };

// What the code does with the response: REST body paths it reads ('[]' steps into an array),
// whether a read uses the whole value, and the reads Refit cannot follow.
interface Read {
  path: string[];
  whole: boolean;
}

interface Trace {
  reads: Read[];
  stops: string[];
  pagination: boolean;
}

export interface RestRewrite {
  status: 'rewritten';
  entry: ShopifyScan['rest'][number];
  rule: RestRule;
  edits: SourceEdit[];
  document: string;
  reads: string[];
  // The REST client declaration this rewrite removed, when every use of it was rewritten.
  removedClient?: { line: number };
}

export interface RestStop {
  status: 'stopped';
  entry: ShopifyScan['rest'][number];
  reason: string;
  // Present when the call and its reads are understood but no rule produces them: the AI may
  // propose one.
  request?: { method: string; path: string; query: string[]; reads: string[]; transport: string };
}

const unwrapParent = (node: ts.Node) => {
  while (
    ts.isParenthesizedExpression(node.parent) ||
    ts.isAsExpression(node.parent) ||
    ts.isNonNullExpression(node.parent) ||
    ts.isSatisfiesExpression(node.parent) ||
    ts.isTypeAssertionExpression(node.parent)
  )
    node = node.parent;
  return node;
};

const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) ||
  ts.isAsExpression(node) ||
  ts.isNonNullExpression(node) ||
  ts.isSatisfiesExpression(node)
    ? unwrap(node.expression)
    : node;

const memberName = (node: ts.Node) =>
  ts.isPropertyAccessExpression(node)
    ? node.name.text
    : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
      ? node.argumentExpression.text
      : undefined;

function property(object: ts.ObjectLiteralExpression, name: string) {
  for (const entry of object.properties) {
    if (ts.isShorthandPropertyAssignment(entry) && entry.name.text === name) return entry.name;
    if (
      ts.isPropertyAssignment(entry) &&
      (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) &&
      entry.name.text === name
    )
      return entry.initializer;
  }
  return undefined;
}

const propertyName = (entry: ts.ObjectLiteralElementLike) =>
  entry.name && (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name))
    ? entry.name.text
    : undefined;

// A literal or template as parts.
function literalParts(node: ts.Expression): Part[] | undefined {
  node = unwrap(node);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return [{ text: node.text }];
  if (!ts.isTemplateExpression(node)) return undefined;
  const parts: Part[] = [{ text: node.head.text }];
  for (const span of node.templateSpans)
    parts.push({ expression: span.expression.getText() }, { text: span.literal.text });
  return parts.filter((part) => !('text' in part) || part.text);
}

// Splits parts at the first occurrence of a separator inside literal text.
function splitParts(parts: Part[], separator: string): [Part[], Part[]] | undefined {
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (!('text' in part)) continue;
    const at = part.text.indexOf(separator);
    if (at < 0) continue;
    const before = part.text.slice(0, at);
    const after = part.text.slice(at + separator.length);
    return [
      [...parts.slice(0, index), ...(before ? [{ text: before }] : [])],
      [...(after ? [{ text: after }] : []), ...parts.slice(index + 1)],
    ];
  }
  return undefined;
}

const partsSource = (parts: Part[]) =>
  parts.length === 1 && 'expression' in parts[0]
    ? parts[0].expression
    : parts.every((part) => 'text' in part)
      ? JSON.stringify(parts.map((part) => (part as { text: string }).text).join(''))
      : `\`${parts.map((part) => ('text' in part ? part.text.replace(/[`\\$]/g, '\\$&') : `\${${part.expression}}`)).join('')}\``;

function queryParts(parts: Part[]) {
  const query = new Map<string, Part[]>();
  let rest: Part[] | undefined = parts;
  while (rest && rest.length) {
    const split = splitParts(rest, '&');
    const pair = split ? split[0] : rest;
    rest = split?.[1];
    const assignment = splitParts(pair, '=');
    const name = assignment?.[0];
    if (!assignment || name!.length !== 1 || !('text' in name![0])) return undefined;
    query.set(decodeURIComponent(name![0].text), assignment[1]);
  }
  return query;
}

// The part of a versioned Admin URL after `/admin/api/<version>/`, and the source text before it.
function urlRequest(literal: ts.Expression, method: string) {
  const parts = literalParts(literal);
  if (!parts) return undefined;
  // The version is literal or one substitution: `/admin/api/2024-10/` or `/admin/api/${version}/`.
  let prefix: Part[] | undefined;
  let rest: Part[] = [];
  for (let index = 0; index < parts.length && !prefix; index++) {
    const part = parts[index];
    if (!('text' in part)) continue;
    const literalVersion = /\/admin\/api\/(?:\d{4}-\d{2}|unstable)\//.exec(part.text);
    const next = parts[index + 1];
    const after = parts[index + 2];
    if (literalVersion) {
      const end = literalVersion.index + literalVersion[0].length;
      prefix = [...parts.slice(0, index), { text: part.text.slice(0, end) }];
      rest = [
        ...(part.text.slice(end) ? [{ text: part.text.slice(end) }] : []),
        ...parts.slice(index + 1),
      ];
    } else if (part.text.endsWith('/admin/api/') && next && 'expression' in next) {
      if (!after || !('text' in after) || !after.text.startsWith('/')) return undefined;
      prefix = [...parts.slice(0, index + 2), { text: '/' }];
      rest = [
        ...(after.text.slice(1) ? [{ text: after.text.slice(1) }] : []),
        ...parts.slice(index + 3),
      ];
    }
  }
  if (prefix === undefined) return undefined;
  const [path, query] = splitParts(rest, '?') ?? [rest, []];
  const parsed = queryParts(query);
  return parsed && { prefix, request: { method, path, query: parsed } as RestRequest };
}

// A `{ path, query }` argument of a REST client call.
function clientRequest(argument: ts.Expression | undefined, method: string, file: ts.SourceFile) {
  const options = argument && unwrap(argument);
  if (!options || !ts.isObjectLiteralExpression(options)) return undefined;
  const allowed = new Set(['path', 'query']);
  if (
    options.properties.some((entry) => !propertyName(entry) || !allowed.has(propertyName(entry)!))
  )
    return undefined;
  let pathValue = property(options, 'path');
  if (pathValue && ts.isIdentifier(unwrap(pathValue)))
    pathValue = constantValue(unwrap(pathValue) as ts.Identifier, file);
  const path = pathValue && literalParts(pathValue);
  if (!path) return undefined;
  const queryValue = property(options, 'query');
  const query = new Map<string, Part[]>();
  if (queryValue) {
    const object = unwrap(queryValue);
    if (!ts.isObjectLiteralExpression(object)) return undefined;
    for (const entry of object.properties) {
      const name = propertyName(entry);
      if (!name) return undefined;
      const value = ts.isShorthandPropertyAssignment(entry)
        ? entry.name.text
        : ts.isPropertyAssignment(entry)
          ? entry.initializer.getText()
          : undefined;
      if (!value) return undefined;
      query.set(name, [{ expression: value }]);
    }
  }
  if (path[0] && 'text' in path[0]) path[0] = { text: path[0].text.replace(/^\//, '') };
  return { method, path, query } as RestRequest;
}

// A `const` with a literal value in the same file.
function constantValue(name: ts.Identifier, file: ts.SourceFile) {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name.text &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      node.parent.flags & ts.NodeFlags.Const
    )
      found = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found && literalParts(found) ? found : undefined;
}

// The identifiers in `scope` that name the variable `name` declares, or undefined when another
// declaration of the same name could shadow it.
function references(name: ts.Identifier, scope: ts.Node) {
  const found: ts.Identifier[] = [];
  let shadowed = false;
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node !== name && node.text === name.text) {
      const parent = node.parent;
      const declares =
        (ts.isVariableDeclaration(parent) ||
          ts.isParameter(parent) ||
          ts.isBindingElement(parent) ||
          ts.isFunctionDeclaration(parent)) &&
        parent.name === node;
      if (declares) shadowed = true;
      else if (
        !(ts.isPropertyAccessExpression(parent) && parent.name === node) &&
        !(ts.isPropertyAssignment(parent) && parent.name === node) &&
        !(ts.isBindingElement(parent) && parent.propertyName === node)
      )
        found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return shadowed ? undefined : found;
}

function declarationScope(node: ts.Node) {
  let scope = node.parent;
  while (
    scope &&
    !ts.isBlock(scope) &&
    !ts.isSourceFile(scope) &&
    !ts.isCaseClause(scope) &&
    !ts.isFunctionLike(scope)
  )
    scope = scope.parent;
  return scope;
}

const ARRAY_ELEMENT_CALLBACKS = new Set([
  'map',
  'forEach',
  'some',
  'every',
  'flatMap',
  'findIndex',
]);
const ARRAY_ELEMENT_RESULT = new Set(['find', 'at', 'pop', 'shift']);
const ARRAY_SAME_RESULT = new Set(['filter', 'slice', 'reverse', 'sort', 'concat']);
const EXISTENCE_OPERATORS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

type Value =
  { kind: 'response' | 'axios' | 'client' | 'resource-all' } | { kind: 'body'; path: string[] };

// Follows the value `node` holds (or a promise of it) to every place the code reads it.
function follow(
  node: ts.Expression,
  value: Value,
  promise: boolean,
  trace: Trace,
  depth = 0,
): void {
  if (depth > 40) {
    trace.stops.push('The response flows through more steps than Refit follows.');
    return;
  }
  const next = (expression: ts.Expression, to: Value, isPromise = false) =>
    follow(expression, to, isPromise, trace, depth + 1);
  const whole = (reason: string) => {
    if (value.kind === 'body') trace.reads.push({ path: value.path, whole: true });
    else trace.stops.push(reason);
  };
  const outer = unwrapParent(node) as ts.Expression;
  const parent = outer.parent;
  if (ts.isAwaitExpression(parent)) return next(parent, value);
  // A then-callback's return value is the then() call's value.
  const returned = ts.isReturnStatement(parent)
    ? ts.findAncestor(parent, ts.isFunctionLike)
    : (ts.isArrowFunction(parent) && parent.body === outer && parent) || undefined;
  if (returned) {
    const call = returned.parent;
    if (
      ts.isCallExpression(call) &&
      call.arguments[0] === returned &&
      memberName(call.expression) === 'then'
    )
      return next(call, value, true);
    return whole(
      'The response is returned from a function, so Refit cannot see which fields its callers read.',
    );
  }
  if (promise) {
    const name = memberName(parent);
    if (name && ts.isCallExpression(parent.parent) && parent.parent.expression === parent) {
      const call = parent.parent;
      if (name === 'catch' || name === 'finally') return next(call, value, true);
      if (name === 'then') {
        const callback = call.arguments[0] && unwrap(call.arguments[0]);
        if (
          callback &&
          (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
          callback.parameters.length === 1 &&
          ts.isIdentifier(callback.parameters[0].name)
        ) {
          const uses = references(callback.parameters[0].name, callback.body);
          if (!uses) return void trace.stops.push('A callback parameter shadows the response.');
          for (const use of uses) next(use, value);
          return;
        }
        return void trace.stops.push('The response is passed to a callback Refit cannot follow.');
      }
    }
    if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer === outer &&
      ts.isIdentifier(parent.name)
    )
      return variable(parent, value, true);
    return void trace.stops.push(
      `The pending response flows into \`${parent.getText().slice(0, 60)}\`, which Refit cannot follow.`,
    );
  }
  const name = memberName(parent);
  if (name !== undefined && (parent as ts.PropertyAccessExpression).expression === outer) {
    const access = parent as ts.Expression;
    const called =
      ts.isCallExpression(access.parent) && access.parent.expression === access
        ? access.parent
        : undefined;
    switch (value.kind) {
      case 'response':
        if (name === 'json' && called) return next(called, { kind: 'body', path: [] }, true);
        if (name === 'ok' || name === 'status' || name === 'statusText') return;
        return void trace.stops.push(
          `The code reads the response's \`${name}\`, which the rewrite cannot rebuild.`,
        );
      case 'axios':
        if (name === 'data') return next(access, { kind: 'body', path: [] });
        if (name === 'status' || name === 'statusText') return;
        return void trace.stops.push(
          `The code reads the response's \`${name}\`, which the rewrite cannot rebuild.`,
        );
      case 'client':
        if (name === 'body') return next(access, { kind: 'body', path: [] });
        if (name === 'pageInfo') return void (trace.pagination = true);
        return void trace.stops.push(
          `The code reads the response's \`${name}\`, which the rewrite cannot rebuild.`,
        );
      case 'resource-all':
        if (name === 'data') return next(access, { kind: 'body', path: ['[]'] });
        if (name === 'pageInfo') return void (trace.pagination = true);
        return void trace.stops.push(
          `The code reads the result's \`${name}\`, which the rewrite cannot rebuild.`,
        );
      case 'body': {
        if (called) {
          if (
            ARRAY_ELEMENT_CALLBACKS.has(name) ||
            ARRAY_ELEMENT_RESULT.has(name) ||
            name === 'filter' ||
            name === 'find'
          ) {
            const callback = called.arguments[0] && unwrap(called.arguments[0]);
            if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
              const parameter = callback.parameters[0];
              if (parameter) element(parameter, [...value.path, '[]']);
              if (ARRAY_ELEMENT_CALLBACKS.has(name))
                trace.reads.push({ path: value.path, whole: false });
            } else if (callback) return whole('');
            if (ARRAY_ELEMENT_RESULT.has(name))
              return next(called, { kind: 'body', path: [...value.path, '[]'] });
            if (name === 'filter') return next(called, value);
            return;
          }
          if (ARRAY_SAME_RESULT.has(name) && name !== 'concat') return next(called, value);
          // A method of a value Refit maps whole (a string's `split`, `toLowerCase`).
          return whole('');
        }
        if (name === 'length') return void trace.reads.push({ path: value.path, whole: false });
        return next(access, { kind: 'body', path: [...value.path, name] });
      }
    }
  }
  if (
    value.kind === 'body' &&
    ts.isElementAccessExpression(parent) &&
    parent.expression === outer &&
    !ts.isStringLiteralLike(parent.argumentExpression)
  )
    return next(parent, { kind: 'body', path: [...value.path, '[]'] });
  if (ts.isVariableDeclaration(parent) && parent.initializer === outer)
    return variable(parent, value, false);
  if (ts.isForOfStatement(parent) && parent.expression === outer && value.kind === 'body') {
    const declaration = ts.isVariableDeclarationList(parent.initializer)
      ? parent.initializer.declarations[0]
      : undefined;
    if (!declaration)
      return void trace.stops.push(
        'A for-of loop over the response assigns to an outside variable.',
      );
    return element(declaration, [...value.path, '[]']);
  }
  if (ts.isBinaryExpression(parent)) {
    const operator = parent.operatorToken.kind;
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
      if (parent.left === outer) return void exists();
      return next(parent, value);
    }
    if (
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.QuestionQuestionToken
    ) {
      if (parent.left === outer) return next(parent, value);
      return whole('');
    }
    if (EXISTENCE_OPERATORS.has(operator)) {
      const other = parent.left === outer ? parent.right : parent.left;
      if (
        other.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isIdentifier(other) && other.text === 'undefined')
      )
        return void exists();
    }
    if (operator === ts.SyntaxKind.EqualsToken && parent.left === outer)
      return void trace.stops.push('The code assigns to the response.');
    return whole('The response is compared or combined whole.');
  }
  if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken)
    return void exists();
  if (ts.isTypeOfExpression(parent)) return void exists();
  if ((ts.isIfStatement(parent) || ts.isWhileStatement(parent)) && parent.expression === outer)
    return void exists();
  if (ts.isConditionalExpression(parent)) {
    if (parent.condition === outer) return void exists();
    return next(parent, value);
  }
  if (ts.isExpressionStatement(parent)) return;
  // Logging is not behaviour the rewrite keeps; the draft says logged values change.
  if (ts.isCallExpression(parent) && /^console\.\w+$/.test(parent.expression.getText())) return;
  return whole('The response flows into code Refit cannot follow.');

  function exists() {
    if (value.kind === 'body') trace.reads.push({ path: value.path, whole: false });
  }

  function variable(declaration: ts.VariableDeclaration, to: Value, isPromise: boolean) {
    const list = declaration.parent;
    if (ts.isIdentifier(declaration.name)) {
      const uses = references(declaration.name, declarationScope(list));
      if (!uses)
        return void trace.stops.push(`Another declaration shadows \`${declaration.name.text}\`.`);
      if (!(list.flags & ts.NodeFlags.Const))
        for (const use of uses)
          if (
            ts.isBinaryExpression(use.parent) &&
            use.parent.left === use &&
            use.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
          )
            return void trace.stops.push(`\`${declaration.name.text}\` is reassigned.`);
      for (const use of uses) next(use, to, isPromise);
      return;
    }
    if (isPromise) return void trace.stops.push('A pending response is destructured.');
    binding(declaration.name, to);
  }

  function binding(pattern: ts.BindingName, to: Value) {
    if (ts.isIdentifier(pattern)) {
      const uses = references(
        pattern,
        declarationScope(ts.findAncestor(pattern, ts.isVariableDeclarationList) ?? pattern),
      );
      if (!uses) return void trace.stops.push(`Another declaration shadows \`${pattern.text}\`.`);
      for (const use of uses) next(use, to);
      return;
    }
    if (ts.isArrayBindingPattern(pattern)) {
      if (to.kind !== 'body')
        return void trace.stops.push('The response is destructured as an array.');
      for (const entry of pattern.elements)
        if (ts.isBindingElement(entry)) {
          if (entry.dotDotDotToken) return void trace.stops.push('The response is spread.');
          binding(entry.name, { kind: 'body', path: [...to.path, '[]'] });
        }
      return;
    }
    for (const entry of pattern.elements) {
      if (entry.dotDotDotToken) return void trace.stops.push('The response is spread with `...`.');
      const key = entry.propertyName ?? entry.name;
      if (!ts.isIdentifier(key) && !ts.isStringLiteral(key))
        return void trace.stops.push('A computed key destructures the response.');
      const field = key.text;
      const target: Value | undefined =
        to.kind === 'body'
          ? { kind: 'body', path: [...to.path, field] }
          : to.kind === 'axios' && field === 'data'
            ? { kind: 'body', path: [] }
            : to.kind === 'client' && field === 'body'
              ? { kind: 'body', path: [] }
              : to.kind === 'resource-all' && field === 'data'
                ? { kind: 'body', path: ['[]'] }
                : undefined;
      if ((to.kind === 'client' || to.kind === 'resource-all') && field === 'pageInfo') {
        trace.pagination = true;
        continue;
      }
      if (!target)
        return void trace.stops.push(
          `The code destructures \`${field}\` from the response, which the rewrite cannot rebuild.`,
        );
      if (entry.initializer && to.kind === 'body')
        trace.reads.push({ path: target.kind === 'body' ? target.path : [], whole: false });
      binding(entry.name, target);
    }
  }

  function element(declaration: ts.ParameterDeclaration | ts.VariableDeclaration, path: string[]) {
    binding(declaration.name, { kind: 'body', path });
  }
}

// The rule a request matches, with the source text of each path parameter.
function matchRule(request: RestRequest, rules: RestRule[]) {
  const normalized = [...request.path];
  const last = normalized.at(-1);
  if (last && 'text' in last && !last.text.endsWith('.json'))
    normalized[normalized.length - 1] = { text: `${last.text}.json` };
  else if (last && 'expression' in last) normalized.push({ text: '.json' });
  for (const rule of rules) {
    if (rule.method !== request.method) continue;
    const pieces = rule.path.split(/(\{\w+\})/).filter(Boolean);
    const params = new Map<string, string>();
    let index = 0;
    let offset = 0;
    let matched = true;
    for (const piece of pieces) {
      const part = normalized[index];
      if (!part) {
        matched = false;
        break;
      }
      if (piece.startsWith('{')) {
        if (!('expression' in part) || offset) {
          matched = false;
          break;
        }
        params.set(piece.slice(1, -1), part.expression);
        index++;
      } else {
        if (!('text' in part) || !part.text.startsWith(piece, offset)) {
          matched = false;
          break;
        }
        offset += piece.length;
        if (offset === part.text.length) {
          index++;
          offset = 0;
        }
      }
    }
    if (matched && index === normalized.length && !offset) return { rule, params };
  }
  return undefined;
}

// The field a REST path names, walking nested rule fields; undefined when unmapped.
function mapped(rule: RestRule, path: string[]) {
  // Body paths start with the envelope (and '[]' for lists); count bodies are `{ count }`.
  let rest = [...path];
  if (rule.kind === 'count')
    return rest.length <= 1 && (!rest.length || rest[0] === 'count') ? { leaf: true } : undefined;
  if (!rest.length) return { leaf: false };
  if (rest[0] !== rule.envelope) return undefined;
  rest = rest.slice(1);
  if (rule.kind === 'list') {
    if (!rest.length) return { leaf: false };
    if (rest[0] !== '[]') return undefined;
    rest = rest.slice(1);
  }
  let fields: Record<string, RestField> | undefined = rule.fields;
  let leaf = false;
  while (rest.length) {
    if (leaf) return { leaf: true };
    const field: RestField | undefined =
      fields && Object.hasOwn(fields, rest[0]) ? fields[rest[0]] : undefined;
    if (!field) return undefined;
    rest = rest.slice(1);
    if (field.fields) {
      fields = field.fields;
      if (rest[0] === '[]') rest = rest.slice(1);
      else if (rest.length) return undefined;
    } else leaf = true;
  }
  return { leaf: leaf || false };
}

// The rule fields the code reads, keeping only read branches.
function usedFields(rule: RestRule, reads: Read[]) {
  const used: Record<string, RestField> = {};
  for (const read of reads) {
    const path = read.path.slice(rule.kind === 'list' ? 2 : 1).filter((step) => step !== '[]');
    let fields = rule.fields;
    let target = used;
    for (const step of path) {
      const field = fields[step];
      if (!field) break;
      if (!field.fields) {
        target[step] = field;
        break;
      }
      const existing = (target[step] ??= { ...field, fields: {} });
      target = existing.fields!;
      fields = field.fields;
    }
  }
  return used;
}

interface Selection {
  [segment: string]: Selection;
}

function selectionOf(fields: Record<string, RestField>): Selection {
  const tree: Selection = {};
  for (const field of Object.values(fields)) {
    let node = tree;
    for (const segment of field.graphql.split('.')) node = node[segment] ??= {};
    if (field.fields) {
      const nested = selectionOf(field.fields);
      Object.assign(node, nested);
      if (!Object.keys(node).length) node.id = {};
    }
  }
  return tree;
}

const printSelection = (tree: Selection): string =>
  Object.entries(tree)
    .map(([segment, children]) =>
      Object.keys(children).length ? `${segment} { ${printSelection(children)} }` : segment,
    )
    .join(' ');

const isList = (field: RestField) => field.graphql.split('.').at(-1) === 'nodes';

const responseKey = (segment: string) => segment.replace(/\(.*$/, '');

const CONVERTERS: Record<RestConvert, string> = {
  'gid-number': "(value) => (value == null ? value : Number(String(value).split('/').pop()))",
  lowercase: '(value) => (value == null ? value : String(value).toLowerCase())',
  'join-comma': "(value) => (value == null ? value : value.join(', '))",
};

// A JavaScript object literal that builds the REST fields from the GraphQL node `source`.
function mapper(
  fields: Record<string, RestField>,
  source: string,
  typed: boolean,
  used: Set<RestConvert>,
  depth = 0,
): string {
  const any = typed ? ': any' : '';
  return `{ ${Object.entries(fields)
    .map(([name, field]) => {
      const access = field.graphql
        .split('.')
        .map(
          (segment) =>
            `?.${/^\w+$/.test(responseKey(segment)) ? responseKey(segment) : JSON.stringify(responseKey(segment))}`,
        )
        .join('')
        .replace(/^\?/, '');
      let value = `${source}${access}`;
      if (field.fields) {
        const item = `item${depth}`;
        const nested = mapper(field.fields, item, typed, used, depth + 1);
        // A connection's `nodes` is a list; any other nested field is one object or null.
        value = isList(field)
          ? `${value}?.map((${item}${any}) => (${nested}))`
          : `((${item}${any}) => (${item} == null ? ${item} : ${nested}))(${value})`;
      }
      if (field.convert) {
        used.add(field.convert);
        value = `refit${field.convert.replace(/(^|-)(\w)/g, (_, __, letter: string) => letter.toUpperCase())}(${value})`;
      }
      return `${/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)}: ${value}`;
    })
    .join(', ')} }`;
}

function variablesOf(rule: RestRule, request: RestRequest, params: Map<string, string>) {
  const definitions: string[] = [];
  const argumentsText: string[] = [];
  const values: string[] = [];
  const used = new Set<string>();
  for (const [name, argument] of Object.entries(rule.arguments ?? {})) {
    if (argument.value !== undefined) {
      argumentsText.push(`${name}: ${argument.value}`);
      continue;
    }
    const [source, key] = (argument.from ?? '').split(':');
    let expression: string | undefined;
    if (source === 'path') expression = params.get(key);
    else if (source === 'query') {
      const value = request.query.get(key);
      if (value) {
        used.add(key);
        expression = partsSource(value);
      }
    }
    if (expression === undefined) {
      if (argument.type?.endsWith('!'))
        return `The request does not send ${argument.from}, which the GraphQL argument ${name} needs.`;
      continue;
    }
    if (argument.gid) expression = `\`gid://shopify/${argument.gid}/\${${expression}}\``;
    definitions.push(`$${name}: ${argument.type}`);
    argumentsText.push(`${name}: $${name}`);
    values.push(`${name}: ${expression}`);
  }
  if (rule.kind === 'list') {
    const limit = request.query.get('limit');
    used.add('limit');
    definitions.push('$first: Int!');
    argumentsText.push('first: $first');
    values.push(
      `first: ${!limit ? '50' : limit.length === 1 && 'text' in limit[0] && /^\d+$/.test(limit[0].text) ? limit[0].text : `Number(${partsSource(limit)})`}`,
    );
    const pageInfo = request.query.get('page_info');
    if (pageInfo) {
      used.add('page_info');
      definitions.push('$after: String');
      argumentsText.push('after: $after');
      values.push(`after: ${partsSource(pageInfo)}`);
    }
  }
  // `fields` only narrows what REST returns; the rewrite returns only the fields the code reads.
  used.add('fields');
  const unknown = [...request.query.keys()].filter((key) => !used.has(key));
  if (unknown.length)
    return `The request sends ${unknown.map((key) => `\`${key}\``).join(', ')}, which no documented GraphQL argument of ${rule.root} replaces.`;
  return { definitions, argumentsText, values };
}

// The GraphQL document for a rule and the fields read.
function documentOf(
  rule: RestRule,
  used: Record<string, RestField>,
  variables: { definitions: string[]; argumentsText: string[] },
) {
  const name = `RefitRest${rule.id.replace(/(^|[^A-Za-z0-9])(\w)/g, (_, __, letter: string) => letter.toUpperCase()).replace(/\W/g, '')}`;
  const args = variables.argumentsText.length ? `(${variables.argumentsText.join(', ')})` : '';
  const definitions = variables.definitions.length ? `(${variables.definitions.join(', ')})` : '';
  const selection =
    rule.kind === 'count'
      ? 'count'
      : rule.kind === 'list'
        ? `nodes { ${printSelection(selectionOf(used)) || 'id'} } pageInfo { hasNextPage endCursor }`
        : printSelection(selectionOf(used)) || 'id';
  return `query ${name}${definitions} { ${rule.root}${args} { ${selection} } }`;
}

// Why a generated document is not valid on a schema, or undefined.
export function documentProblem(
  text: string,
  schemas: { version: string; schema: GraphQLSchema }[],
) {
  for (const { version, schema } of schemas) {
    const errors = validate(schema, parse(text));
    if (errors.length)
      return `The GraphQL rewrite does not validate on Admin API ${version}: ${errors[0].message}`;
  }
  return undefined;
}

export interface RestRewriteOptions {
  file: string;
  content: string;
  entries: ShopifyScan['rest'];
  rules: RestRule[];
  schemas: { version: string; schema: GraphQLSchema }[];
  // The locked @shopify/shopify-api major: 9 and later send GraphQL with `request`.
  apiMajor?: number;
}

// Rewrites the REST calls of one file. Entries that are not rewritten come back as stops.
export function rewriteRestCalls(options: RestRewriteOptions): (RestRewrite | RestStop)[] {
  const kind = /\.tsx?$|\.mts$|\.cts$/.test(options.file)
    ? options.file.endsWith('x')
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS
    : options.file.endsWith('x')
      ? ts.ScriptKind.JSX
      : ts.ScriptKind.JS;
  const typed = kind === ts.ScriptKind.TS || kind === ts.ScriptKind.TSX;
  const source = ts.createSourceFile(
    options.file,
    options.content,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const offset = (entry: ShopifyScan['rest'][number]) =>
    source.getPositionOfLineAndCharacter(entry.line - 1, entry.column - 1);
  const results: (RestRewrite | RestStop)[] = [];
  const clientCalls = new Map<
    ts.VariableDeclaration,
    { calls: ts.Identifier[]; rewritten: number }
  >();
  const pending: { result: RestRewrite; client?: ts.VariableDeclaration }[] = [];
  for (const entry of options.entries) {
    const stop = (reason: string, request?: RestStop['request']): RestStop => ({
      status: 'stopped',
      entry,
      reason,
      ...(request ? { request } : {}),
    });
    const at = offset(entry);
    const node = findNode(source, at, entry.expression);
    if (!node) {
      results.push(stop('Refit could not locate the call again.'));
      continue;
    }
    if (ts.isNewExpression(node)) continue; // A REST client or resource construction: handled with its calls below.
    const recognized = recognize(node, entry, source, options.apiMajor);
    if (typeof recognized === 'string') {
      results.push(stop(recognized));
      continue;
    }
    const { call, transport, request, initial } = recognized;
    const trace: Trace = { reads: [], stops: [], pagination: false };
    follow(call, initial, true, trace);
    if (trace.stops.length) {
      results.push(stop(trace.stops[0]));
      continue;
    }
    const readText = [...new Set(trace.reads.map((read) => read.path.join('.')))];
    const description = {
      method: request.method,
      path:
        entry.resource ?? request.path.map((part) => ('text' in part ? part.text : '{…}')).join(''),
      query: [...request.query.keys()],
      reads: readText,
      transport: transport.kind,
    };
    if (request.method !== 'GET') {
      results.push(
        stop(
          `Refit rewrites only REST reads; ${request.method} changes data and needs a reviewed mutation.`,
          description,
        ),
      );
      continue;
    }
    const resource = entry.resource && /^(\w+)\.(\w+)$/.exec(entry.resource);
    const match = resource
      ? resourceMatch(options.rules, resource[1], resource[2], node)
      : matchRule(request, options.rules);
    if (!match) {
      results.push(
        stop(
          `No documented GraphQL equivalent covers ${request.method} ${description.path}.`,
          description,
        ),
      );
      continue;
    }
    const { rule, params } = match;
    if (resource)
      for (const read of trace.reads) read.path = resourcePath(rule, resource[2], read.path);
    if (trace.pagination && rule.kind !== 'list') {
      results.push(stop('The code reads pagination of a request that is not a list.'));
      continue;
    }
    const unmapped = trace.reads.find((read) => {
      const field = mapped(rule, read.path);
      return !field || (read.whole && !field.leaf);
    });
    if (unmapped) {
      const field = mapped(rule, unmapped.path);
      results.push(
        stop(
          field
            ? `The code uses ${unmapped.path.join('.') || 'the response'} whole, so Refit cannot tell which fields it needs.`
            : `The code reads ${unmapped.path.join('.')}, which the ${rule.origin === 'ai' ? 'proposed' : 'documented'} GraphQL mapping does not produce.`,
          description,
        ),
      );
      continue;
    }
    const variables = variablesOf(
      rule,
      resource ? resourceRequest(node, request) : request,
      params,
    );
    if (typeof variables === 'string') {
      results.push(stop(variables, description));
      continue;
    }
    const used = usedFields(rule, trace.reads);
    const document = documentOf(rule, used, variables);
    const problem = documentProblem(document, options.schemas);
    if (problem) {
      results.push(stop(problem, description));
      continue;
    }
    const replacement = generate({
      rule,
      used,
      document,
      variables: variables.values,
      transport,
      typed,
      indent: indentOf(source, call.getStart()),
      pagination: trace.pagination,
      apiMajor: options.apiMajor,
    });
    if (typeof replacement === 'string') {
      results.push(stop(replacement, description));
      continue;
    }
    const edits: SourceEdit[] = [
      {
        file: entry.file,
        start: call.getStart(),
        end: call.getEnd(),
        replacement: replacement.text,
        changeId: 'shopify-rest-graphql',
        rule: rule.id,
      },
    ];
    for (const statement of ('removable' in recognized && recognized.removable) || [])
      edits.push({
        file: entry.file,
        start: statement.getFullStart(),
        end: statement.getEnd(),
        replacement: '',
        changeId: 'shopify-rest-graphql',
        rule: rule.id,
      });
    const result: RestRewrite = {
      status: 'rewritten',
      entry,
      rule,
      edits,
      document,
      reads: readText,
    };
    let client: ts.VariableDeclaration | undefined;
    if (transport.kind === 'client' && transport.declaration) {
      client = transport.declaration.declarationList.declarations[0];
      const calls =
        references(
          client.name as ts.Identifier,
          declarationScope(transport.declaration.declarationList),
        ) ?? [];
      const record = clientCalls.get(client) ?? { calls, rewritten: 0 };
      record.rewritten++;
      clientCalls.set(client, record);
    }
    pending.push({ result, client });
  }
  // A REST client every use of which was rewritten is removed; its construction no longer stops.
  for (const { result, client } of pending) {
    if (client) {
      const record = clientCalls.get(client)!;
      if (record.rewritten === record.calls.length) {
        const statement = client.parent.parent as ts.VariableStatement;
        if (!result.edits.some((edit) => edit.changeId === 'shopify-rest-client')) {
          const first = pending.find((entry) => entry.client === client)!.result;
          if (first === result) {
            const start = statement.getFullStart();
            result.edits.push({
              file: result.entry.file,
              start,
              end: statement.getEnd(),
              replacement: '',
              changeId: 'shopify-rest-client',
            });
            result.removedClient = {
              line: source.getLineAndCharacterOfPosition(statement.getStart()).line + 1,
            };
          }
        }
      }
    }
    results.push(result);
  }
  // Constructions: resolved when their declaration was removed.
  for (const entry of options.entries) {
    const node = findNode(source, offset(entry), entry.expression);
    if (!node || !ts.isNewExpression(node)) continue;
    const removed = pending.some(
      ({ result }) => result.removedClient && result.removedClient.line === entry.line,
    );
    if (!removed)
      results.push({
        status: 'stopped',
        entry,
        reason: /\.clients\.Rest$/.test(entry.expression)
          ? 'The REST client is used by calls Refit did not rewrite.'
          : 'A REST resource record is built and saved; Refit rewrites only REST reads.',
      });
  }
  // Two edits must not overlap (a client removal inside a rewritten call cannot happen, but check).
  const all = results.flatMap((result) => (result.status === 'rewritten' ? result.edits : []));
  all.sort((a, b) => a.start - b.start);
  for (let index = 1; index < all.length; index++)
    if (all[index].start < all[index - 1].end)
      return results.map((result) =>
        result.status === 'rewritten'
          ? {
              status: 'stopped',
              entry: result.entry,
              reason: 'Two REST rewrites in this file overlap.',
            }
          : result,
      );
  return results.sort(
    (a, b) => options.entries.indexOf(a.entry) - options.entries.indexOf(b.entry),
  );
}

function findNode(source: ts.SourceFile, position: number, expression?: string) {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (
      node.getStart() === position &&
      // Calls chained on the REST call start at the same place; the scan names the call's callee.
      (((ts.isCallExpression(node) || ts.isNewExpression(node)) &&
        (expression === undefined || node.expression.getText() === expression)) ||
        ts.isStringLiteralLike(node) ||
        ts.isTemplateExpression(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node))
    )
      found = node;
    else if (node.getStart() <= position && position < node.getEnd()) ts.forEachChild(node, visit);
  };
  visit(source);
  // The scan locates a URL by the template piece that holds it.
  if (found && ts.isTemplateHead(found)) return found.parent;
  if (found && (ts.isTemplateMiddle(found) || ts.isTemplateTail(found))) return found.parent.parent;
  return found;
}

function indentOf(source: ts.SourceFile, position: number) {
  const line = source.getLineAndCharacterOfPosition(position).line;
  const text = source.text.slice(source.getPositionOfLineAndCharacter(line, 0));
  return /^[ \t]*/.exec(text)![0];
}

const SIMPLE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

function recognize(
  node: ts.Node,
  entry: ShopifyScan['rest'][number],
  source: ts.SourceFile,
  apiMajor?: number,
) {
  // A REST URL literal passed to fetch() or axios, directly or through a const used once.
  if (!ts.isCallExpression(node)) {
    let literal = unwrapParent(node) as ts.Expression;
    const declaration = literal.parent;
    let removable: ts.VariableStatement | undefined;
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer === literal &&
      ts.isIdentifier(declaration.name)
    ) {
      if (!(declaration.parent.flags & ts.NodeFlags.Const))
        return 'The REST URL is held in a variable that is not const.';
      const uses = references(declaration.name, declarationScope(declaration.parent));
      if (!uses || uses.length !== 1) return 'The REST URL constant is used more than once.';
      if (
        (declaration.parent as ts.VariableDeclarationList).declarations.length === 1 &&
        ts.isVariableStatement(declaration.parent.parent)
      )
        removable = declaration.parent.parent;
      literal = unwrapParent(uses[0]) as ts.Expression;
    }
    const call = literal.parent;
    if (!ts.isCallExpression(call) || call.arguments[0] !== literal)
      return 'The REST URL is not passed straight to fetch() or axios.';
    const callee = call.expression.getText();
    const method = entry.method;
    if (!method) return 'Refit cannot tell the HTTP method of this request.';
    const parsed = urlRequest(node as ts.Expression, method);
    if (!parsed) return 'Refit cannot read the REST path and query of this URL.';
    const extra = removable ? [removable] : [];
    if (/^(?:globalThis\.|window\.)?fetch$/.test(callee)) {
      const options = call.arguments[1] && unwrap(call.arguments[1]);
      if (options && !ts.isObjectLiteralExpression(options))
        return 'The fetch options are not an object literal.';
      if (call.arguments.length > 2) return 'fetch() is called with extra arguments.';
      return {
        call,
        transport: { kind: 'fetch', prefix: parsed.prefix, options } as Transport,
        request: parsed.request,
        initial: { kind: 'response' } as Value,
        removable: extra,
      };
    }
    const axios = /^(\w+)\.(get)$/.exec(callee);
    if (axios && axios[1] === 'axios') {
      const config = call.arguments[1] && unwrap(call.arguments[1]);
      if (config && !ts.isObjectLiteralExpression(config))
        return 'The axios config is not an object literal.';
      return {
        call,
        transport: {
          kind: 'axios',
          prefix: parsed.prefix,
          receiver: axios[1],
          config,
        } as Transport,
        request: parsed.request,
        initial: { kind: 'axios' } as Value,
        removable: extra,
      };
    }
    return `The REST URL is sent by ${callee.slice(0, 60)}(), which Refit does not rewrite.`;
  }
  if (!ts.isPropertyAccessExpression(node.expression)) return 'Refit cannot read this REST call.';
  const operation = node.expression.name.text;
  const receiver = node.expression.expression.getText();
  // `admin.rest.resources.Product.all({ session })` and `shopify.rest.Product.all({ session })`.
  const resource = /^(.*?)\.rest(?:\.resources)?\.([A-Z]\w*)$/.exec(receiver);
  if (resource) {
    const options = node.arguments[0] && unwrap(node.arguments[0]);
    if (
      !options ||
      !ts.isObjectLiteralExpression(options) ||
      options.properties.some((entry) => !propertyName(entry))
    )
      return 'The resource call options are not a plain object literal.';
    const initial: Value =
      operation === 'all'
        ? { kind: 'resource-all' }
        : operation === 'count'
          ? { kind: 'body', path: [] }
          : { kind: 'body', path: ['__record'] };
    const request: RestRequest = { method: 'GET', path: [], query: new Map() };
    if (!SIMPLE.test(resource[1]))
      return 'The resource is reached through an expression Refit cannot repeat.';
    if (/\.resources$/.test(receiver.replace(/\.[A-Z]\w*$/, '')) || /^admin$/.test(resource[1]))
      return {
        call: node,
        transport: { kind: 'resource-remix', admin: resource[1], operation } as Transport,
        request,
        initial,
      };
    const session = property(options, 'session');
    if (!session || !SIMPLE.test(session.getText()))
      return 'The resource call has no session Refit can pass to a GraphQL client.';
    return {
      call: node,
      transport: {
        kind: 'resource',
        factory: resource[1],
        session: session.getText(),
        operation,
      } as Transport,
      request,
      initial,
    };
  }
  const method = entry.method;
  if (!method) return 'Refit cannot tell the HTTP method of this request.';
  const request = clientRequest(node.arguments[0], method, source);
  if (!request)
    return 'The REST client call does not name a literal path with a plain query object.';
  if (node.arguments.length > 1) return 'The REST client call has extra arguments.';
  // Remix `admin.rest.get({ path })`: a fetch Response.
  const remix = /^(.*)\.rest$/.exec(receiver);
  if (remix && SIMPLE.test(remix[1]))
    return {
      call: node,
      transport: { kind: 'remix', admin: remix[1] } as Transport,
      request,
      initial: { kind: 'response' } as Value,
    };
  // `client.get({ path })` on `const client = new shopify.clients.Rest({ session })`.
  if (ts.isIdentifier(node.expression.expression)) {
    const declaration = declarationOf(node.expression.expression, source);
    const value = declaration?.initializer && unwrap(declaration.initializer);
    if (declaration && value && ts.isNewExpression(value)) {
      const factory = /^(.*)\.clients\.Rest$/.exec(value.expression.getText());
      const options = value.arguments?.[0] && unwrap(value.arguments[0]);
      const session =
        options && ts.isObjectLiteralExpression(options) ? property(options, 'session') : undefined;
      if (
        factory &&
        session &&
        SIMPLE.test(factory[1]) &&
        SIMPLE.test(session.getText()) &&
        options!
          .getText()
          .replace(/\s/g, '')
          .match(/^\{session(?::[\w$.]+)?,?\}$/)
      ) {
        if (apiMajor === undefined)
          return 'Refit cannot tell which @shopify/shopify-api release the repository locks, so it cannot pick the GraphQL client call.';
        const statement = declaration.parent.parent;
        return {
          call: node,
          transport: {
            kind: 'client',
            factory: factory[1],
            session: session.getText(),
            declaration:
              ts.isVariableStatement(statement) &&
              (declaration.parent as ts.VariableDeclarationList).declarations.length === 1 &&
              declaration.parent.flags & ts.NodeFlags.Const
                ? statement
                : undefined,
          } as Transport,
          request,
          initial: { kind: 'client' } as Value,
        };
      }
    }
  }
  return `The REST call goes through ${receiver.slice(0, 60)}, a client Refit does not rewrite.`;
}

function declarationOf(name: ts.Identifier, source: ts.SourceFile) {
  let found: ts.VariableDeclaration | undefined;
  let count = 0;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name.text
    ) {
      count++;
      found = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count === 1 ? found : undefined;
}

// A resource call's reads as REST body paths: `all` returns records under `data`, `find` one record.
function resourcePath(rule: RestRule, operation: string, path: string[]) {
  if (operation === 'count') return path;
  if (operation === 'all') {
    if (rule.kind === 'list') return [rule.envelope, ...path];
    return [rule.envelope, ...(path[0] === '[]' ? path.slice(1) : path)];
  }
  return [rule.envelope, ...path.slice(1)];
}

function resourceMatch(rules: RestRule[], className: string, operation: string, node: ts.Node) {
  const rule = rules.find(
    (entry) => entry.resource?.class === className && entry.resource.operation === operation,
  );
  if (!rule) return undefined;
  const params = new Map<string, string>();
  const options = unwrap((node as ts.CallExpression).arguments[0]) as ts.ObjectLiteralExpression;
  const placeholders = [...rule.path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
  if (placeholders.length > 1) return undefined;
  if (placeholders.length) {
    const id = property(options, 'id');
    if (!id) return undefined;
    params.set(placeholders[0], id.getText());
  }
  return { rule, params };
}

// A resource call's options other than `session` and `id` as query parameters.
function resourceRequest(node: ts.Node, request: RestRequest): RestRequest {
  const options = unwrap((node as ts.CallExpression).arguments[0]) as ts.ObjectLiteralExpression;
  const query = new Map<string, Part[]>();
  for (const entry of options.properties) {
    const name = propertyName(entry)!;
    if (name === 'session' || name === 'id') continue;
    query.set(name, [
      {
        expression: ts.isShorthandPropertyAssignment(entry)
          ? entry.name.text
          : (entry as ts.PropertyAssignment).initializer.getText(),
      },
    ]);
  }
  return { ...request, query };
}

function generate(input: {
  rule: RestRule;
  used: Record<string, RestField>;
  document: string;
  variables: string[];
  transport: Transport;
  typed: boolean;
  indent: string;
  pagination: boolean;
  apiMajor?: number;
}): { text: string; extra: SourceEdit[] } | string {
  const { rule, transport, typed, indent } = input;
  const any = typed ? ': any' : '';
  const converters = new Set<RestConvert>();
  const node = 'node';
  const record = rule.kind === 'count' ? '' : mapper(input.used, node, typed, converters);
  const pad = `${indent}  `;
  const lines: string[] = [];
  const queryText = `\`#graphql\n${pad}  ${input.document}\``;
  const variables = `{ ${input.variables.join(', ')} }`;
  // `result` is the GraphQL `data`; `body` the REST JSON body the code reads.
  const bodyLines = (missing: string) => {
    const out: string[] = [];
    if (rule.kind === 'count')
      out.push(`const body = { count: result.${rule.root.replace(/\(.*$/, '')}?.count };`);
    else if (rule.kind === 'list')
      out.push(
        `const body = { ${rule.envelope}: result.${responseKey(rule.root)}.nodes.map((${node}${any}) => (${record})) };`,
      );
    else {
      out.push(`const ${node}${any} = result.${responseKey(rule.root)};`);
      out.push(`if (!${node}) ${missing}`);
      out.push(`const body = { ${rule.envelope}: ${record} };`);
    }
    return out;
  };
  const pageInfo = () =>
    `{ ...(result.${responseKey(rule.root)}.pageInfo.hasNextPage ? { nextPage: { query: { limit: ${variablesFirst(input.variables)}, page_info: result.${responseKey(rule.root)}.pageInfo.endCursor } } } : {}) }`;
  for (const name of converters)
    lines.push(
      `const refit${name.replace(/(^|-)(\w)/g, (_, __, letter: string) => letter.toUpperCase())} = ${typed ? CONVERTERS[name].replace('(value)', '(value: any)') : CONVERTERS[name]};`,
    );
  switch (transport.kind) {
    case 'fetch': {
      if (input.pagination)
        return 'The code reads REST Link-header pagination, which Refit does not rebuild.';
      const options = transport.options;
      const kept: string[] = [];
      let headers: string | undefined;
      for (const entry of options?.properties ?? []) {
        const name = propertyName(entry);
        if (!name) return 'The fetch options spread or compute a key.';
        if (name === 'method' || name === 'body') continue;
        if (name === 'headers') {
          headers = headerText(entry);
          if (headers === undefined)
            return 'The fetch headers are not an object literal Refit can extend with a JSON content type.';
          continue;
        }
        kept.push(entry.getText());
      }
      if (!headers)
        return 'The request sends no headers, so it carries no access token Refit can reuse.';
      lines.push(
        `const response = await fetch(${partsSource([...transport.prefix, { text: 'graphql.json' }])}, { ${[...kept, 'method: "POST"', `headers: ${headers}`, `body: JSON.stringify({ query: ${queryText}, variables: ${variables} })`].join(', ')} });`,
        `const json${any} = response.ok ? await response.json() : undefined;`,
        `if (!json?.data) return new Response(JSON.stringify({ errors: json?.errors ?? response.statusText }), { status: response.ok ? 400 : response.status });`,
        'const result = json.data;',
        ...bodyLines(
          `return new Response(JSON.stringify({ errors: "Not Found" }), { status: 404 });`,
        ),
        'return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });',
      );
      break;
    }
    case 'axios': {
      if (input.pagination)
        return 'The code reads REST pagination headers, which Refit does not rebuild.';
      const config = transport.config;
      let headers: string | undefined;
      const kept: string[] = [];
      for (const entry of config?.properties ?? []) {
        const name = propertyName(entry);
        if (!name) return 'The axios config spreads or computes a key.';
        if (name === 'headers') {
          headers = headerText(entry);
          if (headers === undefined)
            return 'The axios headers are not an object literal Refit can extend with a JSON content type.';
        } else if (name === 'params' || name === 'method' || name === 'url' || name === 'data')
          return `The axios config sets ${name}.`;
        else kept.push(entry.getText());
      }
      if (!headers)
        return 'The request sends no headers, so it carries no access token Refit can reuse.';
      lines.push(
        `const response${any} = await ${transport.receiver}.post(${partsSource([...transport.prefix, { text: 'graphql.json' }])}, { query: ${queryText}, variables: ${variables} }, { ${[...kept, `headers: ${headers}`].join(', ')} });`,
        'if (!response.data?.data) throw new Error(`Shopify GraphQL request failed: ${JSON.stringify(response.data?.errors)}`);',
        'const result = response.data.data;',
        ...bodyLines('throw new Error("Not Found");'),
        'return { ...response, data: body };',
      );
      break;
    }
    case 'remix':
    case 'resource-remix': {
      lines.push(
        `const response = await ${transport.admin}.graphql(${queryText}, { variables: ${variables} });`,
        `const { data: result }${any} = await response.json();`,
        ...bodyLines('throw new Error("Not Found");'),
      );
      if (transport.kind === 'remix') {
        if (input.pagination)
          return 'The code reads REST pagination from a Response, which Refit does not rebuild.';
        lines.push(
          'return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });',
        );
      } else lines.push(...resourceReturn(rule, transport.operation, pageInfo));
      break;
    }
    case 'client':
    case 'resource': {
      const major = input.apiMajor;
      if (major === undefined)
        return 'Refit cannot tell which @shopify/shopify-api release the repository locks.';
      lines.push(
        `const graphql = new ${transport.factory}.clients.Graphql({ session: ${transport.session} });`,
      );
      if (major >= 9)
        lines.push(
          `const { data: result }${any} = await graphql.request(${queryText}, { variables: ${variables} });`,
        );
      else
        lines.push(
          `const { body: { data: result } }${any} = await graphql.query({ data: { query: ${queryText}, variables: ${variables} } });`,
        );
      lines.push(...bodyLines('throw new Error("Not Found");'));
      if (transport.kind === 'client')
        lines.push(
          rule.kind === 'list' && input.pagination
            ? `return { body, headers: {}, pageInfo: ${pageInfo()} };`
            : 'return { body, headers: {} };',
        );
      else lines.push(...resourceReturn(rule, transport.operation, pageInfo));
      break;
    }
  }
  const comment = `// Refit: REST ${rule.method} ${rule.path} → GraphQL Admin \`${rule.root}\`${rule.graphql ? ` (${rule.graphql.url})` : ''}; rebuilds the REST fields this code reads.`;
  return {
    text: `(async () => {\n${pad}${comment}\n${lines.map((line) => `${pad}${line}`).join('\n')}\n${indent}})()`,
    extra: [],
  };
}

function variablesFirst(values: string[]) {
  return values.find((value) => value.startsWith('first: '))!.slice('first: '.length);
}

function resourceReturn(rule: RestRule, operation: string, pageInfo: () => string) {
  if (operation === 'all' && rule.kind === 'list')
    return [`return { data: body.${rule.envelope}, headers: {}, pageInfo: ${pageInfo()} };`];
  if (operation === 'all') return [`return { data: [body.${rule.envelope}], headers: {} };`];
  if (operation === 'count') return ['return body;'];
  return [`return body.${rule.envelope};`];
}

// The headers object with a JSON content type, or undefined when Refit cannot be sure of it.
function headerText(entry: ts.ObjectLiteralElementLike) {
  if (!ts.isPropertyAssignment(entry)) return undefined;
  const object = unwrap(entry.initializer);
  if (!ts.isObjectLiteralExpression(object)) return undefined;
  let contentType: ts.Expression | undefined;
  for (const header of object.properties) {
    const name = propertyName(header);
    if (!name || !ts.isPropertyAssignment(header)) return undefined;
    if (name.toLowerCase() === 'content-type') contentType = header.initializer;
  }
  if (contentType)
    return ts.isStringLiteralLike(contentType) && contentType.text === 'application/json'
      ? object.getText()
      : undefined;
  const text = object.getText();
  return object.properties.length
    ? `${text.replace(/\s*\}$/, '').replace(/,\s*$/, '')}, "Content-Type": "application/json" }`
    : '{ "Content-Type": "application/json" }';
}

type Category = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'unknown';

const STRING_SCALARS = new Set([
  'String',
  'ID',
  'URL',
  'HTML',
  'DateTime',
  'Date',
  'Decimal',
  'Money',
  'FormattedString',
  'UnsignedInt64',
  'ARN',
  'Color',
  'UtcOffset',
  'StorefrontID',
]);

// The category a GraphQL field path yields after its conversion, or why the path does not exist.
function graphqlCategory(
  schema: GraphQLSchema,
  typeName: string,
  field: RestField,
): Category | string {
  let type: GraphQLType | undefined = schema.getType(typeName) as GraphQLType | undefined;
  for (const segment of field.graphql.split('.')) {
    const named = type && getNamedType(type);
    if (!named || (!isObjectType(named) && !isInterfaceType(named)))
      return `${segment} is not a field of an object`;
    const next = named.getFields()[responseKey(segment)];
    if (!next) return `${named.name}.${responseKey(segment)} does not exist`;
    type = next.type;
  }
  if (!type) return 'empty path';
  const named = getNamedType(type);
  const list = isListType(getNullableType(type));
  if (field.fields) return isList(field) || list ? 'array' : 'object';
  switch (field.convert) {
    case 'gid-number':
      return named.name === 'ID' && !list ? 'number' : `gid-number on ${String(type)}`;
    case 'lowercase':
      return isEnumType(named) && !list ? 'string' : `lowercase on ${String(type)}`;
    case 'join-comma':
      return list && named.name === 'String' ? 'string' : `join-comma on ${String(type)}`;
  }
  if (list) return 'array';
  if (isEnumType(named)) return 'string';
  if (named.name === 'Int' || named.name === 'Float') return 'number';
  if (named.name === 'Boolean') return 'boolean';
  if (STRING_SCALARS.has(named.name)) return 'string';
  return 'unknown';
}

// What the SDK's REST resource declares. Shopify's REST JSON sends ids as numbers while
// @shopify/shopify-api declares them `string`, so ids accept either.
function restCategories(name: string, declared: string): Set<Category> {
  const found = new Set<Category>();
  if (/\bstring\b/.test(declared)) found.add('string');
  if (/\bnumber\b/.test(declared)) found.add('number');
  if (/\bboolean\b/.test(declared)) found.add('boolean');
  if (/\[\]/.test(declared)) found.add('array');
  if (/\{|unknown|any|Record/.test(declared)) found.add('object');
  if (name === 'id' || name.endsWith('_id')) found.add('number').add('string');
  return found;
}

export interface RestContract {
  resources: Record<string, { singular: string; plural: string; fields: Record<string, string> }>;
}

const CONTRACT_FILE = new URL('../data/shopify-rest-resources.json', import.meta.url);

export function loadShopifyRestContract(): RestContract {
  return JSON.parse(readFileSync(CONTRACT_FILE, 'utf8')) as RestContract;
}

// Why a rule cannot be trusted on a schema: a GraphQL path that does not exist, a conversion that
// does not fit, or a value whose type differs from what the REST resource declares.
export function ruleProblems(rule: RestRule, schema: GraphQLSchema, contract: RestContract) {
  const problems: string[] = [];
  const query = schema.getQueryType()!;
  const root = query.getFields()[responseKey(rule.root)];
  if (!root) return [`QueryRoot.${rule.root} does not exist`];
  let node = getNamedType(root.type);
  if (rule.kind === 'list') {
    const nodes = isObjectType(node) ? node.getFields().nodes : undefined;
    if (!nodes) return [`${rule.root} is not a connection`];
    node = getNamedType(nodes.type);
  }
  if (rule.kind === 'count') {
    const count = isObjectType(node) ? node.getFields().count : undefined;
    return count ? [] : [`${rule.root} has no count`];
  }
  const resource = rule.resource && contract.resources[rule.resource.class];
  const check = (
    fields: Record<string, RestField>,
    typeName: string,
    declared?: Record<string, string>,
  ) => {
    for (const [name, field] of Object.entries(fields)) {
      const category = graphqlCategory(schema, typeName, field);
      if (!['string', 'number', 'boolean', 'array', 'object', 'unknown'].includes(category)) {
        problems.push(`${rule.id} ${name}: ${category}`);
        continue;
      }
      if (field.fields) continue;
      const rest = declared?.[name];
      if (declared && rest === undefined)
        problems.push(`${rule.id} ${name}: the REST resource declares no such field`);
      else if (rest && !restCategories(name, rest).has(category as Category))
        problems.push(
          `${rule.id} ${name}: GraphQL gives ${category}, the REST resource declares ${rest}`,
        );
    }
  };
  check(rule.fields, node.name, resource?.fields);
  return problems;
}

// Every REST call the scan found, rewritten where a rule and the traced reads allow.
export function shopifyRestRewrites(
  repository: { files: { path: string; content: string }[] },
  scan: Pick<ShopifyScan, 'rest'>,
  schemas: { version: string; schema: GraphQLSchema }[],
  sdkRelease: string | undefined,
  rules = loadShopifyRestRules(),
) {
  const major = sdkRelease ? Number.parseInt(sdkRelease, 10) : Number.NaN;
  const byFile = new Map<string, ShopifyScan['rest']>();
  for (const entry of scan.rest) byFile.set(entry.file, [...(byFile.get(entry.file) ?? []), entry]);
  return [...byFile].flatMap(([file, entries]) => {
    const content = repository.files.find((entry) => entry.path === file)?.content;
    if (content === undefined)
      return entries.map((entry): RestStop => ({
        status: 'stopped',
        entry,
        reason: 'Refit could not read the file again.',
      }));
    return rewriteRestCalls({
      file,
      content,
      entries,
      rules,
      schemas,
      ...(Number.isFinite(major) ? { apiMajor: major } : {}),
    });
  });
}

// The draft's "what changed" lines for each rewrite.
export function restRewriteNotes(rewrites: RestRewrite[]) {
  return rewrites.map(
    (result) =>
      `REST rewrite at ${result.entry.file}:${result.entry.line}: ${result.rule.method} ${result.rule.path} now sends the GraphQL Admin query \`${result.rule.root}\` and rebuilds ${result.reads.filter(Boolean).join(', ') || 'no fields (the code reads none)'} in the REST shape. Errors and missing records still fail, but as GraphQL errors (a thrown Error or a 400/404 Response) rather than REST status codes; logged response bodies now hold only the rebuilt fields.${(result.rule.notes ?? []).length ? ` ${result.rule.notes!.join(' ')}` : ''}`,
  );
}
