// Freezes an "active teams" Stripe benchmark list: repositories a working team is changing now,
// selected only from GitHub metadata and committed files, before Refit sees any of them.
// Usage: GITHUB_TOKEN=… node scripts/stripe-active-select.mjs --work <dir> --output <frozen.json>
//          [--frozen-at YYYY-MM-DD] [--exclude docs/benchmarks/<list>.json …] [--limit 200]
// The token is read from GITHUB_TOKEN, or from `gh auth token` when unset. Each phase caches its
// result in --work, so an interrupted selection resumes.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);

export const ACTIVE_DAYS = 90;
const METADATA_CONCURRENCY = 2;
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
// Code search returns at most 1,000 results per query, so each query runs once per file-size
// range (bytes) to reach past that cap.
export const SIZE_RANGES = ['<2000', '2000..4000', '4000..8000', '8000..16000', '>16000'];
// The lists the October 16 active-teams set excluded; --exclude replaces them.
export const DEFAULT_EXCLUDES = [
  'docs/benchmarks/2026-10-14-stripe-repos.json',
  'docs/benchmarks/2026-10-15-stripe-heldout-repos.json',
  'docs/benchmarks/2026-10-16-stripe-fresh-repos.json',
];
const PIN = /apiVersion\s*:\s*['"`](\d{4}-\d{2}-\d{2}(?:\.[a-z]+)?)['"`]/g;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;
const SOURCE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;

export function searchQueries() {
  return QUERIES.flatMap((query) => SIZE_RANGES.map((size) => `${query} size:${size}`));
}

export function activeSince(frozenAt) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(frozenAt) || Number.isNaN(Date.parse(frozenAt)))
    throw new Error(`--frozen-at must be a date such as 2026-10-24, not ${frozenAt}`);
  return new Date(Date.parse(frozenAt) - ACTIVE_DAYS * 86_400_000).toISOString().slice(0, 19) + 'Z';
}

// Literal apiVersion pins, skipping commented-out lines (`// apiVersion: '2023-08-16'`).
export function apiVersionPins(text) {
  return text
    .split('\n')
    .filter((line) => !COMMENT_LINE.test(line))
    .flatMap((line) => [...line.matchAll(PIN)].map((match) => match[1]));
}

// Every repository in the excluded lists (lower-cased), each list's size, and the union of their
// pinned specification tags.
export async function readExclusions(paths) {
  const repos = new Set();
  const lists = [];
  const specs = new Map();
  for (const path of paths) {
    const list = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(list.repos)) throw new Error(`${path} has no repos array`);
    for (const entry of list.repos) repos.add(entry.repo.toLowerCase());
    for (const spec of list.specs ?? []) {
      const known = specs.get(spec.version);
      if (known && known !== spec.tag)
        throw new Error(`${path} pins ${spec.version} to ${spec.tag}, another list to ${known}`);
      specs.set(spec.version, spec.tag);
    }
    lists.push({ list: path, repositories: list.repos.length });
  }
  return { repos, lists, specs };
}

async function main() {
  const { values } = parseArgs({
    options: {
      work: { type: 'string' },
      output: { type: 'string' },
      limit: { type: 'string', default: '200' },
      'frozen-at': { type: 'string', default: '2026-10-16' },
      exclude: { type: 'string', multiple: true, default: DEFAULT_EXCLUDES },
      help: { type: 'boolean' },
    },
  });
  if (values.help || !values.work || !values.output) {
    console.log(
      'Usage: node scripts/stripe-active-select.mjs --work <dir> --output <frozen.json> [--frozen-at YYYY-MM-DD] [--exclude <list.json> …] [--limit 200]',
    );
    process.exit(values.help ? 0 : 1);
  }
  const frozenAt = values['frozen-at'];
  const since = activeSince(frozenAt);
  const exclusions = await readExclusions(values.exclude);
  const work = resolve(values.work);
  await mkdir(join(work, 'repos'), { recursive: true });

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
  const queries = searchQueries();
  const search = await cached('search.json', async () => {
    const repositories = new Set();
    for (const query of queries) {
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

  const excludedByList = Object.fromEntries(exclusions.lists.map(({ list }) => [list, 0]));
  const listOf = new Map();
  for (const { list } of exclusions.lists)
    for (const entry of JSON.parse(await readFile(list, 'utf8')).repos)
      if (!listOf.has(entry.repo.toLowerCase())) listOf.set(entry.repo.toLowerCase(), list);
  const candidates = search.filter((repo) => {
    const list = listOf.get(repo.toLowerCase());
    if (list) excludedByList[list] += 1;
    return !list;
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

  function humanAuthors(commit) {
    return new Set(
      (commit?.history?.nodes ?? [])
        .map((node) => node.author?.user?.login ?? node.author?.email)
        .filter((author) => author && !BOT.test(author)),
    );
  }

  // Why a repository is not eligible, or null when it is.
  function ineligibility(record) {
    const commit = record?.defaultBranchRef?.target;
    const locks = LOCKFILES.filter((_, index) => record?.[`lock${index}`]);
    return !record
      ? 'unavailable'
      : record.isArchived || record.isFork
        ? 'archived or fork'
        : record.diskUsage >= MAX_DISK_KB
          ? 'over 50 MB'
          : !commit || commit.committedDate < since
            ? `no commit in ${ACTIVE_DAYS} days`
            : humanAuthors(commit).size < MIN_AUTHORS
              ? `fewer than 2 human authors in ${ACTIVE_DAYS} days`
              : !record.workflows?.entries?.length
                ? 'no GitHub Actions workflow'
                : !declaresStripe(record.manifest?.text ?? '')
                  ? 'stripe not in root package.json'
                  : locks.length !== 1
                    ? 'not exactly one root lockfile'
                    : null;
  }

  // 2. Metadata. A light pass (100 repositories per GraphQL query) drops archived repositories,
  // forks, large ones and those not pushed to since the window opened: a push is never older than
  // the default branch's last commit, so none of these could pass the full check. The rest get
  // recent history and root files, 20 per query. Queries run METADATA_CONCURRENCY at a time.
  const metadata = await cached('metadata.json', async () => {
    const query = async (batch, fields) => {
      const aliases = batch
        .map((repo, index) => {
          const [owner, name] = repo.split('/');
          return `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} }`;
        })
        .join('\n');
      const result = await github('/graphql', {
        method: 'POST',
        body: JSON.stringify({ query: `query { ${aliases} }` }),
      });
      return batch.map((repo, index) => [repo, result.data?.[`r${index}`] ?? null]);
    };
    const readAll = async (repos, size, fields, label) => {
      const records = {};
      const step = size * METADATA_CONCURRENCY;
      for (let start = 0; start < repos.length; start += step) {
        const batches = [];
        for (let offset = start; offset < Math.min(start + step, repos.length); offset += size)
          batches.push(repos.slice(offset, offset + size));
        for (const entries of await Promise.all(batches.map((batch) => query(batch, fields))))
          for (const [repo, record] of entries) records[repo] = record;
        console.error(`${label} ${Math.min(start + step, repos.length)}/${repos.length}`);
      }
      return records;
    };
    const light = await readAll(
      candidates,
      100,
      'nameWithOwner isArchived isFork diskUsage pushedAt',
      'light',
    );
    const full = await readAll(
      candidates.filter((repo) => {
        const record = light[repo];
        return (
          record &&
          !record.isArchived &&
          !record.isFork &&
          record.diskUsage < MAX_DISK_KB &&
          record.pushedAt >= since
        );
      }),
      20,
      `nameWithOwner isArchived isFork diskUsage stargazerCount
          owner { __typename }
          defaultBranchRef { target { ... on Commit {
            oid committedDate
            history(since: ${JSON.stringify(since)}, first: 100) {
              totalCount nodes { author { email user { login } } }
            }
          } } }
          workflows: object(expression: "HEAD:.github/workflows") { ... on Tree { entries { name } } }
          manifest: object(expression: "HEAD:package.json") { ... on Blob { text } }
          ${LOCKFILES.map((file, lock) => `lock${lock}: object(expression: "HEAD:${file}") { oid }`).join('\n')}`,
      'full',
    );
    // A repository the light pass dropped keeps its light record, which fails the same check.
    return Object.fromEntries(candidates.map((repo) => [repo, full[repo] ?? light[repo]]));
  });

  const reasons = {};
  const eligible = [];
  for (const repo of candidates) {
    const record = metadata[repo];
    const commit = record?.defaultBranchRef?.target;
    const reason = ineligibility(record);
    if (reason) {
      reasons[reason] = (reasons[reason] ?? 0) + 1;
      continue;
    }
    // A repository renamed into an excluded list's name is still excluded.
    const renamed = listOf.get(record.nameWithOwner.toLowerCase());
    if (renamed) {
      excludedByList[renamed] += 1;
      continue;
    }
    eligible.push({
      repo: record.nameWithOwner,
      stars: record.stargazerCount,
      commit: commit.oid,
      owner: record.owner.__typename,
      authors90d: humanAuthors(commit).size,
      packageManager: { 'package-lock.json': 'npm', 'pnpm-lock.yaml': 'pnpm', 'yarn.lock': 'yarn' }[
        LOCKFILES.find((_, index) => record[`lock${index}`])
      ],
    });
  }
  eligible.sort((a, b) => b.stars - a.stars || a.repo.localeCompare(b.repo));
  const cloned = eligible.slice(0, Number(values.limit));

  // 3. Each repository's API version: its oldest literal apiVersion pin, else the locked
  // stripe-node release mapped through the same table the SDK upgrade uses. Only this script reads
  // the clones, and it deletes each one after reading.
  const { STRIPE_SDK_RELEASES } = await import('../pipeline/stripe-package-upgrade.ts');
  const compare = (a, b) => {
    const [x, y] = [a, b].map((version) => version.split('.').map(Number));
    for (let index = 0; index < 3; index++) if (x[index] !== y[index]) return x[index] - y[index];
    return 0;
  };
  const releases = Object.entries(STRIPE_SDK_RELEASES).sort(([, a], [, b]) => compare(a, b));

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

  const versions = await cached('versions.json', async () => {
    const found = {};
    for (const [index, entry] of cloned.entries()) {
      const directory = join(work, 'repos', entry.repo.replace('/', '__'));
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
        const pins = [];
        for (const file of await sourceFiles(directory))
          pins.push(...apiVersionPins(await readFile(file, 'utf8')));
        const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        found[entry.repo] = {
          pins: [...new Set(pins)].sort(),
          locked: await lockedStripe(directory, entry.packageManager).catch(() => null),
          stripeDependency: manifest.dependencies?.stripe ?? manifest.devDependencies?.stripe,
        };
      } catch {
        found[entry.repo] = null;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    return found;
  });

  const repos = [];
  const dropped = {};
  const droppedRepos = [];
  for (const entry of cloned) {
    const version = versions[entry.repo];
    const before = !version
      ? undefined
      : (version.pins[0] ??
        releases.find(
          ([, release]) => version.locked && compare(release, version.locked) >= 0,
        )?.[0]);
    const reason = !version
      ? 'clone failed'
      : !before
        ? 'no API version'
        : before === TARGET
          ? 'already on the target'
          : !exclusions.specs.has(before)
            ? 'API version without a pinned spec'
            : null;
    if (reason) {
      dropped[reason] = (dropped[reason] ?? 0) + 1;
      droppedRepos.push({ repo: entry.repo, reason, ...(before ? { before } : {}) });
      continue;
    }
    repos.push({
      ...entry,
      before,
      beforeSource: version.pins.length
        ? `apiVersion pin${version.pins.length > 1 ? ` (oldest of ${version.pins.length})` : ''}`
        : 'SDK version',
      stripeDependency: version.stripeDependency,
    });
  }

  const neededSpecs = [...new Set([...repos.map((entry) => entry.before), TARGET])].sort();
  const excludedTotal = exclusions.repos.size;
  await writeFile(
    resolve(values.output),
    `${JSON.stringify(
      {
        frozenAt,
        purpose:
          'Active-team Stripe repositories: none was in an earlier Stripe set, and none was scanned or used to tune Refit before this list was frozen.',
        criteria: `The fresh set's 13 GitHub code searches, each split into ${SIZE_RANGES.length} file-size ranges, excluding the ${excludedTotal} repositories of the excluded lists. Kept: not archived, not a fork, under 50 MB; a default-branch commit since ${since.slice(0, 10)} with at least ${MIN_AUTHORS} distinct human commit authors in that window (bots excluded); a .github/workflows directory; stripe declared in the root package.json; exactly one root lockfile (package-lock.json, pnpm-lock.yaml or yarn.lock). The ${cloned.length} most starred were cloned at their default-branch HEAD by this script, read only for their API version and deleted. The API version is the oldest literal apiVersion pin outside a commented-out line, else the locked stripe-node release; repositories without a pinned spec or already on ${TARGET} are dropped.`,
        search: {
          queries,
          repositories: search.length,
          excludedLists: exclusions.lists.map((entry) => ({
            ...entry,
            foundBySearch: excludedByList[entry.list],
          })),
          unused: candidates.length,
          eligible: eligible.length,
          cloned: cloned.length,
          excluded: reasons,
          dropped,
          droppedRepos,
        },
        target: TARGET,
        specs: neededSpecs.map((version) => ({ version, tag: exclusions.specs.get(version) })),
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
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
