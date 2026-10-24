import { expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import { STRIPE } from './providers.ts';
import { findRemovedProperties } from './specifications.ts';

const string = { maxLength: 5000, type: 'string' };
const ref = (schema: string) => ({ $ref: `#/components/schemas/${schema}` });
const expandable = (schema: string) => ({ anyOf: [string, ref(schema)], nullable: true });

// Reduced from the subscription, invoice, payment_intent and checkout.session schemas of Stripe's
// 2025-02-24.acacia and 2026-09-30.endive OpenAPI documents (stripe/openapi v1505 and v2526).
function schemas(after: boolean): Record<string, unknown> {
  return {
    subscription: {
      type: 'object',
      properties: { id: string, latest_invoice: expandable('invoice') },
    },
    invoice: {
      type: 'object',
      properties: {
        id: string,
        lines: {
          type: 'object',
          properties: { object: string, data: { type: 'array', items: ref('line_item') } },
        },
        ...(after
          ? {
              confirmation_secret: { anyOf: [ref('invoices_resource_confirmation_secret')] },
              parent: { anyOf: [ref('invoice_parent')], nullable: true },
            }
          : {
              payment_intent: expandable('payment_intent'),
              subscription: expandable('subscription'),
            }),
      },
    },
    invoices_resource_confirmation_secret: {
      type: 'object',
      properties: { client_secret: string, type: string },
    },
    invoice_parent: { type: 'object', properties: { type: string } },
    line_item: {
      type: 'object',
      properties: { id: string, ...(after ? { pricing: string } : { price: expandable('price') }) },
    },
    item: { type: 'object', properties: { id: string, price: expandable('price') } },
    price: { type: 'object', properties: { id: string, product: string } },
    payment_intent: { type: 'object', properties: { id: string, client_secret: string } },
    'checkout.session': {
      type: 'object',
      properties: {
        id: string,
        payment_intent: expandable('payment_intent'),
        line_items: {
          type: 'object',
          nullable: true,
          properties: { object: string, data: { type: 'array', items: ref('item') } },
        },
      },
    },
  };
}

const provider = {
  ...STRIPE,
  id: 'stripe-expand-paths',
  operations: [
    {
      resource: 'subscriptions',
      method: 'create',
      schema: 'subscription',
      operationId: 'PostSubscriptions',
    },
    { resource: 'invoices', method: 'retrieve', schema: 'invoice' },
    { resource: 'checkout.sessions', method: 'retrieve', schema: 'checkout.session' },
  ],
};

function analyze(content: string) {
  return analyzeRepository(
    {
      root: '/expand-paths',
      files: [{ path: 'billing.ts', content }],
      dependencies: [],
      lockfiles: [],
      warnings: [],
    },
    findRemovedProperties(schemas(false), schemas(true), provider.id),
    provider,
    schemas(false),
  );
}

it('reports literal expand paths through a removed field, from real benchmark snippets', () => {
  // Ardione321/prep-ai backend/controller/payment.controller.ts:19-23 and 4NDR3S-01/TuSuerteEC
  // src/app/api/webhooks/stripe/route.ts:338, with a Checkout expand that still exists.
  const { findings, edits } = analyze(`import Stripe from 'stripe';
const stripe = new Stripe('sk', { apiVersion: '2025-02-24.acacia' });
export async function subscribe(customerId: string) {
  const subscription = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: 'price_1' }],
    expand: ["latest_invoice.payment_intent"],
  });
  return { subscription };
}
export async function invoiceOf(id: string) {
  return stripe.invoices.retrieve(id, { expand: ['subscription', 'lines.data.price.product'] });
}
export async function session(id: string) {
  return stripe.checkout.sessions.retrieve(id, {
    expand: ['payment_intent', 'line_items.data.price.product'],
  });
}
`);
  expect(edits).toEqual([]);
  const expands = findings.filter((finding) => finding.expression.includes(' expand '));
  expect(expands.map(({ line, expression, confidence }) => [line, expression, confidence])).toEqual(
    [
      [7, "subscriptions.create expand 'latest_invoice.payment_intent'", 'confirmed'],
      [12, "invoices.retrieve expand 'subscription'", 'confirmed'],
      [12, "invoices.retrieve expand 'lines.data.price.product'", 'confirmed'],
    ],
  );
  expect(expands[0].reason).toMatch(/removed invoice\.payment_intent/);
  // The documented client-secret replacement is named for the person who must decide.
  expect(expands[0].reason).toMatch(/confirmation_secret\.client_secret/);
});

it('ignores dynamic expands, unknown paths and other providers', () => {
  const { findings } = analyze(`import Stripe from 'stripe';
const stripe = new Stripe('sk', { apiVersion: '2025-02-24.acacia' });
const fields = ['latest_invoice.payment_intent'];
export const a = () => stripe.subscriptions.create({ customer: 'c', expand: fields });
export const b = () => stripe.subscriptions.create({ customer: 'c', expand: ['latest_invoice.unknown.payment_intent'] });
export const c = () => stripe.subscriptions.create({ customer: 'c', expand: ['latest_invoice'] });
`);
  expect(findings.filter((finding) => finding.expression.includes(' expand '))).toEqual([]);
});
