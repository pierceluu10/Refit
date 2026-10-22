// Selects a frozen benchmark of public GitHub repositories that declare a list-A payments or
// commerce SDK (docs/COMMERCE-APIS.md): Plaid, Square, Braintree, Adyen, Paddle, Lemon Squeezy,
// Shippo, EasyPost, Lob or Coinbase Commerce, following scripts/auth-backend-select.mjs. GitHub
// code search is unavailable to Refit's benchmark environment, so applications come first from the repositories already frozen in
// docs/benchmarks/*-repos.json (found earlier by GitHub code search and npm search), at their
// pinned commits: the root package.json at that commit, read from raw.githubusercontent.com, must
// declare one of the provider's packages in any dependency section. Each provider takes --per
// repositories in a fixed pseudo-random order (SHA-256 of the lower-case repository name), and a
// repository counts for one provider only. A provider short of --per is topped up from npm search,
// as in scripts/paypal-select.mjs: the package's latest manifest declares one of the provider's
// packages in `dependencies`, links a github.com repository outside the vendor's organization,
// was published since 2024-01-01, and is ranked by monthly downloads, frozen at HEAD from
// `git ls-remote`. Nothing is installed or executed.
//
// The npm top-up here widens scripts/auth-backend-select.mjs's: more queries per provider (package
// names, commerce frameworks and shipping or mail terms), `peerDependencies` as well as
// `dependencies`, and packages published since 2021-01-01, because few public applications
// declare most of these SDKs.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const REGISTRY = 'https://registry.npmjs.org';
const RAW = 'https://raw.githubusercontent.com';
const PAGE_SIZE = 250;
const PAGES = 4;
const PUBLISHED_SINCE = '2021-01-01';
const POOL_BEFORE = '2026-10-22';
const CONCURRENCY = 8;
const SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
// The catalog's packages for each provider (pipeline/agent-catalog.ts), and the organizations
// whose own repositories are left out of the npm top-up.
const PROVIDERS = {
  plaid: {
    packages: ['plaid', 'react-plaid-link'],
    vendors: ['plaid'],
    queries: [
      'plaid',
      'plaid link',
      'bank account linking',
      'open banking',
      'fintech',
      'budget app',
      ,
      'plaid',
      'plaid api',
      'banking',
      'transactions sync',
      'medusa',
      'payload plugin',
      'strapi plugin',
      'nestjs',
      'n8n-nodes',
      'ecommerce',
      'commerce',
      'checkout',
      'payments',
      'vendure plugin',
    ],
  },
  square: {
    packages: ['square', '@square/web-sdk', '@square/web-payments-sdk-types'],
    vendors: ['square', 'squareup'],
    queries: [
      'square payments',
      'square pos',
      'squareup',
      'square api',
      'square checkout',
      'square',
      'square sdk',
      'square web payments',
      'square terminal',
      'medusa',
      'payload plugin',
      'strapi plugin',
      'nestjs',
      'n8n-nodes',
      'ecommerce',
      'commerce',
      'checkout',
      'payments',
      'vendure plugin',
    ],
  },
  braintree: {
    packages: ['braintree', 'braintree-web', 'braintree-web-drop-in'],
    vendors: ['braintree', 'paypal'],
    queries: [
      'braintree',
      'braintree payment',
      'braintree drop-in',
      'payment gateway',
      'braintree-web',
      'braintree node',
      'paypal braintree',
      'medusa',
      'payload plugin',
      'strapi plugin',
      'nestjs',
      'n8n-nodes',
      'ecommerce',
      'commerce',
      'checkout',
      'payments',
      'vendure plugin',
    ],
  },
  adyen: {
    packages: ['@adyen/api-library', '@adyen/adyen-web'],
    vendors: ['adyen', 'adyen-examples'],
    queries: [
      'adyen',
      'adyen payment',
      'adyen checkout',
      'adyen plugin',
      'adyen api',
      'adyen web',
      'adyen drop-in',
      'medusa',
      'payload plugin',
      'strapi plugin',
      'nestjs',
      'n8n-nodes',
      'ecommerce',
      'commerce',
      'checkout',
      'payments',
      'vendure plugin',
    ],
  },
  paddle: {
    packages: ['@paddle/paddle-node-sdk', '@paddle/paddle-js'],
    vendors: ['paddlehq', 'paddle'],
    queries: [
      'paddle',
      'paddle billing',
      'paddle payments',
      'saas billing',
      'paddle sdk',
      'paddle checkout',
      'medusa',
      'payload plugin',
      'strapi plugin',
      'nestjs',
      'n8n-nodes',
      'ecommerce',
      'commerce',
      'checkout',
      'payments',
      'vendure plugin',
    ],
  },
  'lemon-squeezy': {
    packages: ['@lemonsqueezy/lemonsqueezy.js'],
    vendors: ['lmsqueezy'],
    queries: [
      'lemonsqueezy',
      'lemon squeezy',
      'saas billing',
      'subscriptions',
      'lemonsqueezy.js',
      'medusa',
      'payload plugin',
      'strapi plugin',
      'nestjs',
      'n8n-nodes',
      'ecommerce',
      'commerce',
      'checkout',
      'payments',
      'vendure plugin',
    ],
  },
  shippo: {
    packages: ['shippo'],
    vendors: ['goshippo'],
    queries: [
      'shippo',
      'shipping label',
      'shipping rates',
      'shipping api',
      'shippo api',
      'goshippo',
      'shipping',
      'shipment',
      'fulfillment',
      'carrier',
      'logistics',
      'medusa',
      'payload plugin',
      'strapi plugin',
      'nestjs',
      'n8n-nodes',
      'ecommerce',
      'commerce',
      'checkout',
      'payments',
      'vendure plugin',
    ],
  },
  easypost: {
    packages: ['@easypost/api'],
    vendors: ['easypost'],
    queries: [
      'easypost',
      'shipping label',
      'shipping rates',
      'shipping api',
      'easypost api',
      'shipping',
      'shipment',
      'fulfillment',
      'carrier',
      'logistics',
      'tracking',
      'medusa',
      'payload plugin',
      'strapi plugin',
      'nestjs',
      'n8n-nodes',
      'ecommerce',
      'commerce',
      'checkout',
      'payments',
      'vendure plugin',
    ],
  },
  lob: {
    packages: ['lob', '@lob/lob-typescript-sdk'],
    vendors: ['lob'],
    queries: [
      'lob',
      'lob api',
      'direct mail',
      'address verification',
      'postcards',
      'lob.com',
      'mail',
      'letters',
      'postcard',
      'address validation',
      'address',
      'print mail',
      'medusa',
      'payload plugin',
      'strapi plugin',
      'nestjs',
      'n8n-nodes',
      'ecommerce',
      'commerce',
      'checkout',
      'payments',
      'vendure plugin',
    ],
  },
  'coinbase-commerce': {
    packages: ['coinbase-commerce-node'],
    vendors: ['coinbase'],
    queries: [
      'coinbase commerce',
      'coinbase',
      'crypto payments',
      'cryptocurrency payment',
      'coinbase-commerce-node',
      'crypto checkout',
      'bitcoin payment',
      'crypto',
      'web3 payments',
      'medusa',
      'payload plugin',
      'strapi plugin',
      'nestjs',
      'n8n-nodes',
      'ecommerce',
      'commerce',
      'checkout',
      'payments',
      'vendure plugin',
    ],
  },
};

const { values } = parseArgs({
  options: {
    per: { type: 'string', default: '10' },
    output: { type: 'string' },
    benchmarks: { type: 'string', default: 'docs/benchmarks' },
    cache: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.output || !values.cache) {
  console.log(
    'Usage: node scripts/commerce-select.mjs --output <frozen.json> --cache <dir> [--per 10] [--benchmarks docs/benchmarks]',
  );
  process.exit(values.help ? 0 : 1);
}
const per = Number(values.per);
await mkdir(values.cache, { recursive: true });

// Every response is cached under --cache by URL, so an interrupted or throttled run resumes and a
// rerun reads the same answers. A request that still fails after the retries is counted, never
// taken as "no dependency".
const failures = { manifests: 0 };
async function fetchJson(url) {
  const cached = join(values.cache, `${createHash('sha256').update(url).digest('hex')}.json`);
  if (existsSync(cached)) return JSON.parse(await readFile(cached, 'utf8')).body;
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url);
    if (response.ok || response.status === 404) {
      const body = response.ok ? await response.json().catch(() => null) : null;
      await writeFile(cached, JSON.stringify({ url, body }));
      return body ?? undefined;
    }
    if (attempt >= 6) throw new Error(`${url}: HTTP ${response.status}`);
    const wait = Number(response.headers.get('retry-after')) || 5 * 2 ** attempt;
    await new Promise((done) => setTimeout(done, wait * 1000));
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

// Every repository frozen before this sample, once, at the first pinned commit found in file-name
// order. Lists dated from POOL_BEFORE on (this sample's own, and later ones) are left out, so a
// rerun draws from the same pool.
const frozen = new Map();
for (const name of (await readdir(values.benchmarks))
  .filter((file) => file.endsWith('-repos.json') && file < POOL_BEFORE)
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
    fetchJson(`${REGISTRY}/${item.name.replace('/', '%2F')}/latest`).catch(() => {
      failures.manifests += 1;
      return undefined;
    }),
  );
  for (const [index, item] of ranked.entries()) {
    if (counts[provider].frozen + counts[provider].npm >= per) break;
    const manifest = latest[index];
    const sdk = declared(manifest, packages, ['dependencies', 'peerDependencies']);
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
      method: `Repositories already frozen in docs/benchmarks/*-repos.json whose root package.json at the pinned commit declares a catalog package of the provider (any dependency section); ${per} per provider in SHA-256 order of the lower-case repository name; one provider per repository. Providers short of ${per} are topped up from npm search (${PAGES} pages of ${PAGE_SIZE} per query; queries listed per provider in the script) with packages published since ${PUBLISHED_SINCE} whose latest manifest declares a provider package in dependencies or peerDependencies and links a github.com repository outside the vendor's organizations, ranked by monthly downloads and frozen at HEAD from git ls-remote.`,
      counts,
      unreadableManifests: failures.manifests,
      repos: selected,
    },
    null,
    2,
  )}\n`,
);
console.error(`Selected ${selected.length}: ${JSON.stringify(counts)}`);
