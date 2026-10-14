import { expect, it } from 'vitest';
import { STRIPE } from './providers.ts';
import { stripeAdapterFor, stripeContractOperations } from './stripe-operations.ts';

const returns = (schema: unknown) => ({
  operationId: 'Op',
  responses: { '200': { content: { 'application/json': { schema } } } },
});
const ref = (schema: string) => ({ $ref: `#/components/schemas/${schema}` });
const contract = {
  paths: {
    '/v1/customers': { get: returns({ type: 'object' }), post: returns(ref('customer')) },
    '/v1/customers/{customer}': {
      get: returns({ anyOf: [ref('customer'), ref('deleted_customer')] }),
      post: returns(ref('customer')),
      delete: returns(ref('deleted_customer')),
    },
    '/v1/customers/{customer}/sources/{id}': { get: returns(ref('bank_account')) },
    '/v1/subscriptions/{subscription_exposed_id}': {
      delete: returns(ref('subscription')),
    },
    '/v1/payment_intents/{intent}/cancel': { post: returns(ref('payment_intent')) },
    '/v1/checkout/sessions': { post: returns(ref('checkout.session')) },
    '/v1/balance': { get: returns(ref('balance')) },
  },
};

it('names stripe-node methods from Stripe URL shapes and the objects they return', () => {
  expect(
    stripeContractOperations(contract).map(
      (operation) => `${operation.resource}.${operation.method}→${operation.schema}`,
    ),
  ).toEqual([
    'customers.create→customer',
    'customers.retrieve→customer',
    'customers.update→customer',
    'customers.del→deleted_customer',
    'subscriptions.del→subscription',
    'subscriptions.cancel→subscription',
    'paymentIntents.cancel→payment_intent',
    'checkout.sessions.create→checkout.session',
    'balance.retrieve→balance',
  ]);
});

it('extends the built-in adapter with only the methods an application calls', () => {
  const adapter = stripeAdapterFor(
    STRIPE,
    contract,
    new Set(['customers.retrieve', 'subscriptions.cancel', 'paymentIntents.cancel']),
  );
  expect(adapter.id).toBe('stripe');
  const added = adapter.operations.slice(STRIPE.operations.length);
  expect(added.map((operation) => `${operation.resource}.${operation.method}`)).toEqual([
    'customers.retrieve',
    'subscriptions.cancel',
  ]);
});
