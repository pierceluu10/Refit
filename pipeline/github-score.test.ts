import { expect, it } from 'vitest';
import { scoreGitHub } from '../scripts/github-score.mjs';

const call = (file: string, line: number, route: string | null, use = 'live') => ({
  file,
  line,
  route,
  use,
});

it('scores live requests and pins against labels, comparing routes with parameters as {}', () => {
  const labels = {
    repos: [
      {
        repo: 'a/one',
        commit: '1',
        calls: [
          call('src/a.ts', 3, 'GET /repos/{}/{}/issues'),
          call('src/a.ts', 9, 'POST /repos/{}/{}/issues'),
          call('src/a.ts', 12, null),
          call('src/a.ts', 14, 'GET /repos/{}/{}/compare/{}'),
          call('src/b.ts', 1, 'GET /user'),
        ],
        pins: [{ file: 'src/a.ts', line: 4 }],
      },
      { repo: 'a/two', commit: '2', calls: [call('x.ts', 1, 'GET /user')] },
    ],
  };
  const results = {
    results: [
      {
        repo: 'a/one',
        commit: '1',
        calls: [
          call('src/a.ts', 3, 'GET /repos/{owner}/{repo}/issues'),
          call('src/a.ts', 9, 'PATCH /repos/{owner}/{repo}/issues/'),
          call('src/a.ts', 12, null),
          call('src/a.ts', 14, 'GET /repos/{owner}/{repo}/compare/{base}...{head}'),
          call('src/c.ts', 4, 'GET /user'),
          call('test/a.test.ts', 1, 'GET /user', 'test'),
        ],
        pins: [
          { file: 'src/a.ts', line: 4, use: 'live' },
          { file: 'src/c.ts', line: 2, use: 'live' },
        ],
      },
      { repo: 'a/two', commit: '2', error: 'Repository exceeds scan limits' },
    ],
  };
  expect(scoreGitHub(labels, results)).toEqual({
    repositories: 1,
    skipped: ['a/two'],
    labels: 5,
    reported: 5,
    matched: 4,
    precision: 0.8,
    recall: 0.8,
    routeAgreement: 0.667,
    compared: 3,
    misses: ['a/one src/b.ts:1'],
    extras: ['a/one src/c.ts:4'],
    disagreements: [
      'a/one src/a.ts:9: labelled POST /repos/{}/{}/issues, reported PATCH /repos/{}/{}/issues',
    ],
    pins: {
      labels: 1,
      reported: 2,
      matched: 1,
      precision: 0.5,
      recall: 1,
      misses: [],
      extras: ['a/one src/c.ts:2'],
    },
  });
});
