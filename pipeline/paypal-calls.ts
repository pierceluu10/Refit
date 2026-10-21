import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript-compiler';
import { TEST_PATH } from './deadline-exposure.ts';
import {
  calleeText,
  consumers,
  constantString,
  excerpt,
  exported,
  expressionName,
  extendedElsewhere,
  findDeclaration,
  httpMethod,
  importedNames,
  isConst,
  isUrlRoot,
  lineOf,
  objectProperty,
  partsOf,
  propertyName,
  reassignedName,
  requiredModule,
  resolveImport,
  sourceOf,
  unwrap,
  type Part,
} from './meta-graph-calls.ts';
import { readRepository } from './repository.ts';
import { isObject, parseObject } from './specifications.ts';
import type { Repository } from './types.ts';

// PayPal REST requests a repository makes, read from source without running it: request classes of
// the deprecated @paypal/checkout-server-sdk, controller calls of @paypal/paypal-server-sdk, and
// raw HTTP calls to PayPal's REST hosts. Each request is matched to PayPal's published OpenAPI
// documents. Every value is read from literal code or reported as unknown with the reason.

export const PAYPAL_REQUESTS = new URL('../data/paypal-requests.json', import.meta.url);
export const PAYPAL_CHECKOUT_SDK = '@paypal/checkout-server-sdk';
export const PAYPAL_SERVER_SDK = '@paypal/paypal-server-sdk';
// api-m.* is what @paypal/paypal-server-sdk and the published OpenAPI documents name; api.* is
// what @paypal/checkout-server-sdk 1.0.3 calls (lib/core/paypal_environment.js).
const HOST = /^(?:https?:)?\/\/(api(?:-m)?(?:\.sandbox)?\.paypal\.com)(?=[/?#]|$)/;
const AXIOS_METHODS = new Set(['get', 'delete', 'head', 'options', 'post', 'put', 'patch']);
// A whole-segment substitution with one of these names may hold several path segments.
const PATH_NAME = /path|endpoint|url|route|uri/i;

type Method = 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';

export interface PayPalCall {
  kind: 'checkout-sdk' | 'server-sdk' | 'url';
  // Where the request is made: the request class, the controller call or the HTTP call, or the URL
  // itself when no call was traced.
  file: string;
  line: number;
  // `test` for test, spec, story, fixture and example files.
  use: 'live' | 'test';
  // `orders.OrdersCreateRequest` or `OrdersController.createOrder`; null for raw HTTP calls.
  request: string | null;
  // The call that sends it: `client.execute`, `fetch`, `axios.post`, a helper such as
  // `paypalFetch`, or the controller method; null when no call was traced.
  client: string | null;
  method: Method | null;
  // The REST hosts the request can reach, from the URL; [] for SDK calls, whose host is chosen by
  // the SDK's environment.
  hosts: string[];
  // `/v2/checkout/orders/{orderId}/capture`: literal segments as written, runtime ones in braces.
  path: string | null;
  // The matching operation in PayPal's published OpenAPI documents; null when there is none or
  // the path is unknown.
  operation: { document: string; operationId: string | null } | null;
  // Controller methods of the newest recorded @paypal/paypal-server-sdk release that make the same
  // request; null when the path or method is unknown.
  counterpart: string[] | null;
  // Facts for review: missing operations, methods the declared SDK release lacks.
  notes: string[];
  // What could not be read, and why.
  unknown: string[];
  // The source line the request is made on, trimmed.
  text: string;
}

export interface PayPalPackage {
  name: string;
  file: string;
  declared: string;
  locked: string | null;
  // npm's deprecation notice, when PayPal deprecated the package.
  deprecated: string | null;
}

export interface PayPalCallScan {
  calls: PayPalCall[];
  packages: PayPalPackage[];
  specification: { repository: string; commit: string; committedAt: string };
  warnings: string[];
}

interface Endpoint {
  method: Method;
  path: string;
}

export interface PayPalRequests {
  checkedAt: string;
  checkout: {
    version: string;
    deprecated: string | null;
    requests: Map<string, Endpoint>;
  };
  server: {
    releases: string[];
    controllers: Map<string, Map<string, Endpoint & { releases: string[] }>>;
  };
  specification: PayPalCallScan['specification'] & {
    operations: { document: string; method: string; key: string; operationId: string | null }[];
    // Hostnames the documents list as servers.
    hosts: Set<string>;
    // `/v2/checkout` -> the documents with operations under it.
    prefixes: Map<string, string[]>;
  };
}

// `/v2/checkout/orders/{id}` and `/v2/checkout/orders/{order_id}` compare equal.
function pathKey(path: string) {
  return path
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .split('/')
    .map((segment) => (segment.includes('{') ? '{}' : segment))
    .join('/');
}

function prefixOf(path: string) {
  return path.split('/').slice(0, 3).join('/');
}

let requests: Promise<PayPalRequests> | undefined;
export function loadPayPalRequests(path: string | URL = PAYPAL_REQUESTS): Promise<PayPalRequests> {
  const load = async () => {
    const value = parseObject(await readFile(path, 'utf8'), 'PayPal requests');
    const { checkout, server, specification } = value;
    if (
      value.formatVersion !== 1 ||
      !isObject(checkout) ||
      !isObject(checkout.requests) ||
      !isObject(server) ||
      !Array.isArray(server.releases) ||
      !isObject(server.controllers) ||
      !isObject(specification) ||
      !isObject(specification.documents)
    )
      throw new Error(
        'PayPal requests require formatVersion 1, checkout requests, server controllers and a specification.',
      );
    const operations: PayPalRequests['specification']['operations'] = [];
    const prefixes = new Map<string, string[]>();
    const hosts = new Set<string>();
    for (const [document, entry] of Object.entries(specification.documents)) {
      const { operations: listed, servers } = entry as {
        operations: Record<string, string>[];
        servers: string[];
      };
      for (const server of servers) hosts.add(new URL(server).hostname);
      for (const operation of listed) {
        operations.push({
          document,
          method: operation.method,
          key: pathKey(operation.path),
          operationId: operation.operationId ?? null,
        });
        const listed = prefixes.get(prefixOf(operation.path)) ?? [];
        if (!listed.includes(document)) listed.push(document);
        prefixes.set(prefixOf(operation.path), listed);
      }
    }
    return {
      checkedAt: String(value.checkedAt),
      checkout: {
        version: String(checkout.version),
        deprecated: typeof checkout.deprecated === 'string' ? checkout.deprecated : null,
        requests: new Map(
          Object.entries(checkout.requests).flatMap(([area, classes]) =>
            Object.entries(classes as Record<string, Endpoint>).map(([name, endpoint]) => [
              `${area}.${name}`,
              endpoint,
            ]),
          ),
        ),
      },
      server: {
        releases: server.releases.map(String),
        controllers: new Map(
          Object.entries(server.controllers).map(([name, methods]) => [
            name,
            new Map(Object.entries(methods as Record<string, Endpoint & { releases: string[] }>)),
          ]),
        ),
      },
      specification: {
        repository: String(specification.repository),
        commit: String(specification.commit),
        committedAt: String(specification.committedAt),
        operations,
        prefixes,
        hosts,
      },
    };
  };
  if (path !== PAYPAL_REQUESTS) return load();
  requests ??= load();
  return requests;
}

interface Review {
  operation: PayPalCall['operation'];
  counterpart: PayPalCall['counterpart'];
  notes: string[];
}

// Matches a request to the published documents and to the newest SDK release's controllers.
function review(data: PayPalRequests, method: Method | null, path: string | null): Review {
  if (path === null) return { operation: null, counterpart: null, notes: [] };
  const key = pathKey(path);
  const notes: string[] = [];
  const commit = data.specification.commit.slice(0, 7);
  const matches = data.specification.operations.filter(
    (operation) => operation.key === key && (method === null || operation.method === method),
  );
  const operation =
    matches.length === 1
      ? { document: matches[0].document, operationId: matches[0].operationId }
      : null;
  if (!matches.length) {
    const documents = data.specification.prefixes.get(prefixOf(path));
    notes.push(
      documents
        ? `${method ?? 'the request'} ${path} is not in PayPal's published ${documents.join(', ')} (paypal-rest-api-specifications ${commit})`
        : `no published PayPal OpenAPI document covers ${prefixOf(path)} (paypal-rest-api-specifications ${commit})`,
    );
  }
  if (method === null) return { operation, counterpart: null, notes };
  const newest = data.server.releases.at(-1)!;
  const counterpart: string[] = [];
  for (const [controller, methods] of data.server.controllers)
    for (const [name, endpoint] of methods)
      if (
        endpoint.method === method &&
        pathKey(endpoint.path) === key &&
        endpoint.releases.includes(newest)
      )
        counterpart.push(`${controller}.${name}`);
  return { operation, counterpart, notes };
}

interface FileContext {
  path: string;
  source: ts.SourceFile;
  use: PayPalCall['use'];
}

// The enclosing block or file, where a variable's uses are searched.
function scopeOf(node: ts.Node) {
  return ts.findAncestor(node, (item) => ts.isBlock(item) || ts.isSourceFile(item)) ?? node;
}

// Calls a variable is passed to as an argument, after `const request = new …` or
// `request = new …`.
function argumentUses(
  name: string,
  declaration: ts.VariableDeclaration | undefined,
  from: ts.Node,
) {
  const calls: ts.CallExpression[] = [];
  const visit = (child: ts.Node) => {
    if (
      ts.isIdentifier(child) &&
      child.text === name &&
      ts.isCallExpression(child.parent) &&
      child.parent.arguments.includes(child) &&
      findDeclaration(name, child) === declaration
    )
      calls.push(child.parent);
    ts.forEachChild(child, visit);
  };
  visit(declaration ? scopeOf(declaration) : scopeOf(from));
  return calls;
}

function calleeName(call: ts.CallExpression) {
  return ts.isPropertyAccessExpression(call.expression)
    ? call.expression.name.text
    : ts.isIdentifier(call.expression)
      ? call.expression.text
      : '';
}

// Module bindings of an SDK in a file: namespace names (`paypal` in `require(M)`, `import * as`,
// a default import) and named bindings by local name.
function moduleBindings(source: ts.SourceFile, module: string) {
  const namespaces = new Set<string>();
  const named = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === module &&
      node.importClause
    ) {
      const clause = node.importClause;
      if (clause.name) namespaces.add(clause.name.text);
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))
        namespaces.add(clause.namedBindings.name.text);
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings))
        for (const element of clause.namedBindings.elements)
          named.set(element.name.text, (element.propertyName ?? element.name).text);
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression) &&
      node.moduleReference.expression.text === module
    )
      namespaces.add(node.name.text);
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = unwrap(node.initializer);
      // `require(M)` and `require(M).default`.
      const required =
        requiredModule(initializer) ??
        (ts.isPropertyAccessExpression(initializer) && initializer.name.text === 'default'
          ? requiredModule(initializer.expression)
          : undefined);
      if (required === module) {
        if (ts.isIdentifier(node.name)) namespaces.add(node.name.text);
        if (ts.isObjectBindingPattern(node.name))
          for (const element of node.name.elements) {
            const name = propertyName(element.propertyName) ?? propertyName(element.name);
            if (name && ts.isIdentifier(element.name)) named.set(element.name.text, name);
          }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { namespaces, named };
}

// Every `const x = <expression>` and `const { a, b: c } = <expression>` in a file, so names bound
// from a namespace (`const { orders } = paypal`) can be followed.
function aliases(source: ts.SourceFile) {
  const found: { local: string; property: string | null; initializer: ts.Expression }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = unwrap(node.initializer);
      if (ts.isIdentifier(node.name))
        found.push({ local: node.name.text, property: null, initializer });
      if (ts.isObjectBindingPattern(node.name))
        for (const element of node.name.elements) {
          const name = propertyName(element.propertyName) ?? propertyName(element.name);
          if (name && ts.isIdentifier(element.name))
            found.push({ local: element.name.text, property: name, initializer });
        }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// `client.execute(new paypal.orders.OrdersCreateRequest())` and the same through a variable.
function checkoutCalls(file: FileContext, data: PayPalRequests): PayPalCall[] {
  const { source } = file;
  const { namespaces, named } = moduleBindings(source, PAYPAL_CHECKOUT_SDK);
  if (!namespaces.size && !named.size) return [];
  const areaNames = new Set(
    [...data.checkout.requests.keys()].map((request) => request.split('.')[0]),
  );
  // Local name -> area (`orders`) and local name -> `area.Class`.
  const areas = new Map<string, string>();
  const classes = new Map<string, string>();
  for (const [local, name] of named) if (areaNames.has(name)) areas.set(local, name);
  // The area an expression names: `paypal.orders` or a local bound to it.
  const areaOf = (expression: ts.Expression): string | undefined => {
    const node = unwrap(expression);
    if (ts.isIdentifier(node)) return areas.get(node.text);
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text)
    )
      return node.name.text;
    return undefined;
  };
  // Two passes reach `const { orders } = paypal` and then `const { OrdersCreateRequest } = orders`.
  for (let pass = 0; pass < 2; pass += 1)
    for (const alias of aliases(source)) {
      const { initializer, local, property } = alias;
      if (property === null) {
        const area = areaOf(initializer);
        if (area && ts.isPropertyAccessExpression(initializer)) areas.set(local, area);
        else if (ts.isPropertyAccessExpression(initializer)) {
          const owner = areaOf(initializer.expression);
          if (owner) classes.set(local, `${owner}.${initializer.name.text}`);
        }
        continue;
      }
      if (ts.isIdentifier(initializer) && namespaces.has(initializer.text))
        areas.set(local, property);
      else {
        const owner = areaOf(initializer);
        if (owner) classes.set(local, `${owner}.${property}`);
      }
    }
  const requestOf = (expression: ts.Expression): string | undefined => {
    const node = unwrap(expression);
    if (ts.isIdentifier(node)) return classes.get(node.text);
    if (ts.isPropertyAccessExpression(node)) {
      const area = areaOf(node.expression);
      if (area) return `${area}.${node.name.text}`;
    }
    return undefined;
  };
  const calls: PayPalCall[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node)) {
      const request = requestOf(node.expression);
      const endpoint = request ? data.checkout.requests.get(request) : undefined;
      // Environments and the HTTP client are not requests; an unknown `…Request` class is.
      if (request && (endpoint || request.endsWith('Request')))
        calls.push(checkoutRecord(file, node, request, endpoint, data));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

function checkoutRecord(
  file: FileContext,
  node: ts.NewExpression,
  request: string,
  endpoint: Endpoint | undefined,
  data: PayPalRequests,
): PayPalCall {
  const unknown: string[] = [];
  if (!endpoint)
    unknown.push(
      `\`${request}\` is not a request class of ${PAYPAL_CHECKOUT_SDK} ${data.checkout.version}`,
    );
  // The call the request object reaches: passed directly, or through `const request = new …` or
  // `request = new …`.
  let current: ts.Node = node;
  while (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent))
    current = current.parent;
  const parent = current.parent;
  let uses: ts.CallExpression[] = [];
  if (ts.isCallExpression(parent) && parent.arguments.includes(current as ts.Expression))
    uses = [parent];
  else if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name))
    uses = argumentUses(parent.name.text, parent, parent);
  else if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(parent.left)
  )
    uses = argumentUses(parent.left.text, findDeclaration(parent.left.text, parent), parent);
  const executed = uses.filter((call) => calleeName(call) === 'execute');
  const client = executed[0] ? calleeText(executed[0]) : uses[0] ? calleeText(uses[0]) : null;
  if (!uses.length) unknown.push('no `execute` call was traced for this request');
  else if (!executed.length)
    unknown.push(`the request is passed to \`${client}\`; whether it is executed is not traced`);
  const method = endpoint?.method ?? null;
  const path = endpoint?.path ?? null;
  return {
    kind: 'checkout-sdk',
    file: file.path,
    line: lineOf(file.source, node),
    use: file.use,
    request,
    client,
    method,
    hosts: [],
    path,
    ...review(data, method, path),
    unknown,
    text: excerpt(file.source, node),
  };
}

// `new OrdersController(client).createOrder(...)`, a variable or class property holding a
// controller, and namespace forms such as `sdk.OrdersController`.
function serverCalls(
  file: FileContext,
  data: PayPalRequests,
  version: string | null,
): PayPalCall[] {
  const { source } = file;
  const { namespaces, named } = moduleBindings(source, PAYPAL_SERVER_SDK);
  if (!namespaces.size && !named.size) return [];
  const controllerOf = (expression: ts.Expression): string | undefined => {
    const node = unwrap(expression);
    if (ts.isIdentifier(node)) {
      const name = named.get(node.text);
      return name && data.server.controllers.has(name) ? name : undefined;
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text) &&
      data.server.controllers.has(node.name.text)
    )
      return node.name.text;
    return undefined;
  };
  const constructed = (expression: ts.Expression | undefined) => {
    const node = expression && unwrap(expression);
    return node && ts.isNewExpression(node) ? controllerOf(node.expression) : undefined;
  };
  // Controllers held in variables (by declaration) and in class properties (by class and name).
  const variables = new Map<ts.VariableDeclaration, string>();
  const properties = new Map<ts.ClassLikeDeclaration, Map<string, string>>();
  const setProperty = (node: ts.Node, name: string, controller: string) => {
    const owner = ts.findAncestor(node, ts.isClassLike);
    if (!owner) return;
    const map = properties.get(owner) ?? new Map<string, string>();
    properties.set(owner, map);
    map.set(name, controller);
  };
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node)) {
      const controller = constructed(node.initializer);
      if (controller) variables.set(node, controller);
    }
    if (ts.isPropertyDeclaration(node)) {
      const controller = constructed(node.initializer);
      const name = propertyName(node.name);
      if (controller && name) setProperty(node, name, controller);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const controller = constructed(node.right);
      const left = unwrap(node.left);
      if (controller && ts.isIdentifier(left)) {
        const declaration = findDeclaration(left.text, node);
        if (declaration) variables.set(declaration, controller);
      }
      if (
        controller &&
        ts.isPropertyAccessExpression(left) &&
        left.expression.kind === ts.SyntaxKind.ThisKeyword
      )
        setProperty(node, left.name.text, controller);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  const receiverOf = (expression: ts.Expression): string | undefined => {
    const node = unwrap(expression);
    if (ts.isNewExpression(node)) return controllerOf(node.expression);
    if (ts.isIdentifier(node)) {
      const declaration = findDeclaration(node.text, node);
      return declaration ? variables.get(declaration) : undefined;
    }
    if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const owner = ts.findAncestor(node, ts.isClassLike);
      return owner ? properties.get(owner)?.get(node.name.text) : undefined;
    }
    return undefined;
  };
  const calls: PayPalCall[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const controller = receiverOf(node.expression.expression);
      if (controller)
        calls.push(serverRecord(file, node, controller, node.expression.name.text, data, version));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

function serverRecord(
  file: FileContext,
  call: ts.CallExpression,
  controller: string,
  name: string,
  data: PayPalRequests,
  version: string | null,
): PayPalCall {
  const endpoint = data.server.controllers.get(controller)?.get(name);
  const { releases } = data.server;
  const unknown: string[] = [];
  const notes: string[] = [];
  if (!endpoint)
    unknown.push(
      `\`${controller}.${name}\` is not a method in any recorded ${PAYPAL_SERVER_SDK} release (${releases[0]} to ${releases.at(-1)})`,
    );
  else if (!version)
    unknown.push(
      `no locked or exact ${PAYPAL_SERVER_SDK} version, so whether the release defines \`${name}\` is not checked`,
    );
  else if (!releases.includes(version))
    unknown.push(`${PAYPAL_SERVER_SDK} ${version} is not a recorded release`);
  else if (!endpoint.releases.includes(version))
    notes.push(
      `\`${controller}.${name}\` is not in ${PAYPAL_SERVER_SDK} ${version}; it is in ${endpoint.releases[0]} to ${endpoint.releases.at(-1)}`,
    );
  const method = endpoint?.method ?? null;
  const path = endpoint?.path ?? null;
  const reviewed = review(data, method, path);
  if (endpoint && version !== releases.at(-1) && !endpoint.releases.includes(releases.at(-1)!))
    notes.push(
      `\`${name}\` is not in ${PAYPAL_SERVER_SDK} ${releases.at(-1)}${reviewed.counterpart?.length ? `, which makes this request with ${reviewed.counterpart.map((item) => `\`${item}\``).join(', ')}` : ''}`,
    );
  return {
    kind: 'server-sdk',
    file: file.path,
    line: lineOf(file.source, call),
    use: file.use,
    request: `${controller}.${name}`,
    client: `${controller}.${name}`,
    method,
    hosts: [],
    path,
    ...reviewed,
    notes: [...notes, ...reviewed.notes],
    unknown,
    text: excerpt(file.source, call),
  };
}

// A PayPal URL's hosts and the parts after them. A base can be a literal, a `const` holding one,
// a conditional between two (`live ? 'https://api-m.paypal.com' : 'https://api-m.sandbox…'`), or
// an exported base imported from another file.
interface PayPalUrl {
  hosts: string[];
  parts: Part[];
}

interface Base {
  hosts: string[];
  declaration: ts.VariableDeclaration;
}

// A base expression holding only hosts: a host literal, or a conditional whose branches are.
function baseHosts(expression: ts.Expression): string[] | undefined {
  const node = unwrap(expression);
  if (ts.isStringLiteralLike(node)) {
    const match = HOST.exec(node.text);
    return match && node.text.replace(HOST, '').replace(/\/+$/, '') === '' ? [match[1]] : undefined;
  }
  if (ts.isConditionalExpression(node)) {
    const left = baseHosts(node.whenTrue);
    const right = baseHosts(node.whenFalse);
    return left && right ? [...new Set([...left, ...right])] : undefined;
  }
  return undefined;
}

function paypalUrl(
  expression: ts.Expression,
  imports: Map<string, Base>,
  depth = 0,
): PayPalUrl | undefined {
  const parts = partsOf(expression);
  const [first, ...rest] = parts;
  if (!first || depth > 3) return undefined;
  if ('text' in first) {
    const match = HOST.exec(first.text);
    return match
      ? {
          hosts: [match[1]],
          parts: [{ text: first.text.replace(HOST, ''), node: first.node }, ...rest],
        }
      : undefined;
  }
  const node = unwrap(first.expression);
  const conditional = baseHosts(node);
  if (conditional) return { hosts: conditional, parts: rest };
  if (!ts.isIdentifier(node)) return undefined;
  const declaration = findDeclaration(node.text, node);
  if (declaration?.initializer && isConst(declaration)) {
    const inner = paypalUrl(declaration.initializer, imports, depth + 1);
    return inner && { hosts: inner.hosts, parts: [...inner.parts, ...rest] };
  }
  const base = !declaration ? imports.get(node.text) : undefined;
  return base && { hosts: base.hosts, parts: rest };
}

// The path a URL's parts after the host spell, with runtime pieces named in braces.
function urlPath(parts: Part[], unknown: string[]): string | null {
  const segments: Part[][] = [[]];
  for (const part of parts) {
    if ('expression' in part) {
      segments.at(-1)!.push(part);
      continue;
    }
    const cut = part.text.search(/[?#]/);
    const pieces = (cut < 0 ? part.text : part.text.slice(0, cut)).split('/');
    pieces.forEach((piece, index) => {
      if (index > 0) segments.push([]);
      if (piece.trim()) segments.at(-1)!.push({ text: piece.trim(), node: part.node });
    });
    if (cut >= 0) break;
  }
  let path = '';
  for (const [index, segment] of segments.entries()) {
    if (!segment.length) continue;
    const [only] = segment;
    if (segment.length === 1 && 'expression' in only) {
      const name = expressionName(only.expression);
      // `${base}${path}` or `/v2/${resource}`: the rest of the path is chosen at runtime.
      if (index === 0 || PATH_NAME.test(name) || path === '' || /^\/v\d+$/.test(path)) {
        unknown.push(`path is built at runtime from \`${name}\``);
        return null;
      }
    }
    path += `/${segment.map((part) => ('text' in part ? part.text : `{${expressionName(part.expression)}}`)).join('')}`;
  }
  return path || null;
}

// Reads the HTTP method of a call a PayPal URL is passed to.
function requestMethod(call: ts.CallExpression, argument: number, unknown: string[]) {
  const client = calleeText(call);
  const name = calleeName(call);
  const receiver = ts.isPropertyAccessExpression(call.expression)
    ? call.expression.expression.getText()
    : '';
  const optionMethod = (expression: ts.Expression | undefined): Method | null | undefined => {
    const node = expression && unwrap(expression);
    if (!node) return undefined;
    if (!ts.isObjectLiteralExpression(node)) {
      unknown.push(`request options come from \`${expressionName(node)}\` at runtime`);
      return null;
    }
    const method = objectProperty(node, 'method');
    if (!method) return undefined;
    const value = constantString(method)?.value;
    if (value === undefined) unknown.push('HTTP method is chosen at runtime');
    return httpMethod(value);
  };
  if (name === 'fetch' || name === '$fetch' || name === 'ofetch') {
    if (argument !== 0) return { client, method: null, helper: true };
    const method = optionMethod(call.arguments[1]);
    return { client, method: method === undefined ? ('GET' as const) : method, helper: false };
  }
  if (AXIOS_METHODS.has(name) && /axios|http|client|api|instance/i.test(receiver) && argument === 0)
    return { client, method: httpMethod(name), helper: false };
  if (name === 'axios' || (name === 'request' && /axios/i.test(receiver))) {
    const method = optionMethod(argument === -1 ? call.arguments[0] : call.arguments[1]);
    return { client, method: method === undefined ? ('GET' as const) : method, helper: false };
  }
  return { client, method: null, helper: true };
}

function urlCalls(
  file: FileContext,
  imports: Map<string, Base>,
  imported: Set<ts.VariableDeclaration>,
  data: PayPalRequests,
): PayPalCall[] {
  const calls: PayPalCall[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isExpression(node) && isUrlRoot(node)) {
      const url = paypalUrl(node, imports);
      if (url) {
        calls.push(...urlRecords(file, node, url, imported, data));
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file.source);
  return calls;
}

function urlRecords(
  file: FileContext,
  node: ts.Expression,
  url: PayPalUrl,
  imported: Set<ts.VariableDeclaration>,
  data: PayPalRequests,
): PayPalCall[] {
  const pathUnknown: string[] = [];
  const path = urlPath(url.parts, pathUnknown);
  const base = path === null && !pathUnknown.length;
  const found = consumers(node);
  const declaration = ts.isVariableDeclaration(node.parent) ? node.parent : undefined;
  // A base held in a variable is reported through the URLs built from it.
  if (
    declaration &&
    (base || imported.has(declaration) || (!found.length && extendedElsewhere(declaration)))
  )
    return [];
  if (base && !found.length) return [];
  const reassigned = declaration && reassignedName(declaration);
  return (found.length ? found : [undefined]).map((consumer) => {
    const unknown = [...pathUnknown];
    let client: string | null = null;
    let method: Method | null = null;
    let anchor: ts.Node = node;
    if (consumer && base)
      unknown.push(
        `the base URL is passed to \`${calleeText(consumer.call)}\`; requests built from it are not traced`,
      );
    else if (consumer) {
      const read = requestMethod(consumer.call, consumer.argument, unknown);
      client = read.client;
      method = read.method;
      anchor = consumer.call;
      if (read.helper) unknown.push(`HTTP method of helper \`${client}\` is not known`);
    } else unknown.push('no request call was traced for this URL');
    if (reassigned)
      unknown.push(`\`${reassigned}\` is reassigned, so the request may use another URL`);
    const known = base || reassigned ? null : path;
    const reviewed = review(data, method, known);
    const servers = [...data.specification.hosts].sort().join(' and ');
    const unlisted = url.hosts.filter((host) => !data.specification.hosts.has(host));
    if (unlisted.length)
      reviewed.notes.unshift(
        `${unlisted.join(' and ')} ${unlisted.length === 1 ? 'is not a server' : 'are not servers'} in PayPal's published OpenAPI documents, which list ${servers}`,
      );
    return {
      kind: 'url' as const,
      file: file.path,
      line: lineOf(file.source, anchor),
      use: file.use,
      request: null,
      client,
      method,
      hosts: url.hosts,
      path: known,
      ...reviewed,
      unknown: [...new Set(unknown)],
      text: excerpt(file.source, anchor),
    };
  });
}

function hasHost(content: string) {
  return /\/\/api(?:-m)?(?:\.sandbox)?\.paypal\.com/.test(content);
}

// The version an SDK call is checked against: the locked version, or an exact declared one.
function exactVersion(item: PayPalPackage | undefined) {
  if (!item) return null;
  if (item.locked) return item.locked;
  return /^\d+\.\d+\.\d+$/.test(item.declared) ? item.declared : null;
}

// Lists every PayPal REST request a repository makes, with what is known about it.
export async function scanPayPalCalls(
  directory: string,
  options: { data?: PayPalRequests } = {},
): Promise<PayPalCallScan> {
  const data = options.data ?? (await loadPayPalRequests());
  const root = resolve(directory);
  // One read per package, as `refit agents` does; the files are the same in both.
  const checkoutRepository = await readRepository(root, PAYPAL_CHECKOUT_SDK);
  const serverRepository = await readRepository(root, PAYPAL_SERVER_SDK);
  const packages: PayPalPackage[] = [
    ...declarations(checkoutRepository, PAYPAL_CHECKOUT_SDK, data.checkout.deprecated),
    ...declarations(serverRepository, PAYPAL_SERVER_SDK, null),
  ];
  const repository = checkoutRepository;
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
  // Exported PayPal base constants per file, and their imports per file.
  const exportedBases = new Map<string, Map<string, Base>>();
  for (const file of repository.files) {
    if (!hasHost(file.content)) continue;
    const { source } = context(file.path, file.content);
    for (const statement of source.statements)
      if (ts.isVariableStatement(statement))
        for (const declaration of statement.declarationList.declarations) {
          const hosts = declaration.initializer && baseHosts(declaration.initializer);
          if (ts.isIdentifier(declaration.name) && hosts && exported(declaration)) {
            const bases = exportedBases.get(file.path) ?? new Map<string, Base>();
            exportedBases.set(file.path, bases);
            bases.set(declaration.name.text, { hosts, declaration });
          }
        }
  }
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
  const version = exactVersion(packages.find((item) => item.name === PAYPAL_SERVER_SDK));
  const calls: PayPalCall[] = [];
  for (const file of repository.files) {
    const imports = importsByFile.get(file.path) ?? new Map<string, Base>();
    const urlFile = hasHost(file.content) || imports.size > 0;
    const checkoutFile = file.content.includes(PAYPAL_CHECKOUT_SDK);
    const serverFile = file.content.includes(PAYPAL_SERVER_SDK);
    if (!urlFile && !checkoutFile && !serverFile) continue;
    const current = context(file.path, file.content);
    if (urlFile) calls.push(...urlCalls(current, imports, imported, data));
    if (checkoutFile) calls.push(...checkoutCalls(current, data));
    if (serverFile) calls.push(...serverCalls(current, data, version));
  }
  calls.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const { repository: source, commit, committedAt } = data.specification;
  return {
    calls,
    packages,
    specification: { repository: source, commit, committedAt },
    warnings: repository.warnings,
  };
}

function declarations(
  repository: Repository,
  name: string,
  deprecated: string | null,
): PayPalPackage[] {
  return repository.dependencies.map((dependency) => ({
    name,
    file: dependency.file,
    declared: dependency.version,
    locked: dependency.lock.version,
    deprecated,
  }));
}
