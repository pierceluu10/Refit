import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript-compiler';
import type { ShopifyScan } from './shopify-analysis.ts';

// REST Admin call tracing for the versioned REST contract prover (pipeline/shopify-rest-contract.ts):
// the request each call sends and the response fields the code reads. The REST → GraphQL mapping
// table (data/shopify-rest-graphql.json) is loaded only as context for the agent fixer, which
// rewrites REST calls itself (docs/GUT-PLAN.md).

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
  // The SDK REST resource whose field types the mapping must match, when `resource` is not set.
  restResource?: string;
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

// An endpoint whose GraphQL counterpart Shopify documents with different rows (a default filter
// one side applies), so neither a rule nor the model may rewrite it.
export interface RestRefusal {
  method: string;
  path: string;
  reason: string;
  source: string;
  quote?: string;
}

function restTable() {
  if (!existsSync(RULES_FILE)) return { formatVersion: 1, rules: [], nonEquivalent: [] };
  return JSON.parse(readFileSync(RULES_FILE, 'utf8')) as {
    formatVersion: number;
    rules: RestRule[];
    nonEquivalent?: RestRefusal[];
  };
}

export const loadShopifyRestRefusals = () => restTable().nonEquivalent ?? [];

export function loadShopifyRestRules(): RestRule[] {
  const table = restTable();
  if (table.formatVersion !== 1) throw new Error('data/shopify-rest-graphql.json: unknown format');
  return table.rules.map((rule) => ({ ...rule, origin: rule.origin ?? 'documented' }));
}

// One piece of a request: literal text, or a JavaScript expression (source text).
type Part = { text: string } | { expression: string };

interface RestRequest {
  method: string;
  path: Part[];
  query: Map<string, Part[]>;
  // The JSON body a write sends: a client call's `data`, fetch's `body` or axios's data argument.
  body?: ts.Expression;
}

// What the code does with the response: REST body paths it reads ('[]' steps into an array),
// whether a read uses the whole value, and the reads Refit cannot follow.
export interface Read {
  path: string[];
  whole: boolean;
}

// What a traced REST call sends and reads, for the versioned contract check
// (pipeline/shopify-rest-contract.ts): the raw path (ids as `{p0}`) or the resource class and
// operation, the query or option names, the body's key paths (null when the body is not an object
// literal) and every read of the response.
export interface RestTrace {
  method: string;
  path?: string;
  resource?: { name: string; operation: string };
  query: string[];
  reads: Read[];
  body?: string[][] | null;
}

interface Trace {
  reads: Read[];
  stops: string[];
}

export interface RestStop {
  status: 'stopped';
  entry: ShopifyScan['rest'][number];
  reason: string;
  trace?: RestTrace;
  // A `new <shopify>.clients.Rest(...)` construction: where each use of the client is called, or
  // null when a use is anything but a call on it.
  clientCalls?: { line: number; column: number }[] | null;
}

export const unwrapParent = (node: ts.Node) => {
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

export const unwrap = (node: ts.Expression): ts.Expression =>
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

export const propertyName = (entry: ts.ObjectLiteralElementLike) =>
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
  const allowed = new Set(['path', 'query', 'data', 'type']);
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
  const body = property(options, 'data');
  return { method, path, query, ...(body ? { body } : {}) } as RestRequest;
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

// Whether a block, function or loop declares `text` itself, so names inside it are its own.
function declaresDirectly(node: ts.Node, text: string): boolean {
  const binds = (name: ts.BindingName): boolean =>
    ts.isIdentifier(name)
      ? name.text === text
      : name.elements.some((entry) => !ts.isOmittedExpression(entry) && binds(entry.name));
  const listBinds = (list: ts.VariableDeclarationList) =>
    list.declarations.some((declaration) => binds(declaration.name));
  if (ts.isFunctionLike(node))
    return (
      node.parameters.some((parameter) => binds(parameter.name)) ||
      (ts.isFunctionExpression(node) && node.name?.text === text)
    );
  if (ts.isBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node))
    return node.statements.some(
      (statement) =>
        (ts.isVariableStatement(statement) && listBinds(statement.declarationList)) ||
        ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
          statement.name?.text === text),
    );
  if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node))
    return Boolean(
      node.initializer &&
      ts.isVariableDeclarationList(node.initializer) &&
      listBinds(node.initializer),
    );
  if (ts.isCatchClause(node))
    return Boolean(node.variableDeclaration && binds(node.variableDeclaration.name));
  return false;
}

// The identifiers in `scope` that name the variable `name` declares, skipping nested scopes that
// declare the same name; undefined when the name is declared again in this scope.
export function references(name: ts.Identifier, scope: ts.Node) {
  const found: ts.Identifier[] = [];
  let shadowed = false;
  const visit = (node: ts.Node) => {
    if (
      node !== scope &&
      !(node.pos <= name.pos && name.end <= node.end) &&
      declaresDirectly(node, name.text)
    ) {
      // A `var` in a nested block belongs to the enclosing function, so it is not a new scope.
      const hoisted =
        ts.isBlock(node) &&
        node.statements.some(
          (statement) =>
            ts.isVariableStatement(statement) &&
            !(statement.declarationList.flags & ts.NodeFlags.BlockScoped) &&
            statement.declarationList.declarations.some(
              (declaration) =>
                ts.isIdentifier(declaration.name) && declaration.name.text === name.text,
            ),
        );
      if (hoisted) shadowed = true;
      else return;
    }
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

export function declarationScope(node: ts.Node) {
  let scope = node.parent;
  while (
    scope &&
    !ts.isBlock(scope) &&
    !ts.isSourceFile(scope) &&
    !ts.isCaseClause(scope) &&
    !ts.isFunctionLike(scope)
  )
    scope = scope.parent;
  // A `case` clause's declarations belong to the whole switch.
  return scope && ts.isCaseClause(scope) ? scope.parent : scope;
}

// Array methods whose callback receives elements, those that return an element, and those that
// return elements of the same array.
const ARRAY_CALLBACKS = new Set([
  'map',
  'forEach',
  'some',
  'every',
  'flatMap',
  'findIndex',
  'findLastIndex',
  'find',
  'findLast',
  'filter',
  'sort',
  'toSorted',
]);
const ARRAY_ELEMENT_RESULT = new Set(['find', 'findLast', 'at', 'pop', 'shift']);
const ARRAY_SAME_RESULT = new Set(['filter', 'slice', 'reverse', 'sort', 'toSorted', 'toReversed']);
const EXISTENCE_OPERATORS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

type Value =
  { kind: 'response' | 'axios' | 'client' | 'resource-all' } | { kind: 'body'; path: string[] };

// Whether an identifier is written: `x = …`, `x += …`, `x++`, or a destructuring target.
export function assigned(use: ts.Identifier) {
  let node: ts.Node = use;
  while (
    ts.isParenthesizedExpression(node.parent) ||
    ts.isShorthandPropertyAssignment(node.parent) ||
    ts.isPropertyAssignment(node.parent) ||
    ts.isArrayLiteralExpression(node.parent) ||
    ts.isObjectLiteralExpression(node.parent)
  )
    node = node.parent;
  const parent = node.parent;
  return (
    (ts.isBinaryExpression(parent) &&
      parent.left === node &&
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
    ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
      (parent.operator === ts.SyntaxKind.PlusPlusToken ||
        parent.operator === ts.SyntaxKind.MinusMinusToken))
  );
}

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
    // A resource call's result used whole holds its records whole (and SDK paging state).
    else if (value.kind === 'resource-all') trace.reads.push({ path: ['[]'], whole: true });
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
        // `text()` is the whole body as a string.
        if (name === 'text' && called) return void trace.reads.push({ path: [], whole: true });
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
        if (name === 'pageInfo') return;
        return void trace.stops.push(
          `The code reads the response's \`${name}\`, which the rewrite cannot rebuild.`,
        );
      case 'resource-all':
        if (name === 'data') return next(access, { kind: 'body', path: ['[]'] });
        if (name === 'pageInfo') return;
        // The SDK's result object has no `length`: the read is undefined in every version.
        if (name === 'length' && !called) return;
        return void trace.stops.push(
          `The code reads the result's \`${name}\`, which the rewrite cannot rebuild.`,
        );
      case 'body': {
        if (called) {
          if (
            ARRAY_CALLBACKS.has(name) ||
            ARRAY_ELEMENT_RESULT.has(name) ||
            ARRAY_SAME_RESULT.has(name)
          ) {
            const callback = called.arguments[0] && unwrap(called.arguments[0]);
            if (callback && ARRAY_CALLBACKS.has(name)) {
              if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))
                return whole('');
              const element = [...value.path, '[]'];
              const { parameters } = callback;
              if (
                parameters.some((parameter) => parameter.dotDotDotToken) ||
                /\barguments\b/.test(callback.body.getText())
              )
                return void trace.stops.push(
                  'An array callback reads its arguments in a way Refit does not follow.',
                );
              // `sort` compares two elements; other callbacks get (element, index, array).
              if (parameters[0]) bind(parameters[0], element);
              if (parameters[1] && name.endsWith('ort')) bind(parameters[1], element);
              if (parameters[2]) bind(parameters[2], value.path);
            } else if (callback) return whole('');
            trace.reads.push({ path: value.path, whole: false });
            if (ARRAY_ELEMENT_RESULT.has(name))
              return next(called, { kind: 'body', path: [...value.path, '[]'] });
            if (ARRAY_SAME_RESULT.has(name)) return next(called, value);
            return;
          }
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
    return bind(declaration, [...value.path, '[]']);
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
    // A `var` belongs to the whole function, not the block Refit would search.
    if (!(list.flags & ts.NodeFlags.BlockScoped))
      return void trace.stops.push('The response is held in a `var`.');
    if (ts.isIdentifier(declaration.name)) {
      const uses = references(declaration.name, declarationScope(list));
      if (!uses)
        return void trace.stops.push(`Another declaration shadows \`${declaration.name.text}\`.`);
      if (uses.some(assigned))
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
      if (uses.some(assigned)) return void trace.stops.push(`\`${pattern.text}\` is reassigned.`);
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
      if ((to.kind === 'client' || to.kind === 'resource-all') && field === 'pageInfo') continue;
      if (!target)
        return void trace.stops.push(
          `The code destructures \`${field}\` from the response, which the rewrite cannot rebuild.`,
        );
      if (entry.initializer && to.kind === 'body')
        trace.reads.push({ path: target.kind === 'body' ? target.path : [], whole: false });
      binding(entry.name, target);
    }
  }

  function bind(declaration: ts.ParameterDeclaration | ts.VariableDeclaration, path: string[]) {
    binding(declaration.name, { kind: 'body', path });
  }
}

// Every read of a REST body value `node` holds at `path`, for tracers outside this file.
export function followBody(node: ts.Expression, path: string[]) {
  const trace: Trace = { reads: [], stops: [] };
  follow(node, { kind: 'body', path }, false, trace);
  return trace;
}

export interface RestRewriteOptions {
  file: string;
  content: string;
  entries: ShopifyScan['rest'];
}

// Traces the REST calls of one file for the contract check; every entry comes back as a stop that
// carries its trace where Refit could follow the call.
export function rewriteRestCalls(options: RestRewriteOptions): RestStop[] {
  const kind = /\.tsx?$|\.mts$|\.cts$/.test(options.file)
    ? options.file.endsWith('x')
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS
    : options.file.endsWith('x')
      ? ts.ScriptKind.JSX
      : ts.ScriptKind.JS;
  const source = ts.createSourceFile(
    options.file,
    options.content,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const offset = (entry: ShopifyScan['rest'][number]) =>
    source.getPositionOfLineAndCharacter(entry.line - 1, entry.column - 1);
  const results: RestStop[] = [];
  for (const entry of options.entries) {
    let trace: RestTrace | undefined;
    const stop = (reason: string): RestStop => ({
      status: 'stopped',
      entry,
      reason,
      ...(trace ? { trace } : {}),
    });
    const at = offset(entry);
    const node = findNode(source, at, entry.expression);
    if (!node) {
      results.push(stop('Refit could not locate the call again.'));
      continue;
    }
    if (ts.isNewExpression(node)) continue; // A REST client or resource construction: handled with its calls below.
    const recognized = recognize(node, entry, source);
    if (typeof recognized === 'string') {
      results.push(stop(recognized));
      continue;
    }
    const { call, request, initial } = recognized;
    const followed: Trace = { reads: [], stops: [] };
    follow(call, initial, true, followed);
    if (followed.stops.length) {
      results.push(stop(followed.stops[0]));
      continue;
    }
    const description = {
      path:
        entry.resource ??
        (() => {
          let index = 0;
          const path = request.path
            .map((part) => ('text' in part ? part.text : `{p${index++}}`))
            .join('');
          return /\.json$/.test(path) ? path : `${path}.json`;
        })(),
      query: [...request.query.keys()],
    };
    const resourceCall = entry.resource && /^(\w+)\.(\w+)$/.exec(entry.resource);
    trace = {
      method: request.method,
      ...(resourceCall
        ? { resource: { name: resourceCall[1], operation: resourceCall[2] } }
        : { path: description.path }),
      query: resourceCall
        ? (
            unwrap((node as ts.CallExpression).arguments[0]) as ts.ObjectLiteralExpression
          ).properties
            .map((property) => propertyName(property)!)
            .filter((name) => name !== 'session')
        : description.query,
      reads: followed.reads,
      ...(request.body ? { body: bodyKeys(request.body) } : {}),
    };
    if (request.method === 'GET' && request.body) {
      results.push(stop('The GET request sends a body.'));
      continue;
    }
    results.push(stop('Traced for the contract check.'));
  }
  // Constructions: a REST client or resource record built in this file.
  for (const entry of options.entries) {
    const node = findNode(source, offset(entry), entry.expression);
    if (!node || !ts.isNewExpression(node)) continue;
    results.push({
      status: 'stopped',
      entry,
      reason: /\.clients\.Rest$/.test(entry.expression)
        ? 'The REST client is used by calls Refit did not rewrite.'
        : 'A REST resource record is built and saved; Refit rewrites only REST reads.',
      ...(/\.clients\.Rest$/.test(entry.expression)
        ? { clientCalls: clientCallSites(node, source) }
        : {}),
    });
  }
  return results.sort(
    (a, b) => options.entries.indexOf(a.entry) - options.entries.indexOf(b.entry),
  );
}

// The key paths of a JSON body written as an object literal, directly or in `JSON.stringify(…)`:
// `{ script_tag: { event, src } }` is `script_tag.event` and `script_tag.src`. A value that is
// not an object literal is a leaf the code sends whole. The literal may be held in a const whose
// only other uses are property writes (`body.page.title = …`), which add their paths. Null for
// anything else.
function bodyKeys(expression: ts.Expression): string[][] | null {
  let value = unwrap(expression);
  if (
    ts.isCallExpression(value) &&
    value.expression.getText() === 'JSON.stringify' &&
    value.arguments.length === 1
  )
    value = unwrap(value.arguments[0]);
  if (ts.isIdentifier(value)) return constBodyKeys(value);
  if (!ts.isObjectLiteralExpression(value)) return null;
  const paths: string[][] = [];
  const walk = (object: ts.ObjectLiteralExpression, prefix: string[]): boolean =>
    object.properties.every((entry) => {
      const name = propertyName(entry);
      if (!name || !(ts.isPropertyAssignment(entry) || ts.isShorthandPropertyAssignment(entry)))
        return false;
      const inner = ts.isPropertyAssignment(entry) ? unwrap(entry.initializer) : undefined;
      if (inner && ts.isObjectLiteralExpression(inner)) return walk(inner, [...prefix, name]);
      paths.push([...prefix, name]);
      return true;
    });
  return walk(value, []) ? paths : null;
}

function constBodyKeys(name: ts.Identifier): string[][] | null {
  const declaration = declarationOf(name, name.getSourceFile());
  const literal = declaration?.initializer && unwrap(declaration.initializer);
  if (
    !declaration ||
    !literal ||
    !ts.isObjectLiteralExpression(literal) ||
    !(declaration.parent.flags & ts.NodeFlags.Const)
  )
    return null;
  const paths = bodyKeys(literal);
  const uses = references(declaration.name as ts.Identifier, declarationScope(declaration.parent));
  if (!paths || !uses) return null;
  for (const use of uses) {
    if (use === name) continue;
    const logged = unwrapParent(use).parent;
    if (ts.isCallExpression(logged) && /^console\.\w+$/.test(logged.expression.getText())) continue;
    let access: ts.Node = use;
    const path: string[] = [];
    while (ts.isPropertyAccessExpression(access.parent) && access.parent.expression === access) {
      path.push(access.parent.name.text);
      access = access.parent;
    }
    const write = access.parent;
    if (
      !path.length ||
      !ts.isBinaryExpression(write) ||
      write.left !== access ||
      write.operatorToken.kind !== ts.SyntaxKind.EqualsToken
    )
      return null;
    paths.push(path);
  }
  return paths;
}

// Where each use of a `const client = new <shopify>.clients.Rest(…)` is a call on it
// (`client.get(…)`), or null when a use is anything else (passed on, returned, reassigned).
function clientCallSites(construction: ts.Node, source: ts.SourceFile) {
  const declaration = unwrapParent(construction).parent;
  if (
    !ts.isVariableDeclaration(declaration) ||
    !ts.isIdentifier(declaration.name) ||
    !(declaration.parent.flags & ts.NodeFlags.Const) ||
    // An exported client is used in files this one cannot see.
    ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Export
  )
    return null;
  const uses = references(declaration.name, declarationScope(declaration.parent));
  if (!uses) return null;
  const sites: { line: number; column: number }[] = [];
  for (const use of uses) {
    const call = use.parent.parent;
    if (
      !ts.isPropertyAccessExpression(use.parent) ||
      use.parent.expression !== use ||
      !ts.isCallExpression(call) ||
      call.expression !== use.parent
    )
      return null;
    const at = source.getLineAndCharacterOfPosition(call.getStart());
    sites.push({ line: at.line + 1, column: at.character + 1 });
  }
  return sites;
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

const SIMPLE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

// Why a URL const's substitutions cannot be evaluated where its single use is instead: the const
// must sit in the same function as the use, each substitution must be a name or property chain, and
// no name it starts from may be assigned in that function or declared again between the two.
function movableUrl(literal: ts.Expression, use: ts.Identifier) {
  const fn = ts.findAncestor(literal, ts.isFunctionLike);
  if (!fn || ts.findAncestor(use, ts.isFunctionLike) !== fn)
    return 'The REST URL constant is declared outside the function that sends it.';
  const roots = new Set<string>();
  if (ts.isTemplateExpression(literal))
    for (const span of literal.templateSpans) {
      const text = span.expression.getText();
      if (!SIMPLE.test(text))
        return 'The REST URL constant computes part of its URL, which Refit would evaluate later.';
      roots.add(text.split('.')[0]);
    }
  let conflict: string | undefined;
  const visit = (node: ts.Node) => {
    if (conflict) return;
    if (ts.isIdentifier(node) && roots.has(node.text) && assigned(node))
      conflict = `${node.text} is assigned in the function that sends the REST URL.`;
    const between =
      node.pos <= use.pos &&
      use.end <= node.end &&
      !(node.pos <= literal.pos && literal.end <= node.end);
    if (between && [...roots].some((root) => declaresDirectly(node, root)))
      conflict = 'A name in the REST URL is declared again before the request.';
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return conflict;
}

function recognize(node: ts.Node, entry: ShopifyScan['rest'][number], source: ts.SourceFile) {
  // A REST URL literal passed to fetch() or axios, directly or through a const used once.
  if (!ts.isCallExpression(node)) {
    let literal = unwrapParent(node) as ts.Expression;
    const declaration = literal.parent;
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
        (declaration.parent as ts.VariableDeclarationList).declarations.length !== 1 ||
        !ts.isVariableStatement(declaration.parent.parent)
      )
        return 'The REST URL constant shares its declaration with other variables.';
      const moved = movableUrl(literal, uses[0]);
      if (moved) return moved;
      literal = unwrapParent(uses[0]) as ts.Expression;
    }
    const call = literal.parent;
    if (!ts.isCallExpression(call) || call.arguments[0] !== literal)
      return 'The REST URL is not passed straight to fetch() or axios.';
    const callee = call.expression.getText().replace(/\s+/g, '');
    const method = entry.method;
    if (!method) return 'Refit cannot tell the HTTP method of this request.';
    const parsed = urlRequest(node as ts.Expression, method);
    if (!parsed) return 'Refit cannot read the REST path and query of this URL.';
    if (/^(?:globalThis\.|window\.)?fetch$/.test(callee)) {
      const options = call.arguments[1] && unwrap(call.arguments[1]);
      if (options && !ts.isObjectLiteralExpression(options))
        return 'The fetch options are not an object literal.';
      if (call.arguments.length > 2) return 'fetch() is called with extra arguments.';
      const body = options && property(options as ts.ObjectLiteralExpression, 'body');
      return {
        call,
        request: { ...parsed.request, ...(body ? { body } : {}) },
        initial: { kind: 'response' } as Value,
      };
    }
    const axios = /^(\w+)\.(get|post|put|delete)$/.exec(callee);
    if (axios && axios[1] === 'axios') {
      // axios.post(url, data, config) and axios.put; get and delete take (url, config).
      const writes = axios[2] === 'post' || axios[2] === 'put';
      const config = call.arguments[writes ? 2 : 1] && unwrap(call.arguments[writes ? 2 : 1]);
      if (config && !ts.isObjectLiteralExpression(config))
        return 'The axios config is not an object literal.';
      return {
        call,
        request: {
          ...parsed.request,
          ...(writes && call.arguments[1] ? { body: call.arguments[1] } : {}),
        },
        initial: { kind: 'axios' } as Value,
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
    return { call: node, request, initial };
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
        const statement = declaration.parent.parent;
        const receiver = node.expression.expression;
        if (
          !ts.isVariableStatement(statement) ||
          (declaration.parent as ts.VariableDeclarationList).declarations.length !== 1 ||
          !(declaration.parent.flags & ts.NodeFlags.Const) ||
          !references(
            declaration.name as ts.Identifier,
            declarationScope(declaration.parent),
          )?.includes(receiver)
        )
          return 'The REST client is not a const Refit can follow to this call.';
        return {
          call: node,
          request,
          initial: { kind: 'client' } as Value,
        };
      }
    }
  }
  return `The REST call goes through ${receiver.slice(0, 60)}, a client Refit does not rewrite.`;
}

// The variable declaration `name` refers to: the one declaration of that name whose scope
// resolves `name` to it, so functions that each declare their own `client` are told apart.
function declarationOf(name: ts.Identifier, source: ts.SourceFile) {
  const found: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name.text &&
      (node.name === name || references(node.name, declarationScope(node.parent))?.includes(name))
    )
      found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found.length === 1 ? found[0] : undefined;
}
