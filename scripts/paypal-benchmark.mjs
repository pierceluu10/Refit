// Runs `refit paypal` over a frozen PayPal benchmark: shallow fetches at the pinned commits, one
// scan per repository, and a text cross-check of how many SDK call lines the scan reports.
// Repository code is never installed or run, and PayPal is never contacted.
//
//   node scripts/paypal-benchmark.mjs --root <dir> [--list <repos.json>] [--refit <checkout>] [--output <file>]
//
// The cross-check is a heuristic, not a hand label: a line counts as a likely SDK call when it
// constructs a request class @paypal/checkout-server-sdk defines (`new …OrdersCreateRequest(`) or
// calls a method name a @paypal/paypal-server-sdk controller defines (`.createOrder(`) in a file
// that names either package or a controller class. Lines in tests and examples are left out.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const GIT_TIMEOUT_MS = 300_000;
const SCAN_TIMEOUT_MS = 120_000;
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const SKIPPED =
  /(?:^|\/)(?:node_modules|dist|build|coverage|\.next|out|vendor)\/|\.d\.[cm]?ts$|\.min\.js$/;
const TEST_PATH =
  /(?:^|\/)(?:__tests__|__mocks__|__fixtures__|tests?|specs?|e2e|cypress|fixtures?|examples?|stories)\/|\.(?:test|spec|e2e|stories|story)\.[cm]?[jt]sx?$/i;
const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    list: { type: 'string', default: 'docs/benchmarks/2026-10-21-paypal-repos.json' },
    refit: { type: 'string', default: fileURLToPath(new URL('..', import.meta.url)) },
    output: { type: 'string', default: 'paypal-results.json' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.root) {
  console.log(
    'Usage: node scripts/paypal-benchmark.mjs --root <dir> [--list <repos.json>] [--refit <checkout>] [--output <file>]',
  );
  process.exit(values.help ? 0 : 1);
}
const root = resolve(values.root);
const refitRoot = resolve(values.refit);
const refit = join(refitRoot, 'bin', 'refit.mjs');
const data = JSON.parse(await readFile(join(refitRoot, 'data', 'paypal-requests.json'), 'utf8'));
const requestClasses = new Set(
  Object.values(data.checkout.requests).flatMap((area) => Object.keys(area)),
);
const controllerClasses = Object.keys(data.server.controllers);
const controllerMethods = new Set(
  Object.values(data.server.controllers).flatMap((methods) => Object.keys(methods)),
);
const OLD_CALL = /\bnew\s+[\w$.]*?\b(\w+Request)\s*\(/g;
const NEW_CALL = /\.(\w+)\s*\(/g;

// Likely SDK call lines in live source files, by `file:line`.
async function likelyCalls(directory) {
  const { stdout } = await execute('git', ['-C', directory, 'ls-files'], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const lines = [];
  for (const file of stdout.split('\n')) {
    if (!SOURCE.test(file) || SKIPPED.test(file) || TEST_PATH.test(file)) continue;
    let content;
    try {
      content = await readFile(join(directory, file), 'utf8');
    } catch {
      continue;
    }
    const checkout = content.includes('@paypal/checkout-server-sdk');
    const server =
      content.includes('@paypal/paypal-server-sdk') ||
      controllerClasses.some((name) => content.includes(name));
    if (!checkout && !server) continue;
    for (const [index, line] of content.split('\n').entries()) {
      const old =
        checkout && [...line.matchAll(OLD_CALL)].some((match) => requestClasses.has(match[1]));
      const fresh =
        server && [...line.matchAll(NEW_CALL)].some((match) => controllerMethods.has(match[1]));
      if (old || fresh) lines.push(`${file}:${index + 1}`);
    }
  }
  return lines;
}

const pinned = JSON.parse(await readFile(values.list, 'utf8'));
await mkdir(join(root, 'repos'), { recursive: true });
const results = [];
for (const [index, entry] of pinned.repos.entries()) {
  const directory = join(root, 'repos', entry.repo.replace('/', '__'));
  console.error(`[${index + 1}/${pinned.repos.length}] ${entry.repo}`);
  const result = {
    repo: entry.repo,
    commit: entry.commit,
    package: entry.package,
    declared: entry.declared,
  };
  try {
    if (!existsSync(join(directory, '.git'))) {
      await execute('git', ['init', '-q', directory]);
      await execute(
        'git',
        [
          '-C',
          directory,
          'fetch',
          '-q',
          '--depth',
          '1',
          `https://github.com/${entry.repo}`,
          entry.commit,
        ],
        { timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      );
      await execute('git', ['-C', directory, 'checkout', '-q', 'FETCH_HEAD']);
    }
  } catch (error) {
    results.push({ ...result, status: 'not-fetched', error: message(error) });
    continue;
  }
  const likely = await likelyCalls(directory);
  try {
    const { stdout } = await execute(
      process.execPath,
      [refit, 'paypal', '--repository', directory, '--json'],
      { maxBuffer: 64 * 1024 * 1024, timeout: SCAN_TIMEOUT_MS },
    );
    const report = JSON.parse(stdout);
    const reported = new Set(
      report.calls.filter((call) => call.kind !== 'url').map((call) => `${call.file}:${call.line}`),
    );
    results.push({
      ...result,
      status: 'scanned',
      packages: report.packages,
      calls: report.calls,
      likelySdkCalls: likely.length,
      traced: likely.filter((line) => reported.has(line)).length,
      missed: likely.filter((line) => !reported.has(line)),
      warnings: report.warnings,
    });
  } catch (error) {
    results.push({
      ...result,
      status: 'not-scanned',
      error: message(error),
      likelySdkCalls: likely.length,
    });
  }
}

function message(error) {
  const text = error instanceof Error ? error.stderr || error.message : String(error);
  return String(text).trim().split('\n').at(-1).slice(0, 300);
}

const live = (result) => (result.calls ?? []).filter((call) => call.use === 'live');
const count = (test) =>
  results.reduce((total, result) => total + live(result).filter(test).length, 0);
const summary = {
  repositories: results.length,
  scanned: results.filter((result) => result.status === 'scanned').length,
  notScanned: results
    .filter((result) => result.status !== 'scanned')
    .map((result) => `${result.repo}: ${result.error}`),
  withLiveRequests: results.filter((result) => live(result).length).length,
  liveRequests: count(() => true),
  byKind: {
    checkoutSdk: count((call) => call.kind === 'checkout-sdk'),
    serverSdk: count((call) => call.kind === 'server-sdk'),
    url: count((call) => call.kind === 'url'),
  },
  pathKnown: count((call) => call.path !== null),
  operationMatched: count((call) => call.operation !== null),
  withNotes: count((call) => call.notes.length > 0),
  likelySdkCalls: results.reduce((total, result) => total + (result.likelySdkCalls ?? 0), 0),
  traced: results.reduce((total, result) => total + (result.traced ?? 0), 0),
};
await writeFile(
  join(root, values.output),
  `${JSON.stringify({ formatVersion: 1, list: values.list, checkedAt: new Date().toISOString(), summary, results }, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));
