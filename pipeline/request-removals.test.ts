import { expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import { migrationReviewReason } from './migration-review.ts';
import type { ProviderAdapter } from './providers.ts';
import { removedRequestParameters } from './request-removals.ts';
import type { Repository } from './types.ts';

const provider: ProviderAdapter = {
  id: 'stripe-request-removals',
  packageName: 'stripe',
  defaultImport: true,
  namedExport: null,
  operations: [
    {
      resource: 'checkout.sessions',
      method: 'create',
      schema: 'checkout.session',
      operationId: 'PostCheckoutSessions',
    },
    {
      resource: 'customers',
      method: 'update',
      schema: 'customer',
      operationId: 'PostCustomersCustomer',
    },
  ],
};

// Stripe documents use inline form bodies; other providers reference JSON body components.
function contract(sessionFields: string[], customerFields: string[]) {
  const form = (fields: string[]) => ({
    content: {
      'application/x-www-form-urlencoded': {
        schema: {
          type: 'object',
          properties: Object.fromEntries(fields.map((name) => [name, {}])),
        },
      },
    },
  });
  return {
    openapi: '3.0.0',
    paths: {
      '/v1/checkout/sessions': {
        post: { operationId: 'PostCheckoutSessions', requestBody: form(sessionFields) },
      },
      '/v1/customers/{customer}': {
        post: {
          operationId: 'PostCustomersCustomer',
          requestBody: { $ref: '#/components/requestBodies/customer' },
        },
      },
    },
    components: {
      requestBodies: {
        customer: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/params' } } },
        },
      },
      schemas: {
        params: {
          type: 'object',
          properties: Object.fromEntries(customerFields.map((name) => [name, {}])),
        },
      },
    },
  };
}

const before = contract(['mode', 'payment_method_types'], ['email', 'tax_exempt']);
const after = contract(['mode'], ['email']);

function analyze(source: string) {
  const repository: Repository = {
    root: '/refit-request-removals',
    files: [{ path: 'checkout.ts', content: `import Stripe from 'stripe';\n${source}` }],
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

it('finds request parameters removed from mapped operations, after path parameters', () => {
  expect(removedRequestParameters(provider, before, after)).toEqual([
    {
      id: 'request-parameter:PostCheckoutSessions.payment_method_types',
      resource: 'checkout.sessions',
      method: 'create',
      operationId: 'PostCheckoutSessions',
      parameter: 'payment_method_types',
      argumentIndex: 0,
    },
    {
      id: 'request-parameter:PostCustomersCustomer.tax_exempt',
      resource: 'customers',
      method: 'update',
      operationId: 'PostCustomersCustomer',
      parameter: 'tax_exempt',
      argumentIndex: 1,
    },
  ]);
});

it('stops for review when a traced SDK body still sends a removed parameter', () => {
  const result = analyze(`const stripe = new Stripe('test');
    export async function checkout(id: string) {
      await stripe.checkout.sessions.create({ mode: 'payment', payment_method_types: ['card'] });
      await stripe.customers.update(id, { 'tax_exempt': 'none' });
    }`);
  expect(
    result.findings.map(({ line, expression, confidence }) => ({ line, expression, confidence })),
  ).toEqual([
    {
      line: 4,
      expression: 'checkout.sessions.create argument[0].payment_method_types',
      confidence: 'confirmed',
    },
    { line: 5, expression: 'customers.update argument[1].tax_exempt', confidence: 'confirmed' },
  ]);
  expect(result.edits).toEqual([]);
  expect(migrationReviewReason(result)).toMatch(/removed\. No reviewed replacement/);
});

it('ignores bodies without the parameter, other arguments and bodies it cannot see', () => {
  const result = analyze(`const stripe = new Stripe('test');
    const params = { payment_method_types: ['card'] };
    export async function checkout(id: string) {
      await stripe.checkout.sessions.create({ mode: 'payment' });
      await stripe.checkout.sessions.create(params);
      await stripe.customers.update(id, { email: 'a@example.com' }, { tax_exempt: 'none' });
    }`);
  expect(result.findings).toEqual([]);
  expect(migrationReviewReason(result)).toBeUndefined();
});
