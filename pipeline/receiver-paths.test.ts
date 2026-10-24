import { expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import { STRIPE } from './providers.ts';
import type { Repository } from './types.ts';

// Trimmed from the 2024-06-20 components in stripe/openapi v1095 (spec3.json, read 2026-10-24):
// a subscription's `items` lists subscription items, an invoice's `lines` lists line items, a
// Checkout Session's `line_items` lists `item`s, and an event's `data.object` is any object.
const list = (item: string) => ({
  type: 'object',
  properties: {
    data: { type: 'array', items: { $ref: `#/components/schemas/${item}` } },
    has_more: { type: 'boolean' },
    object: { type: 'string', enum: ['list'] },
    url: { type: 'string' },
  },
});
const price = { anyOf: [{ $ref: '#/components/schemas/price' }], nullable: true };
const schemas = {
  price: { type: 'object', properties: { id: { type: 'string' }, product: { type: 'string' } } },
  subscription: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      items: list('subscription_item'),
      metadata: { type: 'object', additionalProperties: { type: 'string', maxLength: 500 } },
    },
  },
  subscription_item: {
    type: 'object',
    properties: { id: { type: 'string' }, price: { $ref: '#/components/schemas/price' } },
  },
  invoice: { type: 'object', properties: { id: { type: 'string' }, lines: list('line_item') } },
  line_item: { type: 'object', properties: { id: { type: 'string' }, price } },
  invoiceitem: { type: 'object', properties: { id: { type: 'string' }, price } },
  'checkout.session': {
    type: 'object',
    properties: { id: { type: 'string' }, line_items: list('item') },
  },
  item: { type: 'object', properties: { id: { type: 'string' }, price } },
  event: {
    type: 'object',
    properties: {
      type: { type: 'string' },
      data: { $ref: '#/components/schemas/notification_event_data' },
    },
  },
  notification_event_data: { type: 'object', properties: { object: { type: 'object' } } },
};
// endive removes `price` from invoice line items and invoice items (as findRemovedProperties records it).
const changes = ['line_item', 'invoiceitem'].map((schema) => ({
  id: schema,
  schema,
  property: 'price',
  pointer: `/components/schemas/${schema}/properties/price`,
}));
function review(body: string) {
  const repository: Repository = {
    root: '/path-fixture',
    files: [
      {
        path: 'route.ts',
        content: `import Stripe from 'stripe';\nexport const stripe = new Stripe('key');\n${body}`,
      },
    ],
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
  return analyzeRepository(repository, changes, STRIPE, schemas)
    .findings.filter((finding) => finding.confidence === 'review')
    .map((finding) => finding.changeId);
}

it.each([
  [
    'a subscription item (buildFast10x/Nextjs-Boilerplate app/api/webhook/stripe/route.ts)',
    'export const save = (subscription: any) => ({ stripePriceId: subscription.items.data[0].price.id });',
  ],
  [
    'an optional subscription item (stephen99-dot/aiqs-portal server/stripe-webhook.js)',
    'export const priceId = (subscription: any) => subscription.items.data[0]?.price?.id;',
  ],
  [
    'a Checkout Session line item (sa902/ship-fast-ts-main app/api/webhook/stripe/route.ts)',
    'export const priceId = (session: any) => session?.line_items?.data[0]?.price.id;',
  ],
])('does not report a read that no schema path leads to the changed object: %s', (_n, body) => {
  expect(review(body)).toEqual([]);
});

it.each([
  [
    'an invoice line (krishna-praveen/shipfast-template-1 app/api/webhook/stripe/route.ts)',
    'export const priceId = (stripeObject: any) => stripeObject.lines.data[0].price.id;',
    ['line_item'],
  ],
  [
    'a list read on its own (the list is inline, not a component)',
    'export const first = (lines: any) => lines.data[0].price;',
    ['line_item'],
  ],
  [
    "an event's free-form data object",
    'export const read = (event: any) => event.data.object.price;',
    ['line_item', 'invoiceitem'],
  ],
  [
    'a computed index',
    'export const read = (subscription: any, i: number) => subscription.items.data[i].price;',
    ['line_item', 'invoiceitem'],
  ],
  [
    'a receiver with no path',
    'export const read = (plan: any) => plan.price;',
    ['line_item', 'invoiceitem'],
  ],
])('keeps the read for review when %s may be the changed object', (_n, body, expected) => {
  expect(review(body)).toEqual(expected);
});
