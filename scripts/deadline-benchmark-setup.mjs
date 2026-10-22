// Rebuilds the deadline benchmark root from a pinned repository list: shallow clones at the
// recorded commits, then `refit deadlines --json` on each. Repository code is never installed or run.
// The output holds every repository in list order with the harness record (see
// docs/BENCHMARK-HARNESS.md) and is rewritten after each one, so --resume can continue a run.
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import {
  checkoutError,
  classifyRow,
  finishedRow,
  json,
  openResultsFile,
  startRun,
} from './benchmark-harness.mjs';
import { assertResults } from './benchmark-results.mjs';

const execute = promisify(execFile);
const GIT_TIMEOUT_MS = 300_000;
const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    list: { type: 'string', default: 'docs/benchmarks/2026-10-16-deadline-repos.json' },
    // A Refit checkout to scan with; run it from a pinned `git worktree`, since each scan loads
    // that checkout's current source files.
    refit: { type: 'string', default: fileURLToPath(new URL('..', import.meta.url)) },
    output: { type: 'string', default: 'results.json' },
    resume: { type: 'boolean' },
    'allow-dirty': { type: 'boolean' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.root) {
  console.log(
    'Usage: node scripts/deadline-benchmark-setup.mjs --root <dir> [--list <repos.json>] [--refit <checkout>] [--output results.json] [--resume] [--allow-dirty]',
  );
  process.exit(values.help ? 0 : 1);
}
const root = resolve(values.root);
const refit = join(resolve(values.refit), 'bin', 'refit.mjs');
const pinned = JSON.parse(await readFile(values.list, 'utf8'));
await mkdir(join(root, 'repos'), { recursive: true });
const output = join(root, values.output);
// The record describes the checkout that scans, which --refit may point elsewhere.
const { harness, rows: previous } = await openResultsFile(
  output,
  await startRun({
    format: 'deadline-results',
    refitRoot: resolve(values.refit),
    list: { path: values.list, file: values.list },
    options: {},
    allowDirty: values['allow-dirty'],
  }),
  { resume: values.resume },
);

// A checkout at the recorded commit. A directory left by a failed fetch is fetched again.
async function checkout(entry, directory) {
  if (!(await checkoutError(directory, entry.commit))) return;
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
    { timeout: GIT_TIMEOUT_MS },
  );
  await execute('git', ['-C', directory, 'checkout', '-q', 'FETCH_HEAD']);
  const wrong = await checkoutError(directory, entry.commit);
  if (wrong) throw new Error(wrong);
}

async function scan(entry) {
  const directory = join(root, 'repos', entry.repo.replace('/', '__'));
  const row = { provider: entry.provider, repo: entry.repo, commit: entry.commit };
  try {
    await checkout(entry, directory);
  } catch (error) {
    return { ...row, error: `checkout: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    const { stdout } = await execute(
      process.execPath,
      [refit, 'deadlines', '--repository', directory, '--json'],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const report = JSON.parse(stdout);
    return {
      ...row,
      checkedAt: report.checkedAt,
      exposures: report.exposures,
      // Deadlines named only outside live code; absent before Refit classified evidence.
      mentions: report.mentions ?? [],
    };
  } catch (error) {
    return { ...row, error: error instanceof Error ? error.message : String(error) };
  }
}

const results = [];
const document = () => ({ formatVersion: 2, list: values.list, harness, results });
for (const [index, entry] of pinned.repos.entries()) {
  const label = `[${index + 1}/${pinned.repos.length}] ${entry.repo}`;
  if (finishedRow(previous[index], entry)) {
    console.error(`${label}: finished before resuming`);
    results.push(previous[index]);
    continue;
  }
  console.error(label);
  const row = await scan(entry);
  results.push({ ...row, ...classifyRow('deadline-results', row) });
  await writeFile(output, json(document()));
}
assertResults('deadline-results', document());
await writeFile(output, json(document()));
const failures = results
  .filter((row) => row.error)
  .map(({ repo, error, outcomeClass }) => ({ repo, error, outcomeClass }));
console.log(
  JSON.stringify(
    {
      root,
      repos: pinned.repos.length,
      scanned: results.length - failures.length,
      failures,
    },
    null,
    2,
  ),
);
if (failures.length) process.exitCode = 1;
