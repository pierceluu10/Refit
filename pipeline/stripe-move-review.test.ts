import { expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import { STRIPE } from './providers.ts';
import { findRemovedProperties } from './specifications.ts';
import { STRIPE_MOVE_REVIEW } from './stripe-field-moves.ts';

// Every removed read confirmed on the four tuned sets without an automatic rule (P2's probe
// 40074110257, docs/overnight/F4.md), and the same-family fields beside them.
const CONFIRMED_WITHOUT_RULE = [
  'invoice.payment_intent',
  'subscription.discount',
  'invoice.discount',
  'payment_intent.invoice',
  'charge.invoice',
  'invoice.charge',
  'invoice.paid',
  'invoice.tax',
  'invoice.subscription_details',
  'line_item.type',
  'line_item.price',
  'promotion_code.coupon',
];

it('names the Stripe page and the decision for every confirmed read without a rule', () => {
  for (const field of CONFIRMED_WITHOUT_RULE) {
    expect(STRIPE_MOVE_REVIEW[field], field).toMatch(/Source: https:\/\/docs\.stripe\.com\//);
  }
  // Several values: the reason asks which one; Refit does not choose.
  expect(STRIPE_MOVE_REVIEW['subscription.discount']).toMatch(/Which discount does this code mean/);
  expect(STRIPE_MOVE_REVIEW['invoice.charge']).toMatch(/Which payment does this code mean/);
});

const string = { type: 'string' };
const ref = (schema: string) => ({ $ref: `#/components/schemas/${schema}` });
// Reduced from the invoice and subscription schemas of Stripe's 2024-04-10 and 2026-09-30.endive
// OpenAPI documents (stripe/openapi).
function schemas(after: boolean): Record<string, unknown> {
  return {
    invoice: {
      type: 'object',
      properties: {
        id: string,
        total: { type: 'integer' },
        ...(after
          ? { total_taxes: { type: 'array', items: { type: 'object' } } }
          : { tax: { type: 'integer', nullable: true }, charge: string }),
      },
    },
    subscription: {
      type: 'object',
      properties: {
        id: string,
        ...(after
          ? { discounts: { type: 'array', items: string } }
          : { discount: { anyOf: [ref('discount')], nullable: true } }),
      },
    },
    discount: { type: 'object', properties: { id: string } },
  };
}

it('gives the reason on real confirmed reads', () => {
  // UNC-GDSC/Micro-SaaS-Starter-Kit lib/invoices.ts:75-94 and kondax-com/Bocker
  // services/stripe/repositories/StripeConnectRepository.ts:342-374.
  const content = `import Stripe from 'stripe';
const stripe = new Stripe('sk', { apiVersion: '2024-04-10' });
export async function syncInvoice(stripeInvoiceId: string) {
  const stripeInvoice = await stripe.invoices.retrieve(stripeInvoiceId);
  return { amount: stripeInvoice.total, tax: stripeInvoice.tax || 0 };
}
export async function verify(stripeSubscriptionId: string) {
  const subscriptionAfter = await stripe.subscriptions.retrieve(stripeSubscriptionId);
  const discountInfo = subscriptionAfter.discount;
  return discountInfo;
}
`;
  const provider = {
    ...STRIPE,
    id: 'stripe-review-reasons',
    operations: [
      { resource: 'invoices', method: 'retrieve', schema: 'invoice' },
      { resource: 'subscriptions', method: 'retrieve', schema: 'subscription' },
    ],
  };
  const { findings, edits } = analyzeRepository(
    {
      root: '/review-reasons',
      files: [{ path: 'billing.ts', content }],
      dependencies: [],
      lockfiles: [],
      warnings: [],
    },
    findRemovedProperties(schemas(false), schemas(true), provider.id),
    provider,
    schemas(false),
  );
  expect(edits).toEqual([]);
  expect(findings.map(({ line, confidence }) => [line, confidence])).toEqual([
    [5, 'confirmed'],
    [9, 'confirmed'],
  ]);
  expect(findings[0].reason).toContain(STRIPE_MOVE_REVIEW['invoice.tax']);
  expect(findings[1].reason).toContain(STRIPE_MOVE_REVIEW['subscription.discount']);
});
