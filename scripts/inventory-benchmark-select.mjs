// Selects the inventory benchmark's frozen list (docs/INVENTORY-BENCHMARK.md): public application
// repositories in JS/TS, Python and Go, found by GitHub repository search with no provider,
// package or keyword filter, shuffled with a recorded seed and checked in that order until each
// language's quota passes. Candidates come through `gh api` (the user's existing login; this
// script never reads or stores a token). Nothing from a repository is installed or executed: only
// its tree listing and package.json files are read. Every stage is cached in --work, so an
// interrupted run resumes and a rerun against the same cache rewrites the same frozen file. The
// search index moves: the frozen file, not a rerun against a fresh index, is the reproducible record.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import {
  classifyGhError,
  frozenListNames,
  seededSample,
  validRepoName,
  validSha,
} from './ai-app-helpers.mjs';
import {
  applicationReason,
  candidateManifests,
  excludedName,
  sourceFileCount,
} from './inventory-benchmark-helpers.mjs';

const execute = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
// Search languages pooled into each group, and how many repositories each group needs.
const GROUPS = {
  'js-ts': { languages: ['TypeScript', 'JavaScript'], count: 100 },
  python: { languages: ['Python'], count: 30 },
  go: { languages: ['Go'], count: 20 },
};
const STAR_BUCKETS = ['10..49', '50..199', '200..999', '1000..20000'];
const PAGES = 3;
// Repository search allows 30 requests a minute.
const SEARCH_PAUSE_MS = 2500;
const SEED = 20261022;
const MIN_SOURCE_FILES = 10;
const MAX_SOURCE_FILES = 1000;
const MAX_MANIFESTS = 20;

const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    work: { type: 'string' },
    pushed: { type: 'string', default: '2026-07-22' },
    cutoff: { type: 'string', default: '2026-04-22' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.output || !values.work) {
  console.log(
    'Usage: node scripts/inventory-benchmark-select.mjs --output <frozen.json> --work <dir> [--pushed YYYY-MM-DD] [--cutoff YYYY-MM-DD]',
  );
  process.exit(values.help ? 0 : 1);
}
const work = resolve(values.work);
for (const directory of ['search', 'heads', 'trees'])
  await mkdir(join(work, directory), { recursive: true });

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const log = (text) => console.error(text);
const hash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 12);

// Runs `gh api` with argv arrays only. Errors carry gh's first stderr line, never the arguments.
async function gh(args, { raw = false } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const { stdout } = await execute(
        'gh',
        ['api', ...(raw ? ['-H', 'Accept: application/vnd.github.raw'] : []), ...args],
        { maxBuffer: 256 * 1024 * 1024, timeout: 180_000 },
      );
      return raw ? stdout : JSON.parse(stdout);
    } catch (error) {
      const stderr = String(error.stderr ?? '');
      const reason = stderr.split('\n')[0] || 'gh api failed';
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
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

// 1. The run date, written once so reruns are byte-identical.
const { selectedAt } = await cached(join(work, 'meta.json'), async () => ({
  selectedAt: new Date().toISOString(),
}));

// 2. Repositories already in any frozen list stay out.
const frozen = new Set();
const excludedLists = [];
for (const file of (await readdir(join(HERE, '..', 'docs', 'benchmarks'))).sort()) {
  if (!file.endsWith('-repos.json') || file.includes('-inventory-')) continue;
  const names = frozenListNames(
    JSON.parse(await readFile(join(HERE, '..', 'docs', 'benchmarks', file), 'utf8')),
  );
  if (names.length === 0) throw new Error(`Frozen list ${file} yielded no repository names.`);
  excludedLists.push({ file, count: names.length });
  for (const name of names) frozen.add(name);
}

const queries = [];
const repos = [];
const rejected = {};
const reject = (group, reason) => {
  rejected[group] ??= {};
  rejected[group][reason] = (rejected[group][reason] ?? 0) + 1;
};
for (const [group, { languages, count }] of Object.entries(GROUPS)) {
  // 3. Repository search, newest updates first: no provider, package or keyword filter.
  const pool = new Map();
  for (const language of languages)
    for (const stars of STAR_BUCKETS) {
      const query = `language:${language} stars:${stars} pushed:>=${values.pushed} fork:false archived:false`;
      let collected = 0;
      let read = 0;
      for (let page = 1; page <= PAGES; page += 1) {
        const result = await cached(
          join(work, 'search', `${hash(query)}-p${page}.json`),
          async () => {
            const response = await gh([
              '-X',
              'GET',
              'search/repositories',
              '-f',
              `q=${query}`,
              '-f',
              'sort=updated',
              '-f',
              'per_page=100',
              '-f',
              `page=${page}`,
            ]);
            await pause(SEARCH_PAUSE_MS);
            return {
              items: (response.items ?? []).map((item) => ({
                repo: item.full_name,
                stars: item.stargazers_count,
                branch: item.default_branch,
                language: item.language,
                template: item.is_template === true,
                fork: item.fork === true,
                archived: item.archived === true,
                topics: item.topics ?? [],
              })),
            };
          },
        );
        read += 1;
        for (const item of result.items) {
          collected += 1;
          if (!validRepoName(item.repo)) reject(group, 'invalid name');
          else if (!pool.has(item.repo.toLowerCase())) pool.set(item.repo.toLowerCase(), item);
        }
        log(`${query} page ${page}: pool ${pool.size}`);
        if (result.items.length < 100) break;
      }
      queries.push({ group, query, sort: 'updated', pages: read, collected });
    }

  // 4. Exclusions that need no further request.
  const eligible = new Map();
  for (const [key, item] of pool) {
    if (item.fork || item.archived || item.template) reject(group, 'fork, archived or template');
    else if (frozen.has(key)) reject(group, 'already in a frozen list');
    else if (excludedName(item.repo, item.topics)) reject(group, 'excluded name or topic');
    else eligible.set(key, item);
  }

  // 5. Seeded shuffle of the whole pool, then the application check in that order until the quota
  // passes. Shuffling before the exclusions keeps the order fixed when an exclusion changes.
  let accepted = 0;
  for (const key of seededSample([...pool.keys()], SEED, 1)) {
    if (accepted === count) break;
    const item = eligible.get(key);
    if (!item) continue;
    const file = `${key.replace('/', '__')}.json`;
    // The head is cached apart from the tree, so the pinned commit never moves between runs and
    // the application rule is applied to the raw tree on every run.
    const head = await cached(join(work, 'heads', file), async () => {
      try {
        const response = await gh([
          `repos/${item.repo}/commits/${encodeURIComponent(item.branch)}`,
        ]);
        if (!validSha(response.sha)) return { verdict: 'invalid commit' };
        return { commit: response.sha, committedDate: response.commit?.committer?.date ?? null };
      } catch (error) {
        if (error.skip) return { verdict: 'unreachable' };
        throw error;
      }
    });
    const tree = head.verdict
      ? head
      : await cached(join(work, 'trees', file), async () => {
          try {
            const listing = await gh([`repos/${item.repo}/git/trees/${head.commit}?recursive=1`]);
            if (listing.truncated) return { verdict: 'tree truncated' };
            const paths = (listing.tree ?? [])
              .filter((entry) => entry.type === 'blob')
              .map((entry) => entry.path);
            const manifests = {};
            if (group === 'js-ts')
              for (const path of candidateManifests(paths).slice(0, MAX_MANIFESTS))
                try {
                  manifests[path] = JSON.parse(
                    await gh([`repos/${item.repo}/contents/${path}?ref=${head.commit}`], {
                      raw: true,
                    }),
                  );
                } catch {
                  manifests[path] = null;
                }
            return { paths, manifests };
          } catch (error) {
            if (error.skip) return { verdict: 'unreachable' };
            throw error;
          }
        });
    const check = tree.verdict
      ? tree
      : {
          verdict: 'checked',
          ...head,
          application: applicationReason(group, tree.paths, tree.manifests),
          sourceFiles: sourceFileCount(group, tree.paths),
        };
    if (check.verdict !== 'checked') reject(group, check.verdict);
    else if (!check.committedDate || check.committedDate.slice(0, 10) < values.cutoff)
      reject(group, 'commit before cutoff');
    else if (!check.application) reject(group, 'not an application');
    else if (check.sourceFiles < MIN_SOURCE_FILES) reject(group, 'fewer than 10 source files');
    else if (check.sourceFiles > MAX_SOURCE_FILES) reject(group, 'more than 1,000 source files');
    else {
      accepted += 1;
      repos.push({
        repo: item.repo,
        group,
        commit: check.commit,
        committedDate: check.committedDate,
        stars: item.stars,
        primaryLanguage: item.language,
        application: check.application,
        sourceFiles: check.sourceFiles,
      });
      log(`${group} ${accepted}/${count}: ${item.repo}`);
    }
  }
  if (accepted < count)
    throw new Error(`Only ${accepted} ${group} repositories passed; widen the pool.`);
}

const frozenFile = {
  formatVersion: 1,
  selectedAt,
  seed: SEED,
  pushedSince: values.pushed,
  cutoff: `frozen commit committedDate >= ${values.cutoff}`,
  sourceFiles: `${MIN_SOURCE_FILES}..${MAX_SOURCE_FILES} in the group's language`,
  method:
    'GitHub repository search through gh api (queries below, sorted by most recently updated), pool deduplicated by lower-cased full name per group, forks, archived repositories, templates, repositories in other frozen lists and excluded names or topics removed, the whole pool shuffled with the seed (mulberry32 Fisher-Yates over sorted names) before those exclusions, and the remaining repositories checked in that order until each group quota passed. No provider, package or keyword is searched for.',
  queries,
  excludedLists,
  rejected,
  repos,
};
await writeFile(resolve(values.output), `${JSON.stringify(frozenFile, null, 2)}\n`);
log(`Wrote ${repos.length} repositories to ${values.output}`);
