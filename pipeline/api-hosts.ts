import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript-compiler';
import { AGENT_CATALOG } from './agent-catalog.ts';
import { TEST_PATH } from './deadline-exposure.ts';
import {
  findDeclaration,
  importedNames,
  isConst,
  lineOf,
  objectProperty,
  partsOf,
  reassignedName,
  requiredModule,
  resolveImport,
  sourceOf,
  unwrap,
} from './meta-graph-calls.ts';
import { readRepository } from './repository.ts';
import { isObject, parseObject } from './specifications.ts';
import type { Repository } from './types.ts';

// Every external HTTP API host a JS/TS repository calls, read from source without running it.
// A host is reported where it reaches an HTTP client: fetch, axios, got, ky, undici, node:http(s)
// or superagent, with the URL written as a literal, a template, a `const` (also one imported from
// another scanned file) or an environment variable with a literal default. Hosts that
// `data/api-hosts.json` or the agent catalog names map to a provider; every other host is
// "untracked". See docs/API-HOSTS.md.

export const API_HOSTS = new URL('../data/api-hosts.json', import.meta.url);

// `request` covers the deprecated request, request-promise and needle libraries. `client` is a call
// on a client held in a variable or a wrapper function the detector could not trace to an import,
// reported only when the call is awaited or chained and sends a literal absolute URL.
export type ApiHostClient =
  'fetch' | 'axios' | 'got' | 'ky' | 'undici' | 'http' | 'superagent' | 'request' | 'client';

// Why a URL is not reported. Each name is counted in `ApiHostScan.excluded`.
export type ApiHostExclusion =
  | 'test-file'
  | 'docs-file'
  | 'localhost'
  | 'private-range'
  | 'asset-url'
  | 'schema-url'
  | 'placeholder';

export interface ApiHostCall {
  host: string;
  // The literal path before the first runtime piece, without a trailing slash; null for none.
  pathPrefix: string | null;
  file: string;
  line: number;
  client: ApiHostClient;
}

export interface ApiHostEntry {
  // An exact hostname, or `*.example.com` for every subdomain of it.
  host: string;
  provider: string;
  docs: string;
  source: string;
  checkedAt: string;
}

export interface ApiHost {
  host: string;
  // The provider the host belongs to; null for an untracked host.
  provider: { id: string; name: string; origin: 'catalog' | 'api-hosts' } | null;
  count: number;
  // At most MAX_EVIDENCE calls.
  calls: ApiHostCall[];
}

export interface ApiHostScan {
  hosts: ApiHost[];
  excluded: Partial<Record<ApiHostExclusion, number>>;
}

const MAX_EVIDENCE = 5;
const MAX_FILE_CHARACTERS = 1_000_000;
const MAX_CONSTANT_DEPTH = 4;
const HTTP_METHODS = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
  'request',
]);
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
// Test helpers named by file rather than folder: `test-audit.mjs`, `smoke_test.js`, `api.mock.ts`.
const TEST_NAME = /(?:^|\/)(?:test|spec)[-_.][^/]*$|[-_.](?:test|spec|mock|mocks)\.[cm]?[jt]sx?$/i;
const DOCS_PATH = /(?:^|\/)(?:docs?|documentation|website\/docs)\//i;
const MODULE_CLIENTS: Record<string, ApiHostClient> = {
  axios: 'axios',
  got: 'got',
  ky: 'ky',
  'ky-universal': 'ky',
  undici: 'undici',
  http: 'http',
  https: 'http',
  'node:http': 'http',
  'node:https': 'http',
  superagent: 'superagent',
  request: 'request',
  'request-promise': 'request',
  'request-promise-native': 'request',
  needle: 'request',
  'node-fetch': 'fetch',
  'cross-fetch': 'fetch',
  'isomorphic-fetch': 'fetch',
  'isomorphic-unfetch': 'fetch',
  ofetch: 'fetch',
};
// A runtime piece inside a flattened URL. It never matches a hostname character.
const RUNTIME = '\u0000';
const URL_START = /^(?:https?:)?\/\/([^/?#\s]*)([^?#\s]*)/i;
const PRIVATE_IPV4 =
  /^(?:10\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
const LOCAL_NAME = /(?:^|\.)(?:localhost|local|localdomain|internal|test|invalid|lan|home)$/i;
const SCHEMA_HOST =
  /^(?:www\.)?(?:w3\.org|json-schema\.org|schemas\.xmlsoap\.org|schemas\.openxmlformats\.org|schemas\.microsoft\.com|purl\.org|ns\.adobe\.com|xmlns\.com|json\.schemastore\.org|openapis\.org|spec\.openapis\.org|ogp\.me|schema\.org|iptc\.org|dublincore\.org|relaxng\.org|docbook\.org)$/i;
const PLACEHOLDER_HOST =
  /(?:^|\.)(?:example\.(?:com|org|net|edu)|domain\.com|yourdomain\.com|your-domain\.com|mydomain\.com|yoursite\.com|your-api\.com|myapi\.com)$/i;
const ASSET_HOST =
  /^(?:(?:cdn|static|assets|images?|img|media|fonts?)\.|.*\.cloudfront\.net$|.*\.fastly\.net$|fonts\.(?:googleapis|gstatic)\.com$|(?:unpkg|cdn\.jsdelivr)\.(?:com|net)$|cdnjs\.cloudflare\.com$|(?:images|plus)\.unsplash\.com$|(?:avatars|user-images|camo)\.githubusercontent\.com$|i\.imgur\.com$|placehold\.co$|(?:wsrv\.nl|images\.weserv\.nl)$|via\.placeholder\.com$|picsum\.photos$|www\.gravatar\.com$|.*\.googleusercontent\.com$|lh3\.google\.com$|img\.shields\.io$)/i;
const ASSET_PATH =
  /\.(?:png|jpe?g|gif|svg|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|css|mp3|mp4|webm|mov|wav|ogg|pdf|zip|wasm)$/i;

let entries: Promise<ApiHostEntry[]> | undefined;
export function loadApiHosts(path: string | URL = API_HOSTS): Promise<ApiHostEntry[]> {
  const load = async () => {
    const document = parseObject(await readFile(path, 'utf8'), 'API host list');
    if (!Array.isArray(document.hosts)) throw new Error('API host list needs a hosts array.');
    return document.hosts.filter(isObject).map((entry) => ({
      host: String(entry.host).toLowerCase(),
      provider: String(entry.provider),
      docs: String(entry.docs),
      source: String(entry.source),
      checkedAt: String(entry.checkedAt),
    }));
  };
  if (path !== API_HOSTS) return load();
  entries ??= load();
  return entries;
}

const hostOf = (entry: string) => entry.split('/')[0].toLowerCase();

function matchesEntry(host: string, entry: string) {
  return entry.startsWith('*.') ? host.endsWith(entry.slice(1)) : host === entry;
}

// The provider a host belongs to: a catalog agent first, then the host list.
export function providerOf(host: string, list: ApiHostEntry[]): ApiHost['provider'] {
  for (const agent of AGENT_CATALOG)
    // A catalog hostname also covers its subdomains: `abc-dsn.algolia.net` is Algolia.
    if (
      agent.hostnames.some(
        (name) => matchesEntry(host, hostOf(name)) || host.endsWith(`.${hostOf(name)}`),
      )
    )
      return { id: agent.id, name: agent.name, origin: 'catalog' };
  const match = list.find((entry) => matchesEntry(host, entry.host));
  return match
    ? {
        id: match.provider.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        name: match.provider,
        origin: 'api-hosts',
      }
    : null;
}

// The reason a host is not an API host, or undefined when it is.
export function excludedHost(host: string, path: string | null): ApiHostExclusion | undefined {
  if (/^(?:127\.|0\.0\.0\.0$|\[?::1\]?$)/.test(host) || LOCAL_NAME.test(host)) return 'localhost';
  if (PRIVATE_IPV4.test(host) || /^\[?(?:f[cd][0-9a-f]{2}|fe80)[:\]]/i.test(host))
    return 'private-range';
  if (SCHEMA_HOST.test(host)) return 'schema-url';
  if (PLACEHOLDER_HOST.test(host)) return 'placeholder';
  if (ASSET_HOST.test(host) || (path !== null && ASSET_PATH.test(path))) return 'asset-url';
  return undefined;
}

interface Site {
  host: string;
  pathPrefix: string | null;
  node: ts.Node;
  client: ApiHostClient;
}

interface FileInfo {
  path: string;
  source: ts.SourceFile;
}

// Flattens a URL expression into text, writing RUNTIME for every piece that is not known. Reads
// literals, templates, `+`, a `const` (in this file or imported from a scanned file), environment
// variables with a literal default, `new URL(path, base)` and `String(...)`.
class Resolver {
  readonly #files = new Map<string, FileInfo>();
  readonly #names = new Set<string>();

  constructor(files: FileInfo[]) {
    for (const file of files) {
      this.#files.set(file.path, file);
      this.#names.add(file.path);
    }
  }

  text(expression: ts.Expression, file: FileInfo, depth = 0): string {
    const node = unwrap(expression);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isTemplateExpression(node) || isPlus(node))
      return partsOf(node)
        .map((part) => ('text' in part ? part.text : this.text(part.expression, file, depth)))
        .join('');
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.QuestionQuestionToken
      ) {
        const left = this.text(node.left, file, depth);
        return left.includes(RUNTIME) || left === '' ? this.text(node.right, file, depth) : left;
      }
    }
    if (ts.isConditionalExpression(node)) {
      // Both branches name a host; the first is the one reported.
      const whenTrue = this.text(node.whenTrue, file, depth);
      return whenTrue.includes(RUNTIME) ? this.text(node.whenFalse, file, depth) : whenTrue;
    }
    if (ts.isNewExpression(node) && node.expression.getText() === 'URL' && node.arguments?.length) {
      const first = this.text(node.arguments[0], file, depth);
      if (/^(?:https?:)?\/\//i.test(first)) return first;
      return node.arguments[1] ? this.text(node.arguments[1], file, depth) : RUNTIME;
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      node.expression.getText() === 'String'
    )
      return this.text(node.arguments[0], file, depth);
    if (
      ts.isCallExpression(node) &&
      !node.arguments.length &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'toString'
    )
      return this.text(node.expression.expression, file, depth);
    if (ts.isIdentifier(node) && depth < MAX_CONSTANT_DEPTH)
      return this.identifier(node, file, depth);
    if (ts.isPropertyAccessExpression(node) && depth < MAX_CONSTANT_DEPTH)
      return this.member(node, file, depth);
    return RUNTIME;
  }

  identifier(node: ts.Identifier, file: FileInfo, depth: number): string {
    const declaration = findDeclaration(node.text, node);
    if (declaration?.initializer && (isConst(declaration) || !reassignedName(declaration)))
      return this.text(declaration.initializer, file, depth + 1);
    if (declaration) return RUNTIME;
    const imported = importedNames(file.source).get(node.text);
    if (!imported) return RUNTIME;
    const target = resolveImport(file.path, imported.specifier, this.#names);
    const targetFile = target && this.#files.get(target);
    if (!targetFile) return RUNTIME;
    for (const statement of targetFile.source.statements)
      if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const)
        for (const item of statement.declarationList.declarations)
          if (ts.isIdentifier(item.name) && item.name.text === imported.name && item.initializer)
            return this.text(item.initializer, targetFile, depth + 1);
    return RUNTIME;
  }

  // `config.apiUrl` where `config` is a `const` object literal, and `process.env.X` or
  // `import.meta.env.X`, which are runtime unless a `||` or `??` default follows.
  member(node: ts.PropertyAccessExpression, file: FileInfo, depth: number): string {
    if (node.name.text === 'href') return this.text(node.expression, file, depth + 1);
    if (node.expression.kind === ts.SyntaxKind.ThisKeyword) return this.field(node, file, depth);
    if (ts.isIdentifier(node.expression)) {
      const declaration = findDeclaration(node.expression.text, node);
      const initializer = declaration?.initializer && unwrap(declaration.initializer);
      if (
        declaration &&
        isConst(declaration) &&
        initializer &&
        ts.isObjectLiteralExpression(initializer)
      ) {
        const value = objectProperty(initializer, node.name.text);
        if (value) return this.text(value, file, depth + 1);
      }
    }
    return RUNTIME;
  }

  // `this.apiUrl` where the enclosing class sets the field once, in its declaration or with
  // `this.apiUrl = apiUrl || 'https://…'`, which reads the default of a constructor parameter.
  field(node: ts.PropertyAccessExpression, file: FileInfo, depth: number): string {
    const owner = ts.findAncestor(node, ts.isClassLike);
    if (!owner) return RUNTIME;
    const values: ts.Expression[] = [];
    const visit = (child: ts.Node) => {
      if (
        ts.isPropertyDeclaration(child) &&
        child.name.getText() === node.name.text &&
        child.initializer
      )
        values.push(child.initializer);
      if (
        ts.isBinaryExpression(child) &&
        child.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(child.left) &&
        child.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
        child.left.name.text === node.name.text
      )
        values.push(child.right);
      ts.forEachChild(child, visit);
    };
    visit(owner);
    return values.length === 1 ? this.text(values[0], file, depth + 1) : RUNTIME;
  }
}

function isPlus(node: ts.Node): node is ts.BinaryExpression {
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;
}

// The host and literal path prefix at the start of a flattened URL, or undefined when the text is
// not an absolute URL or its host holds a runtime piece.
function parseUrl(text: string) {
  const match = URL_START.exec(text);
  if (!match) return undefined;
  const authority = match[1].replace(/^[^@]*@/, '');
  const host = authority.replace(/:\d*$/, '').toLowerCase();
  if (
    !host ||
    host.includes(RUNTIME) ||
    !/^[a-z0-9.[\]:_-]+$/.test(host) ||
    (!host.includes('.') && !host.includes(':') && host !== 'localhost')
  )
    return undefined;
  const path = match[2].split(RUNTIME)[0].replace(/\/+$/, '');
  return { host, path: path || null };
}

// What an import or require of a module binds, as local names mapped to a client.
function clientImports(source: ts.SourceFile) {
  const names = new Map<string, ApiHostClient>();
  const add = (name: string, module: string) => {
    const client = MODULE_CLIENTS[module];
    if (client) names.set(name, client);
  };
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const module = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (clause?.name) add(clause.name.text, module);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) add(bindings.name.text, module);
      if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements) {
          // `import { request } from 'undici'` binds a function, so the local name is the client's
          // own export; map it by its imported name below.
          const imported = (element.propertyName ?? element.name).text;
          if (['default', 'axios', 'got', 'ky', 'superagent', 'fetch'].includes(imported))
            add(element.name.text, module);
          else if (MODULE_CLIENTS[module] === 'undici' || MODULE_CLIENTS[module] === 'http')
            if (['request', 'get', 'fetch', 'stream', 'Client', 'Pool', 'Agent'].includes(imported))
              names.set(`fn:${element.name.text}`, MODULE_CLIENTS[module]);
        }
    }
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) {
        const module = declaration.initializer && requiredModule(declaration.initializer);
        if (!module) {
          // `const axios = require('axios').default`.
          const initializer = declaration.initializer && unwrap(declaration.initializer);
          if (
            initializer &&
            ts.isPropertyAccessExpression(initializer) &&
            initializer.name.text === 'default' &&
            ts.isIdentifier(declaration.name)
          ) {
            const inner = requiredModule(initializer.expression);
            if (inner) add(declaration.name.text, inner);
          }
          continue;
        }
        if (ts.isIdentifier(declaration.name)) add(declaration.name.text, module);
        else if (ts.isObjectBindingPattern(declaration.name))
          for (const element of declaration.name.elements)
            if (
              ts.isIdentifier(element.name) &&
              (MODULE_CLIENTS[module] === 'undici' || MODULE_CLIENTS[module] === 'http')
            )
              names.set(`fn:${element.name.text}`, MODULE_CLIENTS[module]);
      }
  }
  return names;
}

const BASE_KEYS = ['baseURL', 'baseUrl', 'prefixUrl', 'origin'];

// Names bound to a client instance: `const api = axios.create({ baseURL })`, `this.http = got.extend(...)`.
function instanceNames(source: ts.SourceFile, imports: Map<string, ApiHostClient>) {
  const names = new Map<string, ApiHostClient>();
  const factory = (expression: ts.Expression) => {
    const node = unwrap(expression);
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression))
      return undefined;
    const receiver = node.expression.expression;
    return ts.isIdentifier(receiver) &&
      ['create', 'extend', 'agent', 'withConfig'].includes(node.expression.name.text)
      ? imports.get(receiver.text)
      : undefined;
  };
  const visit = (node: ts.Node) => {
    const add = (name: string, value: ts.Expression | undefined) => {
      const client = value && factory(value);
      if (client) names.set(name, client);
    };
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
      add(node.name.text, node.initializer);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      add(node.left.getText().replace(/^this\./, ''), node.right);
    if (ts.isPropertyDeclaration(node)) add(node.name.getText(), node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function receiverName(expression: ts.Expression) {
  const node = unwrap(expression);
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword)
    return node.name.text;
  return undefined;
}

// URL sites in a file: the host of every HTTP client call, client creation and client default.
function sitesOf(file: FileInfo, resolver: Resolver): Site[] {
  const { source } = file;
  const imports = clientImports(source);
  const instances = instanceNames(source, imports);
  const sites: Site[] = [];
  const site = (
    expression: ts.Expression | undefined,
    client: ApiHostClient,
    node: ts.Node | undefined = expression,
  ) => {
    if (!expression || !node) return;
    const url = parseUrl(resolver.text(expression, file));
    if (url) sites.push({ host: url.host, pathPrefix: url.path, node, client });
  };
  // An object literal, or the one a variable that is never reassigned holds.
  const objectOf = (expression: ts.Expression | undefined) => {
    let node = expression && unwrap(expression);
    if (node && ts.isIdentifier(node)) {
      const declaration = findDeclaration(node.text, node);
      node =
        declaration?.initializer && (isConst(declaration) || !reassignedName(declaration))
          ? unwrap(declaration.initializer)
          : undefined;
    }
    return node && ts.isObjectLiteralExpression(node) ? node : undefined;
  };
  const options = (object: ts.Expression | undefined, client: ApiHostClient, urlKeys: string[]) => {
    const literal = objectOf(object);
    if (!literal) return;
    for (const key of urlKeys) {
      const value = objectProperty(literal, key);
      if (value) site(value, client);
    }
  };
  // node:http(s) options without a URL: `{ protocol, hostname | host, path }`.
  const httpOptions = (object: ts.Expression | undefined) => {
    const literal = objectOf(object);
    if (!literal) return;
    const hostname = objectProperty(literal, 'hostname') ?? objectProperty(literal, 'host');
    if (!hostname) return;
    const name = resolver.text(hostname, file);
    const path = objectProperty(literal, 'path');
    const protocol = objectProperty(literal, 'protocol');
    const scheme = protocol && resolver.text(protocol, file).startsWith('http:') ? 'http' : 'https';
    const url = parseUrl(`${scheme}://${name}${path ? resolver.text(path, file) : ''}`);
    if (url) sites.push({ host: url.host, pathPrefix: url.path, node: literal, client: 'http' });
  };

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const [first, second] = node.arguments;
      if (ts.isIdentifier(callee)) {
        const client = imports.get(callee.text);
        if (callee.text === 'fetch' && !findDeclaration('fetch', callee)) {
          site(first, 'fetch');
        } else if (client && first) {
          // `axios(url)`, `axios({ url })`, `got(url, options)`, `ky(url)`, `superagent(method, url)`.
          if (client === 'superagent') site(second ?? first, client);
          else if (client === 'fetch') site(first, 'fetch');
          else {
            site(first, client);
            options(first, client, ['url', ...BASE_KEYS]);
            options(second, client, ['url', ...BASE_KEYS]);
          }
        } else if (
          WRAPPER_NAME.test(callee.text) &&
          first &&
          !imports.has(callee.text) &&
          requestShaped(node)
        ) {
          site(first, 'client');
        } else if (imports.has(`fn:${callee.text}`) && first) {
          const kind = imports.get(`fn:${callee.text}`)!;
          site(first, kind);
          if (kind === 'http') httpOptions(first);
          options(first, kind, ['origin']);
        }
      } else if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        const owner = unwrap(callee.expression);
        const client = ts.isIdentifier(owner) ? imports.get(owner.text) : undefined;
        const name = receiverName(owner);
        if (
          ts.isIdentifier(owner) &&
          ['globalThis', 'window', 'self'].includes(owner.text) &&
          method === 'fetch'
        )
          site(first, 'fetch');
        else if (
          client &&
          (HTTP_METHODS.has(method) ||
            ['stream', 'fetch', 'create', 'extend', 'agent'].includes(method)) &&
          first
        ) {
          if (method === 'create' || method === 'extend') {
            options(first, client, BASE_KEYS);
          } else {
            site(first, client);
            if (client === 'http') httpOptions(first);
            options(first, client, ['url', ...BASE_KEYS]);
            options(second, client, ['url', ...BASE_KEYS]);
          }
        } else if (name && instances.has(name) && HTTP_METHODS.has(method) && first) {
          const kind = instances.get(name)!;
          site(first, kind);
          options(first, kind, ['url']);
        } else if (HTTP_METHODS.has(method) && first && requestShaped(node)) site(first, 'client');
      }
    }
    if (ts.isNewExpression(node) && node.arguments?.length) {
      const callee = unwrap(node.expression);
      const kind = ts.isIdentifier(callee) ? imports.get(`fn:${callee.text}`) : undefined;
      if (kind) {
        site(node.arguments[0], kind);
        options(node.arguments[1], kind, BASE_KEYS);
      }
    }
    // `axios.defaults.baseURL = 'https://…'`.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      BASE_KEYS.includes(node.left.name.text) &&
      /(?:^|\.)defaults\.(?:baseURL|baseUrl|prefixUrl)$/.test(
        node.left.getText().replace(/\s+/g, ''),
      )
    ) {
      const root = node.left.getText().split('.')[0];
      const client = imports.get(root);
      if (client) site(node.right, client);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

// A function named like a request helper: `fetchWithTimeout`, `proxyFetch`, `httpRequest`.
const WRAPPER_NAME = /^(?:\w*[fF]etch\w*|http(?:Get|Post|Put|Request)\w*|\w*Request)$/;
const REQUEST_OPTIONS = [
  'headers',
  'body',
  'json',
  'timeout',
  'method',
  'searchParams',
  'data',
  'params',
  'auth',
  'responseType',
  'signal',
];

// Whether a call is used the way an HTTP request is: awaited, chained into a response reader or
// promise, or given request options. A call that merely looks up a key does none of these.
function requestShaped(call: ts.CallExpression) {
  const parent = call.parent;
  if (ts.isAwaitExpression(parent)) return true;
  if (
    ts.isPropertyAccessExpression(parent) &&
    ['json', 'text', 'then', 'catch', 'buffer', 'body', 'blob', 'arrayBuffer'].includes(
      parent.name.text,
    )
  )
    return true;
  const options = call.arguments[1] && unwrap(call.arguments[1]);
  return Boolean(
    options &&
    ts.isObjectLiteralExpression(options) &&
    options.properties.some((property) => REQUEST_OPTIONS.includes(propertyNameOf(property))),
  );
}

function propertyNameOf(property: ts.ObjectLiteralElementLike) {
  return property.name && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))
    ? property.name.text
    : '';
}

// The text of a file that can name an HTTP client; others are not parsed.
const CLIENT_HINT =
  /fetch|axios|\bgot\b|\bky\b|undici|https?['"]|superagent|request|needle|\.(?:get|post|put|patch|delete)\(/i;

// Lists the external HTTP API hosts a repository calls. Pass `options.repository` to reuse files
// already read.
export async function detectApiHosts(
  directory: string,
  options: { repository?: Repository; list?: ApiHostEntry[] } = {},
): Promise<ApiHostScan> {
  const repository = options.repository ?? (await readRepository(resolve(directory)));
  const list = options.list ?? (await loadApiHosts());
  const excluded: ApiHostScan['excluded'] = {};
  const exclude = (reason: ApiHostExclusion) => (excluded[reason] = (excluded[reason] ?? 0) + 1);
  const files: FileInfo[] = repository.files
    .filter((file) => SOURCE_FILE.test(file.path) && file.content.length <= MAX_FILE_CHARACTERS)
    .map((file) => ({ path: file.path, source: sourceOf(file.path, file.content) }));
  const resolver = new Resolver(files);
  const found = new Map<string, ApiHost>();
  const text = new Map(repository.files.map((file) => [file.path, file.content]));
  for (const file of files) {
    if (!CLIENT_HINT.test(text.get(file.path)!)) continue;
    const reason: ApiHostExclusion | undefined =
      TEST_PATH.test(file.path) || TEST_NAME.test(file.path)
        ? 'test-file'
        : DOCS_PATH.test(file.path)
          ? 'docs-file'
          : undefined;
    for (const item of sitesOf(file, resolver)) {
      // A host a provider documents as its API stays even when it looks like a CDN, as
      // cdn.contentful.com does.
      const known = providerOf(item.host, list);
      const detected = reason ?? excludedHost(item.host, item.pathPrefix);
      const why = known && detected === 'asset-url' ? undefined : detected;
      if (why) {
        exclude(why);
        continue;
      }
      const entry = found.get(item.host) ?? {
        host: item.host,
        provider: known,
        count: 0,
        calls: [],
      };
      found.set(item.host, entry);
      entry.count += 1;
      if (entry.calls.length < MAX_EVIDENCE)
        entry.calls.push({
          host: item.host,
          pathPrefix: item.pathPrefix,
          file: file.path,
          line: lineOf(file.source, item.node),
          client: item.client,
        });
    }
  }
  return {
    hosts: [...found.values()].sort((a, b) => b.count - a.count || a.host.localeCompare(b.host)),
    excluded,
  };
}
