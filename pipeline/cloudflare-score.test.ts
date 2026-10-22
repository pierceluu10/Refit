import { expect, it } from 'vitest';
import { scoreCloudflare } from '../scripts/cloudflare-score.mjs';

const call = (
  file: string,
  line: number,
  method: string | null,
  path: string | null,
  use = 'live',
) => ({
  file,
  line,
  method,
  path,
  use,
});

it('scores live reports against labels and compares endpoints with runtime segments as {}', () => {
  const labels = {
    repos: [
      {
        repo: 'a/one',
        commit: '1',
        calls: [
          call('src/a.ts', 3, 'GET', '/zones/{}/dns_records'),
          call('src/a.ts', 9, 'POST', '/zones/{}/purge_cache'),
          call('src/a.ts', 12, null, null),
          call('src/b.ts', 1, 'GET', '/zones'),
        ],
      },
      { repo: 'a/two', commit: '2', calls: [call('x.ts', 1, 'GET', '/zones')] },
    ],
  };
  const results = {
    results: [
      {
        repo: 'a/one',
        commit: '1',
        calls: [
          call('src/a.ts', 3, 'GET', '/zones/{zone_id}/dns_records'),
          call('src/a.ts', 9, 'POST', '/zones/{zoneId}/purge_cache/'),
          call('src/a.ts', 12, 'GET', null),
          call('src/c.ts', 4, 'GET', '/user'),
          call('test/a.test.ts', 1, 'GET', '/user', 'test'),
        ],
      },
      { repo: 'a/two', commit: '2', error: 'Repository exceeds scan limits' },
    ],
  };
  expect(scoreCloudflare(labels, results)).toEqual({
    repositories: 1,
    skipped: ['a/two'],
    labels: 4,
    reported: 4,
    matched: 3,
    precision: 0.75,
    recall: 0.75,
    endpointAgreement: 1,
    compared: 2,
    misses: ['a/one src/b.ts:1'],
    extras: ['a/one src/c.ts:4'],
    disagreements: [],
  });
});

it('lists endpoint disagreements', () => {
  const labels = { repos: [{ repo: 'r', commit: 'c', calls: [call('a.ts', 1, 'GET', '/zones')] }] };
  const results = {
    results: [{ repo: 'r', commit: 'c', calls: [call('a.ts', 1, 'POST', '/zones')] }],
  };
  expect(scoreCloudflare(labels, results).disagreements).toEqual([
    'r a.ts:1: labelled GET /zones, reported POST /zones',
  ]);
});
