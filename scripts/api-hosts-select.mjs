// Selects the frozen API-host sample: public JS/TS application repositories found by GitHub
// repository search through `gh api` (the user's existing login; no token is read or stored). For
// each topic and language the top results by stars are taken, interleaved across topics and
// deduplicated, until --count repositories have a package.json and source files at the frozen
// commit. Each is fetched at that commit into --root without submodules and nothing is installed or
// run. Rerunning against the same --root rewrites the same frozen file only while search results
// are unchanged: the frozen file, not a rerun, is the reproducible record.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const TOPICS = [
  'nextjs',
  'express',
  'discord-bot',
  'telegram-bot',
  'saas',
  'chatbot',
  'dashboard',
  'react-native',
  'nestjs',
  'slack-bot',
  'web3',
  'weather',
  'ecommerce',
  'cli',
];
const LANGUAGES = ['TypeScript', 'JavaScript'];
const PER_QUERY = 3;
const CUTOFF = '2025-10-21';
const SEARCH_PAUSE_MS = 3000;
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git']);

const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    root: { type: 'string' },
    count: { type: 'string', default: '60' },
  },
});
if (!values.output || !values.root) {
  console.log(
    'Usage: node scripts/api-hosts-select.mjs --output <frozen.json> --root <dir> [--count 60]',
  );
  process.exit(1);
}
const count = Number(values.count);
const root = resolve(values.root);
await mkdir(root, { recursive: true });

const queryFor = (topic, language) =>
  `topic:${topic} language:${language} stars:30..3000 pushed:>=${CUTOFF} fork:false archived:false size:<30000`;
const gh = async (...args) => (await execute('gh', args, { maxBuffer: 64 * 1024 * 1024 })).stdout;

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const queries = [];
for (const topic of TOPICS)
  for (const language of LANGUAGES) {
    const q = queryFor(topic, language);
    const items = JSON.parse(
      await gh(
        'api',
        '-X',
        'GET',
        'search/repositories',
        '-f',
        `q=${q}`,
        '-f',
        'sort=stars',
        '-f',
        `per_page=${PER_QUERY}`,
      ),
    ).items;
    queries.push({ q, repos: items.map((item) => item.full_name) });
    await pause(SEARCH_PAUSE_MS);
  }

// Interleave: first result of every query, then the second, and so on.
const order = [];
const seen = new Set();
for (let rank = 0; rank < PER_QUERY; rank++)
  for (const query of queries) {
    const name = query.repos[rank];
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      order.push(name);
    }
  }

async function sourceFiles(directory) {
  let found = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    if (entry.isDirectory()) found += await sourceFiles(join(directory, entry.name));
    else if (SOURCE.test(entry.name)) found++;
    if (found) return found;
  }
  return found;
}

const repos = [];
const rejected = { noPackageJson: 0, noSource: 0, unreachable: 0 };
for (const name of order) {
  if (repos.length >= count) break;
  try {
    const head = (
      await execute('git', ['ls-remote', `https://github.com/${name}.git`, 'HEAD'])
    ).stdout
      .split('\t')[0]
      .trim();
    if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('no HEAD');
    const directory = join(root, name.replace('/', '__'));
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    const git = (...args) => execute('git', ['-C', directory, ...args]);
    await git('init', '-q');
    await git('fetch', '-q', '--depth', '1', `https://github.com/${name}.git`, head);
    await git('-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD');
    if (!existsSync(join(directory, 'package.json'))) {
      rejected.noPackageJson++;
      await rm(directory, { recursive: true, force: true });
    } else if (!(await sourceFiles(directory))) {
      rejected.noSource++;
      await rm(directory, { recursive: true, force: true });
    } else repos.push({ repo: name, commit: head });
  } catch {
    rejected.unreachable++;
  }
}

await writeFile(
  resolve(values.output),
  `${JSON.stringify(
    {
      formatVersion: 1,
      selectedAt: new Date().toISOString(),
      method: `GitHub repository search (gh api search/repositories, sort=stars, top ${PER_QUERY} per query) for every topic in [${TOPICS.join(', ')}] and language in [${LANGUAGES.join(', ')}] with the qualifiers "stars:30..3000 pushed:>=${CUTOFF} fork:false archived:false size:<30000"; results interleaved across queries and deduplicated; kept when the default-branch HEAD (git ls-remote) has a root package.json and a JS/TS source file; first ${count} kept.`,
      queries,
      rejected,
      repos,
    },
    null,
    2,
  )}\n`,
);
console.log(`${repos.length} repositories frozen`);
