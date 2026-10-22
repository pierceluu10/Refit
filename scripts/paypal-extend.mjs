// Extends a frozen PayPal benchmark list with application repositories found by GitHub code search
// through `gh api` (the user's existing login; no token is read or stored). Three query shapes: a
// root package.json that names each PayPal server SDK, and source files that name a PayPal REST
// host. A candidate is kept when it is not a fork or archived, was pushed since --since, is under
// 60 MB, is not PayPal's own organisation, and its default-branch HEAD declares an SDK or has a
// JS/TS source file naming a PayPal host. Each is fetched at that commit into --root without
// submodules; nothing is installed or run. Entries are appended to --list in place; a rerun adds
// only repositories not already listed. The code-search index moves, so the frozen file is the
// record.
//
//   node scripts/paypal-extend.mjs --list <repos.json> --root <dir> --count 18 --since 2024-10-21
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const QUERIES = [
  {
    kind: 'sdk',
    package: '@paypal/paypal-server-sdk',
    q: '"@paypal/paypal-server-sdk" filename:package.json path:/',
  },
  {
    kind: 'sdk',
    package: '@paypal/checkout-server-sdk',
    q: '"@paypal/checkout-server-sdk" filename:package.json path:/',
  },
  { kind: 'host', q: '"api-m.paypal.com" language:TypeScript' },
  { kind: 'host', q: '"api-m.sandbox.paypal.com" language:JavaScript' },
  { kind: 'host', q: '"api-m.paypal.com" language:JavaScript' },
];
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const SKIPPED = new Set(['node_modules', '.git', 'dist', 'build']);
const HOST = /\/\/api(?:-m)?(?:\.sandbox)?\.paypal\.com/;
const MAX_SIZE_KB = 60_000;
const PAUSE_MS = 7000;

const { values } = parseArgs({
  options: {
    list: { type: 'string' },
    root: { type: 'string' },
    count: { type: 'string', default: '18' },
    since: { type: 'string', default: '2024-10-21' },
  },
});
if (!values.list || !values.root) {
  console.log(
    'Usage: node scripts/paypal-extend.mjs --list <repos.json> --root <dir> [--count 18] [--since 2024-10-21]',
  );
  process.exit(1);
}
const gh = async (...args) => (await execute('gh', args, { maxBuffer: 64 * 1024 * 1024 })).stdout;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const list = JSON.parse(await readFile(values.list, 'utf8'));
const taken = new Set(list.repos.map((entry) => entry.repo.toLowerCase()));
const root = resolve(values.root);
await mkdir(root, { recursive: true });

async function namesHost(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED.has(entry.name) && !entry.name.startsWith('.') && (await namesHost(path)))
        return true;
    } else if (SOURCE.test(entry.name) && HOST.test(await readFile(path, 'utf8').catch(() => '')))
      return true;
  }
  return false;
}

const candidates = [];
const queries = [];
for (const query of QUERIES) {
  let items = [];
  try {
    items = JSON.parse(
      await gh('api', '-X', 'GET', 'search/code', '-f', `q=${query.q}`, '-f', 'per_page=100'),
    ).items;
  } catch {
    /* a failed query contributes nothing */
  }
  queries.push({ q: query.q, results: items.length });
  for (const item of items) candidates.push({ repo: item.repository.full_name, query });
  await pause(PAUSE_MS);
}
// Interleave the queries so no shape fills the quota alone.
const byQuery = QUERIES.map((query) => candidates.filter((item) => item.query === query));
const ordered = [];
for (let rank = 0; ordered.length < candidates.length; rank++) {
  let any = false;
  for (const group of byQuery)
    if (group[rank]) {
      ordered.push(group[rank]);
      any = true;
    }
  if (!any) break;
}
const rejected = {};
const added = [];
for (const { repo, query } of ordered) {
  if (added.length >= Number(values.count)) break;
  const key = repo.toLowerCase();
  if (taken.has(key) || /^paypal/i.test(repo)) continue;
  taken.add(key);
  const reject = (reason) => (rejected[reason] = (rejected[reason] ?? 0) + 1);
  try {
    const meta = JSON.parse(await gh('api', `repos/${repo}`));
    if (meta.fork || meta.archived || meta.disabled) {
      reject('fork or archived');
      continue;
    }
    if (meta.pushed_at < values.since) {
      reject('old');
      continue;
    }
    if (meta.size > MAX_SIZE_KB) {
      reject('large');
      continue;
    }
    const head = (
      await execute('git', ['ls-remote', `https://github.com/${repo}.git`, 'HEAD'])
    ).stdout
      .split('\t')[0]
      .trim();
    const directory = join(root, repo.replace('/', '__'));
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    const git = (...args) => execute('git', ['-C', directory, ...args]);
    await git('init', '-q');
    await git('fetch', '-q', '--depth', '1', `https://github.com/${repo}.git`, head);
    await git('-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD');
    const manifest = JSON.parse(
      await readFile(join(directory, 'package.json'), 'utf8').catch(() => '{}'),
    );
    const declared = Object.fromEntries(
      ['@paypal/checkout-server-sdk', '@paypal/paypal-server-sdk']
        .map((name) => [
          name,
          ['dependencies', 'devDependencies', 'peerDependencies']
            .map((key) => manifest[key]?.[name])
            .find(Boolean),
        ])
        .filter(([, version]) => version),
    );
    if (!Object.keys(declared).length && !(await namesHost(directory))) {
      reject('no SDK or host at HEAD');
      await rm(directory, { recursive: true, force: true });
      continue;
    }
    added.push({
      provider: 'paypal',
      repo,
      commit: head,
      package: null,
      version: null,
      declared,
      monthlyDownloads: null,
      publishedAt: null,
      source: 'code-search',
      found: query.q,
      stars: meta.stargazers_count,
      pushedAt: meta.pushed_at,
    });
  } catch {
    reject('unreachable');
  }
}
list.repos.push(...added);
list.extensions = [
  ...(list.extensions ?? []),
  {
    at: new Date().toISOString(),
    method: `GitHub code search (gh api search/code, first 100 results of each query), queries interleaved; kept when not a fork or archived, pushed on or after ${values.since}, under ${MAX_SIZE_KB} KB, not a paypal* repository, and the HEAD package.json declares a PayPal server SDK or a JS/TS source file names a PayPal REST host.`,
    queries,
    rejected,
    added: added.length,
  },
];
await writeFile(values.list, `${JSON.stringify(list, null, 2)}\n`);
console.log(`${added.length} added; ${list.repos.length} repositories listed`);
