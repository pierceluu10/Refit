// Loads the recovered dev sets. Sealed sets have no data in evals/, so they cannot be loaded.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export type RepoEntry = {
  /** owner/name on GitHub. */
  repo: string;
  /** The commit the set was frozen at. Runs check out exactly this commit. */
  commit: string;
  [metadata: string]: unknown;
};

export type DevSet = {
  name: string;
  /** The provider every repo uses, or 'mixed' when each entry names its own. */
  provider: string;
  kind: 'dev';
  /**
   * Where the list came from: a path, commit and blob in Refit's history for a recovered set, or
   * the set's own file and the day it was built for one curated by hand in evals/.
   */
  source: { path: string; commit: string; blob: string; curated?: string };
  frozenAt?: string;
  purpose?: string;
  criteria?: string;
  repos: RepoEntry[];
};

export const DEV_DIR = join(import.meta.dirname, 'dev');

export function listDevSets(dir = DEV_DIR): string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -'.json'.length))
    .sort();
}

export function loadDevSet(name: string, dir = DEV_DIR): DevSet {
  const known = listDevSets(dir);
  if (!known.includes(name)) {
    throw new Error(`unknown dev set "${name}"; known: ${known.join(', ')}`);
  }
  const set = JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as DevSet;
  for (const entry of set.repos) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(entry.repo) || !/^[0-9a-f]{40}$/.test(entry.commit)) {
      throw new Error(`malformed entry in ${name}: ${JSON.stringify(entry).slice(0, 120)}`);
    }
  }
  return set;
}
