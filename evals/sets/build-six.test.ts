import { describe, expect, it } from 'vitest';
import { PER_PROVIDER, SEARCHES, pickRepos } from './build-six.ts';
import { sampleSet } from './index.ts';

describe('pickRepos', () => {
  it('keeps known repos first, drops case-insensitive duplicates and stops at the limit', () => {
    expect(pickRepos(['a/one', 'b/two'], ['B/Two', 'c/three', 'd/four'], 3)).toEqual([
      'a/one',
      'b/two',
      'c/three',
    ]);
  });
});

describe('SEARCHES', () => {
  it('covers exactly the six providers, 780 repos in all', () => {
    expect(Object.keys(SEARCHES).sort()).toEqual([
      'github',
      'meta',
      'openai',
      'shopify',
      'stripe',
      'twilio',
    ]);
    expect(Object.keys(SEARCHES).length * PER_PROVIDER).toBe(780);
  });
});

describe('sampleSet', () => {
  it('takes repos round-robin across providers up to the limit', () => {
    const set = {
      name: 'x',
      provider: 'mixed',
      kind: 'dev' as const,
      source: { path: '', commit: '', blob: '' },
      repos: [
        { repo: 's/1', commit: 'a', provider: 'stripe' },
        { repo: 's/2', commit: 'a', provider: 'stripe' },
        { repo: 'h/1', commit: 'a', provider: 'shopify' },
        { repo: 'o/1', commit: 'a', provider: 'openai' },
      ],
    };
    expect(sampleSet(set, 3).repos.map((entry) => entry.repo)).toEqual(['s/1', 'h/1', 'o/1']);
    expect(sampleSet(set, 10).repos).toHaveLength(4);
  });
});
