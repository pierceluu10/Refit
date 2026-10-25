import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { STRIPE } from './providers.ts';
import { declaredOperations, stripeAdapterFor, stripeSdkOperations } from './stripe-operations.ts';

const metadata = JSON.parse(
  readFileSync(new URL('./stripe-sdk-metadata.json', import.meta.url), 'utf8'),
) as {
  operationVersions: string[];
  operations: { schema: string; method: string; operation: string; path: string }[];
};

const returns = (schema: unknown) => ({
  operationId: 'Op',
  responses: { '200': { content: { 'application/json': { schema } } } },
});
const ref = (schema: string) => ({ $ref: `#/components/schemas/${schema}` });
const list = (schema: string) => ({
  type: 'object',
  properties: { object: { enum: ['list'] }, data: { type: 'array', items: ref(schema) } },
});
// The response shapes of Stripe's published contract (spec3.json) for these paths.
const contract = {
  paths: {
    '/v1/customers/{customer}': {
      get: returns({ anyOf: [ref('customer'), ref('deleted_customer')] }),
    },
    '/v1/subscriptions': { get: returns(list('subscription')) },
    '/v1/subscriptions/{subscription_exposed_id}': { delete: returns(ref('subscription')) },
    '/v1/invoices/{invoice}': { get: returns(ref('invoice')) },
    '/v1/checkout/sessions': { post: returns(ref('checkout.session')) },
    '/v1/payment_intents/{intent}/cancel': { post: returns(ref('payment_intent')) },
  },
};

it('maps the methods applications call through the generated SDK operations', () => {
  const adapter = stripeAdapterFor(
    STRIPE,
    contract,
    new Set([
      'customers.retrieve',
      'subscriptions.list',
      'subscriptions.cancel',
      'invoices.retrieve',
      'checkout.sessions.create',
      'paymentIntents.cancel',
      'customers.create',
    ]),
  );
  expect(adapter.id).toBe('stripe');
  // paymentIntents.cancel is already built in; customers.create has no response in this contract.
  expect(adapter.operations.slice(STRIPE.operations.length)).toEqual(
    expect.arrayContaining([
      { resource: 'customers', method: 'retrieve', schema: 'customer', operationId: 'Op' },
      {
        resource: 'subscriptions',
        method: 'list',
        schema: 'subscription',
        operationId: 'Op',
        list: true,
      },
      { resource: 'subscriptions', method: 'cancel', schema: 'subscription', operationId: 'Op' },
      { resource: 'invoices', method: 'retrieve', schema: 'invoice', operationId: 'Op' },
      {
        resource: 'checkout.sessions',
        method: 'create',
        schema: 'checkout.session',
        operationId: 'Op',
      },
    ]),
  );
  expect(adapter.operations.length).toBe(STRIPE.operations.length + 5);
});

it('reads the same declarations from an SDK spec as the generated file holds', () => {
  const sdkSpec = {
    components: {
      schemas: {
        subscription: {
          'x-stripeOperations': [
            {
              method_name: 'cancel',
              method_on: 'service',
              operation: 'delete',
              path: '/v1/subscriptions/{subscription_exposed_id}',
            },
            {
              method_name: 'cancel',
              method_on: 'collection',
              operation: 'delete',
              path: '/v1/subscriptions/{subscription_exposed_id}',
            },
          ],
        },
      },
    },
  };
  const declared = declaredOperations(sdkSpec);
  expect(declared).toEqual([
    {
      schema: 'subscription',
      method: 'cancel',
      operation: 'delete',
      path: '/v1/subscriptions/{subscription_exposed_id}',
    },
  ]);
  expect(metadata.operations).toContainEqual(declared[0]);
  expect(stripeSdkOperations(declared, contract)).toEqual([
    { resource: 'subscriptions', method: 'cancel', schema: 'subscription', operationId: 'Op' },
  ]);
});

it('generates operations from every API version a frozen benchmark list pins', () => {
  const lists = new URL('../docs/benchmarks/', import.meta.url);
  const pinned = new Set<string>();
  for (const file of readdirSync(lists).filter((name) => /stripe.*repos\.json$/.test(name)))
    for (const { version } of JSON.parse(readFileSync(new URL(file, lists), 'utf8')).specs ?? [])
      pinned.add(version);
  expect(pinned.size).toBeGreaterThan(0);
  expect(metadata.operationVersions).toEqual(expect.arrayContaining([...pinned]));
});

it('refuses an operation overflow instead of silently truncating coverage', () => {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const { schema, operation, path } of metadata.operations)
    (paths[path] ??= {})[operation] = returns(ref(schema));
  const methods = new Set(
    stripeSdkOperations(metadata.operations, { paths }).map(
      ({ resource, method }) => `${resource}.${method}`,
    ),
  );
  expect(methods.size).toBeGreaterThan(100);
  expect(() => stripeAdapterFor(STRIPE, { paths }, methods)).toThrow(
    'no operations were silently discarded',
  );
});
