import { describe, expect, it, vi } from 'vitest';
import { inSweep, sweepRepo } from './sweep.ts';

describe('the AI sweep', () => {
  it('turns what the scan missed into lessons, naming no more than the session found', async () => {
    const ask = vi.fn(async () => ({
      costUsd: 0.04,
      output: {
        misses: [
          { provider: 'openai', what: 'realtime=v1', file: 'a.ts', line: 3, why: 'Shut down.' },
        ],
      },
    }));
    const result = await sweepRepo({
      repo: 'acme/app',
      dir: '/unused',
      commit: 'abc',
      scan: { findings: [], unlistedProviders: [], clean: true },
      list: [],
      ask,
    });
    expect(result.costUsd).toBe(0.04);
    expect(result.lessons).toEqual([
      {
        kind: 'sweep-miss',
        repo: 'acme/app',
        commit: 'abc',
        file: 'a.ts:3',
        why: 'openai: realtime=v1. Shut down.',
      },
    ]);
    expect(ask.mock.calls[0]).toMatchObject([{ repoDir: '/unused' }]);
  });

  it('picks about the same repos in a month and others the next', () => {
    const repos = Array.from({ length: 2000 }, (_, i) => `acme/repo-${i}`);
    const picked = repos.filter((repo) => inSweep(repo, '2026-11'));
    expect(picked.length).toBeGreaterThan(50);
    expect(picked.length).toBeLessThan(150);
    expect(repos.filter((repo) => inSweep(repo, '2026-11'))).toEqual(picked);
    expect(repos.filter((repo) => inSweep(repo, '2026-12'))).not.toEqual(picked);
  });
});
