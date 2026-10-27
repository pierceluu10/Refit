import { describe, expect, it } from 'vitest';
import type { CapturedDocumentation } from './documentation-sources.ts';
import {
  behaviour,
  completeCandidate,
  keep,
  parseCandidates,
  reproductions,
  type Candidate,
} from './rule-generation.ts';
import {
  STRIPE_PACK,
  parseRuleTable,
  withRuleTables,
  type RuleTable,
  type TableRule,
} from './rule-pack.ts';
import { responseRemovals, verifyRule, type RuleEvidence } from './rule-verification.ts';

// The shipped Stripe rules, which the generator reproduced (data/rules/stripe).
const HAND = STRIPE_PACK;
const hand = (rule: string) =>
  [...HAND.fieldMoves, ...HAND.requestMoves].find((entry) => entry.rule === rule)!;

const SOURCE = 'https://docs.stripe.com/changelog/basil/2025-03-31/example';
const QUOTE = 'Moves `subscription` to `parent.subscription_details.subscription`.';
const page = (content: string): CapturedDocumentation => ({
  formatVersion: 1,
  kind: 'refit-documentation-snapshot',
  label: 'example',
  url: `${SOURCE}.md`,
  revision: 'hash',
  hash: 'hash',
  content,
  contentType: 'text/markdown',
});

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ content: { 'application/json': { schema } } });
const document = (schemas: Record<string, unknown>, paths: Record<string, unknown> = {}) => ({
  openapi: '3.0.0',
  paths: {
    '/v1/invoices/{invoice}': {
      get: { operationId: 'GetInvoicesInvoice', responses: { 200: json(ref('invoice')) } },
    },
    ...paths,
  },
  components: { schemas: { subscription: { type: 'object', properties: {} }, ...schemas } },
});

const invoiceBefore = document({
  invoice: {
    type: 'object',
    properties: {
      subscription: {
        anyOf: [{ type: 'string' }, ref('subscription')],
        nullable: true,
        'x-expansionResources': { oneOf: [ref('subscription')] },
      },
    },
  },
});
const invoiceAfter = document({
  invoice: { type: 'object', properties: { parent: { anyOf: [ref('invoice_parent')] } } },
  invoice_parent: {
    type: 'object',
    properties: { subscription_details: { anyOf: [ref('subscription_details')] } },
  },
  subscription_details: {
    type: 'object',
    properties: { subscription: { anyOf: [{ type: 'string' }, ref('subscription')] } },
  },
});
const invoiceRemoval = {
  id: 'response-required-property-removed',
  text: 'removed the required property `subscription` from the response with the `200` status',
  operation: 'GET',
  operationId: 'GetInvoicesInvoice',
  path: '/v1/invoices/{invoice}',
};

const candidate = (overrides: Partial<Candidate>): Candidate => ({
  family: 'moved-value',
  schemas: [],
  properties: [],
  targets: [],
  operations: [],
  parameter: '',
  replacement: '',
  discriminator: '',
  quote: QUOTE,
  warning: 'Reads go through a helper.',
  rationale: 'The page names the new location.',
  ...overrides,
});
const context = {
  version: '2025-03-31.basil',
  source: SOURCE,
  checkedAt: '2026-10-27',
  generatedBy: { model: 'model', responseId: 'resp_1' },
};
const complete = (input: Candidate, evidence: RuleEvidence) =>
  completeCandidate(input, context, evidence, responseRemovals(evidence.diff, evidence.before));

const invoiceEvidence: RuleEvidence = {
  pages: new Map([[SOURCE, page(`# Example\n\n${QUOTE}`)]]),
  before: invoiceBefore,
  after: invoiceAfter,
  diff: [invoiceRemoval],
};
const invoiceCandidate = candidate({
  schemas: ['invoice'],
  properties: ['subscription'],
  targets: ['invoice.parent.subscription_details.subscription'],
});

describe('rule generation', () => {
  it('derives guards and the helper from the contracts and reproduces the hand rule', () => {
    const outcome = complete(invoiceCandidate, invoiceEvidence);
    expect(outcome).toHaveProperty('rule');
    const rule = (outcome as { rule: TableRule }).rule;
    console.log(JSON.stringify(rule, null, 2));
    expect(rule).toMatchObject({
      family: 'moved-value',
      helper: 'getInvoiceSubscription',
      unlessExpanded: true,
      typeofGuard: true,
      narrowTested: true,
      status: 'review-only',
      origin: 'generated',
      diff: { id: invoiceRemoval.id, operationId: 'GetInvoicesInvoice', text: invoiceRemoval.text },
    });
    expect(behaviour(rule)).toBe(behaviour(hand('stripe-invoice-subscription-helper')));
  });

  it('refuses a quote the page does not hold verbatim', () => {
    const outcome = complete(
      candidate({ ...invoiceCandidate, quote: QUOTE.replace('Moves', 'Moved') }),
      invoiceEvidence,
    );
    expect(outcome).toEqual({
      reason: expect.stringContaining('quote is not in the captured page'),
    });
  });

  it('refuses a move the diff does not remove', () => {
    expect(complete(invoiceCandidate, { ...invoiceEvidence, diff: [] })).toEqual({
      reason: 'the diff removes none of the named properties',
    });
  });

  it('refuses a location no helper reads, and a target the after contract lacks', () => {
    expect(
      complete(
        candidate({ ...invoiceCandidate, targets: ['invoice.parent.subscription'] }),
        invoiceEvidence,
      ),
    ).toEqual({ reason: 'no generated helper reads this location yet' });
    const after = document({ invoice: { type: 'object', properties: {} } });
    expect(complete(invoiceCandidate, { ...invoiceEvidence, after })).toEqual({
      reason: expect.stringContaining('the after contract has no'),
    });
  });

  const promotionPath = (body: object) => ({
    '/v1/promotion_codes': {
      post: {
        operationId: 'PostPromotionCodes',
        requestBody: { content: { 'application/x-www-form-urlencoded': { schema: body } } },
        responses: {},
      },
    },
  });
  const wrapEvidence = (types: string[]): RuleEvidence => ({
    pages: new Map([[SOURCE, page(`# Example\n\n${QUOTE}`)]]),
    before: document(
      {},
      promotionPath({
        type: 'object',
        required: ['coupon'],
        properties: { coupon: { type: 'string' } },
      }),
    ),
    after: document(
      {},
      promotionPath({
        type: 'object',
        properties: {
          promotion: {
            type: 'object',
            properties: { coupon: { type: 'string' }, type: { type: 'string', enum: types } },
          },
        },
      }),
    ),
    diff: [
      {
        id: 'request-property-removed',
        text: 'removed the request property `coupon`',
        operation: 'POST',
        operationId: 'PostPromotionCodes',
        path: '/v1/promotion_codes',
      },
    ],
  });
  const wrap = candidate({
    family: 'request-wrap',
    operations: ['POST /v1/promotion_codes'],
    parameter: 'coupon',
    replacement: 'promotion',
    discriminator: 'coupon',
  });

  it('maps operations to their IDs and checks a wrap against both contracts', () => {
    const outcome = complete(wrap, wrapEvidence(['coupon']));
    expect(outcome).toHaveProperty('rule');
    expect(behaviour((outcome as { rule: TableRule }).rule)).toBe(
      behaviour(hand('stripe-promotion-code-promotion')),
    );
    expect(complete(wrap, wrapEvidence(['other']))).toEqual({
      reason: 'the contracts do not agree with the request-wrap on PostPromotionCodes',
    });
    expect(
      complete({ ...wrap, operations: ['POST /v1/coupons'] }, wrapEvidence(['coupon'])),
    ).toEqual({ reason: 'an operation is not in the before contract' });
  });

  it('counts field moves split across pages as one reproduction', () => {
    const coupon = hand('stripe-coupon-id-helper');
    const part = (schema: string, target: string[]) =>
      ({
        ...coupon,
        rule: `generated-${schema}`,
        schemas: [schema],
        targets: [target],
      }) as TableRule;
    const parts = [
      part('promotion_code', ['promotion_code', 'promotion', 'coupon']),
      part('discount', ['discount', 'source', 'coupon']),
    ];
    expect(reproductions([coupon], parts).get(coupon.rule)).toEqual([
      'generated-promotion_code',
      'generated-discount',
    ]);
    expect(reproductions([coupon], parts.slice(0, 1)).has(coupon.rule)).toBe(false);
  });

  it('joins one helper move proposed on two pages into one rule with both pages as evidence', () => {
    const other = 'https://docs.stripe.com/changelog/clover/2025-09-30/other';
    const removal = (operationId: string, path: string) => ({
      id: 'response-required-property-removed',
      text: 'removed the required property `coupon` from the response with the `200` status',
      operation: 'GET',
      operationId,
      path,
    });
    const endpoint = (path: string, operationId: string, schema: string) => ({
      [path]: { get: { operationId, responses: { 200: json(ref(schema)) } } },
    });
    const paths = {
      ...endpoint('/v1/discounts/{id}', 'GetDiscount', 'discount'),
      ...endpoint('/v1/promotion_codes/{id}', 'GetPromotionCode', 'promotion_code'),
    };
    const id = { anyOf: [{ type: 'string' }, ref('coupon')] };
    const evidence: RuleEvidence = {
      pages: new Map([
        [SOURCE, page(QUOTE)],
        [other, { ...page(QUOTE), url: `${other}.md` }],
      ]),
      before: document(
        {
          coupon: { type: 'object', properties: {} },
          discount: { type: 'object', properties: { coupon: ref('coupon') } },
          promotion_code: { type: 'object', properties: { coupon: ref('coupon') } },
        },
        paths,
      ),
      after: document(
        {
          coupon: { type: 'object', properties: {} },
          discount: { type: 'object', properties: { source: ref('discount_source') } },
          discount_source: { type: 'object', properties: { coupon: id } },
          promotion_code: { type: 'object', properties: { promotion: ref('promotion') } },
          promotion: { type: 'object', properties: { coupon: id } },
        },
        paths,
      ),
      diff: [
        removal('GetDiscount', '/v1/discounts/{id}'),
        removal('GetPromotionCode', '/v1/promotion_codes/{id}'),
      ],
    };
    const removals = responseRemovals(evidence.diff, evidence.before);
    const generate = (schema: string, target: string, source: string) =>
      (
        completeCandidate(
          candidate({
            family: 'moved-id',
            schemas: [schema],
            properties: ['coupon'],
            targets: [target],
          }),
          { ...context, source },
          evidence,
          removals,
        ) as { rule: TableRule }
      ).rule;
    const kept: TableRule[] = [];
    keep(kept, generate('discount', 'discount.source.coupon', SOURCE), evidence, removals);
    keep(
      kept,
      generate('promotion_code', 'promotion_code.promotion.coupon', other),
      evidence,
      removals,
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].also).toEqual([
      expect.objectContaining({
        source: other,
        diff: expect.objectContaining({ operationId: 'GetPromotionCode' }),
      }),
    ]);
    expect(behaviour(kept[0])).toBe(behaviour(hand('stripe-coupon-id-helper')));
    expect(verifyRule(kept[0], evidence)).toEqual([]);
    expect(verifyRule(kept[0], { ...evidence, pages: new Map([[SOURCE, page(QUOTE)]]) })).toEqual([
      `no captured page for ${other}`,
    ]);
  });

  it('rejects model output outside the schema', () => {
    expect(() => parseCandidates(JSON.stringify({ rules: [{ family: 'rename' }] }))).toThrow(
      'does not match the schema',
    );
  });
});

describe('rule tables', () => {
  const table = (rule: Partial<TableRule>): RuleTable => ({
    formatVersion: 1,
    provider: 'stripe',
    version: '2025-09-30.clover',
    previous: '2025-08-27.basil',
    rules: [
      {
        ...hand('stripe-promotion-code-promotion'),
        rule: 'generated-promotion',
        quote: QUOTE,
        checkedAt: '2026-10-27',
        diff: { id: 'request-property-removed', operationId: 'PostPromotionCodes', text: 'x' },
        status: 'review-only',
        origin: 'generated',
        generatedBy: { model: 'model', responseId: 'resp_1' },
        benchmark: undefined,
        ...rule,
      } as TableRule,
    ],
  });

  it('needs benchmark evidence before a rule edits code', () => {
    expect(() => parseRuleTable(table({ status: 'auto' }), 'table')).toThrow(
      'needs the benchmark run',
    );
    expect(() =>
      parseRuleTable(table({ status: 'auto', benchmark: 'run 1' }), 'table'),
    ).not.toThrow();
    expect(() => parseRuleTable(table({ generatedBy: undefined }), 'table')).toThrow(
      'needs generatedBy',
    );
  });

  it('adds only auto rules to the pack, and refuses a rule the pack already has', () => {
    const review = withRuleTables(HAND, [table({})]);
    expect(review.requestMoves.map((move) => move.rule)).not.toContain('generated-promotion');
    const auto = withRuleTables(HAND, [table({ status: 'auto', benchmark: 'run 1' })]);
    expect(auto.requestMoves.map((move) => move.rule)).toContain('generated-promotion');
    expect(() =>
      withRuleTables(HAND, [
        table({ status: 'auto', benchmark: 'run 1', rule: 'stripe-promotion-code-promotion' }),
      ]),
    ).toThrow('is in both the pack and a rule table');
  });

  it('verifies a stored rule against its page and diff', () => {
    const rule = (complete(invoiceCandidate, invoiceEvidence) as { rule: TableRule }).rule;
    expect(verifyRule(rule, invoiceEvidence)).toEqual([]);
    expect(verifyRule(rule, { ...invoiceEvidence, pages: new Map() })).toEqual([
      `no captured page for ${SOURCE}`,
    ]);
  });
});
