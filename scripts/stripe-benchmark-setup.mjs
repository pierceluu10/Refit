// Rebuilds the Stripe benchmark root from the pinned repository list and labels: shallow clones
// at the recorded commits, and each API version's spec and fixtures from its stripe/openapi tag.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const PINNED = 'docs/benchmarks/2026-10-14-stripe-repos.json';
const LABELS = 'docs/benchmarks/2026-10-14-stripe-labels.json';
const HELD_OUT = 'docs/benchmarks/2026-10-15-stripe-heldout-repos.json';
const OPENAPI = 'https://raw.githubusercontent.com/stripe/openapi';
const GIT_TIMEOUT_MS = 300_000;
const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    offset: { type: 'string' },
    limit: { type: 'string' },
    'held-out': { type: 'boolean' },
    list: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.root) {
  console.log(
    'Usage: node scripts/stripe-benchmark-setup.mjs --root <dir> [--held-out | --list <frozen.json>] [--offset N] [--limit N]',
  );
  process.exit(values.help ? 0 : 1);
}
const root = resolve(values.root);
// --held-out or --list builds another frozen list; it has no labels, so every repository is held out.
const list = values.list ?? (values['held-out'] ? HELD_OUT : undefined);
const pinned = JSON.parse(await readFile(list ?? PINNED, 'utf8'));
const labels = list
  ? { labelled: [], heldOut: pinned.repos.map((entry) => entry.repo) }
  : JSON.parse(await readFile(LABELS, 'utf8'));
// --offset and --limit build one shard's slice; the benchmark then runs that root without them.
const repos = pinned.repos
  .slice(Number(values.offset ?? 0))
  .slice(0, values.limit ? Number(values.limit) : undefined);
const latest = pinned.specs
  .map((spec) => spec.version)
  .sort()
  .at(-1);
await mkdir(join(root, 'specs'), { recursive: true });
await mkdir(join(root, 'fixtures'), { recursive: true });
await mkdir(join(root, 'repos'), { recursive: true });

async function download(url, path) {
  if (existsSync(path)) return;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
}

for (const { version, tag } of pinned.specs) {
  await download(`${OPENAPI}/${tag}/openapi/spec3.json`, join(root, 'specs', `${version}.json`));
  await download(
    `${OPENAPI}/${tag}/openapi/fixtures3.json`,
    join(root, 'fixtures', `${version}.json`),
  );
  const spec = JSON.parse(await readFile(join(root, 'specs', `${version}.json`), 'utf8'));
  if (spec.info?.version !== version)
    throw new Error(`stripe/openapi ${tag} is ${spec.info?.version}, not ${version}`);
  if (version === latest)
    await download(
      `${OPENAPI}/${tag}/openapi/spec3.sdk.json`,
      join(root, 'specs', `sdk-${version}.json`),
    );
}

const failures = [];
for (const [index, entry] of repos.entries()) {
  const directory = join(root, 'repos', entry.repo.replace('/', '__'));
  if (existsSync(join(directory, '.git'))) continue;
  console.error(`[${index + 1}/${repos.length}] ${entry.repo}`);
  try {
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
  } catch (error) {
    failures.push({
      repo: entry.repo,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const versions = [...new Set(repos.map((entry) => entry.before)), latest].sort();
await writeFile(join(root, 'selected.json'), `${JSON.stringify(repos, null, 2)}\n`);
await writeFile(
  join(root, 'needed-specs.json'),
  `${JSON.stringify(
    versions.map((version) => ({ version })),
    null,
    2,
  )}\n`,
);
await writeFile(
  join(root, 'split.json'),
  `${JSON.stringify({ labelled: labels.labelled, heldOut: labels.heldOut }, null, 2)}\n`,
);
console.log(
  JSON.stringify({ root, repos: repos.length, specs: pinned.specs.length, failures }, null, 2),
);
if (failures.length) process.exitCode = 1;
