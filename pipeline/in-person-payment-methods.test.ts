import { expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import type { ProviderAdapter } from './providers.ts';
import { removedRequestParameters } from './request-removals.ts';
import type { Repository } from './types.ts';

const OPERATIONS = [
  ['checkout.sessions', '/v1/checkout/sessions', 'PostCheckoutSessions'],
  ['paymentIntents', '/v1/payment_intents', 'PostPaymentIntents'],
  ['setupIntents', '/v1/setup_intents', 'PostSetupIntents'],
] as const;

const provider: ProviderAdapter = {
  id: 'stripe-in-person',
  packageName: 'stripe',
  defaultImport: true,
  namedExport: null,
  operations: OPERATIONS.map(([resource, , operationId]) => ({
    resource,
    method: 'create',
    schema: 'object',
    operationId,
  })),
};

// Like endive: the intents' allowed_payment_method_types enum has the in-person methods, Checkout's
// does not (`inPersonOn` lists the operations whose enum has them).
function contract(parameter: string, inPersonOn: string[]) {
  return {
    openapi: '3.0.0',
    paths: Object.fromEntries(
      OPERATIONS.map(([, path, operationId]) => [
        path,
        {
          post: {
            operationId,
            requestBody: {
              content: {
                'application/x-www-form-urlencoded': {
                  schema: {
                    type: 'object',
                    properties: {
                      amount: {},
                      [parameter]: {
                        type: 'array',
                        items: {
                          type: 'string',
                          enum: [
                            'card',
                            ...(inPersonOn.includes(operationId)
                              ? ['card_present', 'interac_present']
                              : []),
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      ]),
    ),
  };
}

const before = contract('payment_method_types', []);
const endive = contract('allowed_payment_method_types', ['PostPaymentIntents', 'PostSetupIntents']);

function analyze(source: string, after = endive) {
  const repository: Repository = {
    root: '/refit-in-person',
    files: [
      {
        path: 'terminal.ts',
        content: `import Stripe from 'stripe';\nconst stripe = new Stripe('test');\n${source}`,
      },
    ],
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
  const result = analyzeRepository(
    repository,
    [],
    provider,
    {},
    [],
    [],
    [],
    removedRequestParameters(provider, before, after),
  );
  return {
    findings: result.findings.length,
    edits: result.edits.map(({ start, rule }) => [
      repository.files[0].content.slice(0, start).split('\n').length,
      rule,
    ]),
  };
}

it('reads the in-person methods each replacement accepts from the target contract', () => {
  expect(
    removedRequestParameters(provider, before, endive).map(({ operationId, inPerson }) => [
      operationId,
      inPerson,
    ]),
  ).toEqual([
    ['PostCheckoutSessions', undefined],
    ['PostPaymentIntents', ['card_present', 'interac_present']],
    ['PostSetupIntents', ['card_present', 'interac_present']],
  ]);
});

it('moves in-person methods on PaymentIntents and SetupIntents, never on Checkout', () => {
  expect(
    analyze(`export async function charge() {
  await stripe.paymentIntents.create({ amount: 1, payment_method_types: ['card_present'] });
  await stripe.setupIntents.create({ payment_method_types: ['card', 'interac_present'] });
  await stripe.checkout.sessions.create({ payment_method_types: ['card_present'] });
}`),
  ).toEqual({
    findings: 3,
    edits: [
      [4, 'stripe-moved-allowed-payment-method-types'],
      [5, 'stripe-moved-allowed-payment-method-types'],
    ],
  });
});

it('moves an in-person method named through a const only where the call accepts it', () => {
  expect(
    analyze(`const READER = ['card_present'];
export async function charge() {
  await stripe.paymentIntents.create({ amount: 1, payment_method_types: READER });
  await stripe.checkout.sessions.create({ payment_method_types: READER });
}`),
  ).toEqual({ findings: 2, edits: [[5, 'stripe-moved-allowed-payment-method-types']] });
});

it('keeps stopping on an in-person method the target contract does not list', () => {
  expect(
    analyze(
      `export async function charge() {
  await stripe.paymentIntents.create({ amount: 1, payment_method_types: ['card_present'] });
}`,
      contract('allowed_payment_method_types', []),
    ),
  ).toEqual({ findings: 1, edits: [] });
});
