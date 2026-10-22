// Runs `refit github-api` over a frozen GitHub API benchmark: shallow fetches at the pinned commits
// and one scan per repository. Repository code is never installed or run, and the GitHub API is
// never called.
//
//   node scripts/github-benchmark.mjs --root <dir> [--list <repos.json>] [--refit <checkout>] [--output <file>]
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const GIT_TIMEOUT_MS = 300_000;
const SCAN_TIMEOUT_MS = 120_000;
const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    list: { type: 'string', default: 'docs/benchmarks/2026-10-22-github-repos.json' },
    refit: { type: 'string', default: fileURLToPath(new URL('..', import.meta.url)) },
    output: { type: 'string', default: 'github-results.json' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.root) {
  console.log(
    'Usage: node scripts/github-benchmark.mjs --root <dir> [--list <repos.json>] [--refit <checkout>] [--output <file>]',
  );
  process.exit(values.help ? 0 : 1);
}
const root = resolve(values.root);
const refitRoot = resolve(values.refit);
const refit = join(refitRoot, 'bin', 'refit.mjs');
const git = (...args) =>
  execute('git', args, {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });

// A clean checkout at the pinned commit, without submodules, hooks or any install step.
async function checkout(repo, commit) {
  const directory = join(root, repo.replace('/', '__'));
  if (!existsSync(join(directory, '.git'))) {
    await mkdir(directory, { recursive: true });
    await git('-C', directory, 'init', '-q');
    await git('-C', directory, 'remote', 'add', 'origin', `https://github.com/${repo}`);
  }
  const head = await git('-C', directory, 'rev-parse', '--verify', '-q', 'HEAD').catch(() => null);
  if (head?.stdout.trim() !== commit) {
    await git('-C', directory, 'fetch', '-q', '--depth', '1', 'origin', commit);
    await git(
      '-C',
      directory,
      '-c',
      'core.hooksPath=/dev/null',
      'checkout',
      '-q',
      '--force',
      commit,
    );
  }
  return directory;
}

const list = JSON.parse(await readFile(resolve(values.list), 'utf8'));
const refitCommit = (await git('-C', refitRoot, 'rev-parse', 'HEAD')).stdout.trim();
const dirty = (await git('-C', refitRoot, 'status', '--porcelain')).stdout.trim() !== '';
const results = [];
for (const [index, entry] of list.repos.entries()) {
  const result = { repo: entry.repo, commit: entry.commit };
  try {
    const directory = await checkout(entry.repo, entry.commit);
    const { stdout } = await execute(
      process.execPath,
      [refit, 'github-api', '--repository', directory, '--json'],
      { timeout: SCAN_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
    );
    const scan = JSON.parse(stdout);
    result.packages = scan.packages.map((item) => `${item.name}@${item.locked ?? item.declared}`);
    result.calls = scan.calls.map((call) => ({
      file: call.file,
      line: call.line,
      kind: call.kind,
      use: call.use,
      method: call.method,
      route: call.route,
      fields: call.fields,
      notices: call.notices.map((notice) => `${notice.source}: ${notice.text}`),
      versionChanges: call.versionChanges.length,
      notes: call.notes,
      unknown: call.unknown,
    }));
    result.pins = scan.pins.map((pin) => ({
      file: pin.file,
      line: pin.line,
      use: pin.use,
      version: pin.version,
    }));
  } catch (error) {
    result.error = String(error.stderr || error.message)
      .split('\n')
      .find((line) => line.trim())
      ?.slice(0, 300);
  }
  results.push(result);
  console.error(
    `[${index + 1}/${list.repos.length}] ${entry.repo}: ${result.error ? `error ${result.error}` : `${result.calls.length} calls`}`,
  );
}

await writeFile(
  values.output,
  `${JSON.stringify(
    {
      formatVersion: 1,
      list: values.list,
      refit: { commit: refitCommit, dirty },
      scannedAt: new Date().toISOString(),
      results,
    },
    null,
    2,
  )}\n`,
);
