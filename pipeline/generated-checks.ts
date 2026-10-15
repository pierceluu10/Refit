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

// TypeScript sources are transpiled with the bundled compiler rather than Node's type stripping,
// which keeps imports of type-only names (\`import { Price }\`) and fails at runtime.
const RESOLVE = `import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = process.env.REFIT_GENERATED_ROOT ?? '/workspace/';
const map = JSON.parse(readFileSync(new URL('imports.json', import.meta.url), 'utf8'));
let ts;
const compiler = () =>
  (ts ??= createRequire(import.meta.url)(process.env.REFIT_TYPESCRIPT ?? '/refit/typescript/lib/typescript.js'));
const TYPESCRIPT = /\\.(?:[cm]?ts|tsx)$/;
export async function resolve(specifier, context, next) {
  const parent = context.parentURL?.startsWith('file:') ? fileURLToPath(context.parentURL) : '';
  const target = parent.startsWith(root) ? map[parent.slice(root.length)]?.[specifier] : undefined;
  return next(target ? pathToFileURL(root + target).href : specifier, context);
}
export async function load(url, context, next) {
  if (!url.startsWith('file:') || !TYPESCRIPT.test(url)) return next(url, context);
  const path = fileURLToPath(url);
  const ts = compiler();
  const output = ts.transpileModule(readFileSync(path, 'utf8'), {
    fileName: path,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  });
  return { format: 'module', source: output.outputText, shortCircuit: true };
}
`;

// Redirects the Stripe SDK's HTTPS requests for api.stripe.com to stripe-mock on loopback. The SDK
// writes request bodies after `secureConnect`, so the plain socket re-emits it on `connect`.
const REDIRECT = `import http from 'node:http';
import https from 'node:https';
import { register } from 'node:module';
register('./resolve.mjs', import.meta.url);
const port = Number(process.env.REFIT_STRIPE_MOCK_PORT ?? ${MOCK_PORT});
const request = https.request;
https.request = function (options, ...rest) {
  if (options && typeof options === 'object' && (options.hostname ?? options.host) === 'api.stripe.com') {
    const { agent, ...plain } = options;
    const headers = { ...plain.headers, Authorization: 'Bearer sk_test_123' };
    const req = http.request({ ...plain, headers, protocol: 'http:', hostname: '127.0.0.1', host: '127.0.0.1', port }, ...rest);
    req.once('socket', (socket) => socket.once('connect', () => socket.emit('secureConnect')));
    return req;
  }
  return request.call(this, options, ...rest);
};
`;

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
for (const entry of entries) {
  const id = entry.file + '#' + entry.name;
  try {
    const module = await import(pathToFileURL(root + entry.file).href);
    if (typeof module[entry.name] !== 'function') throw new Error(id + ' is not an exported function');
    const args = Array.from({ length: entry.parameters }, (_, index) => 'refit_placeholder_' + (index + 1));
    await module[entry.name](...args);
    console.log('REFIT_GENERATED_RESULT=' + JSON.stringify({ id, ok: true }));
  } catch (error) {
    const text = error instanceof Error ? error.name + ': ' + error.message : String(error);
    console.log('REFIT_GENERATED_RESULT=' + JSON.stringify({ id, ok: false, error: text.slice(0, 500) }));
  }
}
`;

// Per-function results printed by the harness; a missing line means the harness did not reach it.
export function generatedResults(stdout: string) {
  const results = new Map<string, { ok: boolean; error?: string }>();
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('REFIT_GENERATED_RESULT=')) continue;
    const value: unknown = JSON.parse(line.slice('REFIT_GENERATED_RESULT='.length));
    if (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { id?: unknown }).id === 'string' &&
      typeof (value as { ok?: unknown }).ok === 'boolean'
    ) {
      const { id, ok, error } = value as { id: string; ok: boolean; error?: unknown };
      results.set(id, { ok, ...(typeof error === 'string' ? { error } : {}) });
    }
  }
  return results;
}

export async function writeHarness(
  directory: string,
  entries: EntryPoint[],
  imports: Record<string, Record<string, string>> = {},
) {
  await writeFile(join(directory, 'redirect.mjs'), REDIRECT, { mode: 0o444 });
  await writeFile(join(directory, 'resolve.mjs'), RESOLVE, { mode: 0o444 });
  await writeFile(join(directory, 'imports.json'), JSON.stringify(imports), { mode: 0o444 });
  await writeFile(join(directory, 'harness.mjs'), HARNESS, { mode: 0o444 });
  await writeFile(join(directory, 'entries.json'), JSON.stringify(entries), { mode: 0o444 });
}

export function generatedCommand() {
  return [
    'sh',
    '-c',
    `(/refit/stripe-mock -http-addr 127.0.0.1:${MOCK_PORT} -spec /refit/spec.json -fixtures /refit/fixtures.json >/tmp/refit-stripe-mock.log 2>&1 &); ` +
      'STRIPE_SECRET_KEY=sk_test_123 STRIPE_API_KEY=sk_test_123 STRIPE_KEY=sk_test_123 ' +
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

// stripe-mock reads JSON only; YAML contracts cannot be served.
export async function readMockDocument(path: string, label: string) {
  const content = await readFile(path, 'utf8');
  if (!content.trimStart().startsWith('{'))
    throw new PipelineInputError(`Generated checks require a JSON ${label}.`);
  return digest(content);
}

// A function that fails on the original code against the before-version mock cannot run in
// isolation (for example, it needs a database) and is excluded; only functions that ran there must
// also run on the patched code against the after-version mock.
export function compareGeneratedRuns(
  entries: EntryPoint[],
  before: CheckResult,
  after: CheckResult,
) {
  const original = generatedResults(before.stdout);
  const patched = generatedResults(after.stdout);
  const id = (entry: EntryPoint) => `${entry.file}#${entry.name}`;
  const runnable = entries.filter((entry) => original.get(id(entry))?.ok);
  const regressions = runnable
    .filter((entry) => !patched.get(id(entry))?.ok)
    .map((entry) => ({
      id: id(entry),
      error: patched.get(id(entry))?.error ?? 'No result recorded.',
    }));
  const status = (check: CheckResult, failed: boolean): CheckResult['status'] =>
    check.status !== 'passed' ? check.status : failed ? 'failed' : 'passed';
  return {
    notRunnable: entries
      .filter((entry) => !original.get(id(entry))?.ok)
      .map((entry) => ({
        id: id(entry),
        error: original.get(id(entry))?.error ?? 'No result recorded.',
      })),
    regressions,
    baseline: { ...before, status: status(before, false) },
    patched: { ...after, status: status(after, regressions.length > 0) },
  };
}
