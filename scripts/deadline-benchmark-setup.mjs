// Rebuilds the deadline benchmark root from a pinned repository list: shallow clones at the
// recorded commits, then `refit deadlines --json` on each. Repository code is never installed or run.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

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
    // Clone only, so a blind labeller can read the repositories before Refit scans any of them.
    'clone-only': { type: 'boolean' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.root) {
  console.log(
    'Usage: node scripts/deadline-benchmark-setup.mjs --root <dir> [--list <repos.json>] [--refit <checkout>] [--output results.json] [--clone-only]',
  );
  process.exit(values.help ? 0 : 1);
}
const root = resolve(values.root);
const refit = join(resolve(values.refit), 'bin', 'refit.mjs');
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
    if (values['clone-only']) continue;
    const { stdout } = await execute(
      process.execPath,
      [refit, 'deadlines', '--repository', directory, '--json'],
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
      // Deadlines named only outside live code; absent before Refit classified evidence.
      mentions: report.mentions ?? [],
    });
  } catch (error) {
    failures.push({
      repo: entry.repo,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
if (!values['clone-only'])
  await writeFile(join(root, values.output), `${JSON.stringify(results, null, 2)}\n`);
console.log(
  JSON.stringify({ root, repos: pinned.repos.length, scanned: results.length, failures }, null, 2),
);
if (failures.length) process.exitCode = 1;
