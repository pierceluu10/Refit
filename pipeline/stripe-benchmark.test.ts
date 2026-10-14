import { expect, it } from 'vitest';
import { stripeOperations } from './stripe-benchmark.ts';

const ref = (schema: string) => ({ $ref: `#/components/schemas/${schema}` });
const returns = (schema: unknown) => ({
  operationId: 'Op',
  responses: { '200': { content: { 'application/json': { schema } } } },
});

it('maps stripe-node methods to the objects they return in the application contract', () => {
  const sdk = {
    components: {
      schemas: {
        customer: {
          'x-stripeOperations': [
            {
              method_name: 'retrieve',
              method_on: 'service',
              operation: 'get',
              path: '/v1/customers/{customer}',
            },
            {
              method_name: 'delete',
              method_on: 'service',
              operation: 'delete',
              path: '/v1/customers/{customer}',
            },
            { method_name: 'list', method_on: 'service', operation: 'get', path: '/v1/customers' },
          ],
        },
        cash_balance: {
          'x-stripeOperations': [
            {
              method_name: 'retrieve',
              method_on: 'service',
              operation: 'get',
              path: '/v1/customers/{customer}/cash_balance',
            },
          ],
        },
        payment_intent: {
          'x-stripeOperations': [
            {
              method_name: 'cancel',
              method_on: 'service',
              operation: 'post',
              path: '/v1/payment_intents/{intent}/cancel',
            },
          ],
        },
        'checkout.session': {
          'x-stripeOperations': [
            {
              method_name: 'create',
              method_on: 'service',
              operation: 'post',
              path: '/v1/checkout/sessions',
            },
          ],
        },
      },
    },
  };
  const before = {
    paths: {
      '/v1/customers/{customer}': {
        get: returns({ anyOf: [ref('customer'), ref('deleted_customer')] }),
        delete: returns(ref('customer')),
      },
      '/v1/customers': { get: returns({ type: 'object' }) },
      '/v1/customers/{customer}/cash_balance': { get: returns(ref('cash_balance')) },
      '/v1/payment_intents/{intent}/cancel': { post: returns(ref('payment_intent')) },
      '/v1/checkout/sessions': { post: returns(ref('checkout.session')) },
    },
  };
  expect(stripeOperations(sdk, before)).toEqual([
    { resource: 'customers', method: 'retrieve', schema: 'customer', operationId: 'Op' },
    { resource: 'customers', method: 'del', schema: 'customer', operationId: 'Op' },
    { resource: 'paymentIntents', method: 'cancel', schema: 'payment_intent', operationId: 'Op' },
    {
      resource: 'checkout.sessions',
      method: 'create',
      schema: 'checkout.session',
      operationId: 'Op',
    },
  ]);
});
