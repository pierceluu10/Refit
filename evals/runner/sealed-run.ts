// Round 3's single sealed run. A sealed set is read from Refit's git history only here, only when
// the run starts, and kept in memory: nothing in evals/ ever holds its list. Opening one writes a
// marker, and a second open is refused unless it resumes that same run.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DevSet, RepoEntry } from '../sets/index.ts';

type CatalogEntry = { path: string; class: string; commits: string[]; blobs: string[] };

/** The sealed set for each provider round 3 practised on (longtail-dev-20 has none). */
export const SEALED_FOR: Record<string, string> = {
  stripe: 'docs/benchmarks/subsets/heldout-30.json',
  openai: 'docs/benchmarks/subsets/openai-100.json',
  anthropic: 'docs/benchmarks/subsets/anthropic-100.json',
  gemini: 'docs/benchmarks/subsets/gemini-30.json',
};

const CATALOG = join(import.meta.dirname, '..', 'sets', 'catalog.json');

export function sealedMarker(outDir: string): string {
  return join(outDir, 'OPENED.json');
}

/**
 * Reads one provider's sealed set at the commit that wrote it. Refuses when a sealed run was
 * already opened in outDir, unless resume is set (a crashed run picking up where it stopped).
 */
export function openSealedSet(
  provider: string,
  outDir: string,
  { resume = false, repoDir = process.cwd() } = {},
): DevSet {
  const path = SEALED_FOR[provider];
  if (!path) throw new Error(`no sealed set for ${provider}; known: ${Object.keys(SEALED_FOR)}`);
  const marker = sealedMarker(outDir);
  const opened = existsSync(marker)
    ? (JSON.parse(readFileSync(marker, 'utf8')) as Record<string, string>)
    : {};
  if (opened[provider] && !resume) {
    throw new Error(
      `${path} was opened at ${opened[provider]}; the sealed run happens once (pass --resume to finish that run)`,
    );
  }
  const catalog = JSON.parse(readFileSync(CATALOG, 'utf8')) as CatalogEntry[];
  const entry = catalog.find((item) => item.path === path);
  if (!entry || !['blind', 'measurement'].includes(entry.class)) {
    throw new Error(`${path} is not a catalogued sealed set`);
  }
  const commit = entry.commits[0] as string;
  const raw = JSON.parse(
    execFileSync('git', ['-C', repoDir, 'show', `${commit}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  ) as { repos?: Record<string, unknown>[] };
  if (!Array.isArray(raw.repos)) throw new Error(`${path} has no repos array`);
  const repos = raw.repos.map((item) => {
    const repo = item.repo ?? item.fullName ?? item.full_name;
    const sha = item.commit ?? item.sha;
    if (typeof repo !== 'string' || typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error(`${path} has an entry without a repo and a full commit`);
    }
    return { repo, commit: sha } as RepoEntry;
  });
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(
    marker,
    `${JSON.stringify({ ...opened, [provider]: opened[provider] ?? new Date().toISOString() }, null, 2)}\n`,
  );
  return {
    name: `sealed-${provider}`,
    provider,
    kind: 'dev',
    source: { path, commit, blob: entry.blobs[0] as string },
    repos,
  };
}
