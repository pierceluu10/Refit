import { readFile } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import ts from 'typescript-compiler';
import { metaSdkVersion, META_SDK, TEST_PATH } from './deadline-exposure.ts';
import { readRepository } from './repository.ts';
import { isObject, parseObject } from './specifications.ts';
import type { Repository } from './types.ts';

// Meta Graph API requests a repository makes, read from source without running it: raw HTTP calls
// to graph.facebook.com and facebook-nodejs-business-sdk resource-class calls. Every value is
// either read from literal code or reported as unknown with the reason; nothing is guessed.

export const META_BUSINESS_SDK_EDGES = new URL(
  '../data/meta-business-sdk-edges.json',
  import.meta.url,
);
const HOST = /^(?:https?:)?\/\/graph\.facebook\.com(?=[/?#]|$)/;
const VERSION = /^v\d+\.\d+$/;
const MAX_TEXT = 160;
// Clients whose request options Refit reads. Any other function a Graph URL is passed to is
// reported as a helper, with its HTTP method and extra options unknown.
const AXIOS_METHODS = new Set(['get', 'delete', 'head', 'options', 'post', 'put', 'patch']);
const BODY_METHODS = new Set(['post', 'put', 'patch']);
// A whole-segment substitution with one of these names may hold several path segments.
const PATH_NAME = /path|endpoint|url|route|uri/i;

export interface GraphLocation {
  file: string;
  line: number;
}

export interface GraphCall {
  kind: 'url' | 'sdk';
  // Where the request is made: the HTTP or SDK call, or the URL itself when no call was traced.
  file: string;
  line: number;
  // `test` for test, spec, story, fixture and example files.
  use: 'live' | 'test';
  // The function the URL is passed to (`fetch`, `axios.post`, a helper such as `metaFetch`) or the
  // SDK class and method; null when the URL reaches no call Refit traced.
  client: string | null;
  method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH' | null;
  // The Graph API version the request pins, such as `v19.0`; null when unversioned or unknown.
  version: string | null;
  versionSource: 'url' | 'constant' | 'sdk-package' | 'unversioned' | 'unknown';
  // Where the version is written: the URL or constant, or the manifest for the SDK.
  pin: GraphLocation | null;
  // `/{pageId}/photos`: literal segments as written, runtime segments named in braces.
  path: string | null;
  // The edge the request reaches (`photos`); null for a node read or when unknown.
  edge: string | null;
  // Requested fields as written (`picture.type(large)`, `posts{message}`); [] when the request
  // names none, so the node's default fields are returned; null when unknown.
  fields: string[] | null;
  // Insights metrics requested with `metric`; [] when none; null when unknown.
  metrics: string[] | null;
  // Names of query and body parameters; null when some are built at runtime.
  parameters: string[] | null;
  // What could not be read, and why.
  unknown: string[];
  // The source line the request is made on, trimmed.
  text: string;
}

export interface GraphCallScan {
  calls: GraphCall[];
  // Where the business SDK's version comes from, when the repository declares it.
  sdk: {
    version: string | null;
    declared: string;
    locked: string | null;
    file: string;
    line: number;
  } | null;
  warnings: string[];
}

interface SdkEdges {
  version: string;
  classes: Set<string>;
  methods: Map<
    string,
    { http: string | null; edge: string | null; byClass?: Record<string, string> }
  >;
}

let sdkEdges: Promise<SdkEdges> | undefined;
export function loadSdkEdges(path: string | URL = META_BUSINESS_SDK_EDGES): Promise<SdkEdges> {
  const load = async () => {
    const value = parseObject(await readFile(path, 'utf8'), 'Meta business SDK edges');
    if (value.formatVersion !== 1 || !Array.isArray(value.classes) || !isObject(value.methods))
      throw new Error('Meta business SDK edges require formatVersion 1, classes and methods.');
    return {
      version: String(value.version),
      classes: new Set(value.classes.map(String)),
      methods: new Map(
        Object.entries(value.methods).map(([name, entry]) => [name, entry as never]),
      ),
    };
  };
  if (path !== META_BUSINESS_SDK_EDGES) return load();
  sdkEdges ??= load();
  return sdkEdges;
}

// A URL expression flattened into literal text and runtime pieces, in order.
type Part = { text: string; node: ts.Node } | { expression: ts.Expression };

function excerpt(source: ts.SourceFile, node: ts.Node) {
  const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
  const starts = source.getLineStarts();
  const text = source.text.slice(starts[line], starts[line + 1] ?? source.text.length).trim();
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

function lineOf(source: ts.SourceFile, node: ts.Node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  )
    current = current.expression;
  return current;
}

// The parts of a string literal, template or `+` concatenation.
function partsOf(node: ts.Expression): Part[] {
  const expression = unwrap(node);
  if (ts.isStringLiteralLike(expression)) return [{ text: expression.text, node: expression }];
  if (ts.isTemplateExpression(expression)) {
    const parts: Part[] = [{ text: expression.head.text, node: expression.head }];
    for (const span of expression.templateSpans)
      parts.push({ expression: span.expression }, { text: span.literal.text, node: span.literal });
    return parts.filter((part) => !('text' in part) || part.text);
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  )
    return [...partsOf(expression.left), ...partsOf(expression.right)];
  return [{ expression }];
}

function expressionName(expression: ts.Expression) {
  const node = unwrap(expression);
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.getText().replace(/\s+/g, '');
  return node.getText().replace(/\s+/g, ' ').slice(0, 40);
}

function propertyName(name: ts.PropertyName | ts.BindingName | undefined) {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name))
    return name.text;
  // `[Campaign.Fields.name]`, as the business SDK's examples write parameters.
  if (ts.isComputedPropertyName(name)) return sdkFieldName(name.expression);
  return undefined;
}

// `Campaign.Fields.name` or `'name'`.
function sdkFieldName(expression: ts.Expression) {
  const node = unwrap(expression);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'Fields'
  )
    return node.name.text;
  return undefined;
}

// Top-level comma-separated items, keeping `picture.type(large)` and `posts{message,from}` whole.
export function splitFields(value: string) {
  const items: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of value) {
    if (character === '{' || character === '(') depth += 1;
    if (character === '}' || character === ')') depth = Math.max(0, depth - 1);
    if (character === ',' && depth === 0) {
      if (current.trim()) items.push(current.trim());
      current = '';
    } else current += character;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function decode(value: string) {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

// Whether a binding (a name or a destructuring pattern) declares `name`.
function binds(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some(
    (element) => !ts.isOmittedExpression(element) && binds(element.name, name),
  );
}

// The `const`, `let` or `var` a name refers to from a node: the nearest enclosing block, loop or
// file that declares it. No type checker runs, so this follows names only. A closer binding the
// value cannot be read from (a parameter, a destructured name, a loop or catch variable) shadows
// outer declarations, and the result is undefined.
function findDeclaration(name: string, from: ts.Node): ts.VariableDeclaration | undefined {
  for (let scope: ts.Node | undefined = from; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope) && scope.parameters.some((item) => binds(item.name, name)))
      return undefined;
    if (
      ts.isCatchClause(scope) &&
      scope.variableDeclaration &&
      binds(scope.variableDeclaration.name, name)
    )
      return undefined;
    const lists =
      ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope)
        ? scope.statements.flatMap((statement) =>
            ts.isVariableStatement(statement) ? [statement.declarationList] : [],
          )
        : (ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) &&
            scope.initializer &&
            ts.isVariableDeclarationList(scope.initializer)
          ? [scope.initializer]
          : [];
    for (const list of lists)
      for (const declaration of list.declarations) {
        if (!binds(declaration.name, name)) continue;
        return ts.isIdentifier(declaration.name) &&
          !ts.isForOfStatement(scope) &&
          !ts.isForInStatement(scope)
          ? declaration
          : undefined;
      }
  }
  return undefined;
}

function isConst(declaration: ts.VariableDeclaration) {
  return (
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

const MUTATORS = new Set(['set', 'append', 'delete', 'push', 'unshift', 'splice']);

// The initializer of a `const` that nothing changes afterwards: no `params.set(...)`,
// `list.push(...)`, `options.key = ...` or `Object.assign(options, ...)` anywhere it is visible.
function constantValue(identifier: ts.Identifier): ts.Expression | undefined {
  const declaration = findDeclaration(identifier.text, identifier);
  if (!declaration?.initializer || !isConst(declaration)) return undefined;
  const scope = ts.findAncestor(declaration, (item) => ts.isBlock(item) || ts.isSourceFile(item));
  let mutated = false;
  const visit = (child: ts.Node) => {
    if (mutated) return;
    if (
      ts.isIdentifier(child) &&
      child.text === identifier.text &&
      child !== declaration.name &&
      findDeclaration(child.text, child) === declaration
    ) {
      const parent = child.parent;
      const grandparent = parent.parent;
      if (
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
        parent.expression === child &&
        ((ts.isPropertyAccessExpression(parent) &&
          MUTATORS.has(parent.name.text) &&
          ts.isCallExpression(grandparent) &&
          grandparent.expression === parent) ||
          (ts.isBinaryExpression(grandparent) &&
            grandparent.left === parent &&
            grandparent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            grandparent.operatorToken.kind <= ts.SyntaxKind.LastAssignment))
      )
        mutated = true;
      if (
        ts.isCallExpression(parent) &&
        parent.arguments[0] === child &&
        parent.expression.getText().replace(/\s+/g, '') === 'Object.assign'
      )
        mutated = true;
    }
    ts.forEachChild(child, visit);
  };
  if (scope) visit(scope);
  return mutated ? undefined : declaration.initializer;
}

// Why parameters held in an expression cannot be read.
function runtimeValue(node: ts.Expression, label: string) {
  if (ts.isIdentifier(node)) {
    const declaration = findDeclaration(node.text, node);
    if (declaration?.initializer && isConst(declaration))
      return `${label} in \`${node.text}\` are changed after it is declared`;
  }
  return `${label} come from \`${expressionName(node)}\` at runtime`;
}

// A string held in a `const` that is a literal, such as `const VERSION = 'v19.0'`.
function constantString(expression: ts.Expression) {
  const node = unwrap(expression);
  if (ts.isStringLiteralLike(node)) return { value: node.text, node };
  if (!ts.isIdentifier(node)) return undefined;
  const declaration = findDeclaration(node.text, node);
  if (!declaration?.initializer || !isConst(declaration)) return undefined;
  const initializer = unwrap(declaration.initializer);
  return ts.isStringLiteralLike(initializer)
    ? { value: initializer.text, node: initializer }
    : undefined;
}

// A list of field names written literally: `'id,name'`, `['id', 'name'].join(',')`, a `const`
// holding either, or the business SDK's `[Campaign.Fields.name]`.
function literalList(expression: ts.Expression, depth = 0): string[] | undefined {
  const node = unwrap(expression);
  if (ts.isStringLiteralLike(node)) return splitFields(decode(node.text));
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'join' &&
    node.arguments.length <= 1 &&
    (!node.arguments[0] || constantString(node.arguments[0])?.value === ',')
  )
    return literalList(node.expression.expression, depth);
  if (ts.isArrayLiteralExpression(node)) {
    const items = node.elements.map((element) =>
      ts.isSpreadElement(element) ? undefined : sdkFieldName(element),
    );
    return items.every((item) => item !== undefined) ? (items as string[]) : undefined;
  }
  if (ts.isIdentifier(node) && depth < 2) {
    const value = constantValue(node);
    if (value) return literalList(value, depth + 1);
  }
  return undefined;
}

interface Request {
  parameters: Set<string>;
  values: Map<string, string[] | null>;
  unknown: string[];
}

function emptyRequest(): Request {
  return { parameters: new Set(), values: new Map(), unknown: [] };
}

// Parameters from an object literal (`{ fields: 'id', access_token }`), a `const` holding one,
// `new URLSearchParams({...})` or `JSON.stringify({...})`.
function readParameters(expression: ts.Expression, request: Request, label: string, depth = 0) {
  const node = unwrap(expression);
  if (node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.UndefinedKeyword)
    return;
  if (
    (ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'URLSearchParams') ||
    (ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.getText() === 'JSON.stringify')
  ) {
    const [argument] = node.arguments ?? [];
    if (argument) readParameters(argument, request, label, depth);
    return;
  }
  if (ts.isIdentifier(node) && depth < 2) {
    const value = constantValue(node);
    if (value) return readParameters(value, request, label, depth + 1);
  }
  if (!ts.isObjectLiteralExpression(node)) {
    request.unknown.push(runtimeValue(node, label));
    return;
  }
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) {
      request.unknown.push(`${label} spread \`${expressionName(property.expression)}\``);
      continue;
    }
    const name = propertyName(property.name);
    if (name === undefined) {
      request.unknown.push(`${label} include a computed name`);
      continue;
    }
    request.parameters.add(name);
    if (name === 'fields' || name === 'metric')
      request.values.set(
        name,
        ts.isPropertyAssignment(property) ? (literalList(property.initializer) ?? null) : null,
      );
  }
}

// Query parameters written in the URL after `?`.
function readQuery(parts: Part[], request: Request) {
  let buffer = '';
  const flush = (pair: string, runtime: boolean) => {
    if (!pair) return;
    const separator = pair.indexOf('=');
    const name = decode(separator < 0 ? pair : pair.slice(0, separator)).trim();
    if (!name) return;
    request.parameters.add(name);
    if (name === 'fields' || name === 'metric')
      request.values.set(
        name,
        runtime ? null : splitFields(decode(separator < 0 ? '' : pair.slice(separator + 1))),
      );
  };
  let runtime = false;
  for (const part of parts) {
    if ('expression' in part) {
      // A substitution where a parameter name would start holds a whole query.
      if (!buffer || buffer.endsWith('&')) {
        readParameters(part.expression, request, 'query parameters');
        continue;
      }
      if (!buffer.includes('=')) request.unknown.push('a query parameter name is built at runtime');
      buffer += '\u0000';
      runtime = true;
      continue;
    }
    for (const character of part.text) {
      if (character === '&') {
        flush(buffer, runtime);
        buffer = '';
        runtime = false;
      } else buffer += character;
    }
  }
  flush(buffer, runtime);
}

interface ParsedUrl {
  version: string | null;
  versionSource: GraphCall['versionSource'];
  pin: ts.Node | null;
  path: string | null;
  edge: string | null;
  // A URL that ends at the host or version, used as a base for other URLs.
  base: boolean;
  query: Part[];
  unknown: string[];
}

// Splits a Graph URL into version, path and query. `parts` start with the URL's host.
function parseUrl(parts: Part[], pinNode: ts.Node, fromConstant: boolean): ParsedUrl {
  const first = parts[0] as { text: string; node: ts.Node };
  const unknown: string[] = [];
  const rest: Part[] = [
    { text: first.text.replace(HOST, ''), node: first.node },
    ...parts.slice(1),
  ];
  // Split into path segments and the query, keeping runtime pieces in place.
  const segments: Part[][] = [];
  let current: Part[] = [];
  let query: Part[] | undefined;
  for (const part of rest) {
    if (query) {
      query.push(part);
      continue;
    }
    if ('expression' in part) {
      current.push(part);
      continue;
    }
    const cut = part.text.search(/[?#]/);
    const pathText = cut < 0 ? part.text : part.text.slice(0, cut);
    const pieces = pathText.split('/');
    pieces.forEach((piece, index) => {
      if (index > 0) {
        segments.push(current);
        current = [];
      }
      // A template split over lines carries its line breaks; whitespace is not part of a path.
      if (piece.trim()) current.push({ text: piece.trim(), node: part.node });
    });
    if (cut >= 0) {
      query = part.text[cut] === '?' ? [{ text: part.text.slice(cut + 1), node: part.node }] : [];
    }
  }
  segments.push(current);
  // The text before the first `/` is the host's remainder (empty), so drop it.
  const pathSegments = segments.slice(1).filter((segment) => segment.length);
  let version: string | null = null;
  let versionSource: ParsedUrl['versionSource'] = 'unversioned';
  let pin: ts.Node | null = null;
  let pathUnknown = false;
  const head = pathSegments[0];
  if (head?.length && 'text' in head[0] && VERSION.test(head[0].text)) {
    version = head[0].text;
    versionSource = fromConstant ? 'constant' : 'url';
    pin = pinNode;
    pathSegments.shift();
    // `${GRAPH_BASE}${path}`: the path starts right after the version.
    const tail = head[1];
    if (tail) {
      unknown.push(
        `path is built at runtime from \`${'expression' in tail ? expressionName(tail.expression) : tail.text}\``,
      );
      pathUnknown = true;
    }
  } else if (head?.length === 1 && 'expression' in head[0]) {
    const constant = constantString(head[0].expression);
    if (constant && VERSION.test(constant.value)) {
      version = constant.value;
      versionSource = 'constant';
      pin = constant.node;
      pathSegments.shift();
    } else if (!constant && !PATH_NAME.test(expressionName(head[0].expression))) {
      // `${apiVersion}/...` chooses the version at runtime. `${pageId}/feed` on an unversioned URL
      // looks the same, so without a name that says version, the path is unknown too.
      const name = expressionName(head[0].expression);
      versionSource = 'unknown';
      pathSegments.shift();
      if (/version/i.test(name)) unknown.push(`version is built at runtime from \`${name}\``);
      else {
        unknown.push(
          `the segment after the host comes from \`${name}\` at runtime; it may be the version or a node`,
        );
        pathUnknown = true;
      }
    }
  }
  const base = pathSegments.length === 0 && !query && !pathUnknown;
  let path: string | null = pathUnknown ? null : '';
  let edge: string | null = null;
  for (const [index, segment] of pathSegments.entries()) {
    if (path === null) break;
    const last = index === pathSegments.length - 1;
    const runtime = segment.flatMap((part) => ('expression' in part ? [part.expression] : []));
    // A whole segment from a runtime value: the first is a node ID, unless it is named like a
    // path; a later one is an edge or more of the path, so the rest is unknown.
    if (segment.length === 1 && runtime.length === 1) {
      const name = expressionName(runtime[0]);
      if (index > 0 || PATH_NAME.test(name)) {
        unknown.push(
          index > 0
            ? `edge is built at runtime from \`${name}\``
            : `path is built at runtime from \`${name}\``,
        );
        path = null;
        break;
      }
    }
    const written = segment
      .map((part) => ('text' in part ? part.text : `{${expressionName(part.expression)}}`))
      .join('');
    path += `/${written}`;
    if (last && index > 0) {
      if (runtime.length) unknown.push(`edge \`${written}\` is built at runtime`);
      else edge = written;
    }
  }
  if (!pathSegments.length && !base && path !== null) path = '/';
  return { version, versionSource, pin, path, edge, base, query: query ?? [], unknown };
}

// The name of a `let` or `var` that is assigned again after its declaration.
function reassignedName(declaration: ts.VariableDeclaration) {
  if (!ts.isIdentifier(declaration.name) || isConst(declaration)) return undefined;
  const name = declaration.name.text;
  const scope = ts.findAncestor(declaration, (item) => ts.isBlock(item) || ts.isSourceFile(item));
  let found = false;
  const visit = (child: ts.Node) => {
    if (found) return;
    if (
      ts.isBinaryExpression(child) &&
      child.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      child.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(child.left) &&
      child.left.text === name &&
      findDeclaration(name, child.left) === declaration
    )
      found = true;
    ts.forEachChild(child, visit);
  };
  if (scope) visit(scope);
  return found ? name : undefined;
}

// Whether a variable holding a URL is extended into a longer URL, as in `url + '?' + params`.
function extendedElsewhere(declaration: ts.VariableDeclaration) {
  if (!ts.isIdentifier(declaration.name)) return false;
  const name = declaration.name.text;
  const scope = ts.findAncestor(declaration, (item) => ts.isBlock(item) || ts.isSourceFile(item));
  let found = false;
  const visit = (child: ts.Node) => {
    if (found) return;
    if (
      ts.isIdentifier(child) &&
      child.text === name &&
      child !== declaration.name &&
      (ts.isTemplateSpan(child.parent) ||
        (ts.isBinaryExpression(child.parent) &&
          child.parent.operatorToken.kind === ts.SyntaxKind.PlusToken)) &&
      findDeclaration(name, child) === declaration
    )
      found = true;
    ts.forEachChild(child, visit);
  };
  if (scope) visit(scope);
  return found;
}

// How a Graph URL reaches a request: the calls it is passed to, directly or through a variable.
function consumers(node: ts.Expression): { call: ts.CallExpression; argument: number }[] {
  let current: ts.Node = node;
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent))
  )
    current = current.parent;
  const parent = current.parent;
  if (ts.isCallExpression(parent)) {
    const argument = parent.arguments.indexOf(current as ts.Expression);
    return argument >= 0 ? [{ call: parent, argument }] : [];
  }
  // `axios({ url, method })`.
  if (ts.isPropertyAssignment(parent) && propertyName(parent.name) === 'url') {
    const object = parent.parent;
    if (ts.isCallExpression(object.parent) && object.parent.arguments[0] === object)
      return [{ call: object.parent, argument: -1 }];
    return [];
  }
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    const name = parent.name.text;
    const scope = ts.findAncestor(parent, (item) => ts.isBlock(item) || ts.isSourceFile(item));
    const found: { call: ts.CallExpression; argument: number }[] = [];
    const visit = (child: ts.Node) => {
      if (
        ts.isIdentifier(child) &&
        child.text === name &&
        child !== parent.name &&
        findDeclaration(name, child) === parent
      ) {
        if (ts.isShorthandPropertyAssignment(child.parent) && name === 'url') {
          const object = child.parent.parent;
          if (ts.isCallExpression(object.parent) && object.parent.arguments[0] === object)
            found.push({ call: object.parent, argument: -1 });
        } else if (ts.isCallExpression(child.parent)) {
          const argument = child.parent.arguments.indexOf(child);
          if (argument >= 0) found.push({ call: child.parent, argument });
        }
      }
      ts.forEachChild(child, visit);
    };
    if (scope) visit(scope);
    return found;
  }
  return [];
}

function calleeText(call: ts.CallExpression) {
  return call.expression.getText().replace(/\s+/g, '');
}

function httpMethod(value: string | undefined): GraphCall['method'] {
  const method = value?.toUpperCase();
  return method === 'GET' ||
    method === 'POST' ||
    method === 'DELETE' ||
    method === 'PUT' ||
    method === 'PATCH'
    ? method
    : null;
}

function objectProperty(object: ts.ObjectLiteralExpression, name: string) {
  for (const property of object.properties)
    if (propertyName(property.name) === name) {
      if (ts.isPropertyAssignment(property)) return property.initializer;
      if (ts.isShorthandPropertyAssignment(property)) return property.name;
    }
  return undefined;
}

// Reads the method and request options of a call a Graph URL is passed to.
function readCall(
  call: ts.CallExpression,
  argument: number,
  request: Request,
): { client: string; method: GraphCall['method']; helper: boolean } {
  const client = calleeText(call);
  const name = ts.isPropertyAccessExpression(call.expression)
    ? call.expression.name.text
    : ts.isIdentifier(call.expression)
      ? call.expression.text
      : '';
  const receiver = ts.isPropertyAccessExpression(call.expression)
    ? call.expression.expression.getText()
    : '';
  const options = (index: number) => call.arguments[index];
  const readOptions = (expression: ts.Expression | undefined, label: string) => {
    if (!expression) return undefined;
    const node = unwrap(expression);
    const value = ts.isIdentifier(node) ? constantValue(node) : node;
    const object = value && unwrap(value);
    if (!object || !ts.isObjectLiteralExpression(object)) {
      request.unknown.push(runtimeValue(node, label));
      return undefined;
    }
    for (const property of object.properties)
      if (ts.isSpreadAssignment(property))
        request.unknown.push(`${label} spread \`${expressionName(property.expression)}\``);
    for (const key of ['params', 'searchParams', 'query']) {
      const value = objectProperty(object, key);
      if (value) readParameters(value, request, 'query parameters');
    }
    for (const key of ['data', 'json', 'body', 'form']) {
      const value = objectProperty(object, key);
      if (value) readParameters(value, request, 'body parameters');
    }
    const method = objectProperty(object, 'method');
    return method ? (constantString(method)?.value ?? '?') : undefined;
  };
  // fetch(url, init) and wrappers named fetch, such as `ctx.fetch`.
  if (name === 'fetch' || name === '$fetch' || name === 'ofetch') {
    if (argument !== 0) return { client, method: null, helper: true };
    const method = readOptions(options(1), 'request options');
    if (method === '?') request.unknown.push('HTTP method is chosen at runtime');
    return { client, method: method === undefined ? 'GET' : httpMethod(method), helper: false };
  }
  // axios.get(url, config), axios.post(url, data, config), and the same on axios instances.
  if (
    AXIOS_METHODS.has(name) &&
    /axios|http|client|api|instance/i.test(receiver) &&
    argument === 0
  ) {
    if (BODY_METHODS.has(name)) {
      if (options(1)) readParameters(options(1)!, request, 'body parameters');
      readOptions(options(2), 'request options');
    } else readOptions(options(1), 'request options');
    return { client, method: httpMethod(name), helper: false };
  }
  // axios(url, config) and axios({ url, method, params, data }).
  if (name === 'axios' || (name === 'request' && /axios/i.test(receiver))) {
    const method = readOptions(argument === -1 ? options(0) : options(1), 'request options');
    if (method === '?') request.unknown.push('HTTP method is chosen at runtime');
    return { client, method: method === undefined ? 'GET' : httpMethod(method), helper: false };
  }
  return { client, method: null, helper: true };
}

// Graph URL bases: string constants that hold `https://graph.facebook.com[/vNN.N]` and nothing
// else, by file and exported name, so `${GRAPH_BASE}/me/accounts` in another file can be read.
interface Base {
  file: string;
  name: string;
  node: ts.StringLiteralLike;
  declaration: ts.VariableDeclaration;
}

function sourceOf(path: string, content: string) {
  return ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
}

function graphString(node: ts.Node): node is ts.StringLiteralLike {
  return ts.isStringLiteralLike(node) && HOST.test(node.text);
}

// Resolves a relative import to a scanned file: `./meta-graph`, `./meta-graph.js` for a `.ts`
// source, or a directory index.
function resolveImport(from: string, specifier: string, files: Set<string>) {
  if (!specifier.startsWith('.')) return undefined;
  const target = posix.normalize(posix.join(posix.dirname(from), specifier));
  const stem = target.replace(/\.(?:[cm]?js|jsx)$/, '');
  const candidates = [target, stem].flatMap((item) => [
    item,
    ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'].map(
      (extension) => `${item}${extension}`,
    ),
    ...['ts', 'tsx', 'js', 'jsx'].map((extension) => `${item}/index.${extension}`),
  ]);
  return candidates.find((candidate) => files.has(candidate));
}

// Local names bound by imports of another module's export: `import { GRAPH_BASE as B }` and
// `const { GRAPH_BASE } = require('./graph')`.
function importedNames(source: ts.SourceFile) {
  const names = new Map<string, { specifier: string; name: string }>();
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings)
    )
      for (const element of statement.importClause.namedBindings.elements)
        names.set(element.name.text, {
          specifier: statement.moduleSpecifier.text,
          name: (element.propertyName ?? element.name).text,
        });
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) {
        const required = declaration.initializer && requiredModule(declaration.initializer);
        if (required && ts.isObjectBindingPattern(declaration.name))
          for (const element of declaration.name.elements)
            if (ts.isIdentifier(element.name))
              names.set(element.name.text, {
                specifier: required,
                name: propertyName(element.propertyName) ?? element.name.text,
              });
      }
  }
  return names;
}

function requiredModule(expression: ts.Expression) {
  const node = unwrap(expression);
  return ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'require' &&
    node.arguments.length === 1 &&
    ts.isStringLiteral(node.arguments[0])
    ? node.arguments[0].text
    : undefined;
}

function exported(declaration: ts.VariableDeclaration) {
  const statement = declaration.parent.parent;
  return (
    ts.isVariableStatement(statement) &&
    (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
      false)
  );
}

interface FileContext {
  path: string;
  source: ts.SourceFile;
  use: GraphCall['use'];
}

// Lists every Graph API request a repository makes, with what is known about it.
export async function scanGraphCalls(
  directory: string,
  options: { repository?: Repository; edges?: SdkEdges } = {},
): Promise<GraphCallScan> {
  const repository = options.repository ?? (await readRepository(resolve(directory), META_SDK));
  const edges = options.edges ?? (await loadSdkEdges());
  const files = new Set(repository.files.map((file) => file.path));
  const contexts = new Map<string, FileContext>();
  const context = (path: string, content: string) => {
    let found = contexts.get(path);
    if (!found) {
      found = {
        path,
        source: sourceOf(path, content),
        use: TEST_PATH.test(path) ? 'test' : 'live',
      };
      contexts.set(path, found);
    }
    return found;
  };
  // Exported Graph base constants per file.
  const exportedBases = new Map<string, Map<string, Base>>();
  for (const file of repository.files) {
    if (!file.content.includes('graph.facebook.com')) continue;
    const { source } = context(file.path, file.content);
    for (const statement of source.statements)
      if (ts.isVariableStatement(statement))
        for (const declaration of statement.declarationList.declarations)
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.initializer &&
            graphString(unwrap(declaration.initializer)) &&
            exported(declaration)
          ) {
            const bases = exportedBases.get(file.path) ?? new Map<string, Base>();
            exportedBases.set(file.path, bases);
            bases.set(declaration.name.text, {
              file: file.path,
              name: declaration.name.text,
              node: unwrap(declaration.initializer) as ts.StringLiteralLike,
              declaration,
            });
          }
  }
  // Imports of those bases per file, and the declarations some file imports, which are reported
  // through the importer's requests rather than as URLs with no request.
  const importsByFile = new Map<string, Map<string, Base>>();
  const imported = new Set<ts.VariableDeclaration>();
  if (exportedBases.size)
    for (const file of repository.files) {
      if (!/import|require/.test(file.content)) continue;
      const { source } = context(file.path, file.content);
      for (const [local, binding] of importedNames(source)) {
        const target = resolveImport(file.path, binding.specifier, files);
        const base = target && exportedBases.get(target)?.get(binding.name);
        if (!base) continue;
        const imports = importsByFile.get(file.path) ?? new Map<string, Base>();
        importsByFile.set(file.path, imports);
        imports.set(local, base);
        imported.add(base.declaration);
      }
    }
  const calls: GraphCall[] = [];
  const sdk = await sdkDeclaration(repository);
  for (const file of repository.files) {
    const imports = importsByFile.get(file.path) ?? new Map<string, Base>();
    const graphFile = file.content.includes('graph.facebook.com');
    const sdkFile = file.content.includes(META_SDK);
    if (!graphFile && !imports.size && !sdkFile) continue;
    const current = context(file.path, file.content);
    if (graphFile || imports.size) calls.push(...urlCalls(current, imports, contexts, imported));
    if (sdkFile) calls.push(...sdkCalls(current, edges, sdk));
  }
  calls.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { calls, sdk, warnings: repository.warnings };
}

// The SDK release a repository declares, and the Graph API version it targets: release 20.x
// calls v20.0. A locked version wins over the declared range.
async function sdkDeclaration(repository: Repository): Promise<GraphCallScan['sdk']> {
  const [dependency] = repository.dependencies;
  if (!dependency) return null;
  const file =
    dependency.lock.version && dependency.lock.file ? dependency.lock.file : dependency.file;
  return {
    version: metaSdkVersion(dependency.version, dependency.lock.version) ?? null,
    declared: dependency.version,
    locked: dependency.lock.version,
    file,
    line: await sdkPinLine(repository.root, file),
  };
}

interface GraphUrl {
  parts: Part[];
  pin: ts.Node;
  pinFile: string;
  // True when the version comes from a constant that holds only the host and version.
  fromConstant: boolean;
}

// The Graph URL an expression builds: a literal that starts with the host, or one that starts with
// a constant holding a Graph URL, such as `${GRAPH_BASE}/me/accounts` or `url + '?' + params`.
// Constants are followed through `const API_BASE = GRAPH_BASE` and through imports of exported
// bases.
function graphUrl(
  expression: ts.Expression,
  imports: Map<string, Base>,
  file: string,
  depth = 0,
): GraphUrl | undefined {
  const parts = partsOf(expression);
  const [first, ...rest] = parts;
  if (!first || depth > 3) return undefined;
  if ('text' in first)
    return HOST.test(first.text)
      ? { parts, pin: first.node, pinFile: file, fromConstant: false }
      : undefined;
  const node = unwrap(first.expression);
  if (!ts.isIdentifier(node)) return undefined;
  const declaration = findDeclaration(node.text, node);
  let inner: GraphUrl | undefined;
  if (declaration?.initializer && isConst(declaration))
    inner = graphUrl(declaration.initializer, imports, file, depth + 1);
  else if (!declaration && imports.has(node.text)) {
    const base = imports.get(node.text)!;
    inner = {
      parts: [{ text: base.node.text, node: base.node }],
      pin: base.node,
      pinFile: base.file,
      fromConstant: false,
    };
  }
  if (!inner) return undefined;
  const constantBase = inner.parts.length === 1 && 'text' in inner.parts[0];
  return {
    parts: [...inner.parts, ...rest],
    pin: inner.pin,
    pinFile: inner.pinFile,
    fromConstant: inner.fromConstant || constantBase,
  };
}

function urlCalls(
  file: FileContext,
  imports: Map<string, Base>,
  contexts: Map<string, FileContext>,
  imported: Set<ts.VariableDeclaration>,
): GraphCall[] {
  const { source } = file;
  const calls: GraphCall[] = [];
  // URL expressions: the outermost template, string or concatenation that starts with a Graph
  // host or a Graph base constant.
  const visit = (node: ts.Node) => {
    if (ts.isExpression(node) && isUrlRoot(node)) {
      const url = graphUrl(node, imports, file.path);
      if (url) {
        calls.push(...urlRecord(file, node, url, contexts, imported));
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

// The outermost node of a URL expression: not itself a piece of a larger template or concatenation.
function isUrlRoot(node: ts.Node) {
  if (!(
    ts.isStringLiteralLike(node) ||
    ts.isTemplateExpression(node) ||
    (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
  ))
    return false;
  const parent = node.parent;
  return !(ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken);
}

function urlRecord(
  file: FileContext,
  node: ts.Expression,
  url: GraphUrl,
  contexts: Map<string, FileContext>,
  imported: Set<ts.VariableDeclaration>,
): GraphCall[] {
  const parsed = parseUrl(url.parts, url.pin, url.fromConstant);
  const pinSource = contexts.get(url.pinFile)?.source ?? file.source;
  const pin = parsed.pin ? { file: url.pinFile, line: lineOf(pinSource, parsed.pin) } : null;
  const found = consumers(node);
  // A URL held in a variable that builds longer URLs is reported through those, and an
  // unversioned base says nothing about a version. A versioned base the code passes to a function
  // is a pin whose requests are not traced.
  const declaration = ts.isVariableDeclaration(node.parent) ? node.parent : undefined;
  if (
    !found.length &&
    declaration &&
    (parsed.base || imported.has(declaration) || extendedElsewhere(declaration))
  )
    return [];
  if (parsed.base && !parsed.version) return [];
  const reassigned = declaration && reassignedName(declaration);
  const records = (found.length ? found : [undefined]).map((consumer) => {
    const request = emptyRequest();
    readQuery(parsed.query, request);
    const unknown = [...parsed.unknown];
    let client: string | null = null;
    let method: GraphCall['method'] = null;
    let anchor: ts.Node = node;
    let helper = false;
    if (consumer && parsed.base)
      unknown.push(
        `the base URL is passed to \`${calleeText(consumer.call)}\`; requests built from it are not traced`,
      );
    else if (consumer) {
      const read = readCall(consumer.call, consumer.argument, request);
      client = read.client;
      method = read.method;
      helper = read.helper;
      anchor = consumer.call;
      if (helper) unknown.push(`request options passed to \`${client}\` are not read`);
      if (!method && helper) unknown.push(`HTTP method of helper \`${client}\` is not known`);
    } else unknown.push('no request call was traced for this URL');
    unknown.push(...request.unknown);
    // A `let` that is assigned again may hold another URL by the time of the request, such as the
    // next page's link.
    if (reassigned)
      unknown.push(`\`${reassigned}\` is reassigned, so the request may use another URL`);
    const optionsKnown =
      consumer !== undefined && !parsed.base && !helper && !reassigned && !request.unknown.length;
    const valueOf = (name: string) => {
      if (reassigned) return null;
      if (request.values.has(name)) {
        const value = request.values.get(name)!;
        if (value === null) unknown.push(`\`${name}\` is built at runtime`);
        return value;
      }
      // A parameter the request never names is known to be absent only when every option is read.
      return optionsKnown && !parsed.base ? [] : null;
    };
    const fields = valueOf('fields');
    const metrics = valueOf('metric');
    return {
      kind: 'url' as const,
      file: file.path,
      line: lineOf(file.source, anchor),
      use: file.use,
      client,
      method,
      version: parsed.version,
      versionSource: parsed.versionSource,
      pin,
      path: parsed.base || reassigned ? null : parsed.path,
      edge: parsed.base || reassigned ? null : parsed.edge,
      fields,
      metrics,
      parameters: optionsKnown ? [...request.parameters].sort() : null,
      unknown: [...new Set(unknown)],
      text: excerpt(file.source, anchor),
    };
  });
  return records;
}

// Calls on facebook-nodejs-business-sdk resource objects: `new AdAccount(id).getCampaigns(fields)`
// or a variable holding `new AdAccount(id)`.
function sdkCalls(file: FileContext, edges: SdkEdges, sdk: GraphCallScan['sdk']): GraphCall[] {
  const { source } = file;
  // Local name -> SDK class: named imports, `bizSdk.AdAccount`, destructured requires.
  const classes = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === META_SDK &&
      statement.importClause
    ) {
      const clause = statement.importClause;
      if (clause.name) namespaces.add(clause.name.text);
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))
        namespaces.add(clause.namedBindings.name.text);
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings))
        for (const element of clause.namedBindings.elements) {
          const name = (element.propertyName ?? element.name).text;
          if (edges.classes.has(name)) classes.set(element.name.text, name);
        }
    }
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) {
        if (!declaration.initializer) continue;
        if (requiredModule(declaration.initializer) === META_SDK) {
          if (ts.isIdentifier(declaration.name)) namespaces.add(declaration.name.text);
          if (ts.isObjectBindingPattern(declaration.name))
            for (const element of declaration.name.elements) {
              const name = propertyName(element.propertyName) ?? propertyName(element.name);
              if (name && edges.classes.has(name) && ts.isIdentifier(element.name))
                classes.set(element.name.text, name);
            }
        }
      }
  }
  // `const AdAccount = bizSdk.AdAccount` and `const { AdAccount } = bizSdk`.
  for (const statement of source.statements)
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer && unwrap(declaration.initializer);
        if (!initializer) continue;
        if (
          ts.isPropertyAccessExpression(initializer) &&
          ts.isIdentifier(initializer.expression) &&
          namespaces.has(initializer.expression.text) &&
          edges.classes.has(initializer.name.text) &&
          ts.isIdentifier(declaration.name)
        )
          classes.set(declaration.name.text, initializer.name.text);
        if (
          ts.isIdentifier(initializer) &&
          namespaces.has(initializer.text) &&
          ts.isObjectBindingPattern(declaration.name)
        )
          for (const element of declaration.name.elements) {
            const name = propertyName(element.propertyName) ?? propertyName(element.name);
            if (name && edges.classes.has(name) && ts.isIdentifier(element.name))
              classes.set(element.name.text, name);
          }
      }
  const classOf = (expression: ts.Expression): string | undefined => {
    const node = unwrap(expression);
    if (ts.isIdentifier(node)) return classes.get(node.text);
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text) &&
      edges.classes.has(node.name.text)
    )
      return node.name.text;
    return undefined;
  };
  // The SDK class of an object expression: `new AdAccount(id)` or a variable holding one.
  const objectClass = (expression: ts.Expression): string | undefined => {
    const node = unwrap(expression);
    if (ts.isNewExpression(node)) return classOf(node.expression);
    if (ts.isIdentifier(node)) {
      const declaration = findDeclaration(node.text, node);
      const initializer = declaration?.initializer && unwrap(declaration.initializer);
      if (initializer && ts.isNewExpression(initializer)) return classOf(initializer.expression);
    }
    return undefined;
  };
  if (!classes.size && !namespaces.size) return [];
  const calls: GraphCall[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const className = objectClass(node.expression.expression);
      const method = node.expression.name.text;
      const record = className && sdkRecord(file, node, className, method, edges, sdk);
      if (record) calls.push(record);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

function sdkRecord(
  file: FileContext,
  call: ts.CallExpression,
  className: string,
  method: string,
  edges: SdkEdges,
  sdk: GraphCallScan['sdk'],
): GraphCall | undefined {
  const unknown: string[] = [];
  let http: GraphCall['method'];
  let edge: string | null = null;
  let path: string | null;
  const node = `{${className}}`;
  if (method === 'get' || method === 'read') {
    http = 'GET';
    path = `/${node}`;
  } else if (method === 'update') {
    http = 'POST';
    path = `/${node}`;
  } else if (method === 'delete') {
    http = 'DELETE';
    path = `/${node}`;
  } else {
    const entry = edges.methods.get(method);
    if (!entry) return undefined;
    http = httpMethod(entry.http ?? undefined);
    edge = entry.edge ?? entry.byClass?.[className] ?? null;
    if (!edge) {
      unknown.push(
        `${className}.${method} has no edge in SDK ${edges.version}'s generated classes`,
      );
      path = null;
    } else path = `/${node}/${edge}`;
  }
  // Fields come first for reads and edge calls; `delete` and `update` take parameters only.
  const fieldsArgument = method === 'delete' || method === 'update' ? undefined : call.arguments[0];
  const parametersArgument =
    method === 'delete' || method === 'update' ? call.arguments[0] : call.arguments[1];
  let fields: string[] | null = [];
  if (fieldsArgument) {
    fields = literalList(fieldsArgument) ?? null;
    if (!fields) unknown.push(`fields come from \`${expressionName(fieldsArgument)}\` at runtime`);
  }
  const request = emptyRequest();
  if (parametersArgument) readParameters(parametersArgument, request, 'parameters');
  unknown.push(...request.unknown);
  const metric = request.values.get('metric');
  if (!sdk?.version) unknown.push(`no ${META_SDK} version is declared in a manifest`);
  return {
    kind: 'sdk',
    file: file.path,
    line: lineOf(file.source, call),
    use: file.use,
    client: `${className}.${method}`,
    method: http,
    version: sdk?.version ?? null,
    versionSource: sdk?.version ? 'sdk-package' : 'unknown',
    pin: sdk?.version ? { file: sdk.file, line: sdk.line } : null,
    path,
    edge,
    fields,
    metrics: metric === undefined ? (request.unknown.length ? null : []) : metric,
    parameters: request.unknown.length ? null : [...request.parameters].sort(),
    unknown,
    text: excerpt(file.source, call),
  };
}

// The 1-based line naming the SDK in a manifest or lockfile.
async function sdkPinLine(root: string, file: string) {
  try {
    const lines = (await readFile(join(root, file), 'utf8')).split('\n');
    return Math.max(
      1,
      lines.findIndex((line) => line.includes(`"${META_SDK}"`) || line.includes(`${META_SDK}@`)) +
        1,
    );
  } catch {
    return 1;
  }
}
