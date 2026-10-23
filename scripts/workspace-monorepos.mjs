// Lists the monorepos in the frozen Stripe, Shopify, OpenAI and Anthropic benchmark sets, for the
// workspace attribution measurement (docs/WORKSPACE-ATTRIBUTION.md). Each repository is fetched at
// its frozen commit as a tree only (a blobless, single-commit fetch); the few files read to
// classify the layout (root package.json, pnpm-workspace.yaml, lerna.json) are fetched one by one.
// Nothing is checked out, installed or run.
//
//   node scripts/workspace-monorepos.mjs --work <dir> --output <monorepos.json> [--concurrency 8]
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const { values } = parseArgs({
  options: {
    work: { type: 'string' },
    output: { type: 'string' },
    concurrency: { type: 'string', default: '8' },
  },
});
if (!values.work || !values.output)
  throw new Error('Usage: workspace-monorepos.mjs --work <dir> --output <monorepos.json>');

export const FROZEN_SETS = [
  'docs/benchmarks/2026-10-14-stripe-repos.json',
  'docs/benchmarks/2026-10-15-stripe-heldout-repos.json',
  'docs/benchmarks/2026-10-16-stripe-fresh-repos.json',
  'docs/benchmarks/2026-10-16-shopify-repos.json',
  'docs/benchmarks/2026-10-16-shopify-fresh-repos.json',
  'docs/benchmarks/2026-10-21-openai-app-repos.json',
  'docs/benchmarks/2026-10-21-anthropic-app-repos.json',
];
const SKIPPED = /(^|\/)node_modules\//;
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

async function git(directory, args, options = {}) {
  const { stdout } = await execute('git', ['-C', directory, ...args], {
    env: GIT_ENV,
    maxBuffer: 256 * 1024 * 1024,
    timeout: 300_000,
    ...options,
  });
  return stdout;
}

// A layout is a monorepo when the root declares workspaces (npm, Yarn, pnpm, Lerna, Nx, Turborepo)
// or when more than one package.json lives outside node_modules.
async function classify(entry) {
  const directory = join(
    values.work,
    `${entry.repo.replace('/', '__')}@${entry.commit.slice(0, 12)}`,
  );
  if (!existsSync(join(directory, '.git'))) {
    await mkdir(directory, { recursive: true });
    await git(directory, ['init', '-q']);
    await git(directory, ['remote', 'add', 'origin', `https://github.com/${entry.repo}.git`]);
  }
  await git(directory, [
    'fetch',
    '-q',
    '--depth',
    '1',
    '--filter=blob:none',
    '--no-tags',
    'origin',
    entry.commit,
  ]);
  const files = (await git(directory, ['ls-tree', '-r', '--name-only', entry.commit]))
    .split('\n')
    .filter(Boolean);
  const manifests = files.filter(
    (file) => /(^|\/)package\.json$/.test(file) && !SKIPPED.test(file),
  );
  const show = async (file) =>
    files.includes(file) ? git(directory, ['show', `${entry.commit}:${file}`]) : undefined;
  const signals = [];
  const root = await show('package.json');
  try {
    const manifest = root ? JSON.parse(root) : {};
    if (manifest.workspaces) signals.push('package.json workspaces');
  } catch {
    signals.push('unparseable root package.json');
  }
  for (const [file, signal] of [
    ['pnpm-workspace.yaml', 'pnpm-workspace.yaml'],
    ['lerna.json', 'lerna.json'],
    ['nx.json', 'nx.json'],
    ['turbo.json', 'turbo.json'],
    ['rush.json', 'rush.json'],
  ])
    if (files.includes(file)) signals.push(signal);
  if (manifests.length > 1) signals.push(`${manifests.length} package.json files`);
  return {
    repo: entry.repo,
    commit: entry.commit,
    monorepo: signals.some((signal) => !signal.startsWith('unparseable')),
    signals,
    manifests: manifests.length,
    lockfiles: files.filter(
      (file) =>
        /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(file) &&
        !SKIPPED.test(file),
    ),
  };
}

const entries = new Map();
for (const list of FROZEN_SETS) {
  const document = JSON.parse(await readFile(list, 'utf8'));
  for (const entry of document.repos ?? document.repositories) {
    const key = `${entry.repo}@${entry.commit}`;
    if (!entries.has(key)) entries.set(key, { repo: entry.repo, commit: entry.commit, sets: [] });
    entries.get(key).sets.push(list.split('/').pop());
  }
}
const queue = [...entries.values()];
const results = [];
await Promise.all(
  Array.from({ length: Number(values.concurrency) }, async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      try {
        results.push({ ...(await classify(entry)), sets: entry.sets });
      } catch (error) {
        results.push({
          repo: entry.repo,
          commit: entry.commit,
          sets: entry.sets,
          error: String(error.message).split('\n')[0],
        });
      }
      if (results.length % 50 === 0) console.error(`${results.length}/${entries.size}`);
    }
  }),
);
results.sort((a, b) => a.repo.localeCompare(b.repo) || a.commit.localeCompare(b.commit));
await writeFile(
  values.output,
  `${JSON.stringify(
    {
      formatVersion: 1,
      listedAt: new Date().toISOString(),
      sets: FROZEN_SETS,
      rule: 'A monorepo declares workspaces at its root (package.json workspaces, pnpm-workspace.yaml, lerna.json, nx.json, turbo.json, rush.json) or has more than one package.json outside node_modules, at the frozen commit.',
      repositories: results.length,
      monorepos: results.filter((item) => item.monorepo).length,
      errors: results.filter((item) => item.error).length,
      results,
    },
    null,
    2,
  )}\n`,
);
