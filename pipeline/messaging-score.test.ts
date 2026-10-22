import { expect, it } from 'vitest';
import { scoreMessaging } from '../scripts/messaging-score.mjs';

it('scores providers, deprecated calls and twilio versions against labels', () => {
  const score = scoreMessaging(
    {
      repos: [{ repo: 'a/b' }, { repo: 'c/d' }],
      providers: [
        { repo: 'a/b', provider: 'twilio', used: true },
        { repo: 'a/b', provider: 'sendgrid', used: false },
        { repo: 'a/b', provider: 'resend', used: true },
        { repo: 'c/d', provider: 'twilio', used: true },
      ],
      calls: [
        { repo: 'a/b', file: 'src/a.js', line: 3, deprecated: true },
        { repo: 'a/b', file: 'src/b.js', line: 9, deprecated: false },
        { repo: 'a/b', file: 'src/c.js', line: 1, deprecated: true },
      ],
      versions: [
        { repo: 'a/b', file: 'package.json', below: true },
        { repo: 'a/b', file: 'web/package.json', below: false },
      ],
    },
    {
      results: [
        {
          repo: 'a/b',
          status: 'scanned',
          providers: [{ agent: { id: 'twilio' } }, { agent: { id: 'sendgrid' } }],
          calls: [
            { file: 'src/a.js', line: 3, use: 'live' },
            { file: 'src/b.js', line: 9, use: 'live' },
            { file: 'test/a.test.js', line: 1, use: 'test' },
          ],
          packages: [
            { name: 'twilio', file: 'package.json', deadline: { id: 'x' } },
            { name: 'twilio', file: 'web/package.json', deadline: null },
          ],
        },
        { repo: 'c/d', status: 'not-fetched', providers: [], calls: [], packages: [] },
      ],
    },
  );
  expect(score.repositories).toBe(1);
  expect(score.notScanned).toEqual(['c/d']);
  expect(score.providers).toMatchObject({
    truePositives: 1,
    falsePositives: 1,
    falseNegatives: 1,
    precision: 0.5,
    recall: 0.5,
  });
  expect(score.providers.errors).toEqual([
    { kind: 'false-positive', key: 'a/b sendgrid' },
    { kind: 'false-negative', key: 'a/b resend' },
  ]);
  expect(score.calls).toMatchObject({ truePositives: 1, falsePositives: 1, falseNegatives: 1 });
  expect(score.versions).toMatchObject({
    truePositives: 1,
    falsePositives: 0,
    precision: 1,
    recall: 1,
  });
});
