import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import ts from 'typescript-compiler';
import { removeDockerContainer, resolveDockerImage } from './docker-sandbox.ts';
import { createSourceImportResolver } from './source-imports.ts';
import { digest } from './specifications.ts';
import { PipelineInputError, type Finding, type Repository } from './types.ts';
import type { CheckResult } from './validation.ts';

const execute = promisify(execFile);
const PROCESS_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_ENTRY_PARAMETERS = 3;
const MAX_ENTRY_POINTS = 20;
const ENTRY_TIMEOUT_MS = 10_000;
// The harness prints this after its last entry; without it a side stopped early.
const GENERATED_DONE = 'REFIT_GENERATED_DONE';
// The binary path inside the official stripe/stripe-mock image.
const STRIPE_MOCK_BINARY = '/bin/stripe-mock';
export const MOCK_PORT = 12111;
const SOURCE_FILE = /\.(?:[cm]?js|[cm]?ts)$/;

export interface GeneratedChecks {
  stripeMockImage: string;
  beforeFixtures: string;
  afterFixtures: string;
}

export interface EntryPoint {
  file: string;
  name: string;
  parameters: number;
}

// Local names exported through `export { local, local as alias }` lists, mapped to the export name.
function exportListNames(source: ts.SourceFile) {
  const names = new Map<string, string>();
  for (const statement of source.statements)
    if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      !statement.isTypeOnly &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    )
      for (const element of statement.exportClause.elements)
        if (!element.isTypeOnly)
          names.set((element.propertyName ?? element.name).text, element.name.text);
  return names;
}

function exportedName(node: ts.Node, listed: Map<string, string>): string | undefined {
  const modifiers = ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
  const exported = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  const isDefault = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
  if (ts.isFunctionDeclaration(node) && exported) return isDefault ? 'default' : node.name?.text;
  if (ts.isFunctionDeclaration(node) && node.name && ts.isSourceFile(node.parent))
    return listed.get(node.name.text);
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name) &&
    ts.isVariableDeclarationList(node.parent.parent) &&
    node.parent.parent.flags & ts.NodeFlags.Const &&
    ts.isVariableStatement(node.parent.parent.parent) &&
    ts.isSourceFile(node.parent.parent.parent.parent)
  )
    return (ts.getModifiers(node.parent.parent.parent) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    )
      ? node.parent.name.text
      : listed.get(node.parent.name.text);
  return undefined;
}

// Only parameters Refit can fill with placeholder IDs qualify: untyped or `string` identifiers.
function placeholderParameters(node: ts.SignatureDeclaration) {
  return (
    node.parameters.length <= MAX_ENTRY_PARAMETERS &&
    node.parameters.every(
      (parameter) =>
        ts.isIdentifier(parameter.name) &&
        !parameter.dotDotDotToken &&
        (!parameter.type || parameter.type.kind === ts.SyntaxKind.StringKeyword),
    )
  );
}

// The exported functions enclosing confirmed findings, and how many findings no entry covers.
export function generatedEntryPoints(repository: Repository, findings: Finding[]) {
  const confirmed = findings.filter((finding) => finding.confidence === 'confirmed');
  const entries = new Map<string, EntryPoint>();
  let uncovered = 0;
  for (const finding of confirmed) {
    const file = repository.files.find((candidate) => candidate.path === finding.file);
    if (!file || !SOURCE_FILE.test(file.path)) {
      uncovered++;
      continue;
    }
    const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
    const listed = exportListNames(source);
    const position = source.getPositionOfLineAndCharacter(finding.line - 1, finding.column - 1);
    let node: ts.Node | undefined = source;
    let enclosing: ts.SignatureDeclaration | undefined;
    let name: string | undefined;
    // The innermost exported function wins, so findings in inline callbacks map to their caller.
    for (;;) {
      const next: ts.Node | undefined = node!
        .getChildren(source)
        .find((child) => child.getStart(source) <= position && position < child.getEnd());
      if (!next) break;
      const exported = ts.isFunctionLike(next) ? exportedName(next, listed) : undefined;
      if (exported) {
        enclosing = next as ts.SignatureDeclaration;
        name = exported;
      }
      node = next;
    }
    const key = `${file.path}#${name}`;
    if (
      !enclosing ||
      !name ||
      !placeholderParameters(enclosing) ||
      (!entries.has(key) && entries.size >= MAX_ENTRY_POINTS)
    ) {
      uncovered++;
      continue;
    }
    entries.set(key, {
      file: file.path,
      name,
      parameters: enclosing.parameters.length,
    });
  }
  return { entries: [...entries.values()], uncovered };
}

// Maps each source file's static and literal dynamic import specifiers to the repository file Refit's
// own resolver chose, so the sandbox can load extensionless and tsconfig-aliased TypeScript imports.
export function generatedImportMap(repository: Repository) {
  const root = resolve(repository.root);
  const sources = new Map(repository.files.map((file) => [resolve(root, file.path), file.content]));
  const resolver = createSourceImportResolver(repository, sources);
  const map: Record<string, Record<string, string>> = {};
  for (const file of repository.files) {
    if (!SOURCE_FILE.test(file.path)) continue;
    const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
    const specifiers: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      )
        specifiers.push(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteralLike(node.arguments[0])
      )
        specifiers.push(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const specifier of specifiers) {
      const target = resolver.resolve(specifier, resolve(root, file.path));
      if (target && sources.has(target))
        (map[file.path] ??= {})[specifier] = relative(root, target).split('\\').join('/');
    }
  }
  return map;
}

// Credentials and service addresses the repository's code reads from the environment. A client
// created at import, such as createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', ...), throws
// without them and the module never loads. The sandbox gives them placeholders that lead nowhere (a
// closed loopback port) and never replaces a value that is set. Other variables stay unset.
const PLACEHOLDER_URL = 'http://127.0.0.1:9/refit-placeholder';
const PLACEHOLDER_SECRET = 'refit_placeholder_secret';
const ENVIRONMENT_READ =
  /process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\])/g;
const ENVIRONMENT_DESTRUCTURING = /\{([^{}]*)\}\s*=\s*process\.env\b/g;

export function generatedEnvironment(...repositories: Repository[]) {
  const names = new Set<string>();
  for (const file of repositories.flatMap((repository) => repository.files)) {
    if (!SOURCE_FILE.test(file.path) || !file.content.includes('process.env')) continue;
    for (const match of file.content.matchAll(ENVIRONMENT_READ)) names.add(match[1] ?? match[2]);
    for (const match of file.content.matchAll(ENVIRONMENT_DESTRUCTURING))
      for (const part of match[1].split(',')) names.add(part.split(/[:=]/)[0].trim());
  }
  return Object.fromEntries(
    [...names]
      .sort()
      .flatMap((name) =>
        /(?:^|_)(?:URL|URI|DSN|ENDPOINT)$/.test(name)
          ? [[name, PLACEHOLDER_URL]]
          : /(?:^|_)(?:KEY|SECRET|TOKEN)$/.test(name)
            ? [[name, PLACEHOLDER_SECRET]]
            : [],
      ),
  );
}

// The sandbox load hook and the behaviour-test coverage mapping transpile with these same options,
// so V8's offsets into the hook's output map back to TypeScript lines through the inline source map.
const SANDBOX_COMPILER_OPTIONS = {
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ES2022,
  jsx: ts.JsxEmit.ReactJSX,
  esModuleInterop: true,
  inlineSourceMap: true,
  // Comments are kept and mapped otherwise, which would make a comment line look executable.
  removeComments: true,
  newLine: ts.NewLineKind.LineFeed,
};

// What the sandbox runs for a TypeScript file at `fileName` (its path inside the sandbox).
export function sandboxTranspile(content: string, fileName: string) {
  return ts.transpileModule(content, { fileName, compilerOptions: SANDBOX_COMPILER_OPTIONS })
    .outputText;
}

// The module behaviour tests import Stripe's recorded requests from.
export const BEHAVIOUR_MODULE = 'refit:behaviour';

// TypeScript sources are transpiled with the bundled compiler rather than Node's type stripping,
// which keeps imports of type-only names (\`import { Price }\`) and fails at runtime.
const RESOLVE = `import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = process.env.REFIT_GENERATED_ROOT ?? '/workspace/';
// Each side has its own map: a patch can add a module (the generated helper) the original lacks.
const side = process.env.REFIT_GENERATED_SIDE === 'after' ? 'after' : 'before';
const map = JSON.parse(readFileSync(new URL('imports-' + side + '.json', import.meta.url), 'utf8'));
let ts;
const compiler = () =>
  (ts ??= createRequire(import.meta.url)(process.env.REFIT_TYPESCRIPT ?? '/refit/typescript/lib/typescript.js'));
const TYPESCRIPT = /\\.(?:[cm]?ts|tsx)$/;
// Extensions Node or TypeScript resolve as modules; './workerTimers.worker' has none of them.
const EXTENSION = /\\.(?:[cm]?[jt]sx?|json|node)$/i;
const UNRESOLVED = new Set(['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT']);
export async function resolve(specifier, context, next) {
  if (specifier === '${BEHAVIOUR_MODULE}') return { url: '${BEHAVIOUR_MODULE}', shortCircuit: true };
  const parent = context.parentURL?.startsWith('file:') ? fileURLToPath(context.parentURL) : '';
  const target = parent.startsWith(root) ? map[parent.slice(root.length)]?.[specifier] : undefined;
  if (target) return next(pathToFileURL(root + target).href, context);
  try {
    return await next(specifier, context);
  } catch (error) {
    // Next.js bundles routes, so their extensionless imports (next/server, and ./routeMatcher in
    // @clerk/nextjs's ESM build) resolve there; Node's ESM loader needs the file named.
    if (!UNRESOLVED.has(error?.code) || EXTENSION.test(specifier) || specifier.startsWith('node:'))
      throw error;
    for (const suffix of ['.js', '/index.js']) {
      try {
        return await next(specifier + suffix, context);
      } catch (retry) {
        if (!UNRESOLVED.has(retry?.code)) throw retry;
      }
    }
    throw error;
  }
}
export async function load(url, context, next) {
  if (url === '${BEHAVIOUR_MODULE}')
    return {
      format: 'module',
      source: 'export const stripeRequests = globalThis.__refitStripe.requests; export const resetStripeRequests = globalThis.__refitStripe.reset;',
      shortCircuit: true,
    };
  // Bundlers import JSON without an attribute (import pkg from 'next/package.json'); Node's ESM
  // loader refuses that, so the sandbox serves it as a module whose default export is the data.
  if (url.startsWith('file:') && url.endsWith('.json') && context.importAttributes?.type !== 'json')
    return { format: 'module', source: 'export default ' + readFileSync(fileURLToPath(url), 'utf8') + ';', shortCircuit: true };
  if (!url.startsWith('file:') || !TYPESCRIPT.test(url)) return next(url, context);
  const path = fileURLToPath(url);
  const output = compiler().transpileModule(readFileSync(path, 'utf8'), {
    fileName: path,
    compilerOptions: ${JSON.stringify(SANDBOX_COMPILER_OPTIONS)},
  });
  return { format: 'module', source: output.outputText, shortCircuit: true };
}
`;

// Redirects the Stripe SDK's HTTPS requests for api.stripe.com to stripe-mock on loopback, or, in
// Stripe test mode, to the sandbox proxy (REFIT_STRIPE_MOCK_HOST, provider-sandbox.ts). The SDK
// writes request bodies after `secureConnect`, so the plain socket re-emits it on `connect`. Each
// request is recorded for behaviour tests: method, path, query and form body decoded to plain
// objects (\`a[b][0]=x\` to \`{ a: { b: ['x'] } }\`), and the Stripe-Version header.
const REDIRECT = `import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { register } from 'node:module';
register('./resolve.mjs', import.meta.url);
for (const [name, value] of Object.entries(JSON.parse(readFileSync(new URL('environment.json', import.meta.url), 'utf8'))))
  process.env[name] ??= value;
const host = process.env.REFIT_STRIPE_MOCK_HOST ?? '127.0.0.1';
const port = Number(process.env.REFIT_STRIPE_MOCK_PORT ?? ${MOCK_PORT});
const requests = [];
globalThis.__refitStripe = { requests, reset: () => { requests.length = 0; } };
const decode = (text) => decodeURIComponent(text.replace(/\\+/g, ' '));
const arrays = (value) => {
  if (!value || typeof value !== 'object') return value;
  const keys = Object.keys(value);
  for (const key of keys) value[key] = arrays(value[key]);
  return keys.length && keys.every((key, index) => key === String(index)) ? keys.map((key) => value[key]) : value;
};
const parseForm = (text) => {
  const root = {};
  for (const pair of text.split('&')) {
    if (!pair) continue;
    const split = pair.indexOf('=');
    const key = decode(split < 0 ? pair : pair.slice(0, split));
    const path = key.replace(/\\]/g, '').split('[');
    let node = root;
    path.forEach((part, index) => {
      const name = part === '' ? String(Object.keys(node).length) : part;
      if (index === path.length - 1) node[name] = split < 0 ? '' : decode(pair.slice(split + 1));
      else node = node[name] = node[name] && typeof node[name] === 'object' ? node[name] : {};
    });
  }
  return arrays(root);
};
const request = https.request;
https.request = function (options, ...rest) {
  if (options && typeof options === 'object' && (options.hostname ?? options.host) === 'api.stripe.com') {
    const { agent, ...plain } = options;
    // The sandbox proxy replaces this placeholder with Refit's test key and forwards by Host.
    const headers = { ...plain.headers, Authorization: 'Bearer sk_test_123', Host: 'api.stripe.com' };
    const req = http.request({ ...plain, headers, protocol: 'http:', hostname: host, host, port }, ...rest);
    req.once('socket', (socket) => socket.once('connect', () => socket.emit('secureConnect')));
    const chunks = [];
    const keep = (chunk) => { if (chunk != null && typeof chunk !== 'function') chunks.push(Buffer.from(chunk)); };
    const write = req.write;
    req.write = function (chunk, ...args) { keep(chunk); return write.call(this, chunk, ...args); };
    const end = req.end;
    req.end = function (chunk, ...args) {
      keep(chunk);
      const [path, query = ''] = String(plain.path ?? '/').split(/\\?(.*)/s);
      const version = Object.entries(plain.headers ?? {}).find(([name]) => name.toLowerCase() === 'stripe-version');
      requests.push({ method: String(plain.method ?? 'GET').toUpperCase(), path, query: parseForm(query), body: parseForm(Buffer.concat(chunks).toString()), stripeVersion: version ? String(version[1]) : null });
      return end.call(this, chunk, ...args);
    };
    return req;
  }
  return request.call(this, options, ...rest);
};
`;

// Each entry records whether it failed while loading its module or during the call; a call that
// does not settle in ENTRY_TIMEOUT_MS is stopped so one hanging function cannot use up the sandbox.
const HARNESS = `import { connect } from 'node:net';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const port = Number(process.env.REFIT_STRIPE_MOCK_PORT ?? ${MOCK_PORT});
const root = process.env.REFIT_GENERATED_ROOT ?? '/workspace/';
const entries = JSON.parse(await readFile(new URL('entries.json', import.meta.url), 'utf8'));
for (let attempt = 0; ; attempt++) {
  const ready = await new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1', () => { socket.end(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
  if (ready) break;
  if (attempt > 100) throw new Error('stripe-mock did not start');
  await new Promise((resolve) => setTimeout(resolve, 100));
}
// Clients such as supabase-js throw plain objects, which String() prints as [object Object].
const describe = (error) => {
  if (error instanceof Error) return error.name + ': ' + error.message;
  try { return JSON.stringify(error) ?? String(error); } catch { return String(error); }
};
const timeout = () => new Promise((_, reject) => {
  const timer = setTimeout(() => reject(Object.assign(new Error('did not settle within ${ENTRY_TIMEOUT_MS / 1000} seconds'), { phase: 'timeout' })), ${ENTRY_TIMEOUT_MS});
  timer.unref();
});
for (const entry of entries) {
  const id = entry.file + '#' + entry.name;
  let phase = 'load';
  try {
    const module = await Promise.race([import(pathToFileURL(root + entry.file).href), timeout()]);
    if (typeof module[entry.name] !== 'function') throw new Error(id + ' is not an exported function');
    phase = 'call';
    const args = Array.from({ length: entry.parameters }, (_, index) => 'refit_placeholder_' + (index + 1));
    await Promise.race([module[entry.name](...args), timeout()]);
    console.log('REFIT_GENERATED_RESULT=' + JSON.stringify({ id, ok: true }));
  } catch (error) {
    const text = describe(error);
    phase = error?.phase === 'timeout' ? 'timeout' : phase;
    console.log('REFIT_GENERATED_RESULT=' + JSON.stringify({ id, ok: false, phase, error: text.slice(0, 500) }));
  }
}
// A stopped call may still hold the event loop open; exit once everything printed is written.
process.stdout.write('${GENERATED_DONE}\\n', () => process.exit(0));
`;

export type GeneratedPhase = 'load' | 'call' | 'timeout';

// Per-function results printed by the harness; a missing line means the harness did not reach it.
export function generatedResults(stdout: string) {
  const results = new Map<string, { ok: boolean; phase?: GeneratedPhase; error?: string }>();
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('REFIT_GENERATED_RESULT=')) continue;
    const value: unknown = JSON.parse(line.slice('REFIT_GENERATED_RESULT='.length));
    if (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { id?: unknown }).id === 'string' &&
      typeof (value as { ok?: unknown }).ok === 'boolean'
    ) {
      const { id, ok, phase, error } = value as {
        id: string;
        ok: boolean;
        phase?: unknown;
        error?: unknown;
      };
      results.set(id, {
        ok,
        ...(phase === 'load' || phase === 'call' || phase === 'timeout' ? { phase } : {}),
        ...(typeof error === 'string' ? { error } : {}),
      });
    }
  }
  return results;
}

export async function writeHarness(
  directory: string,
  entries: EntryPoint[],
  imports: Record<string, Record<string, string>> = {},
  patchedImports = imports,
  environment: Record<string, string> = {},
) {
  await writeFile(join(directory, 'environment.json'), JSON.stringify(environment), {
    mode: 0o444,
  });
  await writeFile(join(directory, 'redirect.mjs'), REDIRECT, { mode: 0o444 });
  await writeFile(join(directory, 'resolve.mjs'), RESOLVE, { mode: 0o444 });
  await writeFile(join(directory, 'imports-before.json'), JSON.stringify(imports), { mode: 0o444 });
  await writeFile(join(directory, 'imports-after.json'), JSON.stringify(patchedImports), {
    mode: 0o444,
  });
  await writeFile(join(directory, 'harness.mjs'), HARNESS, { mode: 0o444 });
  await writeFile(join(directory, 'entries.json'), JSON.stringify(entries), { mode: 0o444 });
}

export function generatedCommand(side: 'before' | 'after') {
  return [
    'sh',
    '-c',
    `(/refit/stripe-mock -http-addr 127.0.0.1:${MOCK_PORT} -spec /refit/spec.json -fixtures /refit/fixtures.json >/tmp/refit-stripe-mock.log 2>&1 &); ` +
      `STRIPE_SECRET_KEY=sk_test_123 STRIPE_API_KEY=sk_test_123 STRIPE_KEY=sk_test_123 REFIT_GENERATED_SIDE=${side} ` +
      'exec node --import /refit/generated/redirect.mjs /refit/generated/harness.mjs',
  ];
}

// The bundled TypeScript compiler package, mounted read-only for the sandbox load hook.
export function typescriptDirectory() {
  return dirname(createRequire(import.meta.url).resolve('typescript-compiler/package.json'));
}

// Copies the stripe-mock binary out of an existing local image; images are never pulled.
export async function extractStripeMock(image: string, directory: string) {
  const imageId = await resolveDockerImage(image);
  const name = `refit-stripe-mock-${digest(directory).slice(0, 12)}`;
  const binary = join(directory, 'stripe-mock');
  try {
    await execute('docker', ['create', '--name', name, '--pull', 'never', imageId], {
      timeout: PROCESS_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    await execute('docker', ['cp', `${name}:${STRIPE_MOCK_BINARY}`, binary], {
      timeout: PROCESS_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
  } finally {
    await removeDockerContainer(name);
  }
  return { imageId, binary, binaryHash: digest(await readFile(binary)) };
}

// stripe-mock reads JSON only; YAML contracts cannot be served. The copy is world-readable because
// the sandbox user cannot read private run artifacts (mode 600, owned by the worker).
export async function stageMockDocument(path: string, label: string, destination: string) {
  const content = await readFile(path, 'utf8');
  if (!content.trimStart().startsWith('{'))
    throw new PipelineInputError(`Generated checks require a JSON ${label}.`);
  await writeFile(destination, content, { mode: 0o444 });
  return digest(content);
}

// Why a side's harness gives no evidence: the container failed or timed out, or the harness stopped
// before its last entry (stripe-mock did not start, a crash, an exit from application code).
function brokenSide(side: 'before' | 'after', check: CheckResult) {
  if (check.status === 'not-run') return undefined;
  if (check.status === 'error')
    return `The ${side}-version run did not finish: ${check.error ?? 'the container failed'}`;
  if (check.stdout.split('\n').includes(GENERATED_DONE)) return undefined;
  // Node prints an uncaught error as source, caret, `Error: message`, stack and its version.
  const lines = check.stderr.split('\n').map((line) => line.trim());
  const error = lines.find((line) => /^[A-Za-z]*Error\b/.test(line));
  return `The ${side}-version harness stopped before its last function (exit code ${check.exitCode ?? 'none'})${error ? `: ${error.slice(0, 300)}` : '.'}`;
}

// unavailable: the check is broken (setup, container, harness); not-runnable: it ran, but no
// function ran on both sides; not-run: no confirmed finding has an entry point.
export type GeneratedStatus = 'passed' | 'regression' | 'unavailable' | 'not-runnable' | 'not-run';

// What counts against a patch: a function that loaded and completed on the original code against
// the before-version mock, and whose call then threw on the patched code against the after-version
// mock. Same function, same placeholder arguments, same deterministic fixtures: the only
// differences are the patch and the API version, which is what a migration must survive. Everything
// else is a limit of the harness and is reported, never counted: a function that cannot run on the
// original code (it needs a database, a framework runtime), a module that loads on one side only
// (the dependency tree differs after a stripe-node upgrade), a timeout, and a side whose harness or
// container did not finish.
export function compareGeneratedRuns(
  entries: EntryPoint[],
  before: CheckResult,
  after: CheckResult,
) {
  const original = generatedResults(before.stdout);
  const patched = generatedResults(after.stdout);
  const id = (entry: EntryPoint) => `${entry.file}#${entry.name}`;
  const failure = (results: typeof original, entry: EntryPoint) => ({
    id: id(entry),
    ...(results.get(id(entry))?.phase ? { phase: results.get(id(entry))!.phase } : {}),
    error: results.get(id(entry))?.error ?? 'No result recorded.',
  });
  const broken = brokenSide('before', before) ?? brokenSide('after', after);
  const notRunnable = entries
    .filter((entry) => !original.get(id(entry))?.ok)
    .map((entry) => failure(original, entry));
  const failed = broken
    ? []
    : entries.filter((entry) => original.get(id(entry))?.ok && !patched.get(id(entry))?.ok);
  const regressions = failed
    .filter((entry) => patched.get(id(entry))?.phase === 'call')
    .map((entry) => failure(patched, entry));
  const unavailableEntries = failed
    .filter((entry) => patched.get(id(entry))?.phase !== 'call')
    .map((entry) => failure(patched, entry));
  const ran = broken ? 0 : entries.length - notRunnable.length - failed.length;
  const status: GeneratedStatus = broken
    ? 'unavailable'
    : regressions.length
      ? 'regression'
      : ran
        ? 'passed'
        : entries.length
          ? 'not-runnable'
          : 'not-run';
  return {
    status,
    ...(broken ? { reason: broken } : {}),
    ...(status === 'not-runnable'
      ? {
          reason: unavailableEntries.length
            ? `No exported function ran on both sides: ${unavailableEntries.length} that ran on the original code did not load or settle on the patched code.`
            : `None of the ${entries.length} exported functions ran on the original code in isolation.`,
        }
      : {}),
    ran,
    notRunnable,
    unavailableEntries,
    regressions,
    baseline: before,
    patched: after,
  };
}
