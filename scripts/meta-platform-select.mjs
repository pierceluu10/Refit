// Selects a frozen benchmark of public GitHub repositories whose JS/TS code calls the WhatsApp
// Cloud API or the Messenger Send API on graph.facebook.com (docs/META-PLATFORM-CHANGELOGS.md).
// GitHub code search is unavailable to Refit's benchmark environment, so candidates come from npm
// search, as in scripts/paypal-select.mjs: packages published since 2022-01-01 whose latest
// manifest links a github.com repository outside Meta's organizations, ranked by monthly
// downloads, one entry per repository, only packages whose name, description or keywords mention
// WhatsApp or Messenger, no `@types/*` package, and none already frozen in docs/benchmarks/*-repos.json.
// Each candidate is fetched at HEAD (`git ls-remote`), shallow and without submodules, and kept
// when a live source file (not a test, spec, fixture, example or type declaration) names graph.facebook.com and,
// in the same file, a send-API marker: `messaging_product` (WhatsApp Cloud API) or
// `messaging_type`, `sender_action` or a `/messages` path with `recipient` (Messenger Send API).
// Fetched code is only read, never installed or run. Responses and checkouts are cached under
// --cache, so a rerun reads the same answers.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const REGISTRY = 'https://registry.npmjs.org';
const PAGE_SIZE = 250;
const PAGES = 4;
const PUBLISHED_SINCE = '2022-01-01';
const QUERIES = [
  'whatsapp cloud api',
  'whatsapp business api',
  'whatsapp business',
  'whatsapp api',
  'whatsapp bot',
  'whatsapp webhook',
  'whatsapp graph api',
  'whatsapp messages',
  'messenger bot',
  'facebook messenger',
  'messenger platform',
  'messenger api',
  'messenger send api',
  'meta messenger',
  'chatbot whatsapp',
  'omnichannel chat',
];
const VENDORS = ['facebook', 'fbsamples', 'meta', 'facebookincubator', 'whatsapp'];
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
// The deadline scanner's test path (pipeline/deadline-exposure.ts), as scripts/paypal-benchmark.mjs
// copies it.
const TEST_PATH =
  /(?:^|\/)(?:__tests__|__mocks__|__fixtures__|tests?|specs?|e2e|cypress|fixtures?|examples?|stories)\/|\.(?:test|spec|e2e|stories|story)\.[cm]?[jt]sx?$/i;
const DECLARATION = /\.d\.[cm]?ts$/;
const SKIPPED = /(?:^|\/)(?:node_modules|dist|build|coverage|\.next|out|vendor)\//;
const WHATSAPP = /messaging_product/;
const MESSENGER = /messaging_type|sender_action|\/messages[^\w]*[\s\S]{0,400}recipient/;
const ABOUT = /whats\s?app|messenger/i;
const MAX_FILE_BYTES = 512 * 1024;

const { values } = parseArgs({
  options: {
    count: { type: 'string', default: '20' },
    output: { type: 'string' },
    cache: { type: 'string' },
    benchmarks: { type: 'string', default: 'docs/benchmarks' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.output || !values.cache) {
  console.log(
    'Usage: node scripts/meta-platform-select.mjs --output <frozen.json> --cache <dir> [--count 20]',
  );
  process.exit(values.help ? 0 : 1);
}
const count = Number(values.count);
await mkdir(join(values.cache, 'http'), { recursive: true });
await mkdir(join(values.cache, 'repos'), { recursive: true });

async function fetchJson(url) {
  const cached = join(
    values.cache,
    'http',
    `${createHash('sha256').update(url).digest('hex')}.json`,
  );
  if (existsSync(cached)) return JSON.parse(await readFile(cached, 'utf8')).body ?? undefined;
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

function githubRepository(url) {
  const match = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/#?].*)?$/.exec(
    url ?? '',
  );
  return match ? `${match[1]}/${match[2]}` : undefined;
}

async function git(args, cwd) {
  return execute('git', args, {
    cwd,
    timeout: 300_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 16 * 1024 * 1024,
  });
}

// Live source files that call the send APIs, as `file` paths.
async function sendApiFiles(directory) {
  const files = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      const name = relative(directory, child);
      if (entry.isSymbolicLink() || entry.name === '.git' || SKIPPED.test(`${name}/`)) continue;
      if (entry.isDirectory()) await visit(child);
      else if (
        entry.isFile() &&
        SOURCE.test(entry.name) &&
        !DECLARATION.test(entry.name) &&
        !TEST_PATH.test(name)
      ) {
        const content = await readFile(child, 'utf8').catch(() => '');
        if (content.length > MAX_FILE_BYTES || !content.includes('graph.facebook.com')) continue;
        if (WHATSAPP.test(content) || MESSENGER.test(content)) files.push(name);
      }
    }
  }
  await visit(directory);
  return files.sort();
}

const frozen = new Set();
for (const name of (await readdir(values.benchmarks)).filter(
  // This list's own earlier output is not a reason to leave a repository out.
  (file) =>
    file.endsWith('-repos.json') && resolve(values.benchmarks, file) !== resolve(values.output),
))
  for (const item of JSON.parse(await readFile(join(values.benchmarks, name), 'utf8')).repos ?? [])
    if (item.repo) frozen.add(item.repo.toLowerCase());

const candidates = new Map();
for (const query of QUERIES)
  for (let page = 0; page < PAGES; page += 1) {
    const result = await fetchJson(
      `${REGISTRY}/-/v1/search?text=${encodeURIComponent(query)}&size=${PAGE_SIZE}&from=${page * PAGE_SIZE}`,
    );
    for (const { package: item, downloads } of result?.objects ?? [])
      if (!candidates.has(item.name) && item.date >= PUBLISHED_SINCE)
        candidates.set(item.name, {
          name: item.name,
          about: [item.name, item.description ?? '', ...(item.keywords ?? [])].join(' '),
          downloads: downloads?.monthly ?? 0,
          repository: item.links?.repository,
        });
    if ((result?.objects ?? []).length < PAGE_SIZE) break;
  }
const ranked = [...candidates.values()].sort(
  (a, b) => b.downloads - a.downloads || a.name.localeCompare(b.name),
);
console.error(`${ranked.length} npm candidates from ${QUERIES.length} queries`);

const rejected = {
  offTopic: 0,
  types: 0,
  vendor: 0,
  noRepository: 0,
  duplicate: 0,
  unreachable: 0,
  noSendApi: 0,
};
const selected = [];
const seen = new Set();
for (const candidate of ranked) {
  if (selected.length >= count) break;
  // Only packages that say they are about WhatsApp or Messenger are fetched.
  if (!ABOUT.test(candidate.about)) {
    rejected.offTopic += 1;
    continue;
  }
  // Type definitions describe an API; they do not call it.
  if (candidate.name.startsWith('@types/')) {
    rejected.types += 1;
    continue;
  }
  const repo = githubRepository(candidate.repository);
  if (!repo) {
    rejected.noRepository += 1;
    continue;
  }
  if (VENDORS.includes(repo.split('/')[0].toLowerCase())) {
    rejected.vendor += 1;
    continue;
  }
  if (seen.has(repo.toLowerCase()) || frozen.has(repo.toLowerCase())) {
    rejected.duplicate += 1;
    continue;
  }
  seen.add(repo.toLowerCase());
  const directory = join(values.cache, 'repos', repo.replace('/', '__'));
  let commit;
  try {
    const { stdout } = await git(['ls-remote', `https://github.com/${repo}`, 'HEAD']);
    commit = /^([a-f0-9]{40})\tHEAD$/m.exec(stdout)?.[1];
    if (commit && !existsSync(join(directory, '.git'))) {
      await rm(directory, { recursive: true, force: true });
      await mkdir(directory, { recursive: true });
      await git(['init', '-q'], directory);
      await git(
        [
          'fetch',
          '-q',
          '--depth',
          '1',
          '--no-recurse-submodules',
          `https://github.com/${repo}`,
          commit,
        ],
        directory,
      );
      await git(['-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD'], directory);
    }
  } catch {
    commit = undefined;
  }
  if (!commit) {
    rejected.unreachable += 1;
    continue;
  }
  // A renamed repository answers at both names with the same commit.
  if (selected.some((item) => item.commit === commit)) {
    rejected.duplicate += 1;
    continue;
  }
  const files = await sendApiFiles(directory);
  if (!files.length) {
    // A rejected checkout is not kept.
    await rm(directory, { recursive: true, force: true });
    rejected.noSendApi += 1;
    continue;
  }
  selected.push({
    provider: 'meta-graph',
    repo,
    commit,
    package: candidate.name,
    monthlyDownloads: candidate.downloads,
    sendApiFiles: files,
  });
  console.error(`[${selected.length}/${count}] ${repo} (${candidate.name})`);
}

await writeFile(
  values.output,
  `${JSON.stringify(
    {
      formatVersion: 1,
      provider: 'meta-graph',
      selectedAt: new Date().toISOString(),
      method: `npm search for ${QUERIES.map((query) => JSON.stringify(query)).join(', ')} (${PAGES} pages of ${PAGE_SIZE}); published since ${PUBLISHED_SINCE}; github.com repository outside ${VENDORS.join(', ')}; name, description or keywords mention WhatsApp or Messenger; no @types packages; not already in docs/benchmarks/*-repos.json; ranked by monthly downloads; one entry per repository and per commit (a renamed repository answers at both names); frozen at HEAD from git ls-remote; kept when a live JS/TS file names graph.facebook.com and a WhatsApp Cloud API or Messenger Send API marker (messaging_product, messaging_type, sender_action, or a /messages path with recipient).`,
      rejected,
      repos: selected,
    },
    null,
    2,
  )}\n`,
);
console.error(`Selected ${selected.length}; rejected ${JSON.stringify(rejected)}`);
