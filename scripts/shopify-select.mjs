// Freezes the Shopify engine's dev and blind benchmark sets (docs/SHOPIFY-META-ENGINES.md#benchmarks):
// active repositories that use a Shopify SDK, app config or Admin URL, pre-scanned offline with
// Refit's own Shopify scan and kept only where a breaking change reaches them. Candidates are
// ordered by a SHA-256 of a fixed seed and their name, so the split depends on nothing a person saw.
// Usage: GITHUB_TOKEN=… npx tsx scripts/shopify-select.mjs --work <dir>
//          [--output-dir docs/benchmarks/subsets] [--inputs docs/benchmarks/shopify-selection]
//          [--frozen-at YYYY-MM-DD] [--seed refit-shopify-2026-10-29] [--exclude-ref origin/main …]
// The token is read from GITHUB_TOKEN, or from `gh auth token` when unset, and never printed. Each
// phase caches its result in --work, so an interrupted selection resumes; the committed inputs and
// frozen lists are the record, because GitHub's search index moves.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { shallowCheckout } from './ai-app-helpers.mjs';
import { activeSince, ACTIVE_DAYS, SIZE_RANGES } from './stripe-active-select.mjs';

const execute = promisify(execFile);

export const DEFAULT_SEED = 'refit-shopify-2026-10-29';
export const TARGET = '2026-10';
// Sets in the order they are filled from the seeded order of affected repositories: the blind set
// first, so it is as large as possible when fewer than 160 repositories qualify (founder, 2026-10-29).
export const SETS = [
  { name: 'shopify-blind-100', size: 100 },
  { name: 'shopify-dev-60', size: 60 },
];
export const QUERIES = [
  '"@shopify/shopify-api" filename:package.json',
  '"@shopify/shopify-app-remix" filename:package.json',
  '"@shopify/shopify-app-react-router" filename:package.json',
  'api_version filename:shopify.app.toml',
  '"/admin/api/20" language:TypeScript',
  '"/admin/api/20" language:JavaScript',
];
// The committed-source limit validation archives under the 4g profile (founders' decision, 2026-10-27).
const MAX_DISK_KB = 512 * 1024;
const MIN_AUTHORS = 2;
// When too few repositories qualify, blind-set eligibility loosens in this order (founder,
// 2026-10-29): the activity window to 180 days, then one human author. CI, lockfile, Shopify
// usage and the affected checks never loosen.
export const STAGES = [
  { days: ACTIVE_DAYS, authors: MIN_AUTHORS, loosened: [] },
  { days: 180, authors: MIN_AUTHORS, loosened: ['activity window 180 days'] },
  { days: 180, authors: 1, loosened: ['activity window 180 days', '1 human author'] },
];
const METADATA_CONCURRENCY = 2;
const CODE_SEARCH_PAUSE_MS = 6500;
const LOCKFILES = {
  'package-lock.json': 'npm',
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
};
const BOT = /\[bot\]|^(dependabot|renovate|github-actions|actions-user|vercel|netlify)/i;
const CODEGEN_CONFIG = /(?:^|\/)\.graphqlrc\.[cm]?[jt]s$/;
// Product model migration (2024-04 onward): product and variant mutations and their inputs.
const PRODUCT_MODEL =
  /\bproduct(?:Create|Update|Set|VariantCreate|VariantUpdate|VariantDelete|VariantsBulk\w*|Option\w*)\b|\bProduct(?:Variant)?Input\b/;
// Anything that looks like a GitHub `owner/name` (the holdout selector's rule).
const SLUG = /(?<![A-Za-z0-9_.-])[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+/g;

export function searchQueries() {
  return QUERIES.flatMap((query) => SIZE_RANGES.map((size) => `${query} size:${size}`));
}

export function seedRank(seed, repo) {
  return createHash('sha256').update(`${seed}\n${repo.toLowerCase()}`).digest('hex');
}

export function seededOrder(seed, repos) {
  return repos
    .map((repo) => ({ repo, rank: seedRank(seed, repo) }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .map(({ repo }) => repo);
}

export function slugTokens(text) {
  return new Set(
    [...text.matchAll(SLUG)].map((match) => match[0].toLowerCase().replace(/\.git$/, '')),
  );
}

// Admin API versions still served on `frozenAt`, oldest first, from the deadline registry.
export function supportedVersions(deadlines, frozenAt) {
  return deadlines.deadlines
    .map((entry) => ({ version: /^shopify-admin-(\d{4}-\d{2})$/.exec(entry.id)?.[1], ...entry }))
    .filter((entry) => entry.version && entry.date > frozenAt)
    .map((entry) => entry.version)
    .sort();
}

export function lockfilesOf(record) {
  return Object.keys(LOCKFILES).filter((_, index) => record?.[`lock${index}`]);
}

function humanAuthors(commit, since) {
  return new Set(
    (commit?.history?.nodes ?? [])
      .filter((node) => !node.committedDate || node.committedDate >= since)
      .map((node) => node.author?.user?.login ?? node.author?.email)
      .filter((author) => author && !BOT.test(author)),
  );
}

// Why a GraphQL metadata record cannot be selected, or null.
export function metadataIneligibility(
  record,
  since,
  { days = ACTIVE_DAYS, authors = MIN_AUTHORS } = {},
) {
  const commit = record?.defaultBranchRef?.target;
  if (!record) return 'unavailable';
  if (record.isArchived || record.isFork) return 'archived or fork';
  if (record.diskUsage >= MAX_DISK_KB) return 'over 512 MB';
  if (!commit?.committedDate || commit.committedDate < since) return `no commit in ${days} days`;
  if (humanAuthors(commit, since).size < authors)
    return `fewer than ${authors} human authors in ${days} days`;
  if (!record.workflows?.entries?.length) return 'no GitHub Actions workflow';
  if (!record.manifest) return 'no root package.json';
  if (!lockfilesOf(record).length) return 'no root lockfile';
  return null;
}

// The breaking-change categories a pre-scan reaches; empty means the repository is not affected.
export function categories(check, supported) {
  if (!check || check.error || !check.shopifyUsage) return [];
  const found = [];
  const oldest = check.pins[0];
  if (oldest && oldest < supported[0]) found.push('unsupported-version');
  if (oldest === supported[0]) found.push('retiring-soonest');
  if (check.rest) found.push('deprecated-rest');
  if (check.breakingDocuments + check.alreadyFailing) found.push('removed-fields');
  if (check.productModel) found.push('product-model');
  return found;
}

// Fills each set in order from the seeded order of affected repositories. With `devAffected`
// (repositories from already-open lists), the blind set takes the search's affected repositories
// and the dev set is drawn from those instead.
export function splitSets(seed, affected, devAffected) {
  if (devAffected) {
    const [blind, dev] = SETS;
    return [
      { name: blind.name, repos: seededOrder(seed, affected).slice(0, blind.size) },
      { name: dev.name, repos: seededOrder(seed, devAffected).slice(0, dev.size) },
    ];
  }
  const order = seededOrder(seed, affected);
  let start = 0;
  return SETS.map(({ name, size }) => {
    const repos = order.slice(start, start + size);
    start += size;
    return { name, repos };
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      work: { type: 'string' },
      'output-dir': { type: 'string', default: 'docs/benchmarks/subsets' },
      inputs: { type: 'string', default: 'docs/benchmarks/shopify-selection' },
      'frozen-at': { type: 'string', default: '2026-10-29' },
      seed: { type: 'string', default: DEFAULT_SEED },
      'exclude-ref': { type: 'string', multiple: true, default: ['HEAD', 'origin/main'] },
      'dev-from': { type: 'string', multiple: true },
      help: { type: 'boolean' },
    },
  });
  if (values.help || !values.work) {
    console.log(
      'Usage: npx tsx scripts/shopify-select.mjs --work <dir> [--output-dir <dir>] [--inputs <dir>] [--frozen-at YYYY-MM-DD] [--seed <seed>] [--exclude-ref <git ref> …] [--dev-from <frozen list> …]',
    );
    process.exit(values.help ? 0 : 1);
  }
  const { frozenAt, seed } = { frozenAt: values['frozen-at'], seed: values.seed };
  const since = activeSince(frozenAt);
  const sinceOf = (days) =>
    new Date(Date.parse(frozenAt) - days * 86_400_000).toISOString().slice(0, 19) + 'Z';
  const widest = sinceOf(Math.max(...STAGES.map((stage) => stage.days)));
  const work = resolve(values.work);
  // The pre-scan reads source only: LFS objects stay pointers, with or without git-lfs installed.
  Object.assign(process.env, {
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'filter.lfs.process',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'filter.lfs.smudge',
    GIT_CONFIG_VALUE_1: 'cat',
    GIT_CONFIG_KEY_2: 'filter.lfs.required',
    GIT_CONFIG_VALUE_2: 'false',
  });
  await mkdir(join(work, 'repos'), { recursive: true });
  const supported = supportedVersions(
    JSON.parse(await readFile('data/deadlines.json', 'utf8')),
    frozenAt,
  );
  if (supported.at(-1) !== TARGET)
    throw new Error(`The newest supported version is ${supported.at(-1)}, not ${TARGET}.`);

  const token = process.env.GITHUB_TOKEN || (await execute('gh', ['auth', 'token'])).stdout.trim();
  const pause = (ms) => new Promise((done) => setTimeout(done, ms));

  async function github(path, init = {}) {
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetch(`https://api.github.com${path}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            ...init.headers,
          },
        });
      } catch (error) {
        // Network failures (DNS, timeouts, resets) are retried like server errors.
        if (attempt >= 6) throw error;
        console.error(`GitHub request failed (${error.cause?.code ?? error.message}); retrying`);
        await pause(30_000);
        continue;
      }
      if (response.ok) {
        // A gateway sometimes answers 200 with a truncated body; that is retried too.
        const text = await response.text();
        try {
          return JSON.parse(text);
        } catch (error) {
          if (attempt >= 6) throw error;
          console.error('GitHub returned an unreadable body; retrying');
          await pause(10_000);
          continue;
        }
      }
      // Secondary rate limits answer 403 or 429; server errors are retried sooner.
      const server = response.status >= 500;
      // Rate limits are always waited out; only server errors count toward the attempt cap.
      if ([403, 429].includes(response.status) || (server && attempt < 6)) {
        const retry = Number(response.headers.get('retry-after')) || (server ? 10 : 60);
        console.error(`GitHub ${response.status}; retrying in ${retry}s`);
        await response.body?.cancel();
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

  // 0. Every owner/name any file under docs/benchmarks names, at each --exclude-ref.
  const excluded = new Set();
  for (const ref of values['exclude-ref']) {
    const { stdout } = await execute(
      'git',
      ['ls-tree', '-r', '-z', '--name-only', ref, '--', 'docs/benchmarks'],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    for (const path of stdout.split('\0').filter(Boolean)) {
      const { stdout: text } = await execute('git', ['show', `${ref}:${path}`], {
        maxBuffer: 256 * 1024 * 1024,
      });
      for (const slug of slugTokens(text)) excluded.add(slug);
    }
  }

  // 1. Code search: up to 1,000 results per query, 10 requests a minute.
  const queries = searchQueries();
  const search = await cached('search.json', async () => {
    const repositories = new Set();
    await mkdir(join(work, 'search'), { recursive: true });
    for (const [index, query] of queries.entries()) {
      // Each query is cached on its own, so a failure late in the search keeps the earlier ones.
      const found = await cached(`search/${index}.json`, async () => {
        const names = new Set();
        for (let page = 1; page <= 10; page++) {
          const result = await github(
            `/search/code?q=${encodeURIComponent(query)}&per_page=100&page=${page}`,
          );
          for (const item of result.items) names.add(item.repository.full_name);
          console.error(`${query} page ${page}: ${names.size} repositories`);
          await pause(CODE_SEARCH_PAUSE_MS);
          if (result.items.length < 100) break;
        }
        return [...names].sort();
      });
      for (const name of found) repositories.add(name);
    }
    return [...repositories].sort();
  });
  const candidates = search.filter((repo) => !excluded.has(repo.toLowerCase()));

  // 2. Metadata: a light pass drops archived repositories, forks, large ones and those not pushed
  // to since the widest window opened; the rest get that window's history and root files.
  const metadata = await cached('metadata-180d.json', async () => {
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
          record.pushedAt >= widest
        );
      }),
      20,
      `nameWithOwner isArchived isFork diskUsage stargazerCount
          defaultBranchRef { target { ... on Commit {
            oid committedDate
            history(since: ${JSON.stringify(widest)}, first: 100) {
              totalCount nodes { committedDate author { email user { login } } }
            }
          } } }
          workflows: object(expression: "HEAD:.github/workflows") { ... on Tree { entries { name } } }
          manifest: object(expression: "HEAD:package.json") { ... on Blob { oid } }
          ${Object.keys(LOCKFILES)
            .map((file, lock) => `lock${lock}: object(expression: "HEAD:${file}") { oid }`)
            .join('\n')}`,
      'full',
    );
    return Object.fromEntries(candidates.map((repo) => [repo, full[repo] ?? light[repo]]));
  });

  // Each repository's stage is the first whose filters it passes; reasons are the strict stage's.
  const reasons = {};
  const eligible = new Map();
  for (const repo of candidates) {
    const record = metadata[repo];
    const reason = metadataIneligibility(record, since);
    if (reason) reasons[reason] = (reasons[reason] ?? 0) + 1;
    const stage = STAGES.findIndex(
      ({ days, authors }) => !metadataIneligibility(record, sinceOf(days), { days, authors }),
    );
    if (stage < 0) continue;
    // A repository renamed into an excluded name is still excluded.
    if (excluded.has(record.nameWithOwner.toLowerCase())) {
      if (!stage)
        reasons['renamed into an excluded list'] =
          (reasons['renamed into an excluded list'] ?? 0) + 1;
      continue;
    }
    const commit = record.defaultBranchRef.target;
    eligible.set(record.nameWithOwner, {
      repo: record.nameWithOwner,
      stars: record.stargazerCount,
      commit: commit.oid,
      committedAt: commit.committedDate,
      authors: humanAuthors(commit, sinceOf(STAGES[stage].days)).size,
      lockfiles: lockfilesOf(record),
      stage,
      loosened: STAGES[stage].loosened,
    });
  }

  // 3. Schemas: each supported Admin API version, read once from Shopify's public proxy.
  const snapshots = join(work, 'snapshots');
  await mkdir(snapshots, { recursive: true });
  const schemas = [];
  for (const version of supported) {
    const path = join(snapshots, `${version}.json`);
    if (!existsSync(path))
      await execute(process.execPath, [
        'bin/refit.mjs',
        'shopify-snapshot',
        '--version',
        version,
        '--output',
        path,
      ]);
    schemas.push({ version, sha256: JSON.parse(await readFile(path, 'utf8')).hash });
  }

  // 4. Pre-scan: a shallow clone at the recorded commit, Refit's Shopify scan and the GraphQL
  // contract check against the target, offline; nothing is installed or run, and each clone is
  // deleted after reading. Only counts are kept.
  const { readRepository } = await import('../pipeline/repository.ts');
  const { runPipeline } = await import('../pipeline/run.ts');
  const { scanShopify, SHOPIFY_PACKAGES } = await import('../pipeline/shopify-analysis.ts');
  const { lockedShopifyApi } = await import('../pipeline/shopify-pipeline.ts');
  const { latestApiVersion } = await import('../pipeline/shopify-versions.ts');
  const stageOrders = STAGES.map((_, stage) =>
    seededOrder(
      seed,
      [...eligible.values()].filter((entry) => entry.stage === stage).map((entry) => entry.repo),
    ),
  );
  const checksPath = join(work, 'checks.json');
  const checks = existsSync(checksPath) ? JSON.parse(await readFile(checksPath, 'utf8')) : {};
  const prescan = async (repo, commit) => {
    let directory;
    try {
      directory = await shallowCheckout(join(work, 'repos'), repo, commit);
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      const declared = { ...manifest.dependencies, ...manifest.devDependencies };
      const packageName = SHOPIFY_PACKAGES.find((name) => declared[name]) ?? SHOPIFY_PACKAGES[3];
      const scan = scanShopify(await readRepository(directory, packageName));
      const sdk = await lockedShopifyApi(directory);
      const latest =
        sdk && scan.unresolvedVersions.some((pin) => pin.latest) ? latestApiVersion(sdk) : null;
      const pins = [
        ...new Set([
          ...scan.versions.filter((pin) => !CODEGEN_CONFIG.test(pin.file)).map((pin) => pin.value),
          ...(latest ? [latest] : []),
        ]),
      ].sort();
      const shopifyUsage = Boolean(
        scan.adminCalls || scan.documents.length || scan.versions.length || scan.rest.length,
      );
      const check = {
        packageName: declared[packageName] ? packageName : null,
        sdk: sdk ?? null,
        lockfiles: Object.keys(LOCKFILES).filter((file) => existsSync(join(directory, file))),
        pins,
        shopifyUsage,
        adminCalls: scan.adminCalls,
        documents: scan.documents.length,
        rest: scan.rest.length,
        breakingDocuments: 0,
        alreadyFailing: 0,
        productModel: 0,
      };
      if (shopifyUsage && scan.documents.length) {
        const before =
          [...supported].reverse().find((version) => version <= pins[0]) ?? supported[0];
        const report = await runPipeline({
          repository: directory,
          before: join(snapshots, `${before}.json`),
          after: join(snapshots, `${TARGET}.json`),
        });
        const failing = report.findings.filter(
          (finding) =>
            finding.changeId.startsWith('shopify-graphql') &&
            finding.changeId !== 'shopify-graphql:unreadable',
        );
        check.alreadyFailing = failing.filter((finding) =>
          finding.contractReview?.includes('already fails'),
        ).length;
        check.breakingDocuments = failing.length - check.alreadyFailing;
        const failed = new Set(failing.map((finding) => `${finding.file}:${finding.line}`));
        check.productModel = scan.documents.filter(
          (document) =>
            failed.has(`${document.file}:${document.line}`) && PRODUCT_MODEL.test(document.text),
        ).length;
      }
      return check;
    } catch (error) {
      return { error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  };
  // The strict stage is scanned in full; a loosened stage only until the blind set is full.
  const order = [];
  let found = 0;
  for (const [stage, stageOrder] of stageOrders.entries()) {
    if (stage && found >= SETS[0].size) break;
    for (const [index, repo] of stageOrder.entries()) {
      if (stage && found >= SETS[0].size) break;
      const { commit } = eligible.get(repo);
      if (checks[repo]?.commit !== commit) {
        console.error(`[stage ${stage} ${index + 1}/${stageOrder.length}] ${repo}`);
        checks[repo] = { commit, ...(await prescan(repo, commit)) };
        await writeFile(checksPath, `${JSON.stringify(checks, null, 2)}\n`);
      }
      order.push(repo);
      if (categories(checks[repo], supported).length) found++;
    }
  }

  // 4b. Too few affected repositories for both sets (founder, 2026-10-29: the blind set stays as
  // large as possible): the dev set comes from already-open lists, pre-scanned the same way at
  // their frozen commits. They need a root lockfile, not the activity filters.
  const devSource = new Map();
  for (const path of values['dev-from'] ?? [])
    for (const entry of JSON.parse(await readFile(path, 'utf8')).repos)
      if (!devSource.has(entry.repo)) devSource.set(entry.repo, { ...entry, source: path });
  const devOrder = seededOrder(seed, [...devSource.keys()]);
  const devChecksPath = join(work, 'dev-checks.json');
  const devChecks = existsSync(devChecksPath)
    ? JSON.parse(await readFile(devChecksPath, 'utf8'))
    : {};
  for (const [index, repo] of devOrder.entries()) {
    if (repo in devChecks) continue;
    console.error(`[dev ${index + 1}/${devOrder.length}] ${repo}`);
    devChecks[repo] = await prescan(repo, devSource.get(repo).commit);
    await writeFile(devChecksPath, `${JSON.stringify(devChecks, null, 2)}\n`);
  }
  const devCategorised = Object.fromEntries(
    devOrder.map((repo) => [
      repo,
      devChecks[repo].lockfiles?.length ? categories(devChecks[repo], supported) : [],
    ]),
  );
  const devAffected = devOrder.filter((repo) => devCategorised[repo].length);

  // 5. Split the affected repositories, in seeded order, into the sets.
  const categorised = Object.fromEntries(
    order.map((repo) => [repo, categories(checks[repo], supported)]),
  );
  const affected = order.filter((repo) => categorised[repo].length);
  const dropped = {};
  for (const repo of order) {
    const check = checks[repo];
    const reason = check.error
      ? 'clone or scan failed'
      : !check.shopifyUsage
        ? 'no Shopify Admin usage'
        : !categorised[repo].length
          ? 'not affected'
          : null;
    if (reason) dropped[reason] = (dropped[reason] ?? 0) + 1;
  }
  const stageCounts = STAGES.map(({ loosened }, stage) => ({
    loosened,
    eligible: stageOrders[stage].length,
    scanned: order.filter((repo) => eligible.get(repo).stage === stage).length,
    affected: affected.filter((repo) => eligible.get(repo).stage === stage).length,
  }));
  const fromLists = Boolean(values['dev-from']?.length);
  const sets = splitSets(seed, affected, fromLists ? devAffected : undefined);
  const criteria = [
    `GitHub code search (${QUERIES.length} queries, each split into ${SIZE_RANGES.length} file-size ranges; listed in search.queries), excluding every owner/name any file under docs/benchmarks names at ${values['exclude-ref'].join(' and ')}.`,
    `Kept: not archived, not a fork, under 512 MB on GitHub; a default-branch commit since ${since.slice(0, 10)} with at least ${MIN_AUTHORS} distinct human commit authors in that window (bots excluded); a .github/workflows directory; a root package.json and at least one root lockfile (${Object.keys(LOCKFILES).join(', ')}). With fewer than ${SETS[0].size} affected repositories, ${SETS[0].name} loosens in order (founder, 2026-10-29): the activity window to 180 days, then 1 human author; each loosened stage is pre-scanned in seeded order only until the set is full, and each repository records the filters loosened for it (loosened). CI, lockfile, Shopify usage and affected checks never loosen.`,
    `Pre-scan, offline, at the recorded commit: Refit's Shopify scan (pipeline/shopify-analysis.ts) and runPipeline from the pinned version's supported schema (the oldest supported, ${supported[0]}, for older pins) to ${TARGET}. Affected when the oldest runtime pin (codegen configs excluded; LATEST_API_VERSION resolved through the locked SDK) is unsupported (before ${supported[0]}) or retiring soonest (${supported[0]}), the code calls the REST Admin API, a GraphQL document fails on ${TARGET} or already fails (removed fields), or such a failing document is a product or variant mutation (product model).`,
    fromLists
      ? `Split: affected repositories in the order of SHA-256("${seed}\\n" + lower-cased name). ${SETS[0].name} takes up to ${SETS[0].size} of the search's ${affected.length} affected repositories; ${SETS[1].name} takes up to ${SETS[1].size} affected repositories with a root lockfile from the already-open lists ${values['dev-from'].join(', ')}, pre-scanned the same way at their frozen commits without the activity filters (${devAffected.length} of ${devOrder.length} affected).`
      : `Split: affected repositories in the order of SHA-256("${seed}\\n" + lower-cased name); the first ${SETS[0].size} form ${SETS[0].name}, the next ${SETS[1].size} ${SETS[1].name}.`,
    `Command: GITHUB_TOKEN=… npx tsx scripts/shopify-select.mjs --work <dir> --frozen-at ${frozenAt} --seed ${seed}${(values['dev-from'] ?? []).map((path) => ` --dev-from ${path}`).join('')}`,
  ];
  const schemaBlock = {
    source:
      'https://shopify.dev/admin-graphql-direct-proxy/<version> (public documentation proxy; introspection with descriptions and deprecated input values, no store or credentials)',
    note: `Shopify serves requests for unsupported versions with the oldest supported version, so ${supported[0]} is the effective before contract for older pins. Shopify changes published schemas in place; refit-bench's contracts=current records the hashes each run reads.`,
    versions: schemas,
  };
  const purposes = {
    'shopify-dev-60':
      'Development set for the Shopify engine: agents may open, trace and debug these repositories offline.',
    'shopify-blind-100':
      'Blind set for the Shopify engine: measurement only. Nobody opens, traces or debugs these repositories; it is run once, in the combined Shopify benchmark at the end.',
  };
  await mkdir(resolve(values['output-dir']), { recursive: true });
  for (const { name, repos } of sets)
    await writeFile(
      join(resolve(values['output-dir']), `${name}.json`),
      `${JSON.stringify(
        {
          frozenAt,
          purpose: purposes[name],
          criteria: criteria.join(' '),
          seed,
          ...(name === SETS[0].name
            ? {
                loosened: stageCounts
                  .filter(({ loosened, affected: count }) => loosened.length && count)
                  .map(({ loosened, affected: count }) => ({
                    filters: loosened,
                    repositories: count,
                  })),
              }
            : {}),
          target: TARGET,
          supported,
          schemas: schemaBlock,
          repos: repos.map((repo) =>
            eligible.has(repo)
              ? { ...eligible.get(repo), categories: categorised[repo] }
              : {
                  repo,
                  stars: devSource.get(repo).stars,
                  commit: devSource.get(repo).commit,
                  source: devSource.get(repo).source,
                  lockfiles: devChecks[repo].lockfiles,
                  categories: devCategorised[repo],
                },
          ),
        },
        null,
        2,
      )}\n`,
    );
  // The record: search results, eligibility and pre-scan categories, without any finding text.
  const inputs = resolve(values.inputs);
  await mkdir(inputs, { recursive: true });
  await writeFile(join(inputs, 'search.json'), `${JSON.stringify(search, null, 2)}\n`);
  await writeFile(
    join(inputs, 'checks.json'),
    `${JSON.stringify(
      Object.fromEntries(
        order.map((repo) => [repo, { ...checks[repo], categories: categorised[repo] }]),
      ),
      null,
      2,
    )}\n`,
  );
  if (fromLists)
    await writeFile(
      join(inputs, 'dev-checks.json'),
      `${JSON.stringify(
        Object.fromEntries(
          devOrder.map((repo) => [repo, { ...devChecks[repo], categories: devCategorised[repo] }]),
        ),
        null,
        2,
      )}\n`,
    );
  await writeFile(
    join(inputs, 'selection.json'),
    `${JSON.stringify(
      {
        frozenAt,
        seed,
        queries,
        searched: search.length,
        excludedByLists: search.length - candidates.length,
        ineligible: reasons,
        eligible: stageOrders[0].length,
        stages: stageCounts,
        dropped,
        affected: affected.length,
        categories: Object.fromEntries(
          [
            'unsupported-version',
            'retiring-soonest',
            'deprecated-rest',
            'removed-fields',
            'product-model',
          ].map((category) => [
            category,
            affected.filter((repo) => categorised[repo].includes(category)).length,
          ]),
        ),
        ...(fromLists
          ? {
              devFrom: values['dev-from'],
              devScanned: devOrder.length,
              devAffected: devAffected.length,
            }
          : {}),
        sets: sets.map(({ name, repos }) => ({ name, repositories: repos.length })),
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    JSON.stringify(
      {
        search: search.length,
        stages: stageCounts,
        affected: affected.length,
        reasons,
        dropped,
        devScanned: devOrder.length,
        devAffected: devAffected.length,
        sets: sets.map(({ name, repos }) => [name, repos.length]),
      },
      null,
      2,
    ),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
