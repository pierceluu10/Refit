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
  provider: string;
  kind: 'dev';
  source: { path: string; commit: string; blob: string };
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
