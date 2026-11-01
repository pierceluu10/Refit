// Recovers Refit's frozen repo lists from git history, as data only.
//
//   node evals/sets/recover.ts [--repo <git dir>] [--out evals/sets]
//
// - Dev sets are read with `git show` and written to dev/<name>.json: set-level purpose and
//   criteria plus the repo entries (slug, commit, small metadata). No Refit engine code.
// - Sealed sets (blind and measurement) are never read. The catalog records their path, the
//   commits that wrote them and the blob SHAs from `git ls-tree`.
// - Every other legacy list is catalogued the same way but not recovered: several are
//   supersets of a blind set (push-279-affected contains heldout-30), so copying them would
//   leak blind repos into evals/. A founder can add one to DEV_SETS after checking that.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertNotSealed, sealedClass } from './sealed.ts';

export const HISTORY_PATHSPECS = [
  'subsets/*.json',
  'docs/benchmarks/*-repos.json',
  'docs/benchmarks/subsets/*.json',
  'docs/benchmarks/holdout-selection/*',
];

/** Dev sets to recover: agents may open, trace and debug these freely. */
export const DEV_SETS: { name: string; path: string; provider: string }[] = [
  {
    name: 'shopify-dev-60',
    path: 'docs/benchmarks/subsets/shopify-dev-60.json',
    provider: 'shopify',
  },
  { name: 'meta-dev-60', path: 'docs/benchmarks/subsets/meta-dev-60.json', provider: 'meta-graph' },
  { name: 'stripe-dev-30', path: 'docs/benchmarks/subsets/dev-30.json', provider: 'stripe' },
  {
    name: 'stripe-progress-30',
    path: 'docs/benchmarks/subsets/progress-30.json',
    provider: 'stripe',
  },
  { name: 'openai-dev-30', path: 'docs/benchmarks/subsets/openai-dev-30.json', provider: 'openai' },
  {
    name: 'anthropic-dev-30',
    path: 'docs/benchmarks/subsets/anthropic-dev-30.json',
    provider: 'anthropic',
  },
  { name: 'gemini-dev-15', path: 'docs/benchmarks/subsets/gemini-dev-15.json', provider: 'gemini' },
];

/** Set-level fields kept from a dev list. Everything else (scripts, search stats) is dropped. */
const KEPT_FIELDS = ['frozenAt', 'purpose', 'criteria', 'seed', 'target', 'supported'] as const;

export type CatalogEntry = {
  path: string;
  class: 'dev' | 'blind' | 'measurement' | 'legacy';
  /** Commits that added or modified the file, newest first. */
  commits: string[];
  /** Blob SHA at each of those commits, from `git ls-tree` (never from reading the file). */
  blobs: string[];
  devSet?: string;
  note?: string;
};

const git = (repo: string, args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

export function listHistoryPaths(repo: string): string[] {
  const out = git(repo, ['log', '--all', '--format=', '--name-only', '--', ...HISTORY_PATHSPECS]);
  return [...new Set(out.split('\n').filter(Boolean))].sort();
}

/** Commits and blob SHAs for a path, using only commit metadata and `git ls-tree`. */
export function pathVersions(repo: string, path: string): { commits: string[]; blobs: string[] } {
  const commits = git(repo, ['log', '--all', '--format=%H', '--diff-filter=AM', '--', path])
    .split('\n')
    .filter(Boolean);
  const blobs = commits.map((commit) => {
    const line = git(repo, ['ls-tree', commit, '--', path]).trim();
    const blob = line.split(/\s+/)[2];
    if (!blob) throw new Error(`no blob for ${path} at ${commit}`);
    return blob;
  });
  return { commits, blobs };
}

export function buildCatalog(repo: string): CatalogEntry[] {
  return listHistoryPaths(repo).map((path) => {
    const versions = pathVersions(repo, path);
    const dev = DEV_SETS.find((set) => set.path === path);
    const sealed = sealedClass(path);
    if (sealed) {
      return {
        path,
        class: sealed,
        ...versions,
        note: 'Sealed: never opened. Only path, commits and blob SHAs are recorded.',
      };
    }
    if (dev) return { path, class: 'dev', ...versions, devSet: dev.name };
    return {
      path,
      class: 'legacy',
      ...versions,
      note: 'Catalogued, not recovered: may overlap a blind set.',
    };
  });
}

export function recoverDevSet(
  repo: string,
  set: (typeof DEV_SETS)[number],
  entry: CatalogEntry,
): Record<string, unknown> {
  assertNotSealed(set.path);
  const commit = entry.commits[0];
  if (!commit) throw new Error(`no commit for ${set.path}`);
  const raw = JSON.parse(git(repo, ['show', `${commit}:${set.path}`])) as Record<string, unknown>;
  const repos = raw.repos;
  if (!Array.isArray(repos)) throw new Error(`${set.path} has no repos array`);
  const kept: Record<string, unknown> = {};
  for (const field of KEPT_FIELDS) if (raw[field] !== undefined) kept[field] = raw[field];
  return {
    name: set.name,
    provider: set.provider,
    kind: 'dev',
    source: { path: set.path, commit, blob: entry.blobs[0] },
    ...kept,
    repos,
  };
}

function main(argv: string[]): void {
  const arg = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const repo = resolve(arg('--repo') ?? '.');
  const out = resolve(arg('--out') ?? join(import.meta.dirname, '.'));
  const catalog = buildCatalog(repo);
  mkdirSync(join(out, 'dev'), { recursive: true });
  for (const set of DEV_SETS) {
    const entry = catalog.find((item) => item.path === set.path);
    if (!entry) throw new Error(`dev set ${set.name} not found in history`);
    const data = recoverDevSet(repo, set, entry);
    writeFileSync(join(out, 'dev', `${set.name}.json`), `${JSON.stringify(data, null, 2)}\n`);
  }
  writeFileSync(join(out, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  const counts = catalog.reduce<Record<string, number>>((acc, item) => {
    acc[item.class] = (acc[item.class] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`catalogued ${catalog.length} paths`, counts);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main(process.argv.slice(2));
}
