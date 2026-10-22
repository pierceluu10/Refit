import { expect, it } from 'vitest';
import { scoreCloudSdk } from '../scripts/cloud-sdk-score.mjs';

const site = (file: string, line: number, sdk: string, service: string, client = true) => ({
  repo: 'a/b',
  file,
  line,
  sdk,
  service,
  client,
});
const reported = (file: string, line: number, sdk: string, service: string, use = 'live') => ({
  file,
  line,
  sdk,
  service,
  use,
});

it('scores reported sites against labels per SDK and service', () => {
  const score = scoreCloudSdk(
    {
      repos: [{ repo: 'a/b' }, { repo: 'c/d' }],
      sites: [
        site('src/a.js', 2, 'aws-sdk-v2', 'S3'),
        site('src/a.js', 3, 'aws-sdk-v2', 'SES'),
        site('src/b.ts', 4, 'aws-sdk-v3', '@aws-sdk/client-s3'),
        site('src/c.js', 9, 'aws-sdk-v2', 'S3', false),
        site('src/d.js', 1, 'aws-sdk-v2', 'DynamoDB'),
      ],
    },
    {
      results: [
        {
          repo: 'a/b',
          status: 'scanned',
          clients: [
            reported('src/a.js', 2, 'aws-sdk-v2', 'S3'),
            reported('src/a.js', 3, 'aws-sdk-v2', 'SNS'),
            reported('src/c.js', 9, 'aws-sdk-v2', 'S3'),
            reported('test/a.test.js', 1, 'aws-sdk-v2', 'S3', 'test'),
            reported('dist/a.js', 1, 'aws-sdk-v2', 'S3'),
            reported('src/b.ts', 4, 'aws-sdk-v3', '@aws-sdk/client-s3'),
          ],
        },
        { repo: 'c/d', status: 'not-fetched', clients: [] },
        { repo: 'e/f', status: 'scanned', clients: [reported('x.js', 1, 'aws-sdk-v2', 'S3')] },
      ],
    },
  );
  expect(score.repositories).toBe(2);
  expect(score.notScanned).toEqual(['c/d']);
  expect(score.overall).toEqual({
    truePositives: 2,
    falsePositives: 2,
    falseNegatives: 2,
    wrongService: 1,
    precision: 0.5,
    recall: 0.5,
  });
  expect(score.byService['aws-sdk-v2 S3']).toMatchObject({ truePositives: 1, falsePositives: 1 });
  expect(score.byService['aws-sdk-v2 SES']).toMatchObject({ falseNegatives: 1, wrongService: 1 });
  expect(score.byService['aws-sdk-v2 DynamoDB']).toMatchObject({ falseNegatives: 1, recall: 0 });
  expect(score.bySdk['aws-sdk-v3']).toMatchObject({ precision: 1, recall: 1 });
  expect(score.errors.map((error) => error.kind)).toEqual([
    'wrong-service',
    'false-positive',
    'false-negative',
  ]);
});
