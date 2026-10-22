// Runs `refit meta-graph` and `refit meta-graph --propose-version-moves` over a frozen list of
// repositories that call the WhatsApp Cloud API or Messenger Send API
// (docs/META-PLATFORM-CHANGELOGS.md), then scores the labelled ones with
// scripts/meta-platform-score.mjs. Checkouts are shallow fetches at the pinned commits under
// --root, without submodules; repository code is never installed or run, and Meta is never
// contacted.
//
//   node scripts/meta-platform-benchmark.mjs --root <dir> [--list <repos.json>] [--labels <labels.json>] [--target v25.0] [--output <file>]
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { repositoryResult, scoreMetaPlatform } from './meta-platform-score.mjs';

const execute = promisify(execFile);
const GIT_TIMEOUT_MS = 300_000;
const SCAN_TIMEOUT_MS = 300_000;
const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    list: { type: 'string', default: 'docs/benchmarks/2026-10-22-meta-platform-repos.json' },
    labels: { type: 'string', default: 'docs/benchmarks/2026-10-22-meta-platform-labels.json' },
    target: { type: 'string', default: 'v25.0' },
    output: { type: 'string', default: 'meta-platform-results.json' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.root) {
  console.log(
    'Usage: node scripts/meta-platform-benchmark.mjs --root <dir> [--list <repos.json>] [--labels <labels.json>] [--target v25.0] [--output <file>]',
  );
  process.exit(values.help ? 0 : 1);
}
const root = resolve(values.root);
const refit = fileURLToPath(new URL('../bin/refit.mjs', import.meta.url));
const list = JSON.parse(await readFile(values.list, 'utf8'));
// A mixed list, such as the deadline benchmark's, keeps its Meta repositories.
list.repos = list.repos.filter((item) => (item.provider ?? 'meta-graph') === 'meta-graph');
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

async function checkout(repo, commit) {
  const directory = join(root, repo.replace('/', '__'));
  if (existsSync(join(directory, '.git'))) {
    const { stdout } = await execute('git', ['rev-parse', 'HEAD'], { cwd: directory });
    if (stdout.trim() === commit) return directory;
  }
  await mkdir(directory, { recursive: true });
  const git = (args) => execute('git', args, { cwd: directory, env, timeout: GIT_TIMEOUT_MS });
  await git(['init', '-q']);
  await git([
    'fetch',
    '-q',
    '--depth',
    '1',
    '--no-recurse-submodules',
    `https://github.com/${repo}`,
    commit,
  ]);
  await git(['-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD']);
  return directory;
}

async function refitJson(args) {
  const { stdout } = await execute(process.execPath, [refit, ...args, '--json'], {
    timeout: SCAN_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

const repos = [];
for (const [index, item] of list.repos.entries()) {
  try {
    const directory = await checkout(item.repo, item.commit);
    const scan = await refitJson(['meta-graph', '--repository', directory]);
    const moves = await refitJson([
      'meta-graph',
      '--propose-version-moves',
      '--target',
      values.target,
      '--repository',
      directory,
    ]);
    repos.push({
      repo: item.repo,
      commit: item.commit,
      ...repositoryResult(scan, moves),
      // Every stop's reasons and every move, for reading each result.
      stops: moves.stops.map((stop) => ({
        pin: `${stop.file}:${stop.line}`,
        reasons: stop.reasons,
      })),
      moves: moves.moves.map((move) => ({
        pin: `${move.file}:${move.line}`,
        from: move.from,
        to: move.to,
        requests: move.requests.map(
          (request) => `${request.method} ${request.path} ${request.file}:${request.line}`,
        ),
      })),
    });
  } catch (error) {
    repos.push({
      repo: item.repo,
      commit: item.commit,
      calls: [],
      guarded: [],
      moved: [],
      error: String(error.stderr || error.message).slice(0, 500),
    });
  }
  console.error(`[${index + 1}/${list.repos.length}] ${item.repo}`);
}

const results = {
  formatVersion: 1,
  list: values.list,
  target: values.target,
  scannedAt: new Date().toISOString(),
  repos,
};
const labels = existsSync(values.labels) ? JSON.parse(await readFile(values.labels, 'utf8')) : null;
const score = labels ? scoreMetaPlatform(labels, results) : null;
await writeFile(values.output, `${JSON.stringify({ ...results, score }, null, 2)}\n`);
console.error(
  JSON.stringify(score ? { ...score, misses: score.misses.length } : { scanned: repos.length }),
);
