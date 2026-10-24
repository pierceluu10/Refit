import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import { applySourceEdits } from './patches.ts';
import { STRIPE } from './providers.ts';
import { runPipeline } from './run.ts';
import { findRemovedProperties } from './specifications.ts';
import { subscriptionPeriodHelperModule } from './stripe-subscription-periods.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const string = { type: 'string' };
const ref = (schema: string) => ({ $ref: `#/components/schemas/${schema}` });
const holder = (title: string) => ({
  title,
  type: 'object',
  required: ['type'],
  properties: {
    type: { enum: ['coupon'], type: 'string' },
    coupon: { anyOf: [string, ref('coupon')], nullable: true },
  },
});

// Reduced from the promotion_code and discount schemas of Stripe's 2025-08-27.basil and
// 2026-09-30.endive OpenAPI documents (stripe/openapi).
function schemas(after: boolean): Record<string, unknown> {
  return {
    promotion_code: {
      type: 'object',
      required: after ? ['id', 'promotion'] : ['id', 'coupon'],
      properties: {
        id: string,
        code: string,
        ...(after
          ? { promotion: ref('promotion_codes_resource_promotion') }
          : { coupon: ref('coupon') }),
      },
    },
    discount: {
      type: 'object',
      properties: {
        id: string,
        ...(after ? { source: ref('discount_source') } : { coupon: ref('coupon') }),
      },
    },
    coupon: { type: 'object', properties: { id: string, percent_off: { type: 'number' } } },
    ...(after
      ? {
          promotion_codes_resource_promotion: holder('PromotionCodesResourcePromotion'),
          discount_source: holder('DiscountSource'),
        }
      : {}),
  };
}

const provider = {
  ...STRIPE,
  id: 'stripe-coupons',
  operations: [{ resource: 'promotionCodes', method: 'retrieve', schema: 'promotion_code' }],
};
const header = `import Stripe from 'stripe';\nconst stripe = new Stripe('sk', { apiVersion: '2025-08-27.basil' });\n`;

function analyze(body: string) {
  const content = header + body;
  const result = analyzeRepository(
    {
      root: '/coupon-ids',
      files: [{ path: 'coupons.ts', content }],
      dependencies: [],
      lockfiles: [],
      warnings: [],
    },
    findRemovedProperties(schemas(false), schemas(true), provider.id),
    provider,
    schemas(false),
  );
  return { ...result, patched: applySourceEdits(content, result.edits) };
}

function getCouponId(value: object) {
  const module: { exports: Record<string, (value: object) => unknown> } = { exports: {} };
  new Function('module', subscriptionPeriodHelperModule('cjs'))(module);
  return module.exports.getCouponId(value);
}

it('reads the coupon ID of either API version, expanded or not, and nothing else', () => {
  expect(getCouponId({ coupon: { id: 'co_old', percent_off: 10 } })).toBe('co_old');
  expect(getCouponId({ promotion: { type: 'coupon', coupon: 'co_new' } })).toBe('co_new');
  expect(getCouponId({ promotion: { type: 'coupon', coupon: { id: 'co_expanded' } } })).toBe(
    'co_expanded',
  );
  expect(getCouponId({ source: { type: 'coupon', coupon: 'co_discount' } })).toBe('co_discount');
  // A later promotion type that is not a coupon, a missing coupon, or no coupon at all.
  expect(getCouponId({ promotion: { type: 'gift', coupon: 'co_wrong' } })).toBeUndefined();
  expect(getCouponId({ source: { type: 'coupon', coupon: null } })).toBeUndefined();
  expect(getCouponId({})).toBeUndefined();
});

it('rewrites coupon ID reads of promotion codes and discounts, and leaves Coupon fields for review', () => {
  // helloworld9912/Stripe-Account-Migration src/scripts/promotion_codes.ts (stripe 14, 2023-10-16),
  // and a promotionCodes.retrieve read shaped like internxt/payments-server
  // src/services/payment.service.ts (stripe 17, 2025-02-24.acacia).
  const result = analyze(`function convertToPromotionCodeCreateParams(
  promotion_code: Stripe.PromotionCode
): Stripe.PromotionCodeCreateParams {
  let promotionCodeCreateParams: Stripe.PromotionCodeCreateParams = {
    coupon: promotion_code.coupon.id,
  };
  return promotionCodeCreateParams;
}
export async function checkIfCouponIsAplicable(promoCodeId: string) {
  const promoCode = await stripe.promotionCodes.retrieve(promoCodeId);
  return [promoCode.coupon.id, promoCode.coupon.percent_off, promoCode?.coupon?.id];
}
export const discountCoupon = (discount: Stripe.Discount) => discount.coupon.id;`);
  expect(result.findings.map(({ line, confidence }) => [line, confidence])).toEqual([
    [7, 'confirmed'],
    [13, 'confirmed'],
    [13, 'confirmed'],
    [13, 'confirmed'],
    [15, 'confirmed'],
  ]);
  // Four reads, the helper module and its import; the percent_off read keeps its finding unedited.
  expect(result.edits.filter((edit) => edit.rule === 'stripe-coupon-id-helper')).toHaveLength(6);
  expect(result.patched).toContain("import { getCouponId } from './stripe-subscription-period';");
  expect(result.patched).toContain('coupon: (getCouponId(promotion_code)),');
  expect(result.patched).toContain(
    'return [(getCouponId(promoCode)), promoCode.coupon.percent_off, (promoCode == null ? undefined : getCouponId(promoCode))];',
  );
  expect(result.patched).toContain('(discount: Stripe.Discount) => (getCouponId(discount));');
  // The unedited Coupon field read names why it stays.
  expect(result.findings[2].reason).toMatch(/needs that expand or a coupons\.retrieve call/);
});

it('keeps coupon ID reads only when the target contract has both new locations', async () => {
  const report = async (moved: boolean) => {
    const root = await mkdtemp(join(tmpdir(), 'refit-coupon-ids-'));
    roots.push(root);
    await writeFile(
      join(root, 'coupons.js'),
      `import Stripe from 'stripe';
const stripe = new Stripe('sk', { apiVersion: '2025-08-27.basil' });
export async function couponOf(id) {
  const promoCode = await stripe.promotionCodes.retrieve(id);
  return promoCode.coupon.id;
}
`,
    );
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { stripe: '18.0.0' } }),
    );
    const after = schemas(true);
    if (!moved) delete after.discount_source;
    const contract = (version: string, components: Record<string, unknown>) => ({
      openapi: '3.0.3',
      info: { title: 'Simulated Stripe contract', version },
      paths: {},
      components: { schemas: components },
    });
    await writeFile(
      join(root, 'before.json'),
      JSON.stringify(contract('2025-08-27.basil', schemas(false))),
    );
    await writeFile(join(root, 'after.json'), JSON.stringify(contract('2026-09-30.endive', after)));
    await writeFile(join(root, 'provider.json'), JSON.stringify(provider));
    return runPipeline({
      repository: root,
      before: join(root, 'before.json'),
      after: join(root, 'after.json'),
      providerConfig: join(root, 'provider.json'),
      apiVersion: '2025-08-27.basil',
      proposePatch: true,
    });
  };
  // Owner decision (2026-10-24, overnight sign-off): the helper edit is kept when the target
  // contract has promotion.coupon and source.coupon, and the read stops for review otherwise.
  const moved = await report(true);
  expect('diff' in moved.patch ? moved.patch.diff : '').toContain(
    'return (getCouponId(promoCode));',
  );
  const missing = await report(false);
  expect('diff' in missing.patch ? missing.patch.diff : '').not.toContain('getCouponId');
  expect(missing.findings).toEqual([expect.objectContaining({ confidence: 'confirmed' })]);
});
