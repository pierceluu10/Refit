import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript-compiler';
import { TEST_PATH } from './deadline-exposure.ts';
import {
  calleeText,
  consumers,
  constantString,
  excerpt,
  expressionName,
  findDeclaration,
  httpMethod,
  importedNames,
  isConst,
  isUrlRoot,
  lineOf,
  objectProperty,
  partsOf,
  propertyName,
  requiredModule,
  sourceOf,
  unwrap,
  type Part,
} from './meta-graph-calls.ts';
import { readRepository } from './repository.ts';
import { createSourceImportResolver } from './source-imports.ts';
import { isObject, parseObject } from './specifications.ts';
import type { Repository } from './types.ts';

// Cloudflare API requests a repository makes, read from source without running it: calls of the
// `cloudflare` npm SDK, mapped to the endpoint each method requests, and raw HTTP requests to
// `https://api.cloudflare.com/client/v4`. Each request is matched to Cloudflare's API deprecations
// page and to the operations its published OpenAPI document marks deprecated. Workers
// configuration files are read for their compatibility date and flags. Review only: nothing is
// changed, installed, run or sent to Cloudflare.

export const CLOUDFLARE_ENDPOINTS = new URL('../data/cloudflare-endpoints.json', import.meta.url);
export const CLOUDFLARE_PACKAGE = 'cloudflare';
const HOST = /^(?:https?:)?\/\/api\.cloudflare\.com\/client\/v4(?=[/?#]|$)/;
const AXIOS_METHODS = new Set(['get', 'delete', 'head', 'options', 'post', 'put', 'patch']);
// The SDK client's own request methods: `client.get('/zones')`.
const CLIENT_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'getAPIList']);
const PATH_NAME = /path|endpoint|url|route|uri/i;
const WRANGLER_FILES = new Set(['wrangler.toml', 'wrangler.json', 'wrangler.jsonc']);
const EXCLUDED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.refit',
  '.wrangler',
]);
const MAX_WRANGLER_FILES = 200;
const DAY = 86_400_000;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// What Cloudflare published about an endpoint: an entry of the API deprecations page, or a
// deprecated operation of the OpenAPI document.
export interface CloudflareNotice {
  source: 'deprecations-page' | 'openapi';
  title: string;
  // `deprecated`: the endpoint goes away; `affected`: it stays and changes behaviour.
  change: 'deprecated' | 'affected';
  deprecationDate: string | null;
  endOfLife: string | null;
}

export interface CloudflareCall {
  kind: 'sdk' | 'url';
  file: string;
  line: number;
  use: 'live' | 'test';
  // `zones.settings.edit`; null for raw HTTP.
  property: string | null;
  // The call as written: `client.zones.settings.edit`, `fetch`, `axios.post`.
  client: string | null;
  method: Method | null;
  // `/zones/{zone_id}/settings/{settingID}`: literal segments as written, runtime ones in braces.
  path: string | null;
  notices: CloudflareNotice[];
  notes: string[];
  unknown: string[];
  text: string;
}

// One Worker's compatibility settings in a Wrangler configuration file, for the inventory. These
// are facts, not deadlines: Cloudflare supports every compatibility date indefinitely.
export interface WorkersCompatibility {
  file: string;
  line: number;
  // The `[env.<name>]` or `env.<name>` block, or null for the top level.
  environment: string | null;
  compatibilityDate: string | null;
  flags: string[];
  // Whole days from the compatibility date to the scan date.
  ageDays: number | null;
  // Flags Cloudflare turns on by default for compatibility dates after this one, that this
  // Worker neither sets nor disables.
  laterDefaults: string[];
  notes: string[];
}

export interface CloudflarePackage {
  name: string;
  file: string;
  declared: string;
  locked: string | null;
}

export interface CloudflareScan {
  calls: CloudflareCall[];
  workers: WorkersCompatibility[];
  packages: CloudflarePackage[];
  sources: {
    openapi: { repository: string; commit: string; sha256: string };
    deprecations: { page: string; commit: string };
    checkedAt: string;
  };
  warnings: string[];
}

interface Endpoint {
  method: Method;
  path: string;
  releases: string;
}

export interface CloudflareEndpoints {
  checkedAt: string;
  releases: string[];
  properties: Map<string, Endpoint[]>;
  // `GET /zones/{}/settings` -> what Cloudflare published about it.
  notices: Map<string, CloudflareNotice[]>;
  flags: { enableFlag: string | null; disableFlag: string | null; enableDate: string | null }[];
  // Flags the page names in prose, such as `nodejs_compat`, with no entry of their own.
  documentedFlags: string[];
  sources: CloudflareScan['sources'];
}

// `/zones/{zone_id}` and `/zones/{zone_identifier}/` compare equal.
export function cloudflarePathKey(method: string, path: string) {
  const clean = path
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .split('/')
    .map((segment) => (segment.includes('{') ? '{}' : segment))
    .join('/');
  return `${method} ${clean}`;
}

let endpoints: Promise<CloudflareEndpoints> | undefined;
export function loadCloudflareEndpoints(
  path: string | URL = CLOUDFLARE_ENDPOINTS,
): Promise<CloudflareEndpoints> {
  const load = async () => {
    const value = parseObject(await readFile(path, 'utf8'), 'Cloudflare endpoints');
    const { sdk, openapi, announcements, compatibilityFlags } = value;
    if (
      value.formatVersion !== 1 ||
      !isObject(sdk) ||
      !isObject(sdk.properties) ||
      !isObject(openapi) ||
      !Array.isArray(openapi.deprecated) ||
      !isObject(announcements) ||
      !Array.isArray(announcements.entries) ||
      !isObject(compatibilityFlags) ||
      !Array.isArray(compatibilityFlags.flags)
    )
      throw new Error(
        'Cloudflare endpoints require formatVersion 1, SDK properties, OpenAPI deprecations, announcements and compatibility flags.',
      );
    const notices = new Map<string, CloudflareNotice[]>();
    const add = (method: string, path: string, notice: CloudflareNotice) => {
      const key = cloudflarePathKey(method, path);
      const listed = notices.get(key) ?? [];
      notices.set(key, listed);
      listed.push(notice);
    };
    for (const entry of announcements.entries as {
      title: string;
      deprecationDate: string | null;
      endOfLife: string | null;
      endpoints: { method: string; path: string; change: CloudflareNotice['change'] }[];
    }[])
      for (const endpoint of entry.endpoints)
        add(endpoint.method, endpoint.path, {
          source: 'deprecations-page',
          title: entry.title,
          change: endpoint.change,
          deprecationDate: entry.deprecationDate,
          endOfLife: entry.endOfLife,
        });
    for (const operation of openapi.deprecated as {
      method: string;
      path: string;
      operationId: string | null;
      notice?: { eol: string | null; description: string | null };
    }[]) {
      // The page's entry wins when both list the endpoint.
      const key = cloudflarePathKey(operation.method, operation.path);
      if (notices.get(key)?.some((item) => item.change === 'deprecated')) continue;
      add(operation.method, operation.path, {
        source: 'openapi',
        title: operation.notice?.description ?? operation.operationId ?? 'deprecated operation',
        change: 'deprecated',
        deprecationDate: null,
        endOfLife: operation.notice?.eol ?? null,
      });
    }
    return {
      checkedAt: String(value.checkedAt),
      releases: (sdk.releases as unknown[]).map(String),
      properties: new Map(Object.entries(sdk.properties as Record<string, Endpoint[]>)),
      notices,
      flags: compatibilityFlags.flags as CloudflareEndpoints['flags'],
      documentedFlags: ((compatibilityFlags.documented as unknown[]) ?? []).map(String),
      sources: {
        openapi: {
          repository: String(openapi.repository),
          commit: String(openapi.commit),
          sha256: String(openapi.sha256),
        },
        deprecations: { page: String(announcements.page), commit: String(announcements.commit) },
        checkedAt: String(value.checkedAt),
      },
    };
  };
  if (path !== CLOUDFLARE_ENDPOINTS) return load();
  endpoints ??= load();
  return endpoints;
}

function review(data: CloudflareEndpoints, method: Method | null, path: string | null) {
  if (!method || !path) return [];
  return data.notices.get(cloudflarePathKey(method, path)) ?? [];
}

interface FileContext {
  path: string;
  source: ts.SourceFile;
  use: CloudflareCall['use'];
}

// Local names bound to the `cloudflare` package: the client class (default, named or required)
// and namespaces (`import * as cf`).
function bindings(source: ts.SourceFile) {
  const classes = new Set<string>();
  const namespaces = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === CLOUDFLARE_PACKAGE &&
      node.importClause
    ) {
      const clause = node.importClause;
      if (clause.name) classes.add(clause.name.text);
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))
        namespaces.add(clause.namedBindings.name.text);
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings))
        for (const element of clause.namedBindings.elements)
          if ((element.propertyName ?? element.name).text === 'Cloudflare')
            classes.add(element.name.text);
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression) &&
      node.moduleReference.expression.text === CLOUDFLARE_PACKAGE
    )
      classes.add(node.name.text);
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = unwrap(node.initializer);
      const required =
        requiredModule(initializer) ??
        (ts.isPropertyAccessExpression(initializer) && initializer.name.text === 'default'
          ? requiredModule(initializer.expression)
          : undefined);
      if (required === CLOUDFLARE_PACKAGE) {
        if (ts.isIdentifier(node.name)) classes.add(node.name.text);
        if (ts.isObjectBindingPattern(node.name))
          for (const element of node.name.elements) {
            const name = propertyName(element.propertyName) ?? propertyName(element.name);
            if ((name === 'Cloudflare' || name === 'default') && ts.isIdentifier(element.name))
              classes.add(element.name.text);
          }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { classes, namespaces };
}

// Names other files make clients with: local names imported for an exported alias of the client
// class, for an exported function that returns a client, and method names any class in the
// repository declares to return a client.
interface ResolverContext {
  names: Set<string>;
  functions: Set<string>;
  methods: Set<string>;
}
const EMPTY_CONTEXT: ResolverContext = {
  names: new Set(),
  functions: new Set(),
  methods: new Set(),
};

// Which expressions hold a client in one file: `new Cloudflare()`, the 2.x factory call
// `cloudflare({ token })` or `require('cloudflare')({ … })`, names and class properties typed
// `Cloudflare` or assigned a client, and calls of local functions that return one.
function resolver(source: ts.SourceFile, context: ResolverContext = EMPTY_CONTEXT) {
  const { classes, namespaces } = bindings(source);
  const isClass = (expression: ts.Node) => {
    const node = ts.isExpression(expression) ? unwrap(expression) : expression;
    if (ts.isIdentifier(node)) return classes.has(node.text) || context.names.has(node.text);
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression))
      return namespaces.has(node.expression.text) && node.name.text === 'Cloudflare';
    if (ts.isQualifiedName(node) && ts.isIdentifier(node.left))
      return namespaces.has(node.left.text) && node.right.text === 'Cloudflare';
    return requiredModule(node as ts.Expression) === CLOUDFLARE_PACKAGE;
  };
  // `Cloudflare`, `Cloudflare | null`, or a local `type CloudflareApiClient = Cloudflare`.
  const typed = (type: ts.TypeNode | undefined, depth = 0): boolean => {
    if (!type || depth > 4) return false;
    if (ts.isUnionTypeNode(type)) return type.types.some((item) => typed(item, depth + 1));
    if (!ts.isTypeReferenceNode(type)) return false;
    if (isClass(type.typeName)) return true;
    const name = type.typeName.getText();
    const alias = source.statements.find(
      (statement): statement is ts.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(statement) && statement.name.text === name,
    );
    return !!alias && typed(alias.type, depth + 1);
  };
  // A client whose `baseURL` is set to another host talks to a Cloudflare-compatible server, not
  // Cloudflare: `new Cloudflare({ baseURL: 'http://127.0.0.1:8787/client/v4' })`.
  const elsewhere = (node: ts.NewExpression) => {
    const options = node.arguments?.[0] && unwrap(node.arguments[0]);
    if (!options || !ts.isObjectLiteralExpression(options)) return false;
    const base = objectProperty(options, 'baseURL');
    if (!base) return false;
    const value = constantString(base)?.value;
    return !(value && HOST.test(value));
  };
  const returns = (fn: ts.SignatureDeclaration, depth: number): boolean => {
    if (typed(fn.type)) return true;
    const body = (fn as ts.FunctionLikeDeclaration).body;
    if (!body) return false;
    if (!ts.isBlock(body)) return holds(body, depth + 1);
    let found = false;
    const visit = (node: ts.Node) => {
      if (found || (node !== body && ts.isFunctionLike(node))) return;
      if (ts.isReturnStatement(node) && node.expression) found = holds(node.expression, depth + 1);
      ts.forEachChild(node, visit);
    };
    visit(body);
    return found;
  };
  const functionOf = (name: string, from: ts.Node) => {
    const declaration = findDeclaration(name, from);
    const initializer = declaration?.initializer && unwrap(declaration.initializer);
    if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)))
      return initializer;
    if (declaration) return undefined;
    return source.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === name,
    );
  };
  const assigned = (matches: (left: ts.Expression) => boolean, scope: ts.Node, depth: number) => {
    let found = false;
    const visit = (node: ts.Node) => {
      if (found) return;
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        matches(unwrap(node.left))
      )
        found = holds(node.right, depth + 1);
      ts.forEachChild(node, visit);
    };
    visit(scope);
    return found;
  };
  const property = (owner: ts.ClassLikeDeclaration, name: string, depth: number): boolean => {
    for (const member of owner.members) {
      if (
        ts.isPropertyDeclaration(member) &&
        member.name.getText() === name &&
        (typed(member.type) || holds(member.initializer, depth + 1))
      )
        return true;
      if (ts.isConstructorDeclaration(member))
        for (const parameter of member.parameters)
          if (
            ts.getModifiers(parameter)?.length &&
            ts.isIdentifier(parameter.name) &&
            parameter.name.text === name &&
            typed(parameter.type)
          )
            return true;
    }
    return assigned(
      (left) =>
        ts.isPropertyAccessExpression(left) &&
        left.expression.kind === ts.SyntaxKind.ThisKeyword &&
        left.name.getText() === name,
      owner,
      depth,
    );
  };
  const holds = (expression: ts.Expression | undefined, depth = 0): boolean => {
    if (!expression || depth > 6) return false;
    const node = unwrap(expression);
    if (ts.isAwaitExpression(node)) return holds(node.expression, depth + 1);
    if (ts.isNewExpression(node)) return isClass(node.expression) && !elsewhere(node);
    if (ts.isBinaryExpression(node))
      return (
        (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          node.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
        (holds(node.right, depth + 1) || holds(node.left, depth + 1))
      );
    if (ts.isConditionalExpression(node))
      return holds(node.whenTrue, depth + 1) || holds(node.whenFalse, depth + 1);
    if (ts.isCallExpression(node)) {
      // The 2.x factory: `cloudflare({ token })` or `require('cloudflare')({ token })`.
      if (isClass(node.expression)) return true;
      if (ts.isIdentifier(node.expression)) {
        const fn = functionOf(node.expression.text, node);
        return fn ? returns(fn, depth) : context.functions.has(node.expression.text);
      }
      // `this.getClient()`: a method of this class, or one a base class in another file declares
      // to return a client.
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        const owner = ts.findAncestor(node, ts.isClassLike);
        const name = node.expression.name.getText();
        const method = owner?.members.find(
          (member): member is ts.MethodDeclaration =>
            ts.isMethodDeclaration(member) && member.name.getText() === name,
        );
        if (method) return returns(method, depth);
        return !!owner?.heritageClauses?.length && context.methods.has(name);
      }
      return false;
    }
    if (ts.isIdentifier(node)) {
      const declaration = findDeclaration(node.text, node);
      if (declaration) {
        const scope = ts.findAncestor(
          declaration,
          (item) => ts.isBlock(item) || ts.isSourceFile(item),
        );
        return (
          typed(declaration.type) ||
          holds(declaration.initializer, depth + 1) ||
          (!!scope &&
            assigned(
              (left) =>
                ts.isIdentifier(left) &&
                left.text === node.text &&
                findDeclaration(left.text, left) === declaration,
              scope,
              depth,
            ))
        );
      }
      for (let scope: ts.Node | undefined = node; scope; scope = scope.parent)
        if (ts.isFunctionLike(scope))
          for (const parameter of scope.parameters)
            if (ts.isIdentifier(parameter.name) && parameter.name.text === node.text)
              return typed(parameter.type);
      return false;
    }
    if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const owner = ts.findAncestor(node, ts.isClassLike);
      return !!owner && property(owner, node.name.getText(), depth);
    }
    return false;
  };
  return { holds, returns, typed, functionOf };
}

// The path a URL's parts spell after the API base, with runtime pieces named in braces.
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
      // `${base}${path}` or `/${resource}`: the rest of the path is chosen at runtime.
      if (index === 0 || PATH_NAME.test(name) || path === '') {
        unknown.push(`path is built at runtime from \`${name}\``);
        return null;
      }
    }
    path += `/${segment.map((part) => ('text' in part ? part.text : `{${expressionName(part.expression).replace(/^.*\./, '')}}`)).join('')}`;
  }
  return path || null;
}

// A URL's parts after the API base, with a leading `const` base expanded.
function apiUrl(expression: ts.Expression, depth = 0): Part[] | undefined {
  const [first, ...rest] = partsOf(expression);
  if (!first || depth > 3) return undefined;
  if ('text' in first)
    return HOST.test(first.text)
      ? [{ text: first.text.replace(HOST, ''), node: first.node }, ...rest]
      : undefined;
  const node = unwrap(first.expression);
  const declaration = ts.isIdentifier(node) ? findDeclaration(node.text, node) : undefined;
  if (!declaration?.initializer || !isConst(declaration)) return undefined;
  const inner = apiUrl(declaration.initializer, depth + 1);
  return inner && [...inner, ...rest];
}

// The HTTP method of a call a URL is passed to.
function requestMethod(call: ts.CallExpression, argument: number, unknown: string[]) {
  const client = calleeText(call);
  const name = ts.isPropertyAccessExpression(call.expression)
    ? call.expression.name.text
    : ts.isIdentifier(call.expression)
      ? call.expression.text
      : '';
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

function urlCalls(file: FileContext, data: CloudflareEndpoints): CloudflareCall[] {
  const calls: CloudflareCall[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isExpression(node) && isUrlRoot(node)) {
      const parts = apiUrl(node);
      if (parts) {
        calls.push(...urlRecords(file, node, parts, data));
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file.source);
  return calls;
}

// The request options object a URL is the `url` of, and the calls it is passed to, directly or
// through the variable that holds it: `const options = { method: 'PUT', url }; request(options)`.
function optionsObject(node: ts.Expression) {
  const property = node.parent;
  if (!ts.isPropertyAssignment(property) || propertyName(property.name) !== 'url') return undefined;
  const object = property.parent;
  const method = objectProperty(object, 'method');
  const holder = object.parent;
  if (ts.isCallExpression(holder) && holder.arguments.includes(object))
    return { method, calls: [{ call: holder, argument: holder.arguments.indexOf(object) }] };
  if (!ts.isVariableDeclaration(holder) || !ts.isIdentifier(holder.name)) return undefined;
  const name = holder.name.text;
  const scope = ts.findAncestor(holder, (item) => ts.isBlock(item) || ts.isSourceFile(item));
  const calls: { call: ts.CallExpression; argument: number }[] = [];
  const visit = (child: ts.Node) => {
    if (
      ts.isIdentifier(child) &&
      child.text === name &&
      ts.isCallExpression(child.parent) &&
      child.parent.arguments.includes(child) &&
      findDeclaration(name, child) === holder
    )
      calls.push({ call: child.parent, argument: child.parent.arguments.indexOf(child) });
    ts.forEachChild(child, visit);
  };
  if (scope) visit(scope);
  return calls.length ? { method, calls } : undefined;
}

function urlRecords(
  file: FileContext,
  node: ts.Expression,
  parts: Part[],
  data: CloudflareEndpoints,
): CloudflareCall[] {
  const pathUnknown: string[] = [];
  const path = urlPath(parts, pathUnknown);
  const base = path === null && !pathUnknown.length;
  // `new URL('https://api.cloudflare.com/…')` is followed like the string it wraps.
  const parent = node.parent;
  const wrapped =
    ts.isNewExpression(parent) &&
    parent.expression.getText() === 'URL' &&
    parent.arguments?.[0] === node
      ? parent
      : node;
  const options = optionsObject(wrapped);
  const found = options ? options.calls : consumers(wrapped);
  // A base URL is reported only where it is passed to a call; URLs built from it are reported on
  // their own.
  if (base && !found.length) return [];
  return (found.length ? found : [undefined]).map((consumer) => {
    const unknown = [...pathUnknown];
    let client: string | null = null;
    let method: Method | null = null;
    if (consumer && base)
      unknown.push(
        `the base URL is passed to \`${calleeText(consumer.call)}\`; requests built from it are not traced`,
      );
    else if (consumer && options) {
      // `{ method: 'PUT', url }` handed to a request helper: the method is the object's.
      client = calleeText(consumer.call);
      const value = options.method && constantString(options.method)?.value;
      method = options.method ? httpMethod(value) : 'GET';
      if (options.method && value === undefined) unknown.push('HTTP method is chosen at runtime');
    } else if (consumer) {
      const read = requestMethod(consumer.call, consumer.argument, unknown);
      client = read.client;
      method = read.method;
      if (read.helper) unknown.push(`HTTP method of helper \`${client}\` is not known`);
    } else unknown.push('no request call was traced for this URL');
    const known = base ? null : path;
    const anchor = consumer?.call ?? node;
    return {
      kind: 'url' as const,
      file: file.path,
      line: lineOf(file.source, anchor),
      use: file.use,
      property: null,
      client,
      method,
      path: known,
      notices: review(data, method, known),
      notes: [],
      unknown: [...new Set(unknown)],
      text: excerpt(file.source, anchor),
    };
  });
}

// `client.zones.settings.edit(…)` and the client's own `client.get('/zones')`.
function sdkCalls(
  file: FileContext,
  data: CloudflareEndpoints,
  legacy: boolean,
  context: ResolverContext,
): CloudflareCall[] {
  const { holds } = resolver(file.source, context);
  const calls: CloudflareCall[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const path: string[] = [];
      let receiver: ts.Expression = node.expression;
      let found = false;
      while (ts.isPropertyAccessExpression(receiver)) {
        path.unshift(receiver.name.text);
        receiver = receiver.expression;
        if (holds(receiver)) {
          found = true;
          break;
        }
      }
      if (found) {
        const record = sdkRecord(file, node, path, data, legacy);
        if (record) calls.push(record);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file.source);
  return calls;
}

function sdkRecord(
  file: FileContext,
  call: ts.CallExpression,
  path: string[],
  data: CloudflareEndpoints,
  legacy: boolean,
): CloudflareCall | undefined {
  const unknown: string[] = [];
  const notes: string[] = [];
  const property = path.join('.');
  let method: Method | null = null;
  let endpoint: string | null = null;
  if (path.length === 1 && CLIENT_VERBS.has(path[0]) && !legacy) {
    // `client.get('/zones/…')` sends the path as written.
    method = path[0] === 'getAPIList' ? 'GET' : (path[0].toUpperCase() as Method);
    const argument = call.arguments[0];
    endpoint = argument ? urlPath(partsOf(argument), unknown) : null;
    if (endpoint && !endpoint.startsWith('/')) endpoint = `/${endpoint}`;
  } else if (path.length === 1) return undefined;
  else if (legacy)
    notes.push(
      'cloudflare 2.x is the earlier hand-written client; its methods are not mapped to endpoints',
    );
  else {
    const entries = data.properties.get(property);
    const newest = data.releases.at(-1)!;
    const current = entries?.find((entry) => entry.releases.split(/\.\.| /).includes(newest));
    const chosen = current ?? entries?.at(-1);
    if (!chosen)
      notes.push(
        `\`${property}\` is not a method of any recorded cloudflare release (${data.releases[0]} to ${newest})`,
      );
    else {
      method = chosen.method;
      endpoint = chosen.path;
      if (!current)
        notes.push(`\`${property}\` is not in cloudflare ${newest}; it is in ${chosen.releases}`);
    }
  }
  return {
    kind: 'sdk',
    file: file.path,
    line: lineOf(file.source, call),
    use: file.use,
    property: path.length === 1 && !legacy ? null : property,
    client: calleeText(call),
    method,
    path: endpoint,
    notices: review(data, method, endpoint),
    notes,
    unknown,
    text: excerpt(file.source, call),
  };
}

// Wrangler configuration files, found the way source files are: excluded directories and
// symbolic links are skipped.
async function wranglerFiles(root: string) {
  const found: string[] = [];
  const visit = async (directory: string) => {
    if (found.length >= MAX_WRANGLER_FILES) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry.name)) await visit(path);
      else if (entry.isFile() && WRANGLER_FILES.has(entry.name)) found.push(path);
    }
  };
  await visit(root);
  return found.sort();
}

interface WorkerSettings {
  environment: string | null;
  line: number;
  date: string | null;
  flags: string[];
}

// The keys this needs from TOML, read line by line: `compatibility_date = "…"` and
// `compatibility_flags = [ "…", … ]` at the top level and in `[env.<name>]` tables.
function tomlSettings(content: string): WorkerSettings[] {
  const blocks = new Map<string | null, WorkerSettings>();
  let table: string | null = null;
  let environment: string | null = null;
  let collecting: { block: WorkerSettings; text: string } | undefined;
  const block = (line: number) => {
    let found = blocks.get(environment);
    if (!found) blocks.set(environment, (found = { environment, line, date: null, flags: [] }));
    return found;
  };
  for (const [index, raw] of content.split('\n').entries()) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (collecting) {
      collecting.text += line;
      if (line.includes(']')) {
        collecting.block.flags = [...collecting.text.matchAll(/["']([^"']+)["']/g)].map(
          (match) => match[1],
        );
        collecting = undefined;
      }
      continue;
    }
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      table = header[1].trim();
      environment = /^env\.([\w-]+)$/.exec(table)?.[1] ?? null;
      continue;
    }
    if (table !== null && environment === null) continue;
    const date = /^compatibility_date\s*=\s*["'](\d{4}-\d{2}-\d{2})["']/.exec(line);
    if (date) {
      const found = block(index + 1);
      found.date = date[1];
      found.line = index + 1;
    }
    const flags = /^compatibility_flags\s*=\s*(\[.*)$/.exec(line);
    if (flags) {
      const found = block(index + 1);
      if (flags[1].includes(']'))
        found.flags = [...flags[1].matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
      else collecting = { block: found, text: flags[1] };
    }
  }
  return [...blocks.values()];
}

// The same keys from wrangler.json or wrangler.jsonc, with comments allowed.
function jsonSettings(path: string, content: string): WorkerSettings[] {
  const parsed = ts.parseConfigFileTextToJson(path, content);
  if (parsed.error || !isObject(parsed.config)) return [];
  const lines = content.split('\n');
  const lineOfKey = (key: string, after = 0) =>
    Math.max(1, lines.findIndex((line, index) => index >= after && line.includes(`"${key}"`)) + 1);
  const read = (value: Record<string, unknown>, environment: string | null): WorkerSettings => {
    const start = environment ? lineOfKey(environment) - 1 : 0;
    return {
      environment,
      line: lineOfKey('compatibility_date', start),
      date:
        typeof value.compatibility_date === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(value.compatibility_date)
          ? value.compatibility_date
          : null,
      flags: Array.isArray(value.compatibility_flags)
        ? value.compatibility_flags.filter((flag): flag is string => typeof flag === 'string')
        : [],
    };
  };
  const config = parsed.config as Record<string, unknown>;
  const settings = [read(config, null)];
  if (isObject(config.env))
    for (const [name, value] of Object.entries(config.env))
      if (isObject(value) && ('compatibility_date' in value || 'compatibility_flags' in value))
        settings.push(read(value as Record<string, unknown>, name));
  return settings.filter((item) => item.date || item.flags.length);
}

// Each Worker's compatibility date and flags, with what Cloudflare's flags list says about them.
export async function workersCompatibility(
  directory: string,
  options: { data?: CloudflareEndpoints; now?: Date } = {},
): Promise<WorkersCompatibility[]> {
  const data = options.data ?? (await loadCloudflareEndpoints());
  const now = options.now ?? new Date();
  const root = resolve(directory);
  const known = new Set([
    ...data.flags.flatMap((flag) => [flag.enableFlag, flag.disableFlag]).filter(Boolean),
    ...data.documentedFlags,
  ]);
  const found: WorkersCompatibility[] = [];
  for (const path of await wranglerFiles(root)) {
    const content = await readFile(path, 'utf8');
    const file = relative(root, path).split('\\').join('/');
    const settings = path.endsWith('.toml') ? tomlSettings(content) : jsonSettings(path, content);
    for (const item of settings) {
      const notes: string[] = [];
      const ageDays = item.date
        ? Math.floor((now.getTime() - Date.parse(`${item.date}T00:00:00Z`)) / DAY)
        : null;
      if (!item.date)
        notes.push(
          'no compatibility_date; Cloudflare uses the oldest date (2021-11-02) when an upload sets none',
        );
      else if (ageDays !== null && ageDays > 365)
        notes.push(`the compatibility date is ${ageDays} days old (more than a year)`);
      for (const flag of item.flags)
        if (!known.has(flag))
          notes.push(`\`${flag}\` is not on Cloudflare's compatibility flags page`);
      const laterDefaults = item.date
        ? data.flags
            .filter(
              (flag) =>
                flag.enableFlag &&
                flag.enableDate &&
                flag.enableDate > item.date! &&
                !item.flags.includes(flag.enableFlag) &&
                !(flag.disableFlag && item.flags.includes(flag.disableFlag)),
            )
            .map((flag) => flag.enableFlag!)
        : [];
      found.push({
        file,
        line: item.line,
        environment: item.environment,
        compatibilityDate: item.date,
        flags: item.flags,
        ageDays,
        laterDefaults,
        notes,
      });
    }
  }
  return found;
}

// What a file exports that makes clients elsewhere: aliases of the client class
// (`export type CloudflareApiClient = Cloudflare`, `export { Cloudflare } from 'cloudflare'`),
// functions that return a client, and the names of methods that return one.
function exportsOf(source: ts.SourceFile) {
  const { typed, functionOf, returns } = resolver(source);
  const names = new Set<string>();
  const functions = new Set<string>();
  const methods = new Set<string>();
  const exporting = (statement: ts.Statement) =>
    ts
      .getModifiers(statement as ts.HasModifiers)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  for (const statement of source.statements) {
    if (ts.isTypeAliasDeclaration(statement) && exporting(statement) && typed(statement.type))
      names.add(statement.name.text);
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === CLOUDFLARE_PACKAGE &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    )
      for (const element of statement.exportClause.elements)
        if (['Cloudflare', 'default'].includes((element.propertyName ?? element.name).text))
          names.add(element.name.text);
    if (ts.isFunctionDeclaration(statement) && statement.name && exporting(statement))
      if (returns(statement, 0)) functions.add(statement.name.text);
    if (ts.isVariableStatement(statement) && exporting(statement))
      for (const declaration of statement.declarationList.declarations) {
        const fn = ts.isIdentifier(declaration.name)
          ? functionOf(declaration.name.text, statement)
          : undefined;
        if (fn && returns(fn, 0)) functions.add((declaration.name as ts.Identifier).text);
      }
  }
  const visit = (node: ts.Node) => {
    if (ts.isMethodDeclaration(node) && returns(node, 0)) methods.add(node.name.getText());
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { names, functions, methods };
}

function scanFiles(repository: Repository, data: CloudflareEndpoints, legacy: boolean) {
  const calls: CloudflareCall[] = [];
  const sources = new Map<string, ts.SourceFile>();
  const sourceFor = (file: Repository['files'][number]) => {
    let source = sources.get(file.path);
    if (!source) sources.set(file.path, (source = sourceOf(file.path, file.content)));
    return source;
  };
  const sdkFile = (content: string) => /['"]cloudflare['"]/.test(content);
  // Exports of the files that use the package, followed into the files importing them.
  const exported = new Map<string, ReturnType<typeof exportsOf>>();
  const methods = new Set<string>();
  for (const file of repository.files)
    if (sdkFile(file.content)) {
      const found = exportsOf(sourceFor(file));
      exported.set(file.path, found);
      for (const method of found.methods) methods.add(method);
    }
  const exportedNames = [...exported.values()].flatMap((item) => [
    ...item.names,
    ...item.functions,
  ]);
  const absolute = new Map(
    repository.files.map((file) => [join(repository.root, file.path), file.path]),
  );
  const imports = createSourceImportResolver(repository, absolute);
  for (const file of repository.files) {
    const api = file.content.includes('api.cloudflare.com/client/v4');
    const context: ResolverContext = { names: new Set(), functions: new Set(), methods };
    if (exportedNames.some((name) => file.content.includes(name)))
      for (const [local, binding] of importedNames(sourceFor(file))) {
        const target = imports.resolve(binding.specifier, join(repository.root, file.path));
        const found = target ? exported.get(absolute.get(target)!) : undefined;
        if (found?.names.has(binding.name)) context.names.add(local);
        if (found?.functions.has(binding.name)) context.functions.add(local);
      }
    const inherited = [...methods].some((method) => file.content.includes(`this.${method}(`));
    const sdk =
      sdkFile(file.content) || context.names.size > 0 || context.functions.size > 0 || inherited;
    if (!api && !sdk) continue;
    const current: FileContext = {
      path: file.path,
      source: sourceFor(file),
      use: TEST_PATH.test(file.path) ? 'test' : 'live',
    };
    if (api) calls.push(...urlCalls(current, data));
    if (sdk) calls.push(...sdkCalls(current, data, legacy, context));
  }
  return calls.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// Whether every declaration of the package is the 2.x client.
function legacyOnly(packages: CloudflarePackage[]) {
  return (
    packages.length > 0 &&
    packages.every((item) => /^\D*[0-2]\./.test(item.locked ?? item.declared))
  );
}

// Lists every Cloudflare API request a repository makes and its Workers compatibility settings.
export async function scanCloudflareCalls(
  directory: string,
  options: { data?: CloudflareEndpoints; now?: Date } = {},
): Promise<CloudflareScan> {
  const data = options.data ?? (await loadCloudflareEndpoints());
  const root = resolve(directory);
  const repository = await readRepository(root, CLOUDFLARE_PACKAGE);
  const packages = repository.dependencies.map((dependency) => ({
    name: CLOUDFLARE_PACKAGE,
    file: dependency.file,
    declared: dependency.version,
    locked: dependency.lock.version,
  }));
  return {
    calls: scanFiles(repository, data, legacyOnly(packages)),
    workers: await workersCompatibility(root, { data, now: options.now }),
    packages,
    sources: data.sources,
    warnings: repository.warnings,
  };
}

// Each request a repository's source makes to an endpoint listed in the deadline registry, by the
// registry's own `METHOD /path` spelling, for scanDeadlines.
export async function cloudflareEndpointUses(
  directory: string,
  versions: string[],
  repository?: Repository,
): Promise<{ version: string; file: string; line: number; use: 'live' | 'test'; text: string }[]> {
  const data = await loadCloudflareEndpoints();
  const read = repository ?? (await readRepository(resolve(directory), CLOUDFLARE_PACKAGE));
  const byKey = new Map(
    versions.map((version) => {
      const [method, path] = version.split(' ');
      return [cloudflarePathKey(method, path), version];
    }),
  );
  return scanFiles(read, data, false).flatMap((call) => {
    const version =
      call.method && call.path ? byKey.get(cloudflarePathKey(call.method, call.path)) : undefined;
    return version
      ? [{ version, file: call.file, line: call.line, use: call.use, text: call.text }]
      : [];
  });
}
