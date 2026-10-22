import { expect, it } from 'vitest';
import { scoreSlack } from '../scripts/slack-score.mjs';

const call = (file: string, line: number, methods: string[], use = 'live') => ({
  file,
  line,
  methods,
  use,
});

it('scores live reports against labels by file and line', () => {
  const labels = {
    repos: [
      {
        repo: 'a/one',
        commit: '1',
        calls: [
          { file: 'src/a.js', line: 3, methods: ['chat.postMessage'] },
          { file: 'src/a.js', line: 9, methods: [] },
          { file: 'src/b.js', line: 1, methods: ['files.upload'] },
        ],
      },
      { repo: 'a/two', commit: '2', calls: [{ file: 'x.js', line: 1, methods: ['auth.test'] }] },
      { repo: 'a/three', commit: '3', calls: [] },
    ],
  };
  const results = {
    results: [
      {
        repo: 'a/one',
        commit: '1',
        calls: [
          call('src/a.js', 3, ['chat.postMessage']),
          call('src/a.js', 9, ['users.info']),
          call('src/c.js', 4, ['auth.test']),
          call('test/a.test.js', 1, ['auth.test'], 'test'),
        ],
      },
      { repo: 'a/two', commit: '2', error: 'Repository exceeds scan limits' },
      { repo: 'a/three', commit: 'other', calls: [] },
    ],
  };
  expect(scoreSlack(labels, results)).toEqual({
    repositories: 1,
    skipped: ['a/two', 'a/three'],
    labels: 3,
    reported: 3,
    matched: 2,
    methodsAgree: 1,
    precision: 0.667,
    recall: 0.667,
    methodAgreement: 0.5,
    misses: ['a/one src/b.js:1'],
    extras: ['a/one src/c.js:4'],
    disagreements: ['a/one src/a.js:9: labelled (runtime), reported users.info'],
  });
});

it('scores another field and reports null ratios with nothing to divide', () => {
  const labels = { repos: [{ repo: 'a/one', commit: '1', webhooks: [] }] };
  const results = { results: [{ repo: 'a/one', commit: '1', webhooks: [] }] };
  expect(scoreSlack(labels, results, 'webhooks')).toMatchObject({
    repositories: 1,
    precision: null,
    recall: null,
    methodAgreement: null,
  });
});
