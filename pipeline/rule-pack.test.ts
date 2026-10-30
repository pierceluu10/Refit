import { expect, it } from 'vitest';
import {
  constantValue,
  membersSince,
  minimumMajors,
  parseRulePack,
  releaseDefines,
  SHOPIFY_PACK,
  STRIPE_PACK,
} from './rule-pack.ts';
import { HELPER_NAMES, subscriptionPeriodHelperModule } from './stripe-subscription-periods.ts';

const FILE = 'test.json';
const valid = () => structuredClone(STRIPE_PACK) as unknown as Record<string, unknown>;

it('names a generated helper body for every Stripe field move', () => {
  const helpers = STRIPE_PACK.fieldMoves.flatMap((move) =>
    move.family === 'period-helper' ? Object.values(move.helpers) : [move.helper],
  );
  expect(helpers.length).toBeGreaterThan(0);
  for (const helper of helpers) {
    expect(HELPER_NAMES, helper).toContain(helper);
    expect(subscriptionPeriodHelperModule('ts', [helper]), helper).toContain(`function ${helper}`);
  }
});

it('gives every Stripe rule one entry and a docs.stripe.com changelog source', () => {
  const rules = [...STRIPE_PACK.fieldMoves, ...STRIPE_PACK.requestMoves].map((move) => move.rule);
  expect(new Set(rules).size).toBe(rules.length);
  for (const move of [...STRIPE_PACK.fieldMoves, ...STRIPE_PACK.requestMoves])
    expect(move.source, move.rule).toMatch(/^https:\/\/docs\.stripe\.com\/changelog\//);
});

it.each([
  [
    'an unknown family',
    (pack: any) => (pack.fieldMoves[1].family = 'guess'),
    /unknown field move family/,
  ],
  [
    'a repeated rule',
    (pack: any) => (pack.requestMoves[0].rule = pack.fieldMoves[0].rule),
    /listed twice/,
  ],
  ['a missing source', (pack: any) => delete pack.fieldMoves[2].source, /https source/],
  [
    'an http source',
    (pack: any) => (pack.requestMoves[1].source = 'http://example.com'),
    /https source/,
  ],
  [
    'a helper that is no identifier',
    (pack: any) => (pack.fieldMoves[2].helper = 'get-id'),
    /property and a helper/,
  ],
  [
    'an empty target path',
    (pack: any) => (pack.fieldMoves[1].targets = [['invoice']]),
    /target paths/,
  ],
  ['a flag set to false', (pack: any) => (pack.fieldMoves[1].narrowTested = false), /must be true/],
  [
    'a wrap without discriminator',
    (pack: any) =>
      delete pack.requestMoves.find((move: any) => move.family === 'request-wrap').discriminator,
    /discriminator/,
  ],
  [
    'a review without its source',
    (pack: any) => (pack.readReviews['invoice.tax'] = 'Check it.'),
    /reason with its source/,
  ],
  ['another format version', (pack: any) => (pack.formatVersion = 2), /formatVersion 1/],
])('rejects a pack with %s', (_name, change, message) => {
  const pack = valid();
  change(pack);
  expect(() => parseRulePack(pack, FILE)).toThrow(message);
});

const shopify = () => structuredClone(SHOPIFY_PACK) as unknown as Record<string, unknown>;

it('loads the Stripe pack without SDK facts and the Shopify pack without edit families', () => {
  expect(STRIPE_PACK.sdkFacts).toEqual([]);
  expect(STRIPE_PACK.symbolReviews).toEqual({});
  expect(SHOPIFY_PACK.fieldMoves).toEqual([]);
  expect(SHOPIFY_PACK.requestMoves).toEqual([]);
  expect(Object.keys(SHOPIFY_PACK.symbolReviews)).toEqual([
    'RELEASE_CANDIDATE_API_VERSION',
    'getJwt',
    'setCrypto',
  ]);
});

it('answers SDK facts by release', () => {
  const since = membersSince(SHOPIFY_PACK, '@shopify/shopify-api', 'ApiVersion');
  expect(releaseDefines(since, '12.1.0', 'January26')).toBe(true);
  expect(releaseDefines(since, '12.0.9', 'January26')).toBe(false);
  expect(releaseDefines(since, '14.0.0-rc.1', 'October26')).toBe(true);
  expect(releaseDefines(since, '99.0.0', 'January99')).toBe(false);
  const latest = (release: string) =>
    constantValue(SHOPIFY_PACK, '@shopify/shopify-api', 'LATEST_API_VERSION', release);
  expect(latest('6.9.9')).toBeUndefined();
  expect(latest('8.0.1')).toBe('July23');
  expect(latest('8.0.2')).toBe('October23');
  expect(latest('11.99.0')).toBe('July25');
  expect(latest('12.0.0')).toBeUndefined();
  expect(minimumMajors(SHOPIFY_PACK)).toEqual({
    '@shopify/shopify-api': 12,
    '@shopify/shopify-app-remix': 4,
    '@shopify/shopify-app-react-router': 1,
    '@shopify/shopify-app-express': 6,
  });
  expect(() => membersSince(STRIPE_PACK, '@shopify/shopify-api', 'ApiVersion')).toThrow(
    /no member-since fact/,
  );
});

it.each([
  [
    'an unknown fact family',
    (pack: any) => (pack.sdkFacts[0].family = 'guess'),
    /unknown SDK fact/,
  ],
  ['a fact without checkedAt', (pack: any) => delete pack.sdkFacts[1].checkedAt, /checkedAt/],
  ['an http fact source', (pack: any) => (pack.sdkFacts[2].source = 'http://x'), /https source/],
  [
    'a member without a release',
    (pack: any) => (pack.sdkFacts[0].since.October26 = 'latest'),
    /members with releases/,
  ],
  [
    'constant values out of release order',
    (pack: any) => pack.sdkFacts[1].values.reverse(),
    /ascending release order/,
  ],
  ['a removal that is no release', (pack: any) => (pack.sdkFacts[1].removedIn = '12'), /removedIn/],
  ['a zero major', (pack: any) => (pack.sdkFacts[3].major = 0), /positive major/],
  [
    'a symbol review without its source',
    (pack: any) => delete pack.symbolReviews.getJwt.source,
    /symbol review getJwt/,
  ],
])('rejects a Shopify pack with %s', (_name, change, message) => {
  const pack = shopify();
  change(pack);
  expect(() => parseRulePack(pack, FILE)).toThrow(message);
});
