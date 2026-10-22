// Runs `refit shopify-rest` over a frozen Shopify benchmark statically: shallow fetches at the
// pinned commits and one scan per repository, then how many apps make a REST Admin call to an
// endpoint a later API version removes, and which endpoints. With --labels it scores the labelled
// repositories (scripts/shopify-rest-score.mjs). Repository code is never installed or run, and
// Shopify is never contacted.
//
//   node scripts/shopify-rest-benchmark.mjs --root <dir> [--list <repos.json>] [--refit <checkout>] \
//     [--labels <labels.json>] [--output <file>]
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { shallowCheckout } from './ai-app-helpers.mjs';
import { scoreShopifyRest } from './shopify-rest-score.mjs';

const execute = promisify(execFile);
const SCAN_TIMEOUT_MS = 180_000;
const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    list: { type: 'string', default: 'docs/benchmarks/2026-10-16-shopify-fresh-repos.json' },
    refit: { type: 'string', default: fileURLToPath(new URL('..', import.meta.url)) },
    labels: { type: 'string' },
    output: { type: 'string', default: 'shopify-rest-results.json' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.root) {
  console.log(
    'Usage: node scripts/shopify-rest-benchmark.mjs --root <dir> [--list <repos.json>] [--refit <checkout>] [--labels <labels.json>] [--output <file>]',
  );
  process.exit(values.help ? 0 : 1);
}
const refit = join(resolve(values.refit), 'bin', 'refit.mjs');
const pinned = JSON.parse(await readFile(values.list, 'utf8'));
const results = [];
for (const [index, entry] of pinned.repos.entries()) {
  console.error(`[${index + 1}/${pinned.repos.length}] ${entry.repo}`);
  const result = { repo: entry.repo, commit: entry.commit };
  let directory;
  try {
    directory = await shallowCheckout(values.root, entry.repo, entry.commit);
  } catch (error) {
    results.push({ ...result, status: 'not-fetched', error: message(error), rest: [], calls: [] });
    continue;
  }
  try {
    const { stdout } = await execute(
      process.execPath,
      [refit, 'shopify-rest', '--repository', directory, '--json'],
      { maxBuffer: 64 * 1024 * 1024, timeout: SCAN_TIMEOUT_MS },
    );
    const report = JSON.parse(stdout);
    results.push({
      ...result,
      status: 'scanned',
      pinned: report.pinned,
      served: report.served,
      rest: report.rest,
      calls: report.calls,
      unmatched: report.unmatched,
      unreadable: report.unreadable,
    });
  } catch (error) {
    results.push({ ...result, status: 'not-scanned', error: message(error), rest: [], calls: [] });
  }
}

function message(error) {
  const text = error instanceof Error ? error.stderr || error.message : String(error);
  return String(text).trim().split('\n').at(-1).slice(0, 300);
}

const scanned = results.filter((result) => result.status === 'scanned');
const live = (list) => list.filter((item) => item.use === 'live');
const endpoints = new Map();
for (const result of scanned)
  for (const key of new Set(
    live(result.calls).map(
      (call) =>
        `${call.endpoint.method} ${call.endpoint.path} (removed in ${call.endpoint.removedIn})`,
    ),
  ))
    endpoints.set(key, (endpoints.get(key) ?? 0) + 1);
const summary = {
  repositories: results.length,
  scanned: scanned.length,
  notScanned: results
    .filter((result) => result.status !== 'scanned')
    .map((result) => `${result.repo}: ${result.error}`),
  withLiveRest: scanned.filter((result) => live(result.rest).length).length,
  liveRestCalls: scanned.reduce((total, result) => total + live(result.rest).length, 0),
  withRemovedEndpointCalls: scanned.filter((result) => live(result.calls).length).length,
  alreadyRemovedForServedVersion: scanned.filter((result) =>
    live(result.calls).some((call) => call.status === 'removed'),
  ).length,
  endpoints: Object.fromEntries(
    [...endpoints].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  ),
};
const output = {
  formatVersion: 1,
  list: values.list,
  checkedAt: new Date().toISOString(),
  summary,
  results,
};
if (values.labels)
  output.score = scoreShopifyRest(JSON.parse(await readFile(values.labels, 'utf8')), { results });
await writeFile(join(resolve(values.root), values.output), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ summary, score: output.score }, null, 2));
