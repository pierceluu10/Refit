import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import type { ProviderAdapter } from './providers.ts';
import { REMOVED_PARAMETER_NOTES, removedRequestParameters } from './request-removals.ts';
import { runPipeline } from './run.ts';
import { PROMOTION_CODE_PROMOTION_RULE } from './stripe-request-moves.ts';
import type { Repository } from './types.ts';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const provider: ProviderAdapter = {
  id: 'stripe-promotion-codes',
  packageName: 'stripe',
  defaultImport: true,
  namedExport: null,
  operations: [
    {
      resource: 'promotionCodes',
      method: 'create',
      schema: 'promotion_code',
      operationId: 'PostPromotionCodes',
    },
  ],
};

// Shaped like the POST /v1/promotion_codes bodies of Stripe's 2025-08-27.basil and
// 2026-09-30.endive OpenAPI documents (stripe/openapi), trimmed to the fields used here.
function contract(version: string, body: Record<string, unknown>) {
  return {
    openapi: '3.0.0',
    info: { version },
    paths: {
      '/v1/promotion_codes': {
        post: {
          operationId: 'PostPromotionCodes',
          requestBody: {
            content: { 'application/x-www-form-urlencoded': { schema: body } },
          },
        },
      },
    },
    components: {
      schemas: {
        promotion_code: { type: 'object', properties: { id: { type: 'string' } } },
      },
    },
  };
}
const basilBody = {
  type: 'object',
  required: ['coupon'],
  properties: {
    code: { maxLength: 500, type: 'string' },
    coupon: { maxLength: 5000, type: 'string' },
    max_redemptions: { type: 'integer' },
  },
};
const endiveBody = {
  type: 'object',
  required: ['promotion'],
  properties: {
    code: { maxLength: 500, type: 'string' },
    max_redemptions: { type: 'integer' },
    promotion: {
      title: 'promotion',
      type: 'object',
      required: ['type'],
      properties: {
        coupon: { maxLength: 5000, type: 'string' },
        type: { enum: ['coupon'], type: 'string' },
      },
    },
  },
};
const before = contract('2025-08-27.basil', basilBody);
const after = contract('2026-09-30.endive', endiveBody);

function analyze(source: string, file = 'promotion.ts') {
  const repository: Repository = {
    root: '/refit-promotion-codes',
    files: [{ path: file, content: source }],
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
  return analyzeRepository(
    repository,
    [],
    provider,
    {},
    [],
    [],
    [],
    removedRequestParameters(provider, before, after),
  );
}

it('moves promotion code coupons only when both contracts confirm the documented move', () => {
  expect(removedRequestParameters(provider, before, after)).toEqual([
    expect.objectContaining({ parameter: 'coupon', move: 'promotion' }),
  ]);
  // An optional coupon could be omitted, which promotion would not repeat.
  const optional = contract('2025-08-27.basil', { ...basilBody, required: [] });
  expect(removedRequestParameters(provider, optional, after)[0].move).toBeUndefined();
  // A target without promotion.coupon, or whose promotion type does not accept coupon.
  const { promotion, ...rest } = endiveBody.properties;
  const noPromotion = contract('2026-09-30.endive', { ...endiveBody, properties: rest });
  expect(removedRequestParameters(provider, before, noPromotion)[0].move).toBeUndefined();
  const otherType = contract('2026-09-30.endive', {
    ...endiveBody,
    properties: {
      ...rest,
      promotion: {
        ...promotion,
        properties: { ...promotion.properties, type: { enum: ['other'], type: 'string' } },
      },
    },
  });
  expect(removedRequestParameters(provider, before, otherType)[0].move).toBeUndefined();
  expect(
    removedRequestParameters({ ...provider, packageName: 'other' }, before, after)[0].move,
  ).toBeUndefined();
});

it('rewrites the real promotion code bodies of the benchmark repositories', () => {
  // boristenkes/shop.co features/coupon/actions/create.ts (stripe 18, 2025-04-30.basil) and
  // Nag-Software/proanbud2 lib/billing/welcome-discount.ts (stripe 18, 2025-08-27.basil).
  const result = analyze(`import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
export async function createCoupon(parsedData: { code: string; maxUses?: number }) {
  const stripeCoupon = await stripe.coupons.create({ percent_off: 10, currency: 'usd' });
  const stripePromoCode = await stripe.promotionCodes.create({
    code: parsedData.code,
    coupon: stripeCoupon.id,
    max_redemptions: parsedData.maxUses ?? undefined,
  });
  return stripePromoCode.id;
}
export async function welcome(input: { customerId: string; couponId: string }) {
  return await stripe.promotionCodes.create(
    {
      coupon: input.couponId,
      code: "WELCOME",
      customer: input.customerId,
    },
  );
}`);
  expect(result.findings.map(({ line, confidence }) => [line, confidence])).toEqual([
    [7, 'confirmed'],
    [15, 'confirmed'],
  ]);
  expect(result.edits.map(({ replacement, rule }) => [replacement, rule])).toEqual([
    ["promotion: { type: 'coupon', coupon: stripeCoupon.id }", PROMOTION_CODE_PROMOTION_RULE],
    // The body's own quotes.
    ['promotion: { type: "coupon", coupon: input.couponId }', PROMOTION_CODE_PROMOTION_RULE],
  ]);
});

it('keeps the shorthand value and quoted keys, and stops where the body could hide a conflict', () => {
  const result = analyze(`import Stripe from 'stripe';
const stripe = new Stripe('test');
const defaults = { code: 'SPRING' };
export async function create(coupon: string, promotion: object) {
  await stripe.promotionCodes.create({ coupon });
  await stripe.promotionCodes.create({ 'coupon': coupon, code: 'A' });
  await stripe.promotionCodes.create({ ...defaults, coupon });
  await stripe.promotionCodes.create({ coupon, promotion });
  await stripe.promotionCodes.create({ coupon, [String('code')]: 'B' });
  await stripe?.promotionCodes.create({ coupon });
}`);
  expect(result.edits.map(({ replacement }) => replacement)).toEqual([
    "promotion: { type: 'coupon', coupon: coupon }",
    "promotion: { type: 'coupon', coupon: coupon }",
  ]);
  expect(
    result.findings.map(({ line, confidence, reason }) => [
      line,
      confidence,
      reason.split('. ')[1],
    ]),
  ).toEqual([
    [5, 'confirmed', undefined],
    [6, 'confirmed', undefined],
    [7, 'confirmed', 'Request spreads, methods and computed properties require review.'],
    [8, 'confirmed', 'The request already sends promotion; merging the coupon needs review.'],
    [9, 'confirmed', 'Request spreads, methods and computed properties require review.'],
    [10, 'review', undefined],
  ]);
});

it('explains removed coupon parameters that keep stopping', () => {
  expect(REMOVED_PARAMETER_NOTES.coupon).toMatch(/overwrites every discount/);
  expect(REMOVED_PARAMETER_NOTES.promotion_code).toMatch(/customers have no replacement/);
});

it('leaves a removed request parameter for review instead of moving it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-promotion-codes-'));
  directories.push(root);
  const repository = join(root, 'repository');
  await mkdir(repository);
  await writeFile(
    join(repository, 'package.json'),
    JSON.stringify({ dependencies: { stripe: '18.1.1' } }),
  );
  await writeFile(
    join(repository, 'promotion.js'),
    `import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_KEY, { apiVersion: '2025-08-27.basil' });
export const create = (coupon) => stripe.promotionCodes.create({ code: 'SPRING', coupon });
`,
  );
  const files = { before: join(root, 'before.json'), after: join(root, 'after.json') };
  await writeFile(files.before, JSON.stringify(before));
  await writeFile(files.after, JSON.stringify(after));
  const providerConfig = join(root, 'provider.json');
  await writeFile(
    providerConfig,
    JSON.stringify({
      ...provider,
      namedExport: 'Stripe',
      constructorCalls: true,
      apiVersion: { constructorArgument: 1, property: 'apiVersion', requestArguments: [1, 2] },
    }),
  );
  const report = await runPipeline({
    repository,
    ...files,
    providerConfig,
    apiVersion: '2025-08-27.basil',
    proposePatch: true,
  });
  // Owner decision (2026-10-22): mined request moves stay review-only.
  const diff = 'diff' in report.patch ? report.patch.diff : '';
  expect(diff).not.toContain("promotion: { type: 'coupon'");
  expect(report.findings[0].requestParameter).toBeDefined();
});
