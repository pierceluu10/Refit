// Selects a frozen benchmark of public GitHub repositories whose Python code imports the openai,
// anthropic or google-genai SDK. Candidates come from GitHub code search (through `gh api`, so the
// caller's GitHub login is used), repository metadata from GraphQL; each repository is frozen at its
// default branch head. Retiring models are never consulted. Nothing is cloned, installed or run.
//
//   node scripts/python-models-select.mjs --count 50 --output docs/benchmarks/<date>-python-model-repos.json
import { execFile } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const QUERIES = [
  '"from openai import OpenAI" language:Python',
  '"from openai import AsyncOpenAI" language:Python',
  '"from anthropic import Anthropic" language:Python',
  '"from anthropic import AsyncAnthropic" language:Python',
  '"from google import genai" language:Python',
  '"openai.ChatCompletion.create" language:Python',
];
const PAGES = 3;
const PAGE_SIZE = 100;
// Search allows 10 code queries a minute.
const SEARCH_PAUSE_MS = 6_500;
const PUSHED_SINCE = '2025-10-22';
const MAX_DISK_KB = 100 * 1024;
const VENDORS = new Set([
  'openai',
  'anthropics',
  'google',
  'google-gemini',
  'googleapis',
  'googlecloudplatform',
]);

const { values } = parseArgs({
  options: {
    count: { type: 'string' },
    output: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.count || !values.output) {
  console.log('Usage: node scripts/python-models-select.mjs --count N --output <frozen.json>');
  process.exit(values.help ? 0 : 1);
}
const count = Number(values.count);

async function gh(args) {
  const { stdout } = await execute('gh', args, { maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(stdout);
}

// Repositories already frozen in another benchmark, so sets stay independent.
const frozen = new Set();
for (const name of await readdir('docs/benchmarks'))
  if (name.endsWith('-repos.json'))
    for (const entry of JSON.parse(await readFile(`docs/benchmarks/${name}`, 'utf8')).repos ?? [])
      if (typeof entry.repo === 'string') frozen.add(entry.repo.toLowerCase());

const pool = new Map();
const queries = [];
for (const query of QUERIES) {
  let collected = 0;
  for (let page = 1; page <= PAGES; page += 1) {
    const result = await gh([
      'api',
      '-X',
      'GET',
      'search/code',
      '-f',
      `q=${query}`,
      '-f',
      `per_page=${PAGE_SIZE}`,
      '-f',
      `page=${page}`,
    ]);
    for (const item of result.items ?? []) {
      const name = item.repository.full_name;
      if (!pool.has(name.toLowerCase())) pool.set(name.toLowerCase(), name);
    }
    collected += result.items?.length ?? 0;
    await new Promise((done) => setTimeout(done, SEARCH_PAUSE_MS));
    if ((result.items?.length ?? 0) < PAGE_SIZE) break;
  }
  queries.push({ query, pages: PAGES, collected });
  console.error(`${collected} results for ${query}`);
}

const rejected = { vendor: 0, frozen: 0, fork: 0, archived: 0, stale: 0, large: 0, missing: 0 };
const candidates = [];
const names = [...pool.values()].filter((name) => {
  if (VENDORS.has(name.split('/')[0].toLowerCase())) {
    rejected.vendor += 1;
    return false;
  }
  if (frozen.has(name.toLowerCase())) {
    rejected.frozen += 1;
    return false;
  }
  return true;
});
for (let start = 0; start < names.length; start += 50) {
  const batch = names.slice(start, start + 50);
  const fields = batch
    .map((name, index) => {
      const [owner, repo] = name.split('/');
      return `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { nameWithOwner stargazerCount isFork isArchived pushedAt diskUsage defaultBranchRef { target { oid } } }`;
    })
    .join('\n');
  const result = await gh(['api', 'graphql', '-f', `query=query { ${fields} }`]).catch((error) => ({
    data: JSON.parse(error.stdout || '{}').data ?? {},
  }));
  for (const index of batch.keys()) {
    const repository = result.data?.[`r${index}`];
    if (!repository?.defaultBranchRef) rejected.missing += 1;
    else if (repository.isFork) rejected.fork += 1;
    else if (repository.isArchived) rejected.archived += 1;
    else if (repository.pushedAt < PUSHED_SINCE) rejected.stale += 1;
    else if (repository.diskUsage > MAX_DISK_KB) rejected.large += 1;
    else candidates.push(repository);
  }
}
candidates.sort(
  (a, b) => b.stargazerCount - a.stargazerCount || a.nameWithOwner.localeCompare(b.nameWithOwner),
);
const repos = candidates.slice(0, count).map((repository) => ({
  repo: repository.nameWithOwner,
  commit: repository.defaultBranchRef.target.oid,
  stars: repository.stargazerCount,
  pushedAt: repository.pushedAt,
}));

await writeFile(
  values.output,
  `${JSON.stringify(
    {
      formatVersion: 1,
      language: 'python',
      sdks: ['openai', 'anthropic', 'google-genai'],
      selectedAt: new Date().toISOString(),
      method: `GitHub code search through gh api (queries below, ${PAGES} pages of ${PAGE_SIZE}), pool deduplicated by lower-cased full_name; vendor organizations (${[...VENDORS].join(', ')}) and repositories in other frozen lists removed; metadata through GraphQL; forks, archived repositories, repositories last pushed before ${PUSHED_SINCE} and repositories over ${MAX_DISK_KB / 1024} MB removed; ranked by stars, top ${count}; frozen at the default branch head. Retiring models are never consulted.`,
      queries,
      rejected,
      repos,
    },
    null,
    2,
  )}\n`,
);
console.error(
  `Selected ${repos.length} of ${candidates.length}; rejected ${JSON.stringify(rejected)}`,
);
