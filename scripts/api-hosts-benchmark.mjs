// Measures `refit api-hosts` on the frozen sample: scans each repository under --root (as left by
// scripts/api-hosts-select.mjs) with the checkout's CLI, writes the results, and scores the
// labelled repositories. Repository code is never installed or run.
//
//   node scripts/api-hosts-benchmark.mjs --root <dir> [--output results.json]
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { scoreApiHosts } from './api-hosts-score.mjs';

const execute = promisify(execFile);
const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    list: { type: 'string', default: 'docs/benchmarks/2026-10-22-api-hosts-repos.json' },
    labels: { type: 'string', default: 'docs/benchmarks/2026-10-22-api-hosts-labels.json' },
    output: { type: 'string', default: 'docs/benchmarks/2026-10-22-api-hosts-results.json' },
    refit: { type: 'string', default: fileURLToPath(new URL('..', import.meta.url)) },
  },
});
if (!values.root) {
  console.log('Usage: node scripts/api-hosts-benchmark.mjs --root <dir> [--output <file>]');
  process.exit(1);
}
const cli = join(resolve(values.refit), 'bin', 'refit.mjs');
const refit = (await execute('git', ['-C', values.refit, 'rev-parse', 'HEAD'])).stdout.trim();
const dirty = (await execute('git', ['-C', values.refit, 'status', '--porcelain'])).stdout.trim();
if (dirty) console.error('warning: the Refit tree is dirty; do not publish these numbers');
const pinned = JSON.parse(await readFile(values.list, 'utf8'));
const results = [];
for (const entry of pinned.repos) {
  const directory = join(resolve(values.root), entry.repo.replace('/', '__'));
  try {
    const { stdout } = await execute(
      'node',
      [cli, 'api-hosts', '--repository', directory, '--json'],
      { maxBuffer: 256 * 1024 * 1024, timeout: 300_000 },
    );
    const scan = JSON.parse(stdout);
    results.push({
      repo: entry.repo,
      commit: entry.commit,
      hosts: scan.hosts.map(({ host, provider, count }) => ({
        host,
        provider: provider?.name ?? null,
        count,
      })),
      excluded: scan.excluded,
    });
  } catch (error) {
    results.push({
      repo: entry.repo,
      commit: entry.commit,
      error: String(error.message).slice(0, 300),
    });
  }
}
const labels = JSON.parse(await readFile(values.labels, 'utf8'));
const found = Object.fromEntries(
  results.map((result) => [result.repo, (result.hosts ?? []).map((item) => item.host)]),
);
const score = scoreApiHosts(found, labels);
await writeFile(
  values.output,
  `${JSON.stringify({ formatVersion: 1, refit, dirty: Boolean(dirty), scannedAt: new Date().toISOString(), score, results }, null, 2)}\n`,
);
console.log(
  `${results.length} repositories scanned (${results.filter((item) => item.error).length} failed). Labelled: ${score.repositories} repositories, precision ${score.precision}, recall ${score.recall} (TP ${score.truePositives}, FP ${score.falsePositives}, FN ${score.falseNegatives}).`,
);
for (const item of score.wrong) console.log(`FP  ${item.repo}  ${item.host}`);
for (const item of score.missed) console.log(`FN  ${item.repo}  ${item.host}`);
