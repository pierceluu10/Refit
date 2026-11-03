// Fails if a sealed (blind or measurement) set's contents are ever copied into evals/.
// It never reads a sealed file: it compares git blob SHAs and checks the shape of what's here.
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { CatalogEntry } from './recover.ts';
import { DEV_SETS } from './recover.ts';
import { assertNotSealed, BLIND_PATH_PATTERN, isSealed, MEASUREMENT_PATHS } from './sealed.ts';
import { listDevSets, loadDevSet } from './index.ts';

const EVALS = join(import.meta.dirname, '..');
const catalog = JSON.parse(
  readFileSync(join(import.meta.dirname, 'catalog.json'), 'utf8'),
) as CatalogEntry[];
const sealed = catalog.filter((entry) => entry.class === 'blind' || entry.class === 'measurement');

function evalsFiles(dir = EVALS): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name.startsWith('.')) return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? evalsFiles(full) : [full];
  });
}

/** Git blob SHA of a file we own, computed by git without involving any sealed file. */
function blobShas(files: string[]): string[] {
  const out = execFileSync('git', ['hash-object', '--stdin-paths'], {
    input: files.join('\n'),
    encoding: 'utf8',
  });
  return out.trim().split('\n');
}

describe('sealed repo sets', () => {
  it('catalogues the known blind sets and every measurement set', () => {
    const paths = new Set(sealed.map((entry) => entry.path));
    for (const known of [
      'docs/benchmarks/subsets/holdout-100.json',
      'docs/benchmarks/subsets/holdout-30b.json',
      'docs/benchmarks/subsets/heldout-30.json',
      'docs/benchmarks/2026-10-15-stripe-heldout-repos.json',
      'docs/benchmarks/subsets/shopify-blind-100.json',
      'docs/benchmarks/subsets/meta-blind-100.json',
      'docs/benchmarks/holdout-selection/candidates.json',
      ...MEASUREMENT_PATHS,
    ]) {
      expect(paths.has(known), known).toBe(true);
    }
  });

  it('records only path, commits and blob SHAs for a sealed set', () => {
    for (const entry of sealed) {
      expect(Object.keys(entry).sort()).toEqual(['blobs', 'class', 'commits', 'note', 'path']);
      expect(entry.blobs.length).toBeGreaterThan(0);
      for (const sha of [...entry.blobs, ...entry.commits]) expect(sha).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('has no file in evals/ whose bytes equal any version of a sealed set', () => {
    const files = evalsFiles();
    const sealedBlobs = new Set(sealed.flatMap((entry) => entry.blobs));
    const shas = blobShas(files);
    const copies = files.filter((_, index) => sealedBlobs.has(shas[index] ?? ''));
    expect(copies.map((file) => relative(EVALS, file))).toEqual([]);
  });

  it('has no file in evals/ named like a blind set', () => {
    const named = evalsFiles()
      .map((file) => relative(EVALS, file))
      .filter((file) => BLIND_PATH_PATTERN.test(file));
    expect(named).toEqual([]);
  });

  it('keeps repo lists only in dev sets that trace to a dev path or were curated here', () => {
    const devBlobs = new Map(
      catalog.filter((entry) => entry.class === 'dev').map((entry) => [entry.path, entry.blobs]),
    );
    const listFiles = evalsFiles().filter((file) => {
      if (!file.endsWith('.json') || file.includes(`${join('smoke', 'fixtures')}`)) return false;
      const data = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      return typeof data === 'object' && data !== null && 'repos' in data;
    });
    for (const file of listFiles) {
      const rel = relative(EVALS, file);
      expect(rel.startsWith(join('sets', 'dev')), `${rel} holds a repo list outside sets/dev`).toBe(
        true,
      );
    }
    const historyPaths = new Set(catalog.map((entry) => entry.path));
    for (const name of listDevSets()) {
      const set = loadDevSet(name);
      expect(isSealed(set.source.path)).toBe(false);
      if (set.source.curated) {
        // Built by hand in evals/, not copied from Refit's history: it names its own file and no
        // path from the catalog, so it cannot be a copy of a sealed or legacy list.
        expect(set.source.path).toBe(`evals/sets/dev/${name}.json`);
        expect(historyPaths.has(set.source.path)).toBe(false);
        expect(DEV_SETS.some((dev) => dev.name === name)).toBe(false);
        continue;
      }
      expect(DEV_SETS.some((dev) => dev.name === name && dev.path === set.source.path)).toBe(true);
      expect(devBlobs.get(set.source.path)).toContain(set.source.blob);
    }
  });

  it('refuses to read a sealed path', () => {
    expect(() => assertNotSealed('docs/benchmarks/subsets/holdout-100.json')).toThrow(/sealed/);
    expect(() => assertNotSealed('docs/benchmarks/subsets/openai-100.json')).toThrow(/sealed/);
    expect(() => assertNotSealed('docs/benchmarks/subsets/meta-dev-60.json')).not.toThrow();
  });
});
