import { expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import { STRIPE, type ProviderAdapter } from './providers.ts';
import { removedRequestParameters } from './request-removals.ts';
import { typedStripeClients } from './type-clients.ts';
import type { Repository } from './types.ts';

const IMPORT = `import Stripe from 'stripe';\n`;

function repository(files: Record<string, string>): Repository {
  return {
    root: '/typed-request-clients',
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
}

// Checkout's endive body: payment_method_types removed, allowed_payment_method_types added.
const form = (parameter: string) => ({
  content: {
    'application/x-www-form-urlencoded': {
      schema: { type: 'object', properties: { mode: {}, [parameter]: {} } },
    },
  },
});
const contract = (parameter: string) => ({
  openapi: '3.0.0',
  paths: {
    '/v1/checkout/sessions': {
      post: { operationId: 'PostCheckoutSessions', requestBody: form(parameter) },
    },
  },
});
const provider: ProviderAdapter = {
  ...STRIPE,
  operations: [
    {
      resource: 'checkout.sessions',
      method: 'create',
      schema: 'checkout.session',
      operationId: 'PostCheckoutSessions',
    },
    { resource: 'paymentIntents', method: 'list', schema: 'payment_intent' },
    { resource: 'paymentIntents', method: 'cancel', schema: 'payment_intent' },
    { resource: 'customers', method: 'list', schema: 'customer' },
  ],
};
const removals = removedRequestParameters(
  provider,
  contract('payment_method_types'),
  contract('allowed_payment_method_types'),
);

function analyze(files: Record<string, string>, typed = true) {
  const source = repository(files);
  return analyzeRepository(source, [], provider, {}, [], [], [], removals, {
    typedClients: typed ? typedStripeClients(source).clients : [],
  });
}

const CHECKOUT = `export const pay = () =>
  stripe.checkout.sessions.create({ mode: 'payment', payment_method_types: ['card'] });\n`;

it('keeps the request for review when code writes to a stripe-node client or resource', () => {
  const findings = analyze({
    'stripe.ts': `${IMPORT}export const stripe = new Stripe('sk', { apiVersion: '2026-08-26.dahlia' });
export function forOrg() { return stripe; }
(stripe.checkout.sessions as any).create = async () => ({});
${CHECKOUT}`,
  }).findings;
  expect(findings.map((finding) => finding.confidence)).toEqual(['review']);
});

it('traces a client destructured from the object a local helper returns', () => {
  const source = repository({
    'route.ts': `${IMPORT}export async function POST(key: string) {
  const clients = async () => ({ stripe: new Stripe(key), key });
  const { stripe: client } = await clients();
  return client.checkout.sessions.create({ mode: 'payment' });
}`,
  });
  expect(typedStripeClients(source).clients).toMatchObject([{ source: 'type', sealed: true }]);
});

it('does not trace a destructured client the helper may return from a spread', () => {
  const source = repository({
    'route.ts': `${IMPORT}const extra: any = {};
export async function POST(key: string) {
  const clients = async () => ({ ...extra, stripe: new Stripe(key) });
  const { stripe } = await clients();
  return stripe.checkout.sessions.create({ mode: 'payment' });
}`,
  });
  expect(typedStripeClients(source).clients).toEqual([]);
});

it('knows an untraced client sends its own literal pin unless a version option is unreadable', () => {
  const factory = `${IMPORT}export const clients = { main: new Stripe('sk', { apiVersion: '2026-08-26.dahlia' }) };\n`;
  const pins = (files: Record<string, string>) =>
    analyze(files, false).apiVersionDeclarations.map(({ status, untracedPin }) => ({
      status,
      untracedPin,
    }));
  expect(pins({ 'make.ts': factory })).toEqual([{ status: 'unknown', untracedPin: true }]);
  expect(
    pins({
      'make.ts': factory,
      'other.ts': `${IMPORT}export const send = (s: Stripe, version: string) =>
  s.customers.list({}, { apiVersion: version });\n`,
    })[0],
  ).toEqual({ status: 'unknown', untracedPin: undefined });
});

it('reads the version of a params object that is only written under other keys', () => {
  const declarations = analyze(
    {
      'cancel.ts': `${IMPORT}const stripe = new Stripe('sk', { apiVersion: '2026-08-26.dahlia' });
export async function cancel(id: string, reason?: string) {
  const options: Stripe.PaymentIntentCancelParams = {};
  if (reason === 'duplicate') options.cancellation_reason = reason;
  return stripe.paymentIntents.cancel(id, options);
}`,
    },
    false,
  ).apiVersionDeclarations;
  expect(declarations.map(({ kind, status }) => `${kind} ${status}`)).toEqual([
    'constructor literal',
    'request inherited',
  ]);
});

it('treats a removed parameter key that is only printed as output, not a request', () => {
  const findings = analyze(
    {
      'report.ts': `${IMPORT}const stripe = new Stripe('sk', { apiVersion: '2026-08-26.dahlia' });
export async function report(send: (body: object) => void) {
  const list = await stripe.paymentIntents.list({ limit: 5 });
  console.log(JSON.stringify(list.data.map((pi) => ({ id: pi.id, payment_method_types: pi.payment_method_types }))));
  send({ payment_method_types: ['card'] });
}`,
    },
    false,
  ).findings;
  expect(findings.map((finding) => [finding.line, finding.expression])).toEqual([
    [6, 'payment_method_types outside a traced SDK request body'],
  ]);
});
