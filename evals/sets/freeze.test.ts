import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { devRepos, freezeSealedSet, FROZEN_SEALED_SETS, sha256 } from './freeze.ts';

// Illustrative candidates, not real repos.
const candidates = Array.from({ length: 6 }, (_, i) => ({
  repo: `example-org/candidate-${i}`,
  commit: String(i).repeat(40),
}));

describe('freezing a sealed set', () => {
  it('writes the picks outside evals/ and returns only the path, count and hash', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'refit-sealed-')), 'upgrade-20.json');
    const result = freezeSealedSet({
      name: 'upgrade-20',
      candidates: [...candidates, candidates[0]],
      outPath: out,
      count: 3,
      exclude: new Set(['example-org/candidate-1']),
      pick: () => 0,
      frozenAt: '2026-11-06',
    });
    expect(Object.keys(result).sort()).toEqual(['count', 'path', 'sha256']);
    expect(result.sha256).toBe(sha256(readFileSync(out)));
    const written = JSON.parse(readFileSync(out, 'utf8')) as { repos: { repo: string }[] };
    expect(written.repos.map((r) => r.repo)).toEqual([
      'example-org/candidate-0',
      'example-org/candidate-2',
      'example-org/candidate-3',
    ]);
  });

  it('refuses to write inside evals/ and to pick from too small a pool', () => {
    expect(() =>
      freezeSealedSet({
        name: 'x',
        candidates,
        outPath: join(import.meta.dirname, 'x.json'),
        count: 1,
      }),
    ).toThrow(/inside evals/);
    expect(() =>
      freezeSealedSet({
        name: 'x',
        candidates,
        outPath: join(mkdtempSync(join(tmpdir(), 'refit-sealed-')), 'x.json'),
        count: 7,
        exclude: new Set(),
      }),
    ).toThrow(/only 6 candidates/);
  });

  it('never lets a dev-set repo into a sealed set by default', () => {
    expect(devRepos().size).toBeGreaterThan(0);
  });

  it('records only where each frozen set lives and its hash', () => {
    for (const entry of FROZEN_SEALED_SETS) {
      expect(Object.keys(entry).sort()).toEqual(['frozenAt', 'name', 'note', 'path', 'sha256']);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.path.includes('evals/')).toBe(false);
    }
  });
});
