import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// A throwaway git repo stands in for Refit's history, and the catalogue points at it, so no real
// sealed set is ever read by this test.
const fake = vi.hoisted(() => ({ commit: '' }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    readFileSync: (file: string, ...rest: unknown[]) =>
      String(file).endsWith('catalog.json')
        ? JSON.stringify([
            {
              path: 'docs/benchmarks/subsets/heldout-30.json',
              class: 'blind',
              commits: [fake.commit],
              blobs: ['b'],
            },
          ])
        : (fs.readFileSync as (...args: unknown[]) => unknown)(file, ...rest),
  };
});

const { openSealedSet } = await import('./sealed-run.ts');

describe('openSealedSet', () => {
  it('reads the set from history once, in memory, and refuses a second open', () => {
    const repo = mkdtempSync(join(tmpdir(), 'sealed-test-'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        encoding: 'utf8',
      });
    git('init', '-q');
    mkdirSync(join(repo, 'docs/benchmarks/subsets'), { recursive: true });
    const commit = 'a'.repeat(40);
    writeFileSync(
      join(repo, 'docs/benchmarks/subsets/heldout-30.json'),
      JSON.stringify({ repos: [{ repo: 'acme/shop', commit }] }),
    );
    git('add', '-A');
    git('commit', '-qm', 'set');
    fake.commit = git('rev-parse', 'HEAD').trim();
    const out = mkdtempSync(join(tmpdir(), 'sealed-out-'));

    const set = openSealedSet('stripe', out, { repoDir: repo });
    expect(set).toMatchObject({ name: 'sealed-stripe', repos: [{ repo: 'acme/shop', commit }] });
    expect(() => openSealedSet('stripe', out, { repoDir: repo })).toThrow(/opened at/);
    expect(openSealedSet('stripe', out, { repoDir: repo, resume: true }).repos).toHaveLength(1);
    expect(() => openSealedSet('shopify', out, { repoDir: repo })).toThrow(/no sealed set/);
  });
});
