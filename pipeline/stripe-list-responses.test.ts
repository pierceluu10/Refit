import { expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import { applySourceEdits } from './patches.ts';
import { STRIPE, parseProviderAdapter } from './providers.ts';
import { findRemovedProperties } from './specifications.ts';
import { stripeOperations } from './stripe-benchmark.ts';

const integer = { type: 'integer' };
const ref = (schema: string) => ({ $ref: `#/components/schemas/${schema}` });

// Reduced Stripe contracts for the 2025-03-31.basil subscription period move.
function schemas(after: boolean): Record<string, unknown> {
  const period = { current_period_start: integer, current_period_end: integer };
  return {
    subscription: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        cancel_at_period_end: { type: 'boolean' },
        items: { type: 'object', properties: { data: { type: 'array', items: ref('item') } } },
        ...(after ? {} : period),
      },
    },
    item: { type: 'object', properties: { id: { type: 'string' }, ...(after ? period : {}) } },
  };
}

const provider = (list: boolean) => ({
  ...STRIPE,
  id: 'stripe-lists',
  operations: [
    { resource: 'subscriptions', method: 'retrieve', schema: 'subscription' },
    ...(list
      ? [{ resource: 'subscriptions', method: 'list', schema: 'subscription', list: true as const }]
      : []),
  ],
});

function analyze(body: string, list = true) {
  const content = `import Stripe from 'stripe';\nconst stripe = new Stripe('sk', { apiVersion: '2024-06-20' });\n${body}`;
  const adapter = provider(list);
  const result = analyzeRepository(
    {
      root: '/lists',
      files: [{ path: 'billing.ts', content }],
      dependencies: [],
      lockfiles: [],
      warnings: [],
    },
    findRemovedProperties(schemas(false), schemas(true), adapter.id),
    adapter,
    schemas(false),
  );
  const periods = result.findings.filter((finding) => /current_period/.test(finding.expression));
  return {
    confidences: periods.map((finding) => finding.confidence),
    patched: applySourceEdits(content, result.edits),
  };
}

// Kanba-co/kanba and iggy-tech/product-hunt-clone-final read the first listed subscription.
const firstListed = `export async function next(customer: string) {
  const subscriptions = await stripe.subscriptions.list({ customer, limit: 1 });
  const subscription = subscriptions.data[0];
  return new Date(subscription.current_period_end * 1000);
}`;

// shagunmistry/FlowCraft tests the listed subscriptions in a callback.
const someListed = `export async function active(customer: string) {
  const subscriptions = await stripe.subscriptions.list({ customer });
  return subscriptions.data.some(
    (s) => s.cancel_at_period_end && s.current_period_end * 1000 > Date.now(),
  );
}`;

it('traces the elements of a list response as objects of its schema', () => {
  for (const body of [firstListed, someListed]) {
    expect(analyze(body, false).confidences).toEqual(['review']);
    const { confidences, patched } = analyze(body);
    expect(confidences).toEqual(['confirmed']);
    expect(patched).toMatch(/getSubscriptionPeriodEnd\((subscription|s)\)/);
  }
});

it('traces a direct `(await list()).data` element', () => {
  const { confidences } = analyze(`export async function next(customer: string) {
  const subscription = (await stripe.subscriptions.list({ customer })).data[0];
  return subscription.current_period_end;
}`);
  expect(confidences).toEqual(['confirmed']);
});

it('never treats the list object itself as an object of its schema', () => {
  // A list has no `current_period_end`; this read is not of a subscription.
  const { confidences } = analyze(`export async function odd(customer: string) {
  const subscriptions = await stripe.subscriptions.list({ customer });
  return (subscriptions as any).current_period_end;
}`);
  expect(confidences).not.toContain('confirmed');
});

it('keeps an element of a list the code writes to for review', () => {
  const { confidences } =
    analyze(`export async function next(customer: string, extra: Stripe.Subscription) {
  const subscriptions = await stripe.subscriptions.list({ customer });
  subscriptions.data = [extra];
  return subscriptions.data[0].current_period_end;
}`);
  expect(confidences).not.toContain('confirmed');
});

it('maps list methods from the SDK spec and accepts them in a provider config', () => {
  const listResponse = {
    type: 'object',
    properties: {
      object: { type: 'string', enum: ['list'] },
      data: { type: 'array', items: ref('subscription') },
    },
  };
  const json = (schema: unknown) => ({
    responses: { '200': { content: { 'application/json': { schema } } } },
  });
  const spec = {
    paths: {
      '/v1/subscriptions': { get: { operationId: 'GetSubscriptions', ...json(listResponse) } },
      '/v1/subscriptions/search': {
        get: {
          operationId: 'GetSubscriptionsSearch',
          ...json({
            ...listResponse,
            properties: {
              ...listResponse.properties,
              object: { type: 'string', enum: ['search_result'] },
            },
          }),
        },
      },
      '/v1/subscriptions/{id}': {
        get: { operationId: 'GetSubscriptionsId', ...json(ref('subscription')) },
      },
    },
  };
  const sdk = {
    components: {
      schemas: {
        subscription: {
          'x-stripeOperations': [
            {
              method_name: 'list',
              method_on: 'service',
              method_type: 'list',
              operation: 'get',
              path: '/v1/subscriptions',
            },
            {
              method_name: 'search',
              method_on: 'service',
              method_type: 'custom',
              operation: 'get',
              path: '/v1/subscriptions/search',
            },
            {
              method_name: 'retrieve',
              method_on: 'service',
              method_type: 'retrieve',
              operation: 'get',
              path: '/v1/subscriptions/{id}',
            },
          ],
        },
      },
    },
  };
  const operations = stripeOperations(sdk, spec);
  expect(operations).toEqual([
    { resource: 'subscriptions', method: 'list', schema: 'subscription', list: true },
    {
      resource: 'subscriptions',
      method: 'retrieve',
      schema: 'subscription',
      operationId: 'GetSubscriptionsId',
    },
  ]);
  expect(parseProviderAdapter({ ...STRIPE, id: 'stripe-full', operations }).operations[0]).toEqual({
    resource: 'subscriptions',
    method: 'list',
    schema: 'subscription',
    list: true,
  });
  expect(() =>
    parseProviderAdapter({
      ...STRIPE,
      id: 'stripe-full',
      operations: [
        { resource: 'subscriptions', method: 'list', schema: 'subscription', list: false },
      ],
    }),
  ).toThrow(/Each provider operation/);
});
