// Freezes Refit's measurement-only Stripe holdout sets (holdout-100 and holdout-30b) from the same
// population as the fresh set, which every tuned Stripe set and heldout-30 descend from: the fresh
// set's 13 GitHub code searches and its filters. Candidates are ordered by a SHA-256 of a fixed
// seed and their name, so the order depends on nothing Refit or a person saw.
// Usage: node scripts/stripe-holdout-select.mjs --work <dir> --output-dir docs/benchmarks/subsets
//          [--seed refit-holdout-2026-10-28] [--names-at <commit>] [--frozen-at YYYY-MM-DD]
//          [--batch 50] [--inputs docs/benchmarks/holdout-selection]
// The token is read from GITHUB_TOKEN, or from `gh auth token` when unset, and never printed. Each
// phase caches its result in --work, so an interrupted selection resumes; the committed inputs and
// frozen lists are the record, because GitHub's search index moves.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { validRepoName } from './ai-app-helpers.mjs';
import { apiVersionPins, QUERIES } from './stripe-active-select.mjs';

const execute = promisify(execFile);

export const DEFAULT_SEED = 'refit-holdout-2026-10-28';
// The fresh set's filters (docs/benchmarks/2026-10-16-stripe-fresh-repos.json).
export const PUSHED_SINCE = '2024-01-01';
export const MAX_DISK_KB = 50 * 1024;
export const TARGET = '2026-09-30.endive';
// Sets in the order they are filled from the seeded candidate order.
export const SETS = [
  { name: 'holdout-100', size: 100 },
  { name: 'holdout-30b', size: 30 },
];
// Local scans stay small: at most this many shallow clones exist between two cache writes.
export const MAX_BATCH = 50;
const CLONE_CONCURRENCY = 2;
const METADATA_BATCH = 20;
const CODE_SEARCH_PAUSE_MS = 6500;
const LOCKFILES = { 'package-lock.json': 'npm', 'pnpm-lock.yaml': 'pnpm', 'yarn.lock': 'yarn' };
const VERSIONS = 'data/stripe-openapi-versions.json';
const SOURCE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'out']);
// Files whose Stripe use is not the application's own code.
const NOT_APPLICATION =
  /(?:^|\/)(?:tests?|__tests__|__mocks__|spec|e2e|fixtures?)\/|\.(?:test|spec|stories)\.[^/]+$/;
const SDK_IMPORT = /(?:from\s*|require\(\s*|import\(\s*)['"]stripe['"]/;
// `new Stripe(key)`, `Stripe(key)` or `require('stripe')(key)`.
const SDK_CLIENT = /\bStripe\s*\(|require\(\s*['"]stripe['"]\s*\)\s*\(/;
// Anything that looks like a GitHub `owner/name` in Refit's own files.
// The owner must start a word, so `github.com/owner/name` yields `owner/name`, not `com/owner`.
const SLUG = /(?<![A-Za-z0-9_.-])[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+/g;

// Position of a repository in the seeded order: SHA-256 of the seed, a newline and the
// lower-cased name, as hex.
export function seedRank(seed, repo) {
  return createHash('sha256').update(`${seed}\n${repo.toLowerCase()}`).digest('hex');
}

export function seededOrder(seed, repos) {
  return repos
    .map((repo) => ({ repo, rank: seedRank(seed, repo) }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .map(({ repo }) => repo);
}

// Lower-cased `owner/name` tokens in a text, for excluding every repository Refit already names.
export function slugTokens(text) {
  return new Set(
    [...text.matchAll(SLUG)].map((match) => match[0].toLowerCase().replace(/\.git$/, '')),
  );
}

export function declaresStripe(text) {
  try {
    const manifest = JSON.parse(text);
    return ['dependencies', 'devDependencies'].some(
      (section) => typeof manifest?.[section]?.stripe === 'string',
    );
  } catch {
    return false;
  }
}

// Why a GraphQL metadata record cannot be selected, or null. The fresh set's filters.
export function metadataIneligibility(record) {
  if (!record) return 'unavailable';
  if (record.isArchived) return 'archived';
  if (record.isFork) return 'fork';
  if (record.diskUsage >= MAX_DISK_KB) return 'over 50 MB';
  if (!record.pushedAt || record.pushedAt.slice(0, 10) < PUSHED_SINCE)
    return `no push since ${PUSHED_SINCE}`;
  if (!record.defaultBranchRef?.target?.oid) return 'no default branch';
  if (!record.declaresStripe) return 'stripe not in root package.json';
  return null;
}

export function packageManagerOf(record) {
  const found = Object.keys(LOCKFILES).filter((_, index) => record?.[`lock${index}`]);
  return found.length === 1 ? LOCKFILES[found[0]] : found.length ? 'several' : 'none';
}

// Whether application files import the Stripe SDK and construct a client: the local check that a
// repository really uses stripe-node, not only declares it. `files` holds `{ path, text }`.
export function usesStripeSdk(files) {
  const application = files.filter((file) => !NOT_APPLICATION.test(file.path));
  return (
    application.some((file) => SDK_IMPORT.test(file.text)) &&
    application.some((file) => SDK_CLIENT.test(file.text))
  );
}

function compareSemver(a, b) {
  const [x, y] = [a, b].map((version) => version.split('.').map(Number));
  for (let index = 0; index < 3; index++) if (x[index] !== y[index]) return x[index] - y[index];
  return 0;
}

// The API version as the fresh and active sets read it: the oldest literal apiVersion pin, else the
// API version of the first stripe-node release at or after the locked one.
export function apiVersionOf({ pins, locked }, releases) {
  if (pins.length) return { before: [...pins].sort()[0], beforeSource: pinSource(pins) };
  if (!locked) return null;
  const release = Object.entries(releases)
    .sort(([, a], [, b]) => compareSemver(a, b))
    .find(([, version]) => compareSemver(version, locked) >= 0);
  return release ? { before: release[0], beforeSource: 'SDK version' } : null;
}

function pinSource(pins) {
  return `apiVersion pin${pins.length > 1 ? ` (oldest of ${pins.length})` : ''}`;
}

// Why a checked clone cannot be selected, or null. `specs` holds the versions with a pinned
// stripe/openapi document.
export function checkIneligibility(check, specs) {
  if (!check || check.error) return 'clone failed';
  if (!check.usesSdk) return 'no Stripe SDK client in application code';
  if (!check.before) return 'no API version';
  if (check.before >= TARGET) return 'already on the target';
  if (!specs.has(check.before)) return 'API version without a pinned spec';
  return null;
}

// Fills the sets in order from the kept repositories, which stay in seeded order.
export function assignSets(kept, sets = SETS) {
  let start = 0;
  return sets.map(({ name, size }) => {
    const repos = kept.slice(start, start + size);
    start += size;
    if (repos.length < size)
      throw new Error(`${name} needs ${size} repositories, got ${repos.length}`);
    return { name, repos };
  });
}

export function lockedStripe(text, manager) {
  const match =
    manager === 'npm'
      ? JSON.parse(text).packages?.['node_modules/stripe']?.version
      : manager === 'pnpm'
        ? /^ {6}stripe:\n {8}specifier: [^\n]+\n {8}version: (\d+\.\d+\.\d+)/m.exec(text)?.[1]
        : /^"?stripe@[^\n]*:\n {2}version "(\d+\.\d+\.\d+)"/m.exec(text)?.[1];
  return typeof match === 'string' ? match : null;
}

async function sourceFiles(directory, root = directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path, root)));
    else if (entry.isFile() && SOURCE.test(entry.name))
      files.push({ path: relative(root, path), text: await readFile(path, 'utf8') });
  }
  return files;
}

async function main() {
  const { values } = parseArgs({
    options: {
      work: { type: 'string' },
      'output-dir': { type: 'string', default: 'docs/benchmarks/subsets' },
      inputs: { type: 'string', default: 'docs/benchmarks/holdout-selection' },
      seed: { type: 'string', default: DEFAULT_SEED },
      'names-at': { type: 'string', default: 'HEAD' },
      'frozen-at': { type: 'string', default: '2026-10-28' },
      batch: { type: 'string', default: String(MAX_BATCH) },
      help: { type: 'boolean' },
    },
  });
  if (values.help || !values.work) {
    console.log(
      'Usage: node scripts/stripe-holdout-select.mjs --work <dir> [--output-dir docs/benchmarks/subsets] [--inputs docs/benchmarks/holdout-selection] [--seed <seed>] [--names-at <commit>] [--frozen-at YYYY-MM-DD] [--batch 50]',
    );
    process.exit(values.help ? 0 : 1);
  }
  const batchSize = Number(values.batch);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH)
    throw new Error(`--batch must be 1 to ${MAX_BATCH}`);
  const { seed } = values;
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
      // Secondary rate limits answer 403 or 429; back off longer on each retry.
      if ([403, 429, 502, 503].includes(response.status) && attempt < 8) {
        const retry = Number(response.headers.get('retry-after')) || 60 * (attempt + 1);
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

  // Every owner/name Refit's tracked files mention at --names-at, so a repository any list,
  // result, review, note or test names is never held out. The holdout outputs themselves are
  // left out of the scan, so the selection reproduces after they are committed.
  const namesAt = (await execute('git', ['rev-parse', values['names-at']])).stdout.trim();
  const outputs = [
    ...SETS.map(({ name }) => relative(process.cwd(), join(values['output-dir'], `${name}.json`))),
    relative(process.cwd(), values.inputs),
  ];
  const named = await cached('named.json', async () => {
    // Every line with a slash in a text file at that commit.
    const { stdout } = await execute(
      'git',
      ['grep', '-I', '-h', '-F', '/', namesAt, '--', '.', ...outputs.map((path) => `:!${path}`)],
      { maxBuffer: 1024 * 1024 * 1024 },
    );
    return [...slugTokens(stdout)].sort();
  });
  const namedSet = new Set(named);

  // 1. The fresh set's 13 code searches: up to 1,000 results each, 10 requests a minute.
  const search = await cached('search.json', async () => {
    const repositories = new Set();
    for (const query of QUERIES) {
      for (let page = 1; page <= 10; page++) {
        const result = await github(
          `/search/code?q=${encodeURIComponent(query)}&per_page=100&page=${page}`,
        );
        for (const item of result.items) repositories.add(item.repository.full_name);
        console.error(`${query} page ${page}: ${repositories.size} repositories`);
        await pause(CODE_SEARCH_PAUSE_MS);
        if (result.items.length < 100) break;
      }
    }
    return [...repositories].sort();
  });
  const unnamed = search.filter((repo) => validRepoName(repo) && !namedSet.has(repo.toLowerCase()));

  // 2. Metadata, METADATA_BATCH repositories per GraphQL query, one query at a time.
  const metadata = await cached('metadata.json', async () => {
    const records = {};
    for (let start = 0; start < unnamed.length; start += METADATA_BATCH) {
      const batch = unnamed.slice(start, start + METADATA_BATCH);
      const aliases = batch
        .map((repo, index) => {
          const [owner, name] = repo.split('/');
          return `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
            nameWithOwner isArchived isFork diskUsage pushedAt stargazerCount
            defaultBranchRef { target { ... on Commit { oid } } }
            manifest: object(expression: "HEAD:package.json") { ... on Blob { text } }
            ${Object.keys(LOCKFILES)
              .map((file, lock) => `lock${lock}: object(expression: "HEAD:${file}") { oid }`)
              .join('\n')}
          }`;
        })
        .join('\n');
      const result = await github('/graphql', {
        method: 'POST',
        body: JSON.stringify({ query: `query { ${aliases} }` }),
      });
      for (const [index, repo] of batch.entries()) {
        const record = result.data?.[`r${index}`] ?? null;
        // Only what the selection reads is kept.
        records[repo] = record && {
          nameWithOwner: record.nameWithOwner,
          isArchived: record.isArchived,
          isFork: record.isFork,
          diskUsage: record.diskUsage,
          pushedAt: record.pushedAt,
          stargazerCount: record.stargazerCount,
          defaultBranchRef: record.defaultBranchRef,
          declaresStripe: declaresStripe(record.manifest?.text ?? ''),
          stripeDependency: (() => {
            try {
              const manifest = JSON.parse(record.manifest?.text ?? '');
              return manifest.dependencies?.stripe ?? manifest.devDependencies?.stripe;
            } catch {
              return undefined;
            }
          })(),
          ...Object.fromEntries(
            Object.keys(LOCKFILES).map((_, lock) => [
              `lock${lock}`,
              Boolean(record[`lock${lock}`]),
            ]),
          ),
        };
      }
      console.error(
        `metadata ${Math.min(start + METADATA_BATCH, unnamed.length)}/${unnamed.length}`,
      );
      await pause(1000);
    }
    return records;
  });

  const excluded = {};
  const eligible = [];
  for (const repo of unnamed) {
    const record = metadata[repo];
    const reason = metadataIneligibility(record);
    if (reason) excluded[reason] = (excluded[reason] ?? 0) + 1;
    // A repository renamed to a name Refit already mentions is excluded too.
    else if (namedSet.has(record.nameWithOwner.toLowerCase()))
      excluded['named in Refit'] = (excluded['named in Refit'] ?? 0) + 1;
    else eligible.push(record.nameWithOwner);
  }
  const records = new Map(unnamed.map((repo) => [metadata[repo]?.nameWithOwner, metadata[repo]]));
  const order = seededOrder(seed, [...new Set(eligible)]);

  // 3. Walk the seeded order, at most --batch shallow clones at a time, each deleted after it is
  // read for its API version and SDK use, until every set is full.
  const { STRIPE_SDK_RELEASES } = await import('../pipeline/stripe-package-upgrade.ts');
  const table = JSON.parse(await readFile(VERSIONS, 'utf8'));
  const specs = new Map(table.versions.map((entry) => [entry.version, entry.tag]));
  const checksPath = join(work, 'checks.json');
  const checks = existsSync(checksPath) ? JSON.parse(await readFile(checksPath, 'utf8')) : {};
  const needed = SETS.reduce((total, set) => total + set.size, 0);
  const keptSoFar = () =>
    order.filter((repo) => repo in checks && !checkIneligibility(checks[repo], specs));
  let cursor = 0;
  while (keptSoFar().length < needed && cursor < order.length) {
    const batch = [];
    while (batch.length < batchSize && cursor < order.length) {
      const repo = order[cursor++];
      if (!(repo in checks)) batch.push(repo);
    }
    const queue = [...batch];
    await Promise.all(
      Array.from({ length: CLONE_CONCURRENCY }, async () => {
        for (let repo = queue.shift(); repo; repo = queue.shift()) {
          const record = records.get(repo);
          const commit = record.defaultBranchRef.target.oid;
          const manager = packageManagerOf(record);
          const directory = join(work, 'repos', repo.replace('/', '__'));
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
                `https://github.com/${repo}`,
                commit,
              ],
              {
                timeout: 300_000,
                env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' },
              },
            );
            await execute('git', ['-C', directory, 'checkout', '-q', 'FETCH_HEAD']);
            const files = await sourceFiles(directory);
            const pins = [...new Set(files.flatMap((file) => apiVersionPins(file.text)))].sort();
            const lockfile = Object.entries(LOCKFILES).find(([, name]) => name === manager)?.[0];
            const locked = lockfile
              ? await readFile(join(directory, lockfile), 'utf8')
                  .then((text) => lockedStripe(text, manager))
                  .catch(() => null)
              : null;
            checks[repo] = {
              commit,
              stars: record.stargazerCount,
              stripeDependency: record.stripeDependency,
              packageManager: manager,
              usesSdk: usesStripeSdk(files),
              pins,
              locked,
              ...apiVersionOf({ pins, locked }, STRIPE_SDK_RELEASES),
            };
          } catch (error) {
            checks[repo] = { commit, error: String(error?.code ?? 'clone failed') };
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        }
      }),
    );
    await writeFile(checksPath, `${JSON.stringify(checks, null, 2)}\n`);
    console.error(`checked ${cursor}/${order.length}, kept ${keptSoFar().length}/${needed}`);
  }

  const walked = order.slice(0, cursor);
  const dropped = {};
  for (const repo of walked) {
    const reason = checkIneligibility(checks[repo], specs);
    if (reason) dropped[reason] = (dropped[reason] ?? 0) + 1;
  }
  const kept = walked.filter((repo) => !checkIneligibility(checks[repo], specs)).slice(0, needed);
  const sets = assignSets(kept);

  // The committed inputs: the search result, the seeded order of eligible candidates, and each
  // walked candidate's check, so anyone can recompute the sets without GitHub.
  const inputs = resolve(values.inputs);
  await mkdir(inputs, { recursive: true });
  const write = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  await write(join(inputs, 'search.json'), { queries: QUERIES, repositories: search });
  await write(join(inputs, 'candidates.json'), {
    seed,
    namesAt,
    rank: 'sha256(seed + "\\n" + lowercase(repo)), ascending',
    named: search.length - unnamed.length,
    excluded,
    order,
  });
  await write(
    join(inputs, 'checks.json'),
    Object.fromEntries(
      walked.map((repo) => [
        repo,
        { ...checks[repo], outcome: checkIneligibility(checks[repo], specs) ?? 'kept' },
      ]),
    ),
  );

  const criteria = `The fresh set's 13 GitHub code searches for stripe-node use (docs/benchmarks/holdout-selection/search.json), excluding every owner/name any tracked Refit file mentions at ${namesAt} (every frozen list, subset, result, review and note). Kept, as the fresh set: not archived, not a fork, under 50 MB, pushed since ${PUSHED_SINCE}, stripe declared in the root package.json. Those were ordered by SHA-256 of the seed "${seed}", a newline and the lower-cased name (candidates.json), and walked in that order with shallow clones at the default-branch HEAD, read only for their API version and Stripe use and deleted (checks.json). Kept: an application file (not a test, spec, fixture or mock) imports stripe and one constructs a client; the API version (the oldest literal apiVersion pin outside a commented-out line, else the locked stripe-node release) has a pinned spec in ${VERSIONS} and is older than ${TARGET}. The first ${SETS[0].size} kept are holdout-100, the next ${SETS[1].size} holdout-30b.`;
  let position = 0;
  for (const [index, { name, repos }] of sets.entries()) {
    const entries = repos.map((repo) => {
      const check = checks[repo];
      return {
        repo,
        stars: check.stars,
        commit: check.commit,
        before: check.before,
        beforeSource: check.beforeSource,
        stripeDependency: check.stripeDependency,
        packageManager: check.packageManager,
      };
    });
    const versions = [...new Set([...entries.map((entry) => entry.before), TARGET])].sort();
    await write(resolve(values['output-dir'], `${name}.json`), {
      frozenAt: values['frozen-at'],
      purpose: `Measurement-only Stripe holdout set ${index + 1} of ${SETS.length}: no repository was named anywhere in Refit, opened by a person, scanned by Refit or used to tune it before this list was frozen. Run it only at milestones; never open, trace or debug its repositories, rows or diffs to design a fix (docs/BENCHMARKS.md#holdout-sets).`,
      criteria,
      seed,
      namesAt,
      selection: {
        script: 'scripts/stripe-holdout-select.mjs',
        inputs: relative(process.cwd(), inputs),
        searchRepositories: search.length,
        eligible: order.length,
        walked: walked.length,
        dropped,
        kept: kept.length,
        positions: [position, (position += repos.length)],
      },
      target: TARGET,
      specs: versions.map((version) => ({ version, tag: specs.get(version) })),
      repos: entries,
    });
  }
  console.log(
    JSON.stringify(
      {
        search: search.length,
        named: search.length - unnamed.length,
        eligible: order.length,
        walked: walked.length,
        excluded,
        dropped,
        sets: sets.map((set) => [set.name, set.repos.length]),
      },
      null,
      2,
    ),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
