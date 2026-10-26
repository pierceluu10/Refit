import { expect, it } from 'vitest';
import { parseRulePack, STRIPE_PACK } from './rule-pack.ts';
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
    (pack: any) => delete pack.requestMoves[0].discriminator,
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
