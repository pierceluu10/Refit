// Builds evals/sets/dev/six-providers-780.json: 130 repos for each of Refit's six providers, each
// pinned to its default-branch commit. Repos already in a dev set for that provider come first; the
// rest are found with GitHub code search over dependency manifests and source.
//   node evals/sets/build-six.ts
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DEV_DIR, listDevSets, loadDevSet, type DevSet, type RepoEntry } from './index.ts';

const run = promisify(execFile);

export const SET_NAME = 'six-providers-780';
export const PER_PROVIDER = 130;
// GitHub allows 10 code searches a minute.
const SEARCH_PAUSE_MS = 6_500;

export const SEARCHES: Record<string, string[]> = {
  stripe: [
    '"\\"stripe\\":" filename:package.json',
    'stripe.checkout.sessions.create language:TypeScript',
  ],
  shopify: [
    '"@shopify/shopify-api" filename:package.json',
    '"@shopify/shopify-app-remix" filename:package.json',
    '"/admin/api/" shopify language:JavaScript',
  ],
  openai: ['"\\"openai\\":" filename:package.json', 'chat.completions.create language:TypeScript'],
  twilio: [
    '"\\"twilio\\":" filename:package.json',
    'client.messages.create twilio language:JavaScript',
  ],
  meta: [
    '"graph.facebook.com/v" language:TypeScript',
    '"graph.facebook.com/v" language:JavaScript',
  ],
  github: ['"@octokit/rest" filename:package.json', '"X-GitHub-Api-Version" language:TypeScript'],
};

/** Known repos first, then search hits, without duplicates, up to `limit`. */
export function pickRepos(known: string[], found: string[], limit: number): string[] {
  const seen = new Set<string>();
  const picked: string[] = [];
  for (const repo of [...known, ...found]) {
    const key = repo.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(repo);
    if (picked.length === limit) break;
  }
  return picked;
}

async function gh(args: string[]): Promise<string> {
  return (await run('gh', args, { maxBuffer: 64 * 1024 * 1024 })).stdout;
}

async function search(query: string): Promise<string[]> {
  const out = await gh([
    'api',
    '-X',
    'GET',
    'search/code',
    '-f',
    `q=${query}`,
    '-f',
    'per_page=100',
    '--jq',
    '.items[].repository.full_name',
  ]);
  await new Promise((resolve) => setTimeout(resolve, SEARCH_PAUSE_MS));
  return out.split('\n').filter(Boolean);
}

/** The repo's default-branch commit, or undefined for a fork, an archive or a repo that is gone. */
async function pin(repo: string): Promise<RepoEntry | undefined> {
  try {
    const info = JSON.parse(
      await gh([
        'api',
        `repos/${repo}`,
        '--jq',
        '{fork, archived, branch: .default_branch, stars: .stargazers_count}',
      ]),
    ) as { fork: boolean; archived: boolean; branch: string; stars: number };
    if (info.fork || info.archived) return undefined;
    const commit = (
      await gh(['api', `repos/${repo}/commits/${info.branch}`, '--jq', '.sha'])
    ).trim();
    return { repo, commit, stars: info.stars };
  } catch {
    return undefined;
  }
}

function knownRepos(provider: string, sets: DevSet[]): RepoEntry[] {
  return sets
    .filter((set) => set.name !== SET_NAME && set.provider === provider)
    .flatMap((set) => set.repos);
}

async function main(): Promise<void> {
  const sets = listDevSets().map((name) => loadDevSet(name));
  const repos: RepoEntry[] = [];
  for (const [provider, queries] of Object.entries(SEARCHES)) {
    const known = knownRepos(provider, sets);
    const found: string[] = [];
    for (const query of queries) found.push(...(await search(query)));
    const entries: RepoEntry[] = [];
    // Pins more than needed, since some candidates are forks, archives or gone.
    for (const repo of pickRepos(
      known.map((entry) => entry.repo),
      found,
      PER_PROVIDER * 2,
    )) {
      const entry = known.find((k) => k.repo === repo) ?? (await pin(repo));
      if (entry) entries.push({ ...entry, provider });
      if (entries.length === PER_PROVIDER) break;
    }
    console.log(`${provider}: ${entries.length} repos (${known.length} from dev sets)`);
    repos.push(...entries);
  }
  const today = new Date().toISOString().slice(0, 10);
  const set: DevSet = {
    name: SET_NAME,
    provider: 'mixed',
    kind: 'dev',
    source: { path: `evals/sets/dev/${SET_NAME}.json`, commit: '', blob: '', curated: today },
    frozenAt: today,
    purpose: "Refit's main eval: real public repos for each of its six providers.",
    criteria: `Per provider, repos from the existing dev sets first, then GitHub code search hits (evals/sets/build-six.ts SEARCHES), skipping forks and archives, pinned to the default-branch commit on ${today}.`,
    repos,
  };
  writeFileSync(join(DEV_DIR, `${SET_NAME}.json`), `${JSON.stringify(set, null, 2)}\n`);
  console.log(`${repos.length} repos written`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
