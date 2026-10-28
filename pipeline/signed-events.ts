import { randomBytes } from 'node:crypto';
import { resolve, relative } from 'node:path';
import ts from 'typescript-compiler';
import { createSourceImportResolver } from './source-imports.ts';
import type { Finding, Repository } from './types.ts';

// Signed webhook checks: Refit builds a provider's events in both API versions, signs them with a
// secret it generates for the run, and sends them to the application's webhook handler on the
// original code (old-version events) and on the patched code (events of both versions), offline,
// in the behaviour-test sandbox. Nothing here names a provider; an adapter (stripe-signed-events.ts
// for Stripe) says how its handlers verify signatures, which events they handle and how a payload
// looks in each version.

export interface SignedEventSite {
  // The file that verifies the signature, and the exported route handler Refit calls.
  file: string;
  exportName: string;
  // The environment variable the code reads its signing secret from; the run's secret replaces it.
  secretEnv: string;
  eventTypes: string[];
}

export interface SignedEvent {
  type: string;
  // The event body as the provider sends it, serialized, in the old and the new API version.
  before: string;
  after: string;
}

export interface SignedEventAdapter {
  provider: string;
  // The provider's SDK packages: never replaced by a stand-in.
  sdkPackages: readonly string[];
  signatureHeader: string;
  // JavaScript source of `(payload, secret, timestampSeconds) => headerValue`, run in the sandbox
  // with node:crypto's createHmac in scope.
  signer: string;
  newSecret(): string;
  // JavaScript expression for the sandbox's record of provider requests ({ requests, reset }), if
  // the sandbox keeps one, and the source of a regular expression for the provider's object IDs,
  // which a recorded path or error message masks.
  requestRecorder?: string;
  idPattern: string;
  // Handlers whose signed events the patch can affect, or why one cannot be called.
  sites(
    repository: Repository,
    findings: readonly Finding[],
    changedFiles: readonly string[],
  ): { sites: SignedEventSite[]; skipped: { file: string; reason: string }[] };
  events(site: SignedEventSite): SignedEvent[];
}

// The exported route handler of a file: Next.js App Router's `POST`. Other frameworks need a request
// object Refit cannot build yet, and their handlers stay uncovered.
export function routeHandler(content: string, path: string) {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    const exported = ts
      .getModifiers(statement as ts.HasModifiers)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === 'POST') return 'POST';
    if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === 'POST',
      )
    )
      return 'POST';
  }
  for (const statement of source.statements)
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.some((element) => element.name.text === 'POST')
    )
      return 'POST';
}

// What one file imports: specifier, the names it takes, and member names read off a namespace.
function imports(path: string, content: string) {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const found = new Map<string, Set<string>>();
  const add = (specifier: string, name?: string) => {
    const names = found.get(specifier) ?? new Set<string>();
    if (name) names.add(name);
    found.set(specifier, names);
  };
  const namespaces = new Map<string, string>();
  for (const statement of source.statements) {
    // `export { x } from` and `export * from` load the module like an import does.
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      !statement.isTypeOnly
    ) {
      const specifier = statement.moduleSpecifier.text;
      add(specifier);
      if (statement.exportClause && ts.isNamedExports(statement.exportClause))
        for (const element of statement.exportClause.elements)
          add(specifier, (element.propertyName ?? element.name).text);
      continue;
    }
    if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      ts.isStringLiteral(statement.moduleReference.expression)
    ) {
      add(statement.moduleReference.expression.text, 'default');
      continue;
    }
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const specifier = statement.moduleSpecifier.text;
    add(specifier);
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (clause.name) add(specifier, 'default');
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, specifier);
    if (bindings && ts.isNamedImports(bindings))
      for (const element of bindings.elements)
        if (!element.isTypeOnly) add(specifier, (element.propertyName ?? element.name).text);
  }
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text)
    )
      add(namespaces.get(node.expression.text)!, node.name.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    )
      add(node.arguments[0].text, 'default');
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const NODE_BUILTIN =
  /^node:|^(?:assert|buffer|crypto|events|fs|http|https|net|os|path|stream|url|util|zlib)(?:\/|$)/;
// Framework modules the handler needs to behave like a route: real responses and request headers.
export const FRAMEWORK_STAND_INS: Record<string, string> = {
  'next/server': `export class NextResponse extends Response {
  static json(body, init = {}) { return new NextResponse(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } }); }
  static redirect(url, init) { return new NextResponse(null, { status: typeof init === 'number' ? init : 307, headers: { location: String(url) } }); }
  static next() { return new NextResponse(null, { status: 200 }); }
}
export const NextRequest = Request;
export default { NextResponse, NextRequest };`,
  'next/headers': `export function headers() { return globalThis.__refitRequest?.headers ?? new Headers(); }
export function cookies() { return { get: () => undefined, getAll: () => [], has: () => false, set() {}, delete() {} }; }
export function draftMode() { return { isEnabled: false }; }`,
};

// The modules a handler's code imports that Refit replaces with recording stand-ins, so the handler
// runs without a database, an auth service or any other backend, and every call it makes is
// recorded. Never replaced: the provider SDK, Node's builtins, a repository module that imports the
// SDK (directly or through its own imports), a module the patch changes and a module holding a
// finding, so no stand-in sits on a provider code path or hides changed code.
export function standIns(options: {
  repository: Repository;
  handlerFiles: readonly string[];
  sdkPackages: readonly string[];
  keep: ReadonlySet<string>;
}) {
  const root = resolve(options.repository.root);
  const contents = new Map(options.repository.files.map((file) => [file.path, file.content]));
  const sources = new Map(
    options.repository.files.map((file) => [resolve(root, file.path), file.content]),
  );
  const resolver = createSourceImportResolver(options.repository, sources);
  // An installed package's name, never a path or an alias such as `@/lib`, `~/lib`, `#lib` or a
  // repository directory reached through baseUrl.
  const directories = new Set(options.repository.files.map((file) => file.path.split('/')[0]));
  const bare = (specifier: string) =>
    /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/.*)?$/i.test(specifier) &&
    !directories.has(specifier.split('/')[0]);
  const sdk = (specifier: string) =>
    options.sdkPackages.some((name) => specifier === name || specifier.startsWith(`${name}/`));
  const graph = new Map<
    string,
    { local: Map<string, string>; packages: Map<string, Set<string>> }
  >();
  const names = new Map<string, Set<string>>();
  const visit = (path: string) => {
    if (graph.has(path) || !/\.[cm]?[jt]sx?$/.test(path)) return;
    const node = { local: new Map<string, string>(), packages: new Map<string, Set<string>>() };
    graph.set(path, node);
    for (const [specifier, taken] of imports(path, contents.get(path) ?? '')) {
      const target = resolver.resolve(specifier, resolve(root, path));
      const local =
        target && sources.has(target) ? relative(root, target).split('\\').join('/') : undefined;
      if (local) {
        node.local.set(specifier, local);
        const set = names.get(local) ?? new Set<string>();
        for (const name of taken) set.add(name);
        names.set(local, set);
        visit(local);
      } else node.packages.set(specifier, taken);
    }
  };
  for (const file of options.handlerFiles) visit(file);
  // A module is kept when it, or anything it imports, is SDK code or code the patch touched: a
  // fixed point, so an import cycle cannot hide a path to the SDK.
  const kept = new Set(
    [...graph]
      .filter(
        ([path, node]) =>
          options.keep.has(path) ||
          [...node.packages.keys()].some(sdk) ||
          // An import Refit could not resolve might be the SDK client; the module stays real.
          [...node.packages.keys()].some((specifier) => !bare(specifier)),
      )
      .map(([path]) => path),
  );
  for (let grew = true; grew;) {
    grew = false;
    for (const [path, node] of graph)
      if (!kept.has(path) && [...node.local.values()].some((target) => kept.has(target))) {
        kept.add(path);
        grew = true;
      }
  }
  const keeps = (path: string) => kept.has(path);
  const modules: Record<string, string[]> = {};
  const packages: Record<string, string[]> = {};
  for (const [path, node] of graph) {
    if (!options.handlerFiles.includes(path) && !keeps(path))
      modules[path] = [...(names.get(path) ?? [])].sort();
    // Packages are replaced only where a kept module imports them; a stood-in module never loads.
    if (!keeps(path) && !options.handlerFiles.includes(path)) continue;
    for (const [specifier, taken] of node.packages)
      if (
        bare(specifier) &&
        !sdk(specifier) &&
        !NODE_BUILTIN.test(specifier) &&
        !(specifier in FRAMEWORK_STAND_INS)
      )
        packages[specifier] = [...new Set([...(packages[specifier] ?? []), ...taken])].sort();
  }
  return { modules, packages };
}

export const newSigningSecret = (prefix: string) => prefix + randomBytes(24).toString('hex');

// The hook that serves stand-ins, registered by the generated test before it imports a handler.
// Only imports made from repository files are replaced; packages keep their own dependencies.
const HOOK = `import { fileURLToPath } from 'node:url';
let config;
export function initialize(data) { config = data; }
const fromRepository = (parent) => {
  const path = parent?.startsWith('file:') ? fileURLToPath(parent) : '';
  return path.startsWith(config.root) && !path.includes('/node_modules/');
};
export async function resolve(specifier, context, next) {
  if (fromRepository(context.parentURL)) {
    if (Object.hasOwn(config.frameworks, specifier)) return { url: 'refit-stand-in:framework/' + encodeURIComponent(specifier), shortCircuit: true };
    if (Object.hasOwn(config.packages, specifier)) return { url: 'refit-stand-in:package/' + encodeURIComponent(specifier), shortCircuit: true };
  }
  const result = await next(specifier, context);
  if (fromRepository(context.parentURL) && result.url.startsWith('file:')) {
    const path = fileURLToPath(result.url).slice(config.root.length);
    if (Object.hasOwn(config.modules, path)) return { url: 'refit-stand-in:module/' + encodeURIComponent(path), shortCircuit: true };
  }
  return result;
}
export async function load(url, context, next) {
  if (!url.startsWith('refit-stand-in:')) return next(url, context);
  const [kind, encoded] = url.slice('refit-stand-in:'.length).split('/');
  const name = decodeURIComponent(encoded);
  if (kind === 'framework') return { format: 'module', source: config.frameworks[name], shortCircuit: true };
  const exported = (kind === 'module' ? config.modules : config.packages)[name].filter((item) => item !== 'default');
  const label = JSON.stringify(name);
  const source = ['const value = globalThis.__refitStandIn(' + label + ');', 'export default value;']
    .concat(exported.map((item, index) => 'const v' + index + ' = value[' + JSON.stringify(item) + ']; export { v' + index + ' as ' + JSON.stringify(item) + ' };'))
    .join('\\n');
  return { format: 'module', source, shortCircuit: true };
}
`;

// The test the sandbox runs: each event, in both versions, on the original code and on the patched
// code. Each delivery is recorded to .refit-webhooks/ as a shape: what the handler
// returned or threw, every stand-in call with the shapes of its arguments, and every provider request
// (method, path with IDs masked, body shape). Shapes keep types, not values, because each side's mock
// serves its own version's fixtures; a moved field read as undefined still shows.
const TEST = `import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
const config = __CONFIG__;
const sign = __SIGNER__;
const side = process.env.REFIT_GENERATED_SIDE === 'after' ? 'after' : 'before';
const root = process.env.REFIT_GENERATED_ROOT ?? '/workspace/';
const standIns = config.standIns[side];
register('data:text/javascript,' + encodeURIComponent(__HOOK__), import.meta.url, { data: { root, frameworks: config.frameworks, modules: standIns.modules, packages: standIns.packages } });
for (const handler of config.handlers) process.env[handler.secretEnv] = config.secret;
const LABEL = Symbol('refit stand-in');
const calls = [];
const shape = (value, depth = 0) => {
  if (value === null) return null;
  if (value === undefined) return '<undefined>';
  if (typeof value === 'function') return value[LABEL] ? '<stand-in ' + value[LABEL] + '>' : '<function>';
  if (typeof value === 'number') return Number.isNaN(value) ? '<NaN>' : '<number>';
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'object') return '<' + typeof value + '>';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '<Invalid Date>' : '<Date>';
  if (depth > 6) return '<deep>';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => shape(item, depth + 1));
  if (value instanceof Response || value instanceof Request || value instanceof Headers) return '<' + value.constructor.name + '>';
  return Object.fromEntries(Object.keys(value).sort().slice(0, 50).map((key) => [key, shape(value[key], depth + 1)]));
};
const make = (label) => new Proxy(function () {}, {
  get(_, key) {
    if (key === LABEL) return label;
    if (key === 'then') return undefined;
    if (key === Symbol.toPrimitive) return (hint) => (hint === 'number' ? 0 : 'refit:' + label);
    if (key === Symbol.iterator) return function* () {};
    if (key === Symbol.asyncIterator) return async function* () {};
    if (typeof key === 'symbol') return undefined;
    if (key === 'toJSON') return () => 'refit:' + label;
    // Clients such as supabase-js return { data, error }; a stand-in reports no error.
    if (key === 'error') return null;
    return make(label + '.' + key);
  },
  apply(_, __, args) { calls.push({ call: label, args: args.map((arg) => shape(arg)) }); return make(label + '()'); },
  construct(_, args) { calls.push({ call: 'new ' + label, args: args.map((arg) => shape(arg)) }); return make('new ' + label); },
});
globalThis.__refitStandIn = make;
const describe = (error) => error instanceof Error ? error.name + ': ' + error.message : (() => { try { return JSON.stringify(error) ?? String(error); } catch { return String(error); } })();
const masked = (text) => String(text).replace(new RegExp(config.idPattern, 'g'), '<id>').replace(/\\d+/g, '#').slice(0, 300);
const timeout = () => new Promise((_, reject) => {
  const timer = setTimeout(() => reject(Object.assign(new Error('did not settle within 10 seconds'), { timeout: true })), 10000);
  timer.unref();
});
const output = root + '.refit-webhooks/';
mkdirSync(output, { recursive: true });
let index = 0;
async function deliver(handler, event, version) {
  const record = { file: handler.file, handler: handler.exportName, event: event.type, version };
  let module;
  try {
    module = await import(pathToFileURL(root + handler.file).href);
  } catch (error) {
    return { ...record, outcome: 'load', error: describe(error).slice(0, 500) };
  }
  const payload = event[version];
  const timestamp = Math.floor(Date.now() / 1000);
  const request = new Request('http://localhost/' + handler.file, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [config.header]: sign(payload, config.secret, timestamp) },
    body: payload,
  });
  globalThis.__refitRequest = request;
  calls.length = 0;
  const recorder = (__RECORDER__);
  recorder?.reset();
  try {
    const response = await Promise.race([module[handler.exportName](request, { params: {} }), timeout()]);
    const text = response instanceof Response ? await response.text() : '';
    let body = text ? '<text>' : '';
    try { body = shape(JSON.parse(text)); } catch {}
    Object.assign(record, { outcome: 'returned', status: response instanceof Response ? response.status : shape(response), body, ...(response instanceof Response && response.status >= 300 ? { text: text.slice(0, 300) } : {}) });
  } catch (error) {
    Object.assign(record, { outcome: error?.timeout ? 'timeout' : 'threw', error: masked(describe(error)) });
  }
  return {
    ...record,
    calls: calls.slice(0, 200),
    requests: (recorder?.requests ?? []).slice(0, 50).map((item) => ({ method: item.method, path: masked(item.path), body: shape(item.body) })),
  };
}
for (const handler of config.handlers)
  for (const event of handler.events)
    for (const version of ['before', 'after'])
      test(handler.file + ' ' + event.type + ' ' + version, async () => {
        const record = await deliver(handler, event, version);
        writeFileSync(output + String(index++).padStart(4, '0') + '.json', JSON.stringify(record));
      });
`;

export const SIGNED_EVENT_TEST = 'refit-behaviour/refit-signed-events.test.mjs';

export function signedEventTest(options: {
  adapter: SignedEventAdapter;
  secret: string;
  handlers: (SignedEventSite & { events: SignedEvent[] })[];
  standIns: Record<'before' | 'after', ReturnType<typeof standIns>>;
}) {
  const config = {
    secret: options.secret,
    header: options.adapter.signatureHeader,
    idPattern: options.adapter.idPattern,
    frameworks: FRAMEWORK_STAND_INS,
    standIns: options.standIns,
    handlers: options.handlers.map(({ file, exportName, secretEnv, events }) => ({
      file,
      exportName,
      secretEnv,
      events,
    })),
  };
  return {
    path: SIGNED_EVENT_TEST,
    content: TEST.replace('__CONFIG__', () => JSON.stringify(config))
      .replace('__SIGNER__', () => options.adapter.signer)
      .replace('__RECORDER__', () => options.adapter.requestRecorder ?? 'undefined')
      .replace('__HOOK__', () => JSON.stringify(HOOK)),
  };
}

export interface DeliveryRecord {
  file: string;
  handler: string;
  event: string;
  version: 'before' | 'after';
  outcome: 'load' | 'returned' | 'threw' | 'timeout';
  status?: unknown;
  body?: unknown;
  text?: string;
  error?: string;
  calls?: { call: string; args: unknown[] }[];
  requests?: { method: string; path: string; body: unknown }[];
}

const completed = (record?: DeliveryRecord) =>
  record?.outcome === 'returned' && typeof record.status === 'number' && record.status < 300;
const summary = (record?: DeliveryRecord) =>
  !record
    ? 'no result'
    : record.outcome === 'returned'
      ? `returned ${String(record.status)}${record.text ? ` (${record.text.slice(0, 120)})` : ''}`
      : record.outcome === 'load'
        ? `did not load: ${record.error}`
        : `${record.outcome === 'timeout' ? 'timed out' : 'threw'}: ${record.error}`;
// What a delivery did, without the fields that name it.
const behaviour = (record: DeliveryRecord) => {
  const {
    file: _file,
    handler: _handler,
    event: _event,
    version: _version,
    text: _text,
    ...rest
  } = record;
  return rest;
};

// The first place two deliveries differ, said so a reviewer can find it. Inside a stand-in call's
// arguments a key only one side has is skipped: a whole provider object passed to a backend
// legitimately gains and loses fields between versions; a field the code names stays on both sides.
export function firstDifference(
  a: unknown,
  b: unknown,
  path = '',
  sides: [string, string] = ['the old-version event', 'the new-version event'],
): string | undefined {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const argument = /^calls\[\d+\]\.args\[/.test(path) && !Array.isArray(a);
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])]) {
      if (argument && !(Object.hasOwn(a, key) && Object.hasOwn(b, key))) continue;
      const where = Array.isArray(a) ? `${path}[${key}]` : path ? `${path}.${key}` : key;
      const found = firstDifference(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        where,
        sides,
      );
      if (found) return found;
    }
    // Every key either matched or was skipped; arrays of different lengths differ at an index.
    return;
  }
  return `${path || 'the result'}: ${JSON.stringify(a) ?? 'absent'} on ${sides[0]}, ${JSON.stringify(b) ?? 'absent'} on ${sides[1]}`;
}

export type SignedEventStatus = 'passed' | 'unresolved' | 'regression' | 'not-runnable';

const failed = (record?: DeliveryRecord) =>
  record?.outcome === 'threw' || record?.outcome === 'timeout' || record?.outcome === 'load';

// What the deliveries prove, per handler and event. Same code, same values: only the event's API
// version differs between the two deliveries on one side.
// - Counted, as a regression that fails validation: an event the original code completed (a 2xx
//   response) and handled the same way in both versions, which the patched code handles
//   differently in the new version; and one where the original code still returned on the new
//   version and the patched code throws.
// - Unresolved, a [Needs review] draft: an event both the original and the patched code handle
//   differently in the new version (the patch did not cause it and did not fix it), and an event
//   whose stand-in calls on the patched code differ from the original's on the old version, which
//   each side's own mock cannot explain alone.
// - Excluded: an event the original code does not complete with the old version (the handler
//   needs something the sandbox lacks, or did not accept the signature).
// - Reported, never counted: a delivery that left no record, a patched module that does not load,
//   and patched code that fails the same way on both versions where the original completed.
// A handler file covers its changed lines only when every event the original completed behaved the
// same on both versions on the patched code and matched the original's calls, and every changed
// line of the file ran on both sides: coverage is per process, so an event that did not count
// could otherwise have run the lines.
export function compareSignedEvents(options: {
  sites: SignedEventSite[];
  original: DeliveryRecord[];
  patched: DeliveryRecord[];
  // Changed lines of each file the behaviour harness saw not run, per side.
  missing: Record<'original' | 'patched', Record<string, number[]>>;
  changedFiles: readonly string[];
}) {
  const find = (records: DeliveryRecord[], file: string, event: string, version: string) =>
    records.find(
      (record) => record.file === file && record.event === event && record.version === version,
    );
  const regressions: { id: string; error: string }[] = [];
  const unresolved: { id: string; error: string }[] = [];
  const covered: string[] = [];
  const handlers = options.sites.map((site) => {
    const events = site.eventTypes.map((type) => {
      const [originalBefore, originalAfter, before, after] = [
        find(options.original, site.file, type, 'before'),
        find(options.original, site.file, type, 'after'),
        find(options.patched, site.file, type, 'before'),
        find(options.patched, site.file, type, 'after'),
      ];
      const results = {
        type,
        original: { before: summary(originalBefore), after: summary(originalAfter) },
        patched: { before: summary(before), after: summary(after) },
      };
      if (!completed(originalBefore))
        return { ...results, result: 'not-runnable' as const, detail: results.original.before };
      if (!originalAfter || !before || !after)
        return {
          ...results,
          result: 'not-counted' as const,
          detail: 'A delivery left no record.',
        };
      if (before.outcome === 'load' || after.outcome === 'load')
        return {
          ...results,
          result: 'not-counted' as const,
          detail: 'The handler did not load on the patched code.',
        };
      const id = `${site.file} ${type}`;
      const difference = firstDifference(behaviour(before), behaviour(after));
      const originalDifference = firstDifference(
        behaviour(originalBefore!),
        behaviour(originalAfter),
      );
      if (difference && (!originalDifference || (failed(after) && !failed(originalAfter)))) {
        regressions.push({ id, error: difference });
        return { ...results, result: 'differs' as const, detail: difference };
      }
      if (difference) {
        unresolved.push({ id, error: difference });
        return { ...results, result: 'unresolved' as const, detail: difference };
      }
      if (!completed(before))
        return {
          ...results,
          result: 'not-counted' as const,
          detail: `The patched code ${results.patched.before} on events of both versions; the original completed against its own version's mock.`,
        };
      const crossSide = firstDifference(
        { calls: originalBefore!.calls },
        { calls: before.calls },
        '',
        ['the original code', 'the patched code'],
      );
      if (crossSide) {
        const error = `${crossSide} (old-version event)`;
        unresolved.push({ id, error });
        return { ...results, result: 'unresolved' as const, detail: error };
      }
      return {
        ...results,
        result: 'same' as const,
        ...(originalDifference
          ? {
              detail: `The original code handled the new-version event differently (${originalDifference}); the patched code does not.`,
            }
          : {}),
      };
    });
    const unrun = (['original', 'patched'] as const).flatMap((side) =>
      (options.missing[side][site.file] ?? []).map((line) => `${side} line ${line}`),
    );
    const counted = events.filter((event) => event.result !== 'not-runnable');
    if (
      counted.length &&
      counted.every((event) => event.result === 'same') &&
      !unrun.length &&
      options.changedFiles.includes(site.file)
    )
      covered.push(site.file);
    return {
      file: site.file,
      handler: site.exportName,
      events,
      ...(unrun.length ? { linesNotRun: unrun } : {}),
    };
  });
  const status: SignedEventStatus = regressions.length
    ? 'regression'
    : unresolved.length
      ? 'unresolved'
      : handlers.some((handler) => handler.events.some((event) => event.result === 'same'))
        ? 'passed'
        : 'not-runnable';
  return { status, handlers, covered, regressions, unresolved };
}

export function signedEventRecords(stdout: string) {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('REFIT_WEBHOOK_RECORD='))
    .map((line) => JSON.parse(line.slice('REFIT_WEBHOOK_RECORD='.length)) as DeliveryRecord);
}

// The signed-event test for one validation, or why there is none. Stand-ins are computed per side:
// a patch can add a module (Refit's generated helper) and changes what counts as patched code.
export function prepareSignedEvents(options: {
  adapter: SignedEventAdapter;
  original: Repository;
  patched: Repository;
  findings: readonly Finding[];
  // Source files the patch changes (changedStripeLines), on either side.
  changedFiles: readonly string[];
}) {
  const { sites, skipped } = options.adapter.sites(
    options.patched,
    options.findings,
    options.changedFiles,
  );
  const present = (repository: Repository, path: string) =>
    repository.files.some((file) => file.path === path);
  const runnable = sites.filter((site) => present(options.original, site.file));
  for (const site of sites)
    if (!runnable.includes(site))
      skipped.push({ file: site.file, reason: 'The original code has no such handler.' });
  if (!runnable.length) return { sites: runnable, skipped };
  const handlerFiles = runnable.map((site) => site.file);
  // Every file the patch adds or changes stays real, Refit's generated helper module included.
  const before = new Map(options.original.files.map((file) => [file.path, file.content]));
  const keep = new Set([
    ...options.patched.files
      .filter((file) => before.get(file.path) !== file.content)
      .map((file) => file.path),
    ...options.findings.map((finding) => finding.file),
  ]);
  const side = (repository: Repository) =>
    standIns({ repository, handlerFiles, sdkPackages: options.adapter.sdkPackages, keep });
  return {
    sites: runnable,
    skipped,
    test: signedEventTest({
      adapter: options.adapter,
      secret: options.adapter.newSecret(),
      handlers: runnable.map((site) => ({ ...site, events: options.adapter.events(site) })),
      standIns: { before: side(options.original), after: side(options.patched) },
    }),
  };
}

// A benchmark row's view of the evidence: the status, which files it covered, what counted against
// the patch, and each event's result with the reason where it did not run.
export function signedEventSummary(evidence: {
  status: string;
  reason?: string;
  covered?: string[];
  regressions?: { id: string; error: string }[];
  unresolved?: { id: string; error: string }[];
  skipped?: { file: string; reason: string }[];
  handlers?: { file: string; events: { type: string; result: string; detail?: string }[] }[];
}) {
  return {
    status: evidence.status,
    ...(evidence.reason ? { reason: evidence.reason } : {}),
    covered: evidence.covered ?? [],
    regressions: evidence.regressions ?? [],
    unresolved: evidence.unresolved ?? [],
    ...(evidence.skipped?.length ? { skipped: evidence.skipped } : {}),
    events: (evidence.handlers ?? []).flatMap((handler) =>
      handler.events.map((event) => ({
        id: `${handler.file} ${event.type}`,
        result: event.result,
        ...(event.detail ? { detail: event.detail.slice(0, 300) } : {}),
      })),
    ),
  };
}
