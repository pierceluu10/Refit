// Selects a frozen benchmark of public GitHub repositories that declare an Auth0, Clerk, Firebase
// or Supabase SDK (docs/AUTH-BACKEND-SDKS.md). GitHub code search is unavailable to Refit's
// benchmark environment, so applications come first from the repositories already frozen in
// docs/benchmarks/*-repos.json (found earlier by GitHub code search and npm search), at their
// pinned commits: the root package.json at that commit, read from raw.githubusercontent.com, must
// declare one of the provider's packages in any dependency section. Each provider takes --per
// repositories in a fixed pseudo-random order (SHA-256 of the lower-case repository name), and a
// repository counts for one provider only. A provider short of --per is topped up from npm search,
// as in scripts/paypal-select.mjs: the package's latest manifest declares one of the provider's
// packages in `dependencies`, links a github.com repository outside the vendor's organization,
// was published since 2024-01-01, and is ranked by monthly downloads, frozen at HEAD from
// `git ls-remote`. Nothing is installed or executed.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const REGISTRY = 'https://registry.npmjs.org';
const RAW = 'https://raw.githubusercontent.com';
const PAGE_SIZE = 250;
const PAGES = 2;
const PUBLISHED_SINCE = '2024-01-01';
const CONCURRENCY = 16;
const SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
// The catalog's packages for each provider (pipeline/agent-catalog.ts), and the organizations
// whose own repositories are left out of the npm top-up.
const PROVIDERS = {
  auth0: {
    packages: [
      'auth0',
      '@auth0/nextjs-auth0',
      '@auth0/auth0-react',
      '@auth0/auth0-spa-js',
      '@auth0/auth0-angular',
      '@auth0/auth0-vue',
      '@auth0/auth0-auth-js',
      '@auth0/auth0-server-js',
      'auth0-js',
      'auth0-lock',
      'express-openid-connect',
      'express-oauth2-jwt-bearer',
    ],
    vendors: ['auth0', 'auth0-samples', 'auth0-lab', 'auth0-extensions', 'okta'],
    queries: [
      'auth0',
      'auth0 nextjs',
      'auth0 react',
      'auth0 express',
      'auth0 authentication',
      'auth0 starter',
      'auth0 template',
      'auth0 plugin',
      'nextjs auth',
      'authentication starter',
    ],
  },
  clerk: {
    packages: [
      '@clerk/nextjs',
      '@clerk/react',
      '@clerk/clerk-react',
      '@clerk/clerk-js',
      '@clerk/backend',
      '@clerk/express',
      '@clerk/clerk-sdk-node',
      '@clerk/expo',
      '@clerk/clerk-expo',
      '@clerk/remix',
      '@clerk/react-router',
      '@clerk/astro',
      '@clerk/vue',
      '@clerk/nuxt',
      '@clerk/fastify',
      '@clerk/chrome-extension',
      '@clerk/tanstack-react-start',
      '@clerk/types',
      '@clerk/elements',
      '@clerk/edge',
    ],
    vendors: ['clerk', 'clerkinc'],
    queries: ['clerk', 'clerk nextjs', 'clerk auth'],
  },
  firebase: {
    packages: ['firebase', 'firebase-admin'],
    vendors: ['firebase', 'firebaseextended', 'googlecloudplatform', 'google'],
    queries: ['firebase', 'firebase app', 'firebase starter', 'firestore'],
  },
  supabase: {
    packages: [
      '@supabase/supabase-js',
      '@supabase/ssr',
      '@supabase/auth-helpers-nextjs',
      '@supabase/auth-helpers-react',
      '@supabase/auth-helpers-remix',
      '@supabase/auth-helpers-sveltekit',
      '@supabase/auth-helpers-shared',
    ],
    vendors: ['supabase', 'supabase-community'],
    queries: ['supabase', 'supabase nextjs', 'supabase starter'],
  },
};

const { values } = parseArgs({
  options: {
    per: { type: 'string', default: '20' },
    output: { type: 'string' },
    benchmarks: { type: 'string', default: 'docs/benchmarks' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.output) {
  console.log(
    'Usage: node scripts/auth-backend-select.mjs --output <frozen.json> [--per 20] [--benchmarks docs/benchmarks]',
  );
  process.exit(values.help ? 0 : 1);
}
const per = Number(values.per);

async function fetchJson(url) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url);
    if (response.ok) return response.json().catch(() => undefined);
    if (response.status === 404) return undefined;
    if (attempt >= 3) throw new Error(`${url}: HTTP ${response.status}`);
    await new Promise((done) => setTimeout(done, 2000 * (attempt + 1)));
  }
}

async function inBatches(items, work) {
  const results = [];
  for (let start = 0; start < items.length; start += CONCURRENCY)
    results.push(...(await Promise.all(items.slice(start, start + CONCURRENCY).map(work))));
  return results;
}

function declared(manifest, packages, sections = SECTIONS) {
  const found = {};
  for (const section of sections)
    for (const name of packages)
      if (typeof manifest?.[section]?.[name] === 'string') found[name] ??= manifest[section][name];
  return found;
}

function order(repo) {
  return createHash('sha256').update(repo.toLowerCase()).digest('hex');
}

function githubRepository(url) {
  const match = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/#?].*)?$/.exec(
    url ?? '',
  );
  return match ? `${match[1]}/${match[2]}` : undefined;
}

// Every repository frozen so far, once, at the first pinned commit found in file-name order.
const frozen = new Map();
for (const name of (await readdir(values.benchmarks))
  .filter((file) => file.endsWith('-repos.json'))
  .sort()) {
  const list = JSON.parse(await readFile(join(values.benchmarks, name), 'utf8'));
  for (const item of list.repos ?? [])
    if (item.repo && item.commit && !frozen.has(item.repo.toLowerCase()))
      frozen.set(item.repo.toLowerCase(), { repo: item.repo, commit: item.commit, list: name });
}
const pool = [...frozen.values()];
const manifests = await inBatches(pool, (item) =>
  fetchJson(`${RAW}/${item.repo}/${item.commit}/package.json`).catch(() => undefined),
);
console.error(
  `${pool.length} frozen repositories, ${manifests.filter(Boolean).length} root manifests read`,
);

const taken = new Set();
const selected = [];
const counts = {};
for (const [provider, { packages }] of Object.entries(PROVIDERS)) {
  const candidates = pool
    .map((item, index) => ({ ...item, declared: declared(manifests[index], packages) }))
    .filter((item) => Object.keys(item.declared).length)
    .sort((a, b) => order(a.repo).localeCompare(order(b.repo)));
  counts[provider] = { frozenCandidates: candidates.length, frozen: 0, npm: 0 };
  for (const item of candidates) {
    if (counts[provider].frozen >= per) break;
    if (taken.has(item.repo.toLowerCase())) continue;
    taken.add(item.repo.toLowerCase());
    counts[provider].frozen += 1;
    selected.push({
      provider,
      repo: item.repo,
      commit: item.commit,
      source: `frozen:${item.list}`,
      declared: item.declared,
    });
  }
}

// The npm top-up for providers the frozen sets cannot fill.
for (const [provider, { packages, vendors, queries }] of Object.entries(PROVIDERS)) {
  if (counts[provider].frozen >= per) continue;
  const found = new Map();
  for (const query of queries)
    for (let page = 0; page < PAGES; page += 1) {
      const result = await fetchJson(
        `${REGISTRY}/-/v1/search?text=${encodeURIComponent(query)}&size=${PAGE_SIZE}&from=${page * PAGE_SIZE}`,
      );
      for (const { package: item, downloads } of result?.objects ?? [])
        if (!found.has(item.name) && item.date >= PUBLISHED_SINCE)
          found.set(item.name, { name: item.name, downloads: downloads?.monthly ?? 0 });
      if ((result?.objects ?? []).length < PAGE_SIZE) break;
    }
  const ranked = [...found.values()].sort(
    (a, b) => b.downloads - a.downloads || a.name.localeCompare(b.name),
  );
  const latest = await inBatches(ranked, (item) =>
    fetchJson(`${REGISTRY}/${item.name.replace('/', '%2F')}/latest`).catch(() => undefined),
  );
  for (const [index, item] of ranked.entries()) {
    if (counts[provider].frozen + counts[provider].npm >= per) break;
    const manifest = latest[index];
    const sdk = declared(manifest, packages, ['dependencies']);
    if (!Object.keys(sdk).length || packages.includes(item.name)) continue;
    const repo = githubRepository(
      typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url,
    );
    if (!repo || vendors.includes(repo.split('/')[0].toLowerCase())) continue;
    if (taken.has(repo.toLowerCase())) continue;
    let commit;
    try {
      const { stdout } = await execute('git', ['ls-remote', `https://github.com/${repo}`, 'HEAD'], {
        timeout: 60_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      commit = /^([a-f0-9]{40})\tHEAD$/m.exec(stdout)?.[1];
    } catch {
      commit = undefined;
    }
    if (!commit) continue;
    taken.add(repo.toLowerCase());
    counts[provider].npm += 1;
    selected.push({
      provider,
      repo,
      commit,
      source: `npm:${item.name}@${manifest.version}`,
      declared: sdk,
      monthlyDownloads: item.downloads,
    });
  }
}

await writeFile(
  values.output,
  `${JSON.stringify(
    {
      formatVersion: 1,
      selectedAt: new Date().toISOString(),
      method: `Repositories already frozen in docs/benchmarks/*-repos.json whose root package.json at the pinned commit declares a catalog package of the provider (any dependency section); ${per} per provider in SHA-256 order of the lower-case repository name; one provider per repository. Providers short of ${per} are topped up from npm search (${PAGES} pages of ${PAGE_SIZE} per query; queries listed per provider in the script) with packages published since ${PUBLISHED_SINCE} whose latest manifest declares a provider package in dependencies and links a github.com repository outside the vendor's organizations, ranked by monthly downloads and frozen at HEAD from git ls-remote.`,
      counts,
      repos: selected,
    },
    null,
    2,
  )}\n`,
);
console.error(`Selected ${selected.length}: ${JSON.stringify(counts)}`);
