// Rebuilds the deadline benchmark root from a pinned repository list: shallow clones at the
// recorded commits, then `refit deadlines --json` on each. Repository code is never installed or run.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const REFIT = fileURLToPath(new URL('../bin/refit.mjs', import.meta.url));
const GIT_TIMEOUT_MS = 300_000;
const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    list: { type: 'string', default: 'docs/benchmarks/2026-10-15-deadline-pilot-repos.json' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.root) {
  console.log(
    'Usage: node scripts/deadline-benchmark-setup.mjs --root <dir> [--list <repos.json>]',
  );
  process.exit(values.help ? 0 : 1);
}
const root = resolve(values.root);
const pinned = JSON.parse(await readFile(values.list, 'utf8'));
await mkdir(join(root, 'repos'), { recursive: true });

const failures = [];
const results = [];
for (const [index, entry] of pinned.repos.entries()) {
  const directory = join(root, 'repos', entry.repo.replace('/', '__'));
  console.error(`[${index + 1}/${pinned.repos.length}] ${entry.repo}`);
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
        { timeout: GIT_TIMEOUT_MS },
      );
      await execute('git', ['-C', directory, 'checkout', '-q', 'FETCH_HEAD']);
    }
    const { stdout } = await execute(
      process.execPath,
      [REFIT, 'deadlines', '--repository', directory, '--json'],
      {
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const report = JSON.parse(stdout);
    results.push({
      provider: entry.provider,
      repo: entry.repo,
      commit: entry.commit,
      checkedAt: report.checkedAt,
      exposures: report.exposures,
    });
  } catch (error) {
    failures.push({
      repo: entry.repo,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
await writeFile(join(root, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
console.log(
  JSON.stringify({ root, repos: pinned.repos.length, scanned: results.length, failures }, null, 2),
);
if (failures.length) process.exitCode = 1;
