import { describe, expect, it } from 'vitest';
import labels from '../docs/benchmarks/2026-10-22-paypal-labels.json' with { type: 'json' };
import list from '../docs/benchmarks/2026-10-21-paypal-repos.json' with { type: 'json' };
import { scorePayPal } from '../scripts/paypal-score.mjs';

const call = (file: string, line: number, use = 'live') => ({ file, line, use });

describe('scorePayPal', () => {
  const small = {
    repos: [{ repo: 'a/one', requests: ['src/a.ts:10', 'src/a.ts:30', 'src/b.ts:5'] }],
  };

  it('matches a report to a label in the same file within four lines, one to one', () => {
    const score = scorePayPal(
      [
        {
          repo: 'a/one',
          status: 'scanned',
          calls: [
            call('src/a.ts', 12),
            call('src/a.ts', 14),
            call('src/b.ts', 5),
            call('src/c.ts', 1),
          ],
        },
      ],
      small,
    );
    expect(score).toMatchObject({
      labelled: 3,
      reported: 4,
      matched: 2,
      precision: 0.5,
      recall: 0.6667,
    });
    expect(score.wrong).toEqual([
      { repo: 'a/one', at: 'src/a.ts:14' },
      { repo: 'a/one', at: 'src/c.ts:1' },
    ]);
    expect(score.missed).toEqual([{ repo: 'a/one', at: 'src/a.ts:30' }]);
  });

  it('counts only live reports, and a repository that was not scanned as all missed', () => {
    expect(
      scorePayPal(
        [{ repo: 'a/one', status: 'scanned', calls: [call('src/a.ts', 10, 'test')] }],
        small,
      ),
    ).toMatchObject({ reported: 0, matched: 0, precision: null, recall: 0 });
    expect(scorePayPal([{ repo: 'a/one', status: 'not-scanned' }], small)).toMatchObject({
      matched: 0,
      recall: 0,
    });
  });
});

describe('the committed PayPal sample and labels', () => {
  it('lists at least 40 repositories and labels 20 of them at their pinned commits', () => {
    expect(list.repos.length).toBeGreaterThanOrEqual(40);
    expect(labels.repos).toHaveLength(20);
    const commits = new Map(list.repos.map((entry) => [entry.repo, entry.commit]));
    for (const entry of labels.repos)
      expect(commits.get(entry.repo), entry.repo).toBe(entry.commit);
  });
});
