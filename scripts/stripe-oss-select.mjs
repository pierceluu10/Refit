// Freezes the open-source SaaS Stripe benchmark: public TypeScript and JavaScript applications a
// team maintains, which call the Stripe Node SDK on the server, selected only from GitHub metadata
// and committed files before Refit sees any of them.
// Usage: GITHUB_TOKEN=… node scripts/stripe-oss-select.mjs --work <dir> --output <frozen.json>
//          [--frozen-at YYYY-MM-DD]
// The token is read from GITHUB_TOKEN, or from `gh auth token` when unset. Each phase caches its
// result in --work, so an interrupted selection resumes; the frozen file is the record, because
// GitHub's search index moves.
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { compareCandidates, shallowCheckout, validRepoName } from './ai-app-helpers.mjs';
import { apiVersionPins, cachedIn, githubClient, pause } from './stripe-active-select.mjs';

const execute = promisify(execFile);

export const ACTIVE_DAYS = 365;
// Stars that make a repository worth benchmarking whoever owns it, and the lower bar for one an
// organization owns (an organization account is evidence of a team, not of one person's project).
export const MIN_STARS = 500;
export const ORG_MIN_STARS = 50;
// Distinct human commit authors on the default branch in the activity window.
export const MIN_AUTHORS = 3;
// GitHub's diskUsage (packed history, KiB). A shard clones at depth 1 and installs dependencies
// inside the 4 GiB validation workspace on a 14 GB runner disk; past 1 GiB of packed history the
// checkout plus node_modules no longer fits that workspace in the repositories we measured.
export const MAX_DISK_KB = 1024 * 1024;
// GitHub search returns at most 1,000 results per query.
const SEARCH_CAP = 1000;
const SEARCH_PAUSE_MS = 1000;
const SEARCH_CONCURRENCY = 3;
const CODE_SEARCH_PAUSE_MS = 6500;
// Multi-repository code search queries must stay under GitHub's 256-character query limit.
const QUERY_LIMIT = 256;
const LIGHT_BATCH = 100;
const FULL_BATCH = 20;
const CLONE_CONCURRENCY = 4;
const TARGET = '2026-09-30.endive';
const VERSIONS = 'data/stripe-openapi-versions.json';
const LANGUAGES = ['TypeScript', 'JavaScript'];
// Keyword and topic searches that reach organization-owned applications under MIN_STARS.
const KEYWORDS = [
  'stripe',
  'saas',
  'billing',
  'subscriptions',
  'payments',
  'topic:saas',
  'topic:stripe',
  'topic:billing',
  'topic:payments',
];
// Code searches for server-side Stripe SDK use; their hits pass the same star and owner checks.
const CODE_QUERIES = LANGUAGES.flatMap((language) => [
  `"new Stripe(" language:${language}`,
  `"from 'stripe'" language:${language}`,
  `"require('stripe')" language:${language}`,
]);
export const LOCKFILES = {
  'package-lock.json': 'npm',
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
};
// Root lockfiles of package managers Refit does not prepare.
const UNSUPPORTED_LOCKFILES = ['bun.lockb', 'bun.lock'];
const CI_PATHS = [
  '.github/workflows',
  '.circleci',
  '.gitlab-ci.yml',
  '.buildkite',
  'azure-pipelines.yml',
];
const MONOREPO_FILES = ['pnpm-workspace.yaml', 'lerna.json', 'turbo.json', 'nx.json'];
const BOT = /\[bot\]|^(dependabot|renovate|github-actions|actions-user|vercel|netlify)/i;
// Names, descriptions and topics of templates, tutorials, course work and other non-products.
export const NOT_A_PRODUCT =
  /\b(?:templates?|boilerplates?|starters?|starter-kit|tutorials?|courses?|examples?|samples?|demos?|clones?|learn(?:ing)?|workshops?|bootcamp|students?|university|assignments?|homework|portfolio|hackathon|playground|awesome)\b/i;
// Stripe's own sample and SDK accounts, which demonstrate the SDK rather than use it.
const EXCLUDED_OWNERS = new Set(['stripe', 'stripe-samples', 'stripe-archive']);
// npm's placeholder test script.
const DEFAULT_TEST = /no test specified/;
// Paths whose Stripe use is not the product's own server code.
const NOT_SERVER =
  /(?:^|\/)(?:tests?|__tests__|spec|e2e|fixtures?|examples?|samples?|templates?|docs?|scripts)\/|\.(?:test|spec|stories)\.|(?:^|\/)(?:node_modules|dist|build|\.next)\//;
const SERVER_IMPORT = /(?:from\s*|require\(\s*|import\(\s*)['"]stripe['"]/;
// `new Stripe(key)`, `Stripe(key)` or `require('stripe')(key)`.
const CLIENT = /\bStripe\s*\(|require\(\s*['"]stripe['"]\s*\)\s*\(/;
const SOURCE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;

export function activeSince(frozenAt) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(frozenAt) || Number.isNaN(Date.parse(frozenAt)))
    throw new Error(`--frozen-at must be a date such as 2026-10-27, not ${frozenAt}`);
  return new Date(Date.parse(frozenAt) - ACTIVE_DAYS * 86_400_000).toISOString().slice(0, 10);
}

// Splits a star range until each search reaches every result under GitHub's 1,000 cap.
export function splitStars([low, high]) {
  if (high === undefined) return [[low, low * 2 - 1], [low * 2]];
  const middle = Math.floor((low + high) / 2);
  return [
    [low, middle],
    [middle + 1, high],
  ];
}

export const starQualifier = ([low, high]) =>
  high === undefined ? `stars:>=${low}` : `stars:${low}..${high}`;

// `repo:` groups for one code search each, under QUERY_LIMIT characters with the base query.
export function repoGroups(base, repos) {
  const groups = [];
  let group = [];
  for (const repo of repos) {
    const next = [...group, repo];
    if (
      group.length &&
      `${base} ${next.map((name) => `repo:${name}`).join(' ')}`.length > QUERY_LIMIT
    ) {
      groups.push(group);
      group = [repo];
    } else group = next;
  }
  if (group.length) groups.push(group);
  return groups;
}

// Every package.json path in a code search hit that declares stripe for the product itself.
export function stripeManifest(path) {
  return /(?:^|\/)package\.json$/.test(path) && !NOT_SERVER.test(path);
}

export function declaresStripe(manifest) {
  return ['dependencies', 'devDependencies'].some(
    (section) => typeof manifest?.[section]?.stripe === 'string',
  );
}

// Why a light GraphQL record cannot be selected, or null.
export function lightIneligibility(record, since) {
  if (!record) return 'unavailable';
  if (record.isArchived) return 'archived';
  if (record.isFork) return 'fork';
  if (record.isTemplate) return 'template repository';
  if (EXCLUDED_OWNERS.has(record.owner.login.toLowerCase())) return 'Stripe-owned sample or SDK';
  if (record.diskUsage >= MAX_DISK_KB) return 'over 1 GiB';
  if (record.pushedAt.slice(0, 10) < since) return `no push in ${ACTIVE_DAYS} days`;
  const organization = record.owner.__typename === 'Organization';
  if (record.stargazerCount < (organization ? ORG_MIN_STARS : MIN_STARS))
    return organization
      ? `organization with under ${ORG_MIN_STARS} stars`
      : `user with under ${MIN_STARS} stars`;
  const topics = (record.repositoryTopics?.nodes ?? []).map((node) => node.topic.name);
  const text = [record.name, record.description ?? '', ...topics].join(' ').replace(/[-_]/g, ' ');
  if (NOT_A_PRODUCT.test(text)) return 'template, tutorial or course';
  return null;
}

export function humanAuthors(commit) {
  return new Set(
    (commit?.history?.nodes ?? [])
      .map((node) => node.author?.user?.login ?? node.author?.email)
      .filter((author) => author && !BOT.test(author)),
  );
}

export function testScript(manifest) {
  const script = manifest?.scripts?.test;
  return typeof script === 'string' && !DEFAULT_TEST.test(script) ? script : null;
}

// The stripe-node release a root lockfile installs, for any workspace package.
export function lockedStripeVersion(text, manager) {
  if (manager === 'npm') {
    const packages = JSON.parse(text).packages ?? {};
    const versions = Object.entries(packages)
      .filter(([path]) => /(?:^|\/)node_modules\/stripe$/.test(path))
      .map(([, entry]) => entry.version)
      .filter((version) => typeof version === 'string')
      .sort(compareSemver);
    return versions[0] ?? null;
  }
  const match =
    manager === 'pnpm'
      ? /^ {6}stripe:\n {8}specifier: [^\n]+\n {8}version: (\d+\.\d+\.\d+)/m.exec(text)
      : /^"?stripe@[^\n]*:\n {2}version:? "?(\d+\.\d+\.\d+)/m.exec(text);
  return match?.[1] ?? null;
}

export function compareSemver(a, b) {
  const [x, y] = [a, b].map((version) =>
    version.split('.').map((part) => Number.parseInt(part, 10)),
  );
  for (let index = 0; index < 3; index++) if (x[index] !== y[index]) return x[index] - y[index];
  return 0;
}

// The API version a stripe-node release sends by default: the first recorded version whose
// release is at least the installed one.
export function sdkApiVersion(releases, locked) {
  return Object.entries(releases)
    .sort(([, a], [, b]) => compareSemver(a, b))
    .find(([, release]) => compareSemver(release, locked) >= 0)?.[0];
}

// Non-test source files that import the server SDK and construct a client.
export function serverStripeFile(path, text) {
  return !NOT_SERVER.test(path) && SERVER_IMPORT.test(text) && CLIENT.test(text);
}

export async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'dist', 'build', '.next'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (SOURCE.test(entry.name)) files.push(path);
  }
  return files;
}

async function main() {
  const { values } = parseArgs({
    options: {
      work: { type: 'string' },
      output: { type: 'string' },
      'frozen-at': { type: 'string', default: '2026-10-27' },
      help: { type: 'boolean' },
    },
  });
  if (values.help || !values.work || !values.output) {
    console.log(
      'Usage: node scripts/stripe-oss-select.mjs --work <dir> --output <frozen.json> [--frozen-at YYYY-MM-DD]',
    );
    process.exit(values.help ? 0 : 1);
  }
  const frozenAt = values['frozen-at'];
  const since = activeSince(frozenAt);
  const work = resolve(values.work);
  await mkdir(join(work, 'repos'), { recursive: true });
  const token = process.env.GITHUB_TOKEN || (await execute('gh', ['auth', 'token'])).stdout.trim();
  const github = githubClient(token);
  const cached = cachedIn(work);

  // 1. Candidate pool: repository searches by star range (split until each is under the cap),
  // keyword and topic searches for smaller organization repositories, and SDK code searches.
  const pool = await cached('pool.json', async () => {
    const sources = {};
    // Each search's names are cached on their own, so a dropped connection loses one search.
    const collect = async (source, search) => {
      const slug = source.replace(/[^A-Za-z0-9]+/g, '-');
      const names = await cached(`pool-${slug}.json`, async () => {
        const found = new Set();
        await search((name) => found.add(name));
        return [...found].sort();
      });
      for (const repo of names) (sources[repo] ??= new Set()).add(source);
    };
    async function repositories(query, stars, add) {
      const q = `${query} ${starQualifier(stars)} pushed:>=${since}`.trim();
      const first = await github(
        `/search/repositories?q=${encodeURIComponent(q)}&per_page=100&sort=stars`,
      );
      await pause(SEARCH_PAUSE_MS);
      if (first.total_count > SEARCH_CAP && (stars[1] === undefined || stars[1] > stars[0])) {
        for (const range of splitStars(stars)) await repositories(query, range, add);
        return;
      }
      console.error(`${q}: ${first.total_count}`);
      for (const item of first.items) add(item.full_name);
      for (let page = 2; page <= Math.ceil(Math.min(first.total_count, SEARCH_CAP) / 100); page++) {
        const result = await github(
          `/search/repositories?q=${encodeURIComponent(q)}&per_page=100&sort=stars&page=${page}`,
        );
        for (const item of result.items) add(item.full_name);
        await pause(SEARCH_PAUSE_MS);
      }
    }
    // Each request takes about 5 seconds, so SEARCH_CONCURRENCY searches stay under GitHub's 30
    // search requests a minute.
    const searches = LANGUAGES.flatMap((language) => [
      () =>
        collect(`stars:${language}`, (add) =>
          repositories(`language:${language}`, [MIN_STARS], add),
        ),
      ...KEYWORDS.map(
        (keyword) => () =>
          collect(`search:${keyword}:${language}`, (add) =>
            repositories(`${keyword} language:${language}`, [ORG_MIN_STARS], add),
          ),
      ),
    ]);
    await Promise.all(
      Array.from({ length: SEARCH_CONCURRENCY }, async () => {
        for (let search = searches.shift(); search; search = searches.shift()) await search();
      }),
    );
    for (const query of CODE_QUERIES)
      await collect(`code:${query}`, async (add) => {
        for (let page = 1; page <= SEARCH_CAP / 100; page++) {
          const result = await github(
            `/search/code?q=${encodeURIComponent(query)}&per_page=100&page=${page}`,
          );
          for (const item of result.items) add(item.repository.full_name);
          console.error(`${query} page ${page}: ${result.items.length}`);
          await pause(CODE_SEARCH_PAUSE_MS);
          if (result.items.length < 100) break;
        }
      });
    return Object.fromEntries(
      Object.keys(sources)
        .filter(validRepoName)
        .sort()
        .map((repo) => [repo, [...sources[repo]].sort()]),
    );
  });
  const candidates = Object.keys(pool);

  async function graphql(batch, fields) {
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
  }
  async function readAll(repos, size, fields, label) {
    const records = {};
    for (let start = 0; start < repos.length; start += size) {
      for (const [repo, record] of await graphql(repos.slice(start, start + size), fields))
        records[repo] = record;
      console.error(`${label} ${Math.min(start + size, repos.length)}/${repos.length}`);
    }
    return records;
  }

  // 2. Light metadata for every candidate, with the root manifest and monorepo markers.
  const light = await cached('light.json', () =>
    readAll(
      candidates,
      LIGHT_BATCH,
      `nameWithOwner name description isArchived isFork isTemplate diskUsage stargazerCount pushedAt
        owner { __typename login }
        repositoryTopics(first: 20) { nodes { topic { name } } }
        manifest: object(expression: "HEAD:package.json") { ... on Blob { text } }
        ${MONOREPO_FILES.map((file, index) => `mono${index}: object(expression: "HEAD:${file}") { oid }`).join('\n')}`,
      'light',
    ),
  );
  const excluded = {};
  const exclude = (reason) => (excluded[reason] = (excluded[reason] ?? 0) + 1);
  const parse = (text) => {
    try {
      return JSON.parse(text ?? '');
    } catch {
      return null;
    }
  };
  const passed = candidates.filter((repo) => {
    const reason = lightIneligibility(light[repo], since);
    if (reason) exclude(reason);
    return !reason;
  });

  // 3. Where stripe is declared: the root manifest, else a workspace manifest code search finds.
  const manifests = await cached('manifests.json', async () => {
    const found = {};
    const workspaces = [];
    for (const repo of passed) {
      const record = light[repo];
      const root = parse(record.manifest?.text);
      if (declaresStripe(root)) found[repo] = ['package.json'];
      else if (root?.workspaces || MONOREPO_FILES.some((_, index) => record[`mono${index}`]))
        workspaces.push(record.nameWithOwner);
    }
    const base = '"\\"stripe\\"" filename:package.json';
    for (const group of repoGroups(base, workspaces)) {
      const q = `${base} ${group.map((repo) => `repo:${repo}`).join(' ')}`;
      const result = await github(`/search/code?q=${encodeURIComponent(q)}&per_page=100`);
      for (const item of result.items)
        if (stripeManifest(item.path)) (found[item.repository.full_name] ??= []).push(item.path);
      console.error(`workspace manifests: ${Object.keys(found).length} repositories`);
      await pause(CODE_SEARCH_PAUSE_MS);
    }
    return found;
  });
  const withStripe = passed.filter((repo) => {
    if (!manifests[light[repo].nameWithOwner] && !manifests[repo]) exclude('stripe not declared');
    return manifests[light[repo].nameWithOwner] || manifests[repo];
  });

  // 4. Team, CI, test script and lockfile evidence at the default branch head.
  const full = await cached('full.json', async () => {
    const records = {};
    for (let start = 0; start < withStripe.length; start += FULL_BATCH) {
      const batch = withStripe.slice(start, start + FULL_BATCH);
      const paths = new Set(
        batch.flatMap((repo) => manifests[light[repo].nameWithOwner] ?? manifests[repo]),
      );
      const manifestFields = [...paths]
        .filter((path) => path !== 'package.json')
        .map(
          (path, index) =>
            `m${index}: object(expression: ${JSON.stringify(`HEAD:${path}`)}) { ... on Blob { text } }`,
        );
      const lockFields = [...Object.keys(LOCKFILES), ...UNSUPPORTED_LOCKFILES].map(
        (file, index) => `lock${index}: object(expression: "HEAD:${file}") { oid }`,
      );
      const ciFields = CI_PATHS.map(
        (path, index) => `ci${index}: object(expression: "HEAD:${path}") { oid }`,
      );
      const entries = await graphql(
        batch,
        `nameWithOwner
          defaultBranchRef { target { ... on Commit {
            oid committedDate
            history(since: ${JSON.stringify(`${since}T00:00:00Z`)}, first: 100) {
              totalCount nodes { author { email user { login } } }
            }
          } } }
          ${[...lockFields, ...ciFields, ...manifestFields].join('\n')}`,
      );
      const pathList = [...paths].filter((path) => path !== 'package.json');
      for (const [repo, record] of entries) {
        if (!record) {
          records[repo] = null;
          continue;
        }
        const commit = record.defaultBranchRef?.target;
        records[repo] = {
          commit: commit?.oid,
          committedDate: commit?.committedDate,
          commits365d: commit?.history?.totalCount ?? 0,
          authors365d: humanAuthors(commit).size,
          lockfiles: [...Object.keys(LOCKFILES), ...UNSUPPORTED_LOCKFILES].filter(
            (_, index) => record[`lock${index}`],
          ),
          ci: CI_PATHS.filter((_, index) => record[`ci${index}`]),
          manifests: Object.fromEntries(
            pathList.map((path, index) => [path, record[`m${index}`]?.text ?? null]),
          ),
        };
      }
      console.error(`full ${Math.min(start + FULL_BATCH, withStripe.length)}/${withStripe.length}`);
    }
    return records;
  });

  const eligible = [];
  for (const repo of withStripe) {
    const record = light[repo];
    const detail = full[repo];
    const paths = manifests[record.nameWithOwner] ?? manifests[repo];
    const manifestOf = (path) =>
      path === 'package.json' ? parse(record.manifest?.text) : parse(detail?.manifests?.[path]);
    const stripePaths = paths.filter((path) => declaresStripe(manifestOf(path)));
    const root = parse(record.manifest?.text);
    const tests = [...new Set(['package.json', ...stripePaths])]
      .map((path) => ({ path, script: testScript(manifestOf(path)) }))
      .filter((entry) => entry.script);
    const supported = detail?.lockfiles.filter((file) => LOCKFILES[file]) ?? [];
    const reason = !detail?.commit
      ? 'unavailable'
      : detail.committedDate.slice(0, 10) < since
        ? `no default-branch commit in ${ACTIVE_DAYS} days`
        : detail.authors365d < MIN_AUTHORS
          ? `fewer than ${MIN_AUTHORS} human authors in ${ACTIVE_DAYS} days`
          : !detail.ci.length
            ? 'no CI configuration'
            : !stripePaths.length
              ? 'stripe not declared'
              : !tests.length
                ? 'no test script'
                : !detail.lockfiles.length
                  ? 'no root lockfile'
                  : supported.length !== 1
                    ? supported.length
                      ? 'several root lockfiles'
                      : 'only a Bun lockfile'
                    : null;
    if (reason) {
      exclude(reason);
      continue;
    }
    eligible.push({
      repo: record.nameWithOwner,
      stars: record.stargazerCount,
      commit: detail.commit,
      packageManager: LOCKFILES[supported[0]],
      evidence: {
        sources: pool[repo],
        owner: record.owner.__typename,
        description: record.description,
        pushedAt: record.pushedAt,
        committedAt: detail.committedDate,
        authors365d: detail.authors365d,
        commits365d: detail.commits365d,
        diskUsageKB: record.diskUsage,
        ci: detail.ci,
        tests,
        lockfile: supported[0],
        stripeManifests: stripePaths,
        monorepo:
          Boolean(root?.workspaces) || MONOREPO_FILES.some((_, index) => record[`mono${index}`]),
      },
    });
  }
  eligible.sort(compareCandidates);

  // 5. Each repository's server-side Stripe files and API version, read from a depth-1 checkout
  // that is deleted after reading. Nothing in it is installed or run.
  const { STRIPE_SDK_RELEASES } = await import('../pipeline/stripe-package-upgrade.ts');
  const versions = await cached('versions.json', async () => {
    const found = {};
    const queue = [...eligible];
    async function next() {
      for (let entry = queue.shift(); entry; entry = queue.shift()) {
        console.error(`[${eligible.length - queue.length}/${eligible.length}] ${entry.repo}`);
        const directory = join(work, 'repos', entry.repo.replace('/', '__'));
        try {
          await shallowCheckout(join(work, 'repos'), entry.repo, entry.commit);
          const server = [];
          const pins = [];
          for (const file of await sourceFiles(directory)) {
            const text = await readFile(file, 'utf8');
            const path = relative(directory, file);
            if (serverStripeFile(path, text)) {
              server.push(path);
              pins.push(...apiVersionPins(text));
            }
          }
          const lockText = await readFile(join(directory, entry.evidence.lockfile), 'utf8');
          const stripeManifest = JSON.parse(
            await readFile(join(directory, entry.evidence.stripeManifests[0]), 'utf8'),
          );
          found[entry.repo] = {
            server: server.sort(),
            pins: [...new Set(pins)].sort(),
            locked: (() => {
              try {
                return lockedStripeVersion(lockText, entry.packageManager);
              } catch {
                return null;
              }
            })(),
            stripeDependency:
              stripeManifest.dependencies?.stripe ?? stripeManifest.devDependencies?.stripe,
          };
        } catch (error) {
          found[entry.repo] = { error: error instanceof Error ? error.message : String(error) };
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    }
    await Promise.all(Array.from({ length: CLONE_CONCURRENCY }, next));
    return found;
  });

  const table = JSON.parse(await readFile(VERSIONS, 'utf8')).versions;
  const tags = new Map(table.map((entry) => [entry.version, entry.tag]));
  const repos = [];
  const current = [];
  const dropped = [];
  for (const entry of eligible) {
    const version = versions[entry.repo];
    const before =
      !version || version.error
        ? undefined
        : (version.pins[0] ??
          (version.locked ? sdkApiVersion(STRIPE_SDK_RELEASES, version.locked) : undefined));
    const reason =
      !version || version.error
        ? 'clone failed'
        : !version.server.length
          ? 'no server-side Stripe SDK client'
          : !before
            ? 'no API version'
            : !tags.has(before)
              ? 'API version without a pinned spec'
              : null;
    if (reason) {
      exclude(reason);
      dropped.push({ repo: entry.repo, reason, ...(before ? { before } : {}) });
      continue;
    }
    const selected = {
      repo: entry.repo,
      stars: entry.stars,
      commit: entry.commit,
      before,
      beforeSource: version.pins.length
        ? `apiVersion pin${version.pins.length > 1 ? ` (oldest of ${version.pins.length})` : ''}`
        : 'SDK version',
      stripeDependency: version.stripeDependency,
      packageManager: entry.packageManager,
      evidence: {
        ...entry.evidence,
        serverFiles: version.server.length,
        serverExamples: version.server.slice(0, 5),
        lockedStripe: version.locked,
      },
    };
    // Already on the target: no forward upgrade to measure, but its history still counts.
    (before === TARGET ? current : repos).push(selected);
  }

  const needed = [...new Set([...repos.map((entry) => entry.before), TARGET])].sort();
  await writeFile(
    resolve(values.output),
    `${JSON.stringify(
      {
        frozenAt,
        purpose:
          'Open-source SaaS Stripe benchmark: public applications a team maintains that call the Stripe Node SDK on the server. None was scanned or used to tune Refit before this list was frozen; it is selected by scripts/stripe-oss-select.mjs.',
        criteria: `Candidates: GitHub repository searches for TypeScript and JavaScript repositories pushed since ${since} with at least ${MIN_STARS} stars, keyword and topic searches (${KEYWORDS.join(', ')}) with at least ${ORG_MIN_STARS}, and code searches for server-side Stripe SDK imports. Kept: not archived, a fork or a template repository; not owned by Stripe; packed size under 1 GiB; at least ${MIN_STARS} stars, or ${ORG_MIN_STARS} for an organization; no template, tutorial, course, example, clone or portfolio wording in the name, description or topics; stripe declared in the root or a workspace package.json outside test, example and docs paths; a default-branch commit since ${since} with at least ${MIN_AUTHORS} distinct human commit authors in that window (bots excluded); CI configuration (${CI_PATHS.join(', ')}); a real test script in the root or the stripe package's package.json; exactly one supported root lockfile (package-lock.json, pnpm-lock.yaml or yarn.lock); and a non-test source file that imports stripe and constructs a client. The API version is the oldest literal apiVersion pin in those files, else the default of the locked stripe-node release; repositories whose version has no pinned spec in ${VERSIONS} are dropped, and those already on ${TARGET} are listed under current.`,
        search: {
          languages: LANGUAGES,
          keywords: KEYWORDS,
          codeQueries: CODE_QUERIES,
          candidates: candidates.length,
          eligible: eligible.length,
          excluded,
          dropped,
        },
        target: TARGET,
        specs: needed.map((version) => ({ version, tag: tags.get(version) })),
        repos,
        current,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    JSON.stringify(
      {
        candidates: candidates.length,
        eligible: eligible.length,
        repos: repos.length,
        current: current.length,
        excluded,
      },
      null,
      2,
    ),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
