import { expect, it } from 'vitest';
import { repositoryResult, scoreCommerce } from '../scripts/commerce-score.mjs';

it('keeps list-A providers, their live exposures and their live pins from Refit output', () => {
  expect(
    repositoryResult(
      {
        detected: [
          { id: 'stripe' },
          {
            id: 'plaid',
            apiVersions: [
              { provider: 'plaid', version: '2020-09-14', use: 'live' },
              { provider: 'plaid', version: '2020-09-14', use: 'live' },
              { provider: 'plaid', version: '2019-05-29', use: 'test' },
            ],
          },
        ],
      },
      { exposures: [{ deadline: { id: 'braintree-v2', provider: 'braintree' } }] },
    ),
  ).toEqual({ providers: ['plaid'], exposures: ['braintree-v2'], pins: ['plaid 2020-09-14'] });
});

it('scores providers, exposures and pins by repository', () => {
  const score = scoreCommerce(
    {
      labels: [
        { repo: 'a/one', providers: ['plaid'], exposures: [], pins: ['plaid 2020-09-14'] },
        { repo: 'b/two', providers: ['adyen'], exposures: ['adyen-v3'], pins: [] },
      ],
    },
    {
      repos: [
        { repo: 'a/one', providers: ['plaid'], exposures: [], pins: [] },
        {
          repo: 'b/two',
          providers: ['adyen'],
          exposures: ['adyen-v3'],
          pins: ['adyen checkout/v71'],
        },
      ],
    },
  );
  expect(score.providers).toMatchObject({ truePositive: 2, precision: 1, recall: 1 });
  expect(score.exposures).toMatchObject({ truePositive: 1, precision: 1, recall: 1 });
  expect(score.pins).toEqual({
    truePositive: 0,
    falsePositive: 1,
    falseNegative: 1,
    precision: 0,
    recall: 0,
    misses: [
      { repo: 'a/one', item: 'plaid 2020-09-14', error: 'false negative' },
      { repo: 'b/two', item: 'adyen checkout/v71', error: 'false positive' },
    ],
  });
});
