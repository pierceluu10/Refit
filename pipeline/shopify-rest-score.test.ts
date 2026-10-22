import { expect, it } from 'vitest';
import { scoreShopifyRest } from '../scripts/shopify-rest-score.mjs';

it('scores REST sites and removed-endpoint sites against labels', () => {
  const site = (file: string, line: number, rest: boolean, removed: boolean | null) => ({
    repo: 'a/b',
    file,
    line,
    rest,
    removed,
  });
  const score = scoreShopifyRest(
    {
      repos: [{ repo: 'a/b' }, { repo: 'c/d' }],
      sites: [
        site('app/a.ts', 3, true, true),
        site('app/a.ts', 9, true, false),
        site('app/b.ts', 1, true, null),
        site('app/c.ts', 4, false, null),
      ],
    },
    {
      results: [
        {
          repo: 'a/b',
          status: 'scanned',
          rest: [
            { file: 'app/a.ts', line: 3, use: 'live' },
            { file: 'app/a.ts', line: 9, use: 'live' },
            { file: 'app/c.ts', line: 4, use: 'live' },
            { file: 'test/a.test.ts', line: 1, use: 'test' },
          ],
          calls: [{ file: 'app/a.ts', line: 3, use: 'live' }],
        },
        { repo: 'c/d', status: 'not-scanned', rest: [], calls: [] },
      ],
    },
  );
  expect(score.notScanned).toEqual(['c/d']);
  expect(score.rest).toMatchObject({ truePositives: 2, falsePositives: 1, falseNegatives: 1 });
  expect(score.removed).toMatchObject({
    truePositives: 1,
    falsePositives: 0,
    precision: 1,
    recall: 1,
  });
});
