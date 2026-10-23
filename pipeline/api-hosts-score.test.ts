import { describe, expect, it } from 'vitest';
import { scoreApiHosts } from '../scripts/api-hosts-score.mjs';
import labels from '../docs/benchmarks/2026-10-22-api-hosts-labels.json' with { type: 'json' };
import frozen from '../docs/benchmarks/2026-10-22-api-hosts-repos.json' with { type: 'json' };

describe('scoreApiHosts', () => {
  const small = {
    repos: [
      { repo: 'a/one', hosts: ['api.x.com', 'api.y.com'] },
      { repo: 'a/two', hosts: [] },
    ],
  };

  it('counts true positives, false positives and false negatives per repository and host', () => {
    const score = scoreApiHosts(
      { 'a/one': ['api.x.com', 'api.z.com'], 'a/two': ['api.w.com'] },
      small,
    );
    expect(score).toMatchObject({
      repositories: 2,
      truePositives: 1,
      falsePositives: 2,
      falseNegatives: 1,
      precision: 0.3333,
      recall: 0.5,
    });
    expect(score.wrong).toEqual([
      { repo: 'a/one', host: 'api.z.com' },
      { repo: 'a/two', host: 'api.w.com' },
    ]);
    expect(score.missed).toEqual([{ repo: 'a/one', host: 'api.y.com' }]);
  });

  it('is exact when detection matches, and null when a ratio has no denominator', () => {
    expect(scoreApiHosts({ 'a/one': ['api.x.com', 'api.y.com'] }, small)).toMatchObject({
      precision: 1,
      recall: 1,
    });
    expect(scoreApiHosts({}, { repos: [{ repo: 'a/two', hosts: [] }] })).toMatchObject({
      precision: null,
      recall: null,
    });
  });
});

describe('the committed labels', () => {
  it('cover 30 repositories of the frozen 60, at their pinned commits', () => {
    expect(frozen.repos).toHaveLength(60);
    expect(labels.repos).toHaveLength(30);
    const commits = new Map(frozen.repos.map((entry) => [entry.repo, entry.commit]));
    for (const entry of labels.repos)
      expect(commits.get(entry.repo), entry.repo).toBe(entry.commit);
    for (const entry of labels.repos) expect(entry.hosts).toEqual([...entry.hosts].sort());
  });
});
