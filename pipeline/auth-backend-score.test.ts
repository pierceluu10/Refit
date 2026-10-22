import { expect, it } from 'vitest';
import { repositoryResult, scoreAuthBackend } from '../scripts/auth-backend-score.mjs';

it('keeps only the four providers and their live exposures from Refit output', () => {
  expect(
    repositoryResult(
      { detected: [{ id: 'stripe' }, { id: 'supabase' }, { id: 'clerk' }] },
      {
        exposures: [
          { deadline: { id: 'openai-gpt-4', provider: 'openai' } },
          { deadline: { id: 'supabase-legacy', provider: 'supabase' } },
        ],
      },
    ),
  ).toEqual({ providers: ['clerk', 'supabase'], exposures: ['supabase-legacy'] });
  expect(repositoryResult(undefined, undefined)).toEqual({ providers: [], exposures: [] });
});

it('scores providers and exposures by repository, and counts failed scans apart', () => {
  const labels = {
    labels: [
      { repo: 'a/one', providers: ['clerk'], exposures: ['clerk-core-1'] },
      { repo: 'b/two', providers: ['supabase', 'firebase'], exposures: [] },
      { repo: 'c/three', providers: ['auth0'], exposures: ['auth0-v6'] },
    ],
  };
  const score = scoreAuthBackend(labels, {
    repos: [
      { repo: 'A/One', providers: ['clerk'], exposures: ['clerk-core-1', 'clerk-elements'] },
      { repo: 'b/two', providers: ['supabase'], exposures: [] },
      { repo: 'c/three', providers: [], exposures: [], error: 'timeout' },
    ],
  });
  expect(score.labelled).toBe(3);
  expect(score.scored).toBe(2);
  expect(score.failed).toEqual(['c/three']);
  expect(score.providers).toEqual({
    truePositive: 2,
    falsePositive: 0,
    falseNegative: 1,
    precision: 1,
    recall: 2 / 3,
    misses: [{ repo: 'b/two', item: 'firebase', error: 'false negative' }],
  });
  expect(score.exposures).toMatchObject({
    truePositive: 1,
    falsePositive: 1,
    falseNegative: 0,
    precision: 0.5,
    recall: 1,
  });
  // No labelled positives and no results leave the ratios unmeasured, not zero.
  const empty = scoreAuthBackend(
    { labels: [{ repo: 'd/four', providers: [], exposures: [] }] },
    {
      repos: [{ repo: 'd/four', providers: [], exposures: [] }],
    },
  );
  expect(empty.exposures.precision).toBeNull();
  expect(empty.exposures.recall).toBeNull();
});
