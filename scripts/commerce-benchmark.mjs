// Runs `refit agents` and `refit deadlines` over the frozen list-A payments and commerce sample
// (docs/COMMERCE-APIS.md), then scores the labelled repositories with scripts/commerce-score.mjs,
// as scripts/auth-backend-benchmark.mjs does for its sample. Checkouts are shallow fetches at the
// pinned commits under --root, without submodules; repository code is never installed or run, and
// no provider is contacted.
//
//   node scripts/commerce-benchmark.mjs --root <dir> [--list <repos.json>] [--labels <labels.json>] [--output <file>]
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { PROVIDERS, repositoryResult, scoreCommerce } from './commerce-score.mjs';

const execute = promisify(execFile);
// Evidence lines can quote a key that a scanned repository hard-codes, such as a JWT fallback for
// an environment variable. Results keep the line but never the key.
const KEY_TEXT =
  /\beyJ[\w-]{8,}(?:\.[\w-]*){0,2}|\b(?:sk|pk|rk)_(?:live|test)_\w+|\bsb_(?:secret|publishable)_\w+/g;
const GIT_TIMEOUT_MS = 300_000;
const SCAN_TIMEOUT_MS = 300_000;
const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    list: { type: 'string', default: 'docs/benchmarks/2026-10-22-commerce-repos.json' },
    labels: { type: 'string', default: 'docs/benchmarks/2026-10-22-commerce-labels.json' },
    output: { type: 'string', default: 'commerce-results.json' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.root) {
  console.log(
    'Usage: node scripts/commerce-benchmark.mjs --root <dir> [--list <repos.json>] [--labels <labels.json>] [--output <file>]',
  );
  process.exit(values.help ? 0 : 1);
}
const root = resolve(values.root);
const refit = fileURLToPath(new URL('../bin/refit.mjs', import.meta.url));
const list = JSON.parse(await readFile(values.list, 'utf8'));
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

async function git(directory, args) {
  await execute('git', args, { cwd: directory, env, timeout: GIT_TIMEOUT_MS });
}

// A checkout at the pinned commit, reused when it is already there.
async function checkout(repo, commit) {
  const directory = join(root, repo.replace('/', '__'));
  if (existsSync(join(directory, '.git'))) {
    const { stdout } = await execute('git', ['rev-parse', 'HEAD'], { cwd: directory });
    if (stdout.trim() === commit) return directory;
  }
  await mkdir(directory, { recursive: true });
  await git(directory, ['init', '-q']);
  await git(directory, [
    'fetch',
    '-q',
    '--depth',
    '1',
    '--no-recurse-submodules',
    `https://github.com/${repo}`,
    commit,
  ]);
  await git(directory, ['-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD']);
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
  const started = Date.now();
  try {
    const directory = await checkout(item.repo, item.commit);
    const agents = await refitJson(['agents', '--repository', directory]);
    const deadlines = await refitJson(['deadlines', '--repository', directory]);
    const result = repositoryResult(agents, deadlines);
    repos.push({
      provider: item.provider,
      repo: item.repo,
      commit: item.commit,
      ...result,
      // Live evidence for the providers' entries and every pin, for reading each hit.
      evidence: Object.fromEntries(
        deadlines.exposures
          .filter((exposure) => PROVIDERS.includes(exposure.deadline.provider))
          .map((exposure) => [
            exposure.deadline.id,
            exposure.evidence.map(
              (line) => `${line.file}:${line.line} ${line.text.replace(KEY_TEXT, '[redacted]')}`,
            ),
          ]),
      ),
      apiVersions: agents.detected.flatMap((detection) =>
        (detection.apiVersions ?? []).map(
          (pin) =>
            `${pin.provider} ${pin.version} ${pin.form} ${pin.use} ${pin.file}:${pin.line} ${pin.text.replace(KEY_TEXT, '[redacted]')}`,
        ),
      ),
      seconds: Math.round((Date.now() - started) / 100) / 10,
    });
  } catch (error) {
    repos.push({
      provider: item.provider,
      repo: item.repo,
      commit: item.commit,
      providers: [],
      exposures: [],
      pins: [],
      error: String(error.stderr || error.message).slice(0, 500),
    });
  }
  console.error(`[${index + 1}/${list.repos.length}] ${item.repo}`);
}

const labels = JSON.parse(await readFile(values.labels, 'utf8'));
const results = { formatVersion: 1, list: values.list, scannedAt: new Date().toISOString(), repos };
const score = scoreCommerce(labels, results);
await writeFile(values.output, `${JSON.stringify({ ...results, score }, null, 2)}\n`);
console.error(
  JSON.stringify({
    ...score,
    providers: { ...score.providers, misses: score.providers.misses.length },
    exposures: { ...score.exposures, misses: score.exposures.misses.length },
    pins: { ...score.pins, misses: score.pins.misses.length },
  }),
);
