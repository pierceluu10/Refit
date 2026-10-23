// Selects a frozen benchmark of public GitHub application repositories that declare the OpenAI or
// Anthropic SDK and call a model. Candidates come from GitHub code search through `gh api` (the
// user's existing login; this script never reads or stores a token). Search finds root
// package.json files split by exclusive size buckets, plus source files that import the SDK split
// by path. Candidates are ranked by stars within that retrievable pool, then checked lazily in
// that order until --count pass. Nothing from a fetched repository is installed or executed.
// Every stage is cached in --work, so an interrupted run resumes and a rerun against the same cache
// rewrites the same frozen file. The code-search index moves: the frozen file, not a rerun against
// a fresh index, is the reproducible record.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import {
  classifyGhError,
  EXCLUDED_DIRECTORIES,
  EXCLUDED_NAME,
  LEAKED_SOURCE,
  SCAN_LIMITS,
  SIZE_BUCKETS,
  SOURCE_EXTENSION,
  appShape,
  checkoutDirectory,
  compareCandidates,
  declaresSdk,
  detectModelCall,
  excludedName,
  frozenListNames,
  scanLimitsFromTree,
  shallowCheckout,
  validRepoName,
  validSha,
  validWorkspaceManifest,
} from './ai-app-helpers.mjs';

const execute = promisify(execFile);
const PROVIDERS = {
  openai: { sdk: 'openai', count: 100, importQuery: `"from 'openai'" language:TypeScript` },
  anthropic: {
    sdk: '@anthropic-ai/sdk',
    count: 50,
    importQuery: `"from '@anthropic-ai/sdk'" language:TypeScript`,
  },
  // AI wrapper SDKs (FP3, docs/MODEL-WRAPPERS.md): one list each, merged into one frozen sample.
  'ai-sdk-openai': {
    sdk: '@ai-sdk/openai',
    count: 15,
    importQuery: `"from '@ai-sdk/openai'" language:TypeScript`,
  },
  'ai-sdk-anthropic': {
    sdk: '@ai-sdk/anthropic',
    count: 12,
    importQuery: `"from '@ai-sdk/anthropic'" language:TypeScript`,
  },
  'langchain-openai': {
    sdk: '@langchain/openai',
    count: 15,
    importQuery: `"from '@langchain/openai'" language:TypeScript`,
  },
  'langchain-anthropic': {
    sdk: '@langchain/anthropic',
    count: 8,
    importQuery: `"from '@langchain/anthropic'" language:TypeScript`,
  },
  llamaindex: {
    sdk: 'llamaindex',
    count: 10,
    importQuery: `"from 'llamaindex'" language:TypeScript`,
  },
};
// The frozen commit must be on or after this date, so the set reflects current code.
const CUTOFF = '2025-10-21';
// Bucket edges come from GitHub code search trials on 2026-10-21.
const SOURCE_PATHS = ['app', 'src', 'lib', 'server'];
const SEARCH_PAUSE_MS = 7500;
const MAX_WORKSPACE_MANIFESTS = 40;
const HERE = dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
  options: {
    provider: { type: 'string' },
    count: { type: 'string' },
    output: { type: 'string' },
    work: { type: 'string' },
    root: { type: 'string' },
    pages: { type: 'string', default: '10' },
    help: { type: 'boolean' },
  },
});
const provider = PROVIDERS[values.provider ?? ''];
if (values.help || !provider || !values.output || !values.work || !values.root) {
  console.log(
    'Usage: node scripts/ai-app-select.mjs --provider openai|anthropic|ai-sdk-openai|ai-sdk-anthropic|langchain-openai|langchain-anthropic|llamaindex --output <frozen.json> --work <dir> --root <dir> [--count N] [--pages 10]',
  );
  process.exit(values.help ? 0 : 1);
}
const count = Number(values.count ?? provider.count);
const pages = Number(values.pages);
const work = resolve(values.work);
const root = resolve(values.root);
await mkdir(join(work, 'search'), { recursive: true });
await mkdir(join(work, 'meta'), { recursive: true });
await mkdir(join(work, 'checks'), { recursive: true });

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const log = (text) => console.error(text);
const hash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 12);

// Runs `gh api` with argv arrays only. Errors carry gh's first stderr line, never the arguments.
async function gh(args) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const { stdout } = await execute('gh', ['api', ...args], {
        maxBuffer: 256 * 1024 * 1024,
        timeout: 180_000,
      });
      return JSON.parse(stdout);
    } catch (error) {
      const stderr = String(error.stderr ?? '');
      const reason = stderr.split('\n')[0] || 'gh api failed';
      if (/beyond the first 1000/i.test(stderr + String(error.stdout ?? '')))
        return { capped: true };
      if (args[0] === 'graphql' && error.stdout) {
        // gh exits non-zero with partial data when a repository is missing.
        try {
          const partial = JSON.parse(error.stdout);
          if (partial.data) return partial;
        } catch {
          // fall through to the retry logic
        }
      }
      const kind = classifyGhError(stderr);
      if (kind === 'retry' && attempt < 5) {
        const wait = 60 * 2 ** attempt;
        log(`GitHub rate limit or server error; retrying in ${wait}s`);
        await pause(wait * 1000);
        continue;
      }
      throw Object.assign(new Error(`gh api failed: ${reason}`), { skip: kind === 'skip' });
    }
  }
}

async function cached(path, compute) {
  if (existsSync(path)) return JSON.parse(await readFile(path, 'utf8'));
  const value = await compute();
  // A failed checkout may be a network blip; the next run tries the repository again.
  if (value.verdict === 'checkoutFailed') return value;
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

// 1. The run date, written once so reruns are byte-identical.
const { selectedAt } = await cached(join(work, 'meta.json'), async () => ({
  selectedAt: new Date().toISOString(),
}));

// 2. Code search: up to 1,000 results per query, at most 10 search calls a minute.
const queries = [
  ...SIZE_BUCKETS[values.provider].map((bucket) => ({
    query: `"${provider.sdk}" filename:package.json extension:json path:/ size:${bucket}`,
    rootManifest: true,
  })),
  ...SOURCE_PATHS.map((path) => ({ query: `${provider.importQuery} path:${path}` })),
];
const pool = new Map();
let duplicatesRemoved = 0;
let invalidName = 0;
const queryRecords = [];
for (const { query, rootManifest } of queries) {
  let collected = 0;
  let read = 0;
  for (let page = 1; page <= pages; page += 1) {
    const file = join(work, 'search', `${hash(query)}-p${page}.json`);
    const result = await cached(file, async () => {
      const response = await gh([
        '-X',
        'GET',
        'search/code',
        '-f',
        `q=${query}`,
        '-f',
        'per_page=100',
        '-f',
        `page=${page}`,
      ]);
      await pause(SEARCH_PAUSE_MS);
      if (response.capped) return { names: [], items: 0 };
      const items = response.items ?? [];
      const kept = rootManifest ? items.filter((item) => item.path === 'package.json') : items;
      return { names: kept.map((item) => item.repository?.full_name), items: items.length };
    });
    read += 1;
    for (const name of result.names) {
      if (!validRepoName(name)) {
        invalidName += 1;
        continue;
      }
      collected += 1;
      if (pool.has(name.toLowerCase())) duplicatesRemoved += 1;
      else pool.set(name.toLowerCase(), name);
    }
    log(`${query} page ${page}: pool ${pool.size}`);
    if (result.items < 100) break;
  }
  queryRecords.push({ query, pages: read, collected });
}

// 3. Repositories already in another frozen list stay out. The app lists are not "other".
const excludedLists = [];
const frozen = new Set();
for (const file of (await readdir(join(HERE, '..', 'docs', 'benchmarks'))).sort()) {
  if (!file.endsWith('-repos.json') || file.endsWith('-app-repos.json')) continue;
  const names = frozenListNames(
    JSON.parse(await readFile(join(HERE, '..', 'docs', 'benchmarks', file), 'utf8')),
  );
  if (names.length === 0) throw new Error(`Frozen list ${file} yielded no repository names.`);
  excludedLists.push({ file, count: names.length });
  for (const name of names) frozen.add(name);
}
const rejected = {
  invalidName,
  alreadyFrozen: 0,
  leakedSource: 0,
  unreachable: 0,
  noCommit: 0,
  fork: 0,
  archived: 0,
  old: 0,
  excludedName: 0,
  scanLimits: 0,
  badManifest: 0,
  noDependency: 0,
  library: 0,
  checkoutFailed: 0,
  noModelCall: 0,
};
const unique = [...pool.keys()].sort();
const unfrozen = unique.filter((name) => !frozen.has(name));
rejected.alreadyFrozen = unique.length - unfrozen.length;
const open = unfrozen.filter((name) => !LEAKED_SOURCE.has(name));
rejected.leakedSource = unfrozen.length - open.length;

// 4. Metadata and the root manifest, 20 repositories per GraphQL query.
const metadata = new Map();
for (let start = 0; start < open.length; start += 20) {
  const batch = open.slice(start, start + 20).map((name) => pool.get(name));
  const records = await cached(join(work, 'meta', `${hash(batch.join())}.json`), async () => {
    const fields = batch
      .map((name, index) => {
        const [owner, repo] = name.split('/');
        return `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) {
          nameWithOwner isFork isArchived pushedAt stargazerCount
          repositoryTopics(first: 20) { nodes { topic { name } } }
          defaultBranchRef { target { ... on Commit { oid committedDate } } }
          manifest: object(expression: "HEAD:package.json") { ... on Blob { text } }
        }`;
      })
      .join('\n');
    const result = await gh(['graphql', '-f', `query=query { ${fields} }`]);
    return batch.map((_, index) => result.data?.[`r${index}`] ?? null);
  });
  batch.forEach((name, index) => metadata.set(name.toLowerCase(), records[index]));
  if ((start / 20) % 10 === 0) log(`metadata ${Math.min(start + 20, open.length)}/${open.length}`);
}

// 5. Cheap filters on the metadata.
const candidates = [];
for (const name of open) {
  const record = metadata.get(name);
  const target = record?.defaultBranchRef?.target;
  if (!record) rejected.unreachable += 1;
  else if (!validSha(target?.oid) || !target.committedDate) rejected.noCommit += 1;
  else if (record.isFork) rejected.fork += 1;
  else if (record.isArchived) rejected.archived += 1;
  else if (target.committedDate < CUTOFF) rejected.old += 1;
  else {
    const topics = (record.repositoryTopics?.nodes ?? []).map((node) => node.topic.name);
    if (excludedName(record.nameWithOwner, topics)) rejected.excludedName += 1;
    else if (!validRepoName(record.nameWithOwner)) rejected.invalidName += 1;
    else
      candidates.push({
        repo: record.nameWithOwner,
        stars: record.stargazerCount,
        commit: target.oid,
        committedAt: target.committedDate,
        pushedAt: record.pushedAt,
        manifestText: record.manifest?.text ?? null,
      });
  }
}
// 6. Rank: stars descending, then full name ascending.
candidates.sort(compareCandidates);
log(`${candidates.length} candidates after the cheap filters`);

function parseManifest(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function findModelCall(directory) {
  async function visit(current) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        const found = await visit(path);
        if (found) return found;
      } else if (entry.isFile() && SOURCE_EXTENSION.test(entry.name)) {
        const info = await lstat(path);
        if (info.size > SCAN_LIMITS.fileBytes) continue;
        const name = relative(directory, path).split('\\').join('/');
        if (detectModelCall(name, await readFile(path, 'utf8'), values.provider)) return name;
      }
    }
    return undefined;
  }
  return visit(directory);
}

// 7. Lazy checks in rank order. Each verdict is cached per repository.
async function check(candidate) {
  try {
    return await checkRepository(candidate);
  } catch (error) {
    if (!error.skip) throw error;
    log(`skipping ${candidate.repo}: ${error.message}`);
    return { verdict: 'unreachable' };
  }
}

async function checkRepository(candidate) {
  const tree = await gh([`repos/${candidate.repo}/git/trees/${candidate.commit}?recursive=1`]);
  if (scanLimitsFromTree(tree)) return { verdict: 'scanLimits' };
  const paths = tree.tree.filter((entry) => entry.type === 'blob').map((entry) => entry.path);
  let declaring;
  let manifest;
  let workspace;
  let deeperManifests = 0;
  let rootManifest;
  if (candidate.manifestText !== null) {
    rootManifest = parseManifest(candidate.manifestText);
    if (!rootManifest) return { verdict: 'badManifest' };
  }
  if (declaresSdk(rootManifest, provider.sdk)) {
    declaring = rootManifest;
    manifest = 'package.json';
  } else {
    const nested = paths.filter(validWorkspaceManifest).sort().slice(0, MAX_WORKSPACE_MANIFESTS);
    deeperManifests = paths.filter(
      (path) => path.endsWith('/package.json') && !validWorkspaceManifest(path),
    ).length;
    for (const path of nested) {
      const file = await gh([`repos/${candidate.repo}/contents/${path}?ref=${candidate.commit}`]);
      const text = Buffer.from(file.content ?? '', 'base64').toString('utf8');
      const parsed = parseManifest(text);
      if (declaresSdk(parsed, provider.sdk)) {
        declaring = parsed;
        manifest = path;
        workspace = path.slice(0, -'/package.json'.length);
        break;
      }
    }
  }
  if (!declaring) return { verdict: 'noDependency', deeperManifests };
  const app = appShape(declaring, paths, workspace ?? '');
  if (!app) return { verdict: 'library', deeperManifests };
  const scripts = { ...rootManifest?.scripts, ...declaring.scripts };
  const hasChecks = ['test', 'typecheck', 'build'].some(
    (name) => typeof scripts[name] === 'string',
  );
  const rootFiles = new Set(paths.filter((path) => !path.includes('/')));
  const manager = rootFiles.has('pnpm-lock.yaml')
    ? 'pnpm'
    : rootFiles.has('yarn.lock')
      ? 'yarn'
      : rootFiles.has('package-lock.json')
        ? 'npm'
        : (/^(npm|pnpm|yarn)@/.exec(rootManifest?.packageManager ?? '')?.[1] ?? null);
  const directory = await shallowCheckout(root, candidate.repo, candidate.commit).catch(
    () => undefined,
  );
  if (!directory) return { verdict: 'checkoutFailed' };
  const modelCall = await findModelCall(directory);
  if (!modelCall) {
    await rm(checkoutDirectory(root, candidate.repo), { recursive: true, force: true });
    return { verdict: 'noModelCall', deeperManifests };
  }
  return {
    verdict: 'pass',
    deeperManifests,
    reason: { manifest, app, modelCall },
    hasChecks,
    manager,
    ...(workspace ? { workspace } : {}),
  };
}

const selected = [];
let deeperManifestsNotRead = 0;
for (const candidate of candidates) {
  if (selected.length >= count) break;
  const result = await cached(
    join(work, 'checks', `${candidate.repo.replace('/', '__')}.json`),
    () => check(candidate),
  );
  deeperManifestsNotRead += result.deeperManifests ?? 0;
  if (result.verdict !== 'pass') {
    rejected[result.verdict] += 1;
    continue;
  }
  selected.push({
    provider: values.provider,
    repo: candidate.repo,
    commit: candidate.commit,
    committedAt: candidate.committedAt,
    pushedAt: candidate.pushedAt,
    stars: candidate.stars,
    reason: result.reason,
    hasChecks: result.hasChecks,
    manager: result.manager,
    ...(result.workspace ? { workspace: result.workspace } : {}),
  });
  log(`[${selected.length}/${count}] ${candidate.repo} (${candidate.stars} stars)`);
}

const shortfall =
  selected.length >= count
    ? null
    : {
        target: count,
        selected: selected.length,
        missing: count - selected.length,
        cause: `The retrievable code-search pool (${unique.length} repositories) held only ${selected.length} that pass every filter; no filter was loosened.`,
      };
await writeFile(
  resolve(values.output),
  `${JSON.stringify(
    {
      formatVersion: 1,
      provider: values.provider,
      sdk: provider.sdk,
      selectedAt,
      cutoff: `frozen commit committedDate >= ${CUTOFF}`,
      method: `GitHub code search through gh api (queries below), pool deduplicated by lower-cased full_name, repositories in other frozen lists removed, metadata through GraphQL, candidates ranked by stars then checked in that order until ${count} pass. Exposure to retiring models is never consulted.`,
      queries: queryRecords,
      bucketing:
        'root package.json search split by exclusive size: ranges (inclusive endpoints never shared); source-import search split by path:; results deduplicated by lower-cased full_name before ranking',
      filters: [
        'dedupe by lower-cased full_name before ranking (D-19)',
        'not a fork and not archived',
        `recency by frozen-commit committedDate >= ${CUTOFF} (D-12); pushedAt recorded only`,
        `the root manifest, or one apps/* or packages/* manifest (first ${MAX_WORKSPACE_MANIFESTS} in path order), declares ${provider.sdk} in dependencies`,
        'that manifest is private, or has no main/exports/bin/files, or the tree has an app marker (next.config.*, vite.config.*, wrangler.toml, app/, pages/, src/app/, src/pages/), or it depends on express, fastify, hono or koa',
        'a non-test source file imports the SDK and makes a model call (chat.completions, responses, messages, images, audio, embeddings)',
        `the tree passes Refit's scan limits (${SCAN_LIMITS.files} files, 2 MiB per file, 50 MiB total)`,
        `repository name or topics do not match ${EXCLUDED_NAME.source} (case-insensitive)`,
        'repository is in no other frozen list under docs/benchmarks',
        'repository is not a known copy of leaked proprietary source (LEAKED_SOURCE)',
        'one level of apps/* and packages/* manifests; deeper nesting not read (D-11)',
      ],
      sortOrder: 'stars desc, full name asc, within the retrievable code-search pool',
      excludedLists,
      poolSize: unique.length,
      duplicatesRemoved,
      deeperManifestsNotRead,
      rejected,
      shortfall,
      repos: selected,
    },
    null,
    2,
  )}\n`,
);
log(`Selected ${selected.length}/${count}; rejected ${JSON.stringify(rejected)}`);
