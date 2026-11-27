// Freezes a sealed set: picks repos at random from a candidate pool, writes them outside evals/,
// and reports only the file's path and SHA-256. Nobody reads the result: evals/ records the path
// and hash in FROZEN_SEALED_SETS, and the runner may load it only for a measurement run the
// founders approve.
//
//   node evals/sets/freeze.ts --candidates pool.json --out ~/.config/refit/sealed/upgrade-20.json --count 20
//
// The candidate pool is built with the same criteria as the matching dev set (for upgrade-dev-20,
// see its `criteria`). The person who builds the pool sees candidates, never which ones were picked.
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { listDevSets, loadDevSet, type RepoEntry } from './index.ts';

const EVALS = resolve(import.meta.dirname, '..');

/** A sealed set frozen with freeze.ts. Only where it is and what it hashes to; never its repos. */
export type FrozenSealedSet = {
  name: string;
  /** Where the founders keep it, outside this repository. */
  path: string;
  /** SHA-256 of the file's bytes, so a later run can prove it read the set that was frozen. */
  sha256: string;
  frozenAt: string;
  note: string;
};

/**
 * Sealed sets frozen so far. Empty until a founder runs freeze.ts on a candidate pool; the
 * upgrade blind set is not frozen yet.
 */
export const FROZEN_SEALED_SETS: FrozenSealedSet[] = [];

export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function freezeSealedSet(input: {
  name: string;
  candidates: RepoEntry[];
  outPath: string;
  count: number;
  /** Repos already in a dev set never enter a sealed one. */
  exclude?: Set<string>;
  pick?: (max: number) => number;
  frozenAt?: string;
}): { path: string; sha256: string; count: number } {
  const out = resolve(input.outPath);
  const inside = relative(EVALS, out);
  if (!inside.startsWith('..'))
    throw new Error(`refusing to write a sealed set inside evals/: ${out}`);
  const exclude = input.exclude ?? devRepos();
  const pool = [...new Map(input.candidates.map((entry) => [entry.repo, entry])).values()].filter(
    (entry) => !exclude.has(entry.repo),
  );
  if (pool.length < input.count) {
    throw new Error(`only ${pool.length} candidates outside the dev sets; need ${input.count}`);
  }
  const pick = input.pick ?? randomInt;
  const chosen: RepoEntry[] = [];
  while (chosen.length < input.count) chosen.push(...pool.splice(pick(pool.length), 1));
  const body = `${JSON.stringify(
    {
      name: input.name,
      kind: 'sealed',
      frozenAt: input.frozenAt ?? new Date().toISOString(),
      repos: chosen,
    },
    null,
    2,
  )}\n`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, body);
  return { path: out, sha256: sha256(body), count: chosen.length };
}

export function devRepos(): Set<string> {
  return new Set(
    listDevSets().flatMap((name) => loadDevSet(name).repos.map((entry) => entry.repo)),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const arg = (flag: string) => {
    const index = process.argv.indexOf(flag);
    const value = index > 0 ? process.argv[index + 1] : undefined;
    if (!value) throw new Error(`missing ${flag}`);
    return value;
  };
  const candidates = (
    JSON.parse(readFileSync(arg('--candidates'), 'utf8')) as { repos: RepoEntry[] }
  ).repos;
  const out = arg('--out');
  const result = freezeSealedSet({
    name:
      out
        .split('/')
        .at(-1)
        ?.replace(/\.json$/, '') ?? 'sealed',
    candidates,
    outPath: out,
    count: Number(arg('--count')),
  });
  // Only the path, count and hash are printed: the picked repos stay unopened.
  console.log(JSON.stringify(result, null, 2));
}
