// Draws the deadline benchmark sample: GitHub code search per provider builds a frame of
// repositories, a seeded shuffle orders it, and the first repositories that pass the activity
// filters are pinned at their default branch's current commit. Uses `gh`; nothing is cloned here.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    frame: { type: 'string' },
    seed: { type: 'string', default: 'refit-deadlines-2026-10-15' },
    per: { type: 'string', default: 'openai=7,meta-graph=7,shopify=6' },
    'pushed-since': { type: 'string', default: '2024-01-01' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.output) {
  console.log(
    'Usage: node scripts/deadline-benchmark-sample.mjs --output <repos.json> [--frame <frame.json>] [--seed S] [--per openai=7,meta-graph=7,shopify=6]\n--frame reuses a saved search frame (or saves a new one there when the file does not exist).',
  );
  process.exit(values.help ? 0 : 1);
}

// Unquoted terms: GitHub's REST code search drops punctuation inside quotes and returns nothing.
const QUERIES = [
  { provider: 'openai', query: '"gpt-3.5-turbo"', language: 'TypeScript' },
  { provider: 'openai', query: '"gpt-3.5-turbo"', language: 'JavaScript' },
  { provider: 'openai', query: '"gpt-4-turbo"', language: 'TypeScript' },
  { provider: 'openai', query: 'o1-mini', language: 'TypeScript' },
  { provider: 'meta-graph', query: 'graph.facebook.com/v18.0', language: 'TypeScript' },
  { provider: 'meta-graph', query: 'graph.facebook.com/v19.0', language: 'JavaScript' },
  { provider: 'meta-graph', query: 'graph.facebook.com/v20.0', language: 'TypeScript' },
  { provider: 'shopify', query: 'admin/api/2025-07', language: 'TypeScript' },
  { provider: 'shopify', query: 'admin/api/2025-10', language: 'TypeScript' },
  { provider: 'shopify', query: 'admin/api/2025-10', language: 'JavaScript' },
];
const MAX_SIZE_KB = 50 * 1024;

async function gh(args) {
  const { stdout } = await execute('gh', args, { maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(stdout);
}

// mulberry32 seeded from a string, so the same frame and seed give the same order.
function random(seed) {
  let state =
    [...seed].reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619), 2166136261) >>>
    0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, next) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(next() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

let frame;
if (values.frame && existsSync(values.frame))
  frame = JSON.parse(await readFile(values.frame, 'utf8'));
else {
  frame = { searchedAt: new Date().toISOString(), queries: [] };
  for (const [index, spec] of QUERIES.entries()) {
    if (index) await new Promise((done) => setTimeout(done, 7000)); // code search: 10 requests a minute
    const hits = await gh([
      'search',
      'code',
      spec.query,
      '--language',
      spec.language,
      '--limit',
      '100',
      '--json',
      'repository,path',
    ]);
    frame.queries.push({
      ...spec,
      hits: hits.map((hit) => ({ repo: hit.repository.nameWithOwner, path: hit.path })),
    });
    console.error(`${spec.provider} ${spec.query} (${spec.language}): ${hits.length} hits`);
  }
  if (values.frame) await writeFile(values.frame, `${JSON.stringify(frame, null, 1)}\n`);
}

const quotas = Object.fromEntries(
  values.per
    .split(',')
    .map((part) => part.split('='))
    .map(([provider, count]) => [provider, Number(count)]),
);
// A repository found by several providers' queries belongs to the first provider that drew it.
const taken = new Set();
const repos = [];
const rejected = [];
const frameSizes = {};
for (const provider of Object.keys(quotas)) {
  const hitsByRepo = new Map();
  for (const query of frame.queries.filter((entry) => entry.provider === provider))
    for (const hit of query.hits) {
      const paths = hitsByRepo.get(hit.repo) ?? new Set();
      paths.add(hit.path);
      hitsByRepo.set(hit.repo, paths);
    }
  const candidates = [...hitsByRepo.keys()].sort();
  frameSizes[provider] = candidates.length;
  let picked = 0;
  for (const repo of shuffle(candidates, random(`${values.seed}:${provider}`))) {
    if (picked >= quotas[provider]) break;
    if (taken.has(repo)) continue;
    taken.add(repo);
    let reason = null;
    let meta;
    try {
      meta = await gh(['api', `repos/${repo}`]);
    } catch {
      reason = 'unavailable';
    }
    if (!reason && meta.archived) reason = 'archived';
    else if (!reason && meta.fork) reason = 'fork';
    else if (!reason && meta.pushed_at < values['pushed-since'])
      reason = `pushed ${meta.pushed_at.slice(0, 10)}`;
    else if (!reason && meta.size >= MAX_SIZE_KB)
      reason = `size ${Math.round(meta.size / 1024)} MB`;
    let commit;
    if (!reason) {
      commit = (await gh(['api', `repos/${repo}/commits/${meta.default_branch}`])).sha;
      const tree = await gh(['api', `repos/${repo}/git/trees/${commit}?recursive=1`]);
      const manifest = tree.tree.some(
        (entry) => /(^|\/)package\.json$/.test(entry.path) && !entry.path.includes('node_modules/'),
      );
      if (!manifest) reason = 'no package.json';
    }
    if (reason) {
      rejected.push({ provider, repo, reason });
      continue;
    }
    picked += 1;
    repos.push({
      provider,
      repo,
      commit,
      stars: meta.stargazers_count,
      pushedAt: meta.pushed_at,
      sizeKb: meta.size,
      hitPaths: [...hitsByRepo.get(repo)].sort(),
    });
  }
}

await writeFile(
  values.output,
  `${JSON.stringify(
    {
      formatVersion: 1,
      seed: values.seed,
      searchedAt: frame.searchedAt,
      filters: {
        archived: false,
        fork: false,
        pushedSince: values['pushed-since'],
        maxSizeMb: 50,
        packageJson: true,
      },
      queries: frame.queries.map(({ provider, query, language, hits }) => ({
        provider,
        query,
        language,
        hits: hits.length,
      })),
      frameRepos: frameSizes,
      repos,
      rejected,
    },
    null,
    2,
  )}\n`,
);
console.log(
  JSON.stringify({ frameRepos: frameSizes, picked: repos.length, rejected: rejected.length }),
);
