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

const cardAfter = contract(['mode', 'allowed_payment_method_types'], ['email']);

function analyzeCard(source: string) {
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
    removedRequestParameters(provider, before, cardAfter),
  );
}

it('offers the reviewed card-only replacement only for Stripe and when the target has it', () => {
  expect(removedRequestParameters(provider, before, cardAfter)[0]).toMatchObject({
    parameter: 'payment_method_types',
    cardReplacement: 'allowed_payment_method_types',
  });
  expect(removedRequestParameters(provider, before, after)[0].cardReplacement).toBeUndefined();
  expect(
    removedRequestParameters({ ...provider, packageName: 'other' }, before, cardAfter)[0]
      .cardReplacement,
  ).toBeUndefined();
});

it('renames exactly the literal card list and leaves every other value to review', () => {
  const result = analyzeCard(`const stripe = new Stripe('test');
    const methods = ['card'];
    export async function checkout() {
      await stripe.checkout.sessions.create({ mode: 'payment', payment_method_types: ['card'] });
      await stripe.checkout.sessions.create({ mode: 'payment', 'payment_method_types': ["card"] });
      await stripe.checkout.sessions.create({ mode: 'payment', payment_method_types: ['card', 'paypal'] });
      await stripe.checkout.sessions.create({ mode: 'payment', payment_method_types: ['card_present'] });
      await stripe.checkout.sessions.create({ mode: 'payment', payment_method_types: methods });
      await stripe.checkout.sessions.create({ mode: 'payment', payment_method_types: ['card'] as const });
      await stripe.checkout.sessions.create({ mode: 'payment', payment_method_types: [] });
    }`);
  expect(
    result.findings.map((finding) => [finding.line, Boolean(finding.requestParameter)]),
  ).toEqual([5, 6, 7, 8, 9, 10, 11].map((line) => [line, true]));
  expect(result.edits.map(({ replacement, rule }) => [replacement, rule])).toEqual([
    ['allowed_payment_method_types', 'stripe-card-allowed-payment-method-types'],
    ["'allowed_payment_method_types'", 'stripe-card-allowed-payment-method-types'],
  ]);
});

it('does not rename the card list on a client that escapes or may be replaced', () => {
  const result = analyzeCard(`const stripe = new Stripe('test');
    stripe.checkout.sessions.create = replacement;
    export async function checkout() {
      await stripe.checkout.sessions.create({ payment_method_types: ['card'] });
    }`);
  expect(result.findings).toMatchObject([{ confidence: 'review' }]);
  expect(result.edits).toEqual([]);
});
