// Freezes the "active teams" Stripe benchmark list: repositories a working team is changing now,
// selected only from GitHub metadata and committed files, before Refit sees any of them.
// Usage: GITHUB_TOKEN=… node scripts/stripe-active-select.mjs --work <dir> --output <frozen.json>
// The token is read from GITHUB_TOKEN, or from `gh auth token` when unset. Each phase caches its
// result in --work, so an interrupted selection resumes.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const { values } = parseArgs({
  options: {
    work: { type: 'string' },
    output: { type: 'string' },
    limit: { type: 'string', default: '200' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.work || !values.output) {
  console.log(
    'Usage: node scripts/stripe-active-select.mjs --work <dir> --output <frozen.json> [--limit 200]',
  );
  process.exit(values.help ? 0 : 1);
}
const work = resolve(values.work);
await mkdir(join(work, 'repos'), { recursive: true });

const FROZEN_AT = '2026-10-16';
const ACTIVE_SINCE = '2026-07-18T00:00:00Z'; // 90 days before FROZEN_AT
const TARGET = '2026-09-30.endive';
const MAX_DISK_KB = 50 * 1024;
const MIN_AUTHORS = 2;
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
const BOT = /\[bot\]|^(dependabot|renovate|github-actions|actions-user|vercel|netlify)/i;
// The same 13 queries as the fresh set (docs/benchmarks/2026-10-16-stripe-fresh-repos.json).
const QUERIES = [
  '"new Stripe(" apiVersion language:TypeScript',
  '"new Stripe(" apiVersion language:JavaScript',
  '"new Stripe(" "process.env" language:TypeScript',
  '"require(\'stripe\')" language:JavaScript',
  '"from \'stripe\'" language:TypeScript',
  '"from \\"stripe\\"" language:TypeScript',
  '"stripe.checkout.sessions.create" language:TypeScript',
  '"stripe.checkout.sessions.create" language:JavaScript',
  '"stripe.subscriptions.retrieve" language:TypeScript',
  '"stripe.subscriptions.retrieve" language:JavaScript',
  '"stripe.webhooks.constructEvent" language:TypeScript',
  '"stripe.webhooks.constructEvent" language:JavaScript',
  '"stripe.invoices" language:TypeScript',
];
const USED = [
  'docs/benchmarks/2026-10-14-stripe-repos.json',
  'docs/benchmarks/2026-10-15-stripe-heldout-repos.json',
  'docs/benchmarks/2026-10-16-stripe-fresh-repos.json',
];

const token = process.env.GITHUB_TOKEN || (await execute('gh', ['auth', 'token'])).stdout.trim();
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function github(path, init = {}) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        ...init.headers,
      },
    });
    if (response.ok) return response.json();
    // Secondary rate limits answer 403 or 429; wait and retry a few times.
    if ([403, 429, 502].includes(response.status) && attempt < 6) {
      const retry = Number(response.headers.get('retry-after')) || 60;
      console.error(`GitHub ${response.status}; retrying in ${retry}s`);
      await pause(retry * 1000);
      continue;
    }
    throw new Error(`GitHub ${path} returned ${response.status}: ${await response.text()}`);
  }
}

async function cached(name, compute) {
  const path = join(work, name);
  if (existsSync(path)) return JSON.parse(await readFile(path, 'utf8'));
  const value = await compute();
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

// 1. Code search: up to 1,000 results per query, 10 requests a minute.
const search = await cached('search.json', async () => {
  const repositories = new Set();
  for (const query of QUERIES) {
    for (let page = 1; page <= 10; page++) {
      const result = await github(
        `/search/code?q=${encodeURIComponent(query)}&per_page=100&page=${page}`,
      );
      for (const item of result.items) repositories.add(item.repository.full_name);
      console.error(`${query} page ${page}: ${repositories.size} repositories`);
      await pause(6500);
      if (result.items.length < 100) break;
    }
  }
  return [...repositories].sort();
});

const used = new Set();
for (const path of USED)
  for (const entry of JSON.parse(await readFile(path, 'utf8')).repos)
    used.add(entry.repo.toLowerCase());
const candidates = search.filter((repo) => !used.has(repo.toLowerCase()));

// 2. Metadata, recent history and root files, 20 repositories per GraphQL query.
const metadata = await cached('metadata.json', async () => {
  const records = {};
  for (let start = 0; start < candidates.length; start += 20) {
    const batch = candidates.slice(start, start + 20);
    const fields = batch
      .map((repo, index) => {
        const [owner, name] = repo.split('/');
        return `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
          nameWithOwner isArchived isFork diskUsage stargazerCount
          owner { __typename }
          defaultBranchRef { target { ... on Commit {
            oid committedDate
            history(since: ${JSON.stringify(ACTIVE_SINCE)}, first: 100) {
              totalCount nodes { author { email user { login } } }
            }
          } } }
          workflows: object(expression: "HEAD:.github/workflows") { ... on Tree { entries { name } } }
          manifest: object(expression: "HEAD:package.json") { ... on Blob { text } }
          ${LOCKFILES.map((file, lock) => `lock${lock}: object(expression: "HEAD:${file}") { oid }`).join('\n')}
        }`;
      })
      .join('\n');
    const result = await github('/graphql', {
      method: 'POST',
      body: JSON.stringify({ query: `query { ${fields} }` }),
    });
    for (const [index, repo] of batch.entries()) records[repo] = result.data?.[`r${index}`] ?? null;
    console.error(`metadata ${Math.min(start + 20, candidates.length)}/${candidates.length}`);
  }
  return records;
});

function declaresStripe(text) {
  try {
    const manifest = JSON.parse(text);
    return ['dependencies', 'devDependencies'].some(
      (section) => typeof manifest[section]?.stripe === 'string',
    );
  } catch {
    return false;
  }
}

const reasons = {};
const eligible = [];
for (const repo of candidates) {
  const record = metadata[repo];
  const commit = record?.defaultBranchRef?.target;
  const authors = new Set(
    (commit?.history?.nodes ?? [])
      .map((node) => node.author?.user?.login ?? node.author?.email)
      .filter((author) => author && !BOT.test(author)),
  );
  const locks = LOCKFILES.filter((_, index) => record?.[`lock${index}`]);
  const reason = !record
    ? 'unavailable'
    : record.isArchived || record.isFork
      ? 'archived or fork'
      : record.diskUsage >= MAX_DISK_KB
        ? 'over 50 MB'
        : !commit || commit.committedDate < ACTIVE_SINCE
          ? 'no commit in 90 days'
          : authors.size < MIN_AUTHORS
            ? 'fewer than 2 human authors in 90 days'
            : !record.workflows?.entries?.length
              ? 'no GitHub Actions workflow'
              : !declaresStripe(record.manifest?.text ?? '')
                ? 'stripe not in root package.json'
                : locks.length !== 1
                  ? 'not exactly one root lockfile'
                  : null;
  if (reason) {
    reasons[reason] = (reasons[reason] ?? 0) + 1;
    continue;
  }
  eligible.push({
    repo: record.nameWithOwner,
    stars: record.stargazerCount,
    commit: commit.oid,
    owner: record.owner.__typename,
    authors90d: authors.size,
    packageManager: { 'package-lock.json': 'npm', 'pnpm-lock.yaml': 'pnpm', 'yarn.lock': 'yarn' }[
      locks[0]
    ],
  });
}
eligible.sort((a, b) => b.stars - a.stars || a.repo.localeCompare(b.repo));
const cloned = eligible.slice(0, Number(values.limit));

// 3. Each repository's API version: its oldest literal apiVersion pin, else the locked stripe-node
// release mapped through the same table the SDK upgrade uses.
const { STRIPE_SDK_RELEASES } = await import('../pipeline/stripe-package-upgrade.ts');
const compare = (a, b) => {
  const [x, y] = [a, b].map((version) => version.split('.').map(Number));
  for (let index = 0; index < 3; index++) if (x[index] !== y[index]) return x[index] - y[index];
  return 0;
};
const releases = Object.entries(STRIPE_SDK_RELEASES).sort(([, a], [, b]) => compare(a, b));
const fresh = JSON.parse(await readFile(USED[2], 'utf8'));
const specs = new Map(fresh.specs.map((spec) => [spec.version, spec.tag]));
const SOURCE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
const PIN = /apiVersion\s*:\s*['"`](\d{4}-\d{2}-\d{2}(?:\.[a-z]+)?)['"`]/g;

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'dist', 'build', '.next'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (SOURCE.test(entry.name)) files.push(path);
  }
  return files;
}

async function lockedStripe(directory, manager) {
  const file = { npm: 'package-lock.json', pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock' }[manager];
  const text = await readFile(join(directory, file), 'utf8');
  const match =
    manager === 'npm'
      ? JSON.parse(text).packages?.['node_modules/stripe']?.version
      : manager === 'pnpm'
        ? /^ {6}stripe:\n {8}specifier: [^\n]+\n {8}version: (\d+\.\d+\.\d+)/m.exec(text)?.[1]
        : /^"?stripe@[^\n]*:\n {2}version "(\d+\.\d+\.\d+)"/m.exec(text)?.[1];
  return typeof match === 'string' ? match : null;
}

const repos = [];
const dropped = {};
for (const [index, entry] of cloned.entries()) {
  const directory = join(work, 'repos', entry.repo.replace('/', '__'));
  if (!existsSync(join(directory, '.git'))) {
    console.error(`[${index + 1}/${cloned.length}] ${entry.repo}`);
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
        { timeout: 300_000 },
      );
      await execute('git', ['-C', directory, 'checkout', '-q', 'FETCH_HEAD']);
    } catch {
      dropped['clone failed'] = (dropped['clone failed'] ?? 0) + 1;
      continue;
    }
  }
  const pins = [];
  for (const file of await sourceFiles(directory))
    for (const match of (await readFile(file, 'utf8')).matchAll(PIN)) pins.push(match[1]);
  const distinct = [...new Set(pins)].sort();
  const locked = await lockedStripe(directory, entry.packageManager).catch(() => null);
  const before =
    distinct[0] ?? releases.find(([, release]) => locked && compare(release, locked) >= 0)?.[0];
  const beforeSource = distinct.length
    ? `apiVersion pin${distinct.length > 1 ? ` (oldest of ${distinct.length})` : ''}`
    : 'SDK version';
  const reason = !before
    ? 'no API version'
    : before === TARGET
      ? 'already on the target'
      : !specs.has(before)
        ? 'API version without a pinned spec'
        : null;
  if (reason) {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
    continue;
  }
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  repos.push({
    ...entry,
    before,
    beforeSource,
    stripeDependency: manifest.dependencies?.stripe ?? manifest.devDependencies?.stripe,
  });
}

const neededSpecs = [...new Set([...repos.map((entry) => entry.before), TARGET])].sort();
await writeFile(
  resolve(values.output),
  `${JSON.stringify(
    {
      frozenAt: FROZEN_AT,
      purpose:
        'Active-team Stripe repositories: none was in an earlier Stripe set, and none was scanned or used to tune Refit before this list was frozen.',
      criteria: `The fresh set's 13 GitHub code searches, excluding the 531 repositories used before. Kept: not archived, not a fork, under 50 MB; a default-branch commit since ${ACTIVE_SINCE.slice(0, 10)} with at least ${MIN_AUTHORS} distinct human commit authors in that window (bots excluded); a .github/workflows directory; stripe declared in the root package.json; exactly one root lockfile (package-lock.json, pnpm-lock.yaml or yarn.lock). The ${cloned.length} most starred were cloned at their default-branch HEAD. The API version is the oldest literal apiVersion pin, else the locked stripe-node release; repositories without a pinned spec or already on ${TARGET} are dropped.`,
      search: {
        queries: QUERIES,
        repositories: search.length,
        unused: candidates.length,
        eligible: eligible.length,
        cloned: cloned.length,
        excluded: reasons,
        dropped,
      },
      target: TARGET,
      specs: neededSpecs.map((version) => ({ version, tag: specs.get(version) })),
      repos,
    },
    null,
    2,
  )}\n`,
);
console.log(
  JSON.stringify(
    { search: search.length, eligible: eligible.length, kept: repos.length, reasons, dropped },
    null,
    2,
  ),
);
