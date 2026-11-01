// Sealed repo sets: blind and measurement lists from Refit's history.
// Nobody (human or agent) opens their contents. evals/ records only each one's path,
// the commits that wrote it and the git blob SHAs `git ls-tree` reports for it.

/** Path words that mark a blind set. Any repo-set path containing one is sealed. */
export const BLIND_PATH_PATTERN = /holdout|heldout|held-out|blind/i;

/**
 * Lists that are not blind by name but were frozen as measurement sets or fresh, unused
 * samples (their freeze commits say so). Sealed the same way.
 */
export const MEASUREMENT_PATHS: ReadonlySet<string> = new Set([
  'docs/benchmarks/subsets/openai-100.json',
  'docs/benchmarks/subsets/anthropic-100.json',
  'docs/benchmarks/subsets/gemini-30.json',
  'docs/benchmarks/2026-10-28-stripe-new-repos.json',
  'docs/benchmarks/2026-10-22-deadline-fresh-repos.json',
]);

export type SealedClass = 'blind' | 'measurement';

export function sealedClass(path: string): SealedClass | undefined {
  if (BLIND_PATH_PATTERN.test(path)) return 'blind';
  if (MEASUREMENT_PATHS.has(path)) return 'measurement';
  return undefined;
}

export function isSealed(path: string): boolean {
  return sealedClass(path) !== undefined;
}

/** Throws before any code reads a sealed path. Call it in front of every `git show`. */
export function assertNotSealed(path: string): void {
  const sealed = sealedClass(path);
  if (sealed) throw new Error(`refusing to read ${sealed} set ${path}: sealed sets stay unopened`);
}
