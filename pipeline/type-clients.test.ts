import { expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import { STRIPE } from './providers.ts';
import { measureCoverage } from './sdk-coverage.ts';
import { typedStripeClients } from './type-clients.ts';
import type { Repository } from './types.ts';

function repository(files: Record<string, string>): Repository {
  return {
    root: '/type-clients-fixture',
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
}
function traced(files: Record<string, string>) {
  const source = repository(files);
  const { clients } = typedStripeClients(source);
  return analyzeRepository(source, [], STRIPE, {}, [], [], [], [], {
    typedClients: clients,
  }).sdkCalls.map((call) => `${call.file} ${call.resource}.${call.method} ${call.traceSource}`);
}

const STRIPE_MODULE = `import Stripe from 'stripe';\n`;

it.each([
  [
    'lazy factory behind a module object',
    {
      'lib/stripe.ts': `${STRIPE_MODULE}let instance: Stripe | undefined;
export const payments = { client() { if (!instance) instance = new Stripe(process.env.KEY!); return instance; } };`,
      'app/route.ts': `import { payments } from '../lib/stripe';
export async function GET() { return payments.client().customers.create({ email: 'a@b.c' }); }`,
    },
    'app/route.ts customers.create type',
  ],
  [
    'NestJS injection',
    {
      'src/billing.service.ts': `${STRIPE_MODULE}function Inject(token: string): ParameterDecorator { return () => undefined; }
export class BillingService {
  constructor(@Inject('STRIPE') private readonly stripe: Stripe) {}
  checkout() { return this.stripe.checkout.sessions.create({ mode: 'payment' }); }
}`,
    },
    'src/billing.service.ts checkout.sessions.create type',
  ],
  [
    'context field',
    {
      'src/context.ts': `${STRIPE_MODULE}export interface Context { stripe: Stripe; userId: string }`,
      'src/router.ts': `import type { Context } from './context';
export const list = (ctx: Context) => ctx.stripe.invoices.list({ customer: ctx.userId });`,
    },
    'src/router.ts invoices.list type',
  ],
  [
    'class field set in a method',
    {
      'src/payments.ts': `${STRIPE_MODULE}export class Payments {
  private client?: Stripe;
  init(key: string) { this.client = new Stripe(key); }
  refund(id: string) { return this.client!.refunds.create({ payment_intent: id }); }
}`,
    },
    'src/payments.ts refunds.create type',
  ],
  [
    're-export through an index module',
    {
      'src/stripe/client.ts': `${STRIPE_MODULE}export function makeClient() { return new Stripe(process.env.KEY!); }`,
      'src/stripe/index.ts': `export * from './client';`,
      'src/use.ts': `import * as billing from './stripe';
export const price = () => billing.makeClient().prices.retrieve('price_1');`,
    },
    'src/use.ts prices.retrieve type',
  ],
  [
    'Proxy over a real client',
    {
      'src/stripe.ts': `${STRIPE_MODULE}function real() { return new Stripe(process.env.KEY!); }
export const stripe = new Proxy(real(), { get: (target, key) => Reflect.get(target, key) });
export const sub = (id: string) => stripe.subscriptions.retrieve(id);`,
    },
    'src/stripe.ts subscriptions.retrieve type',
  ],
])('traces a call through a %s by type', (_name, files, expected) => {
  const [file, call] = expected.split(' ');
  // The analyzer's own tracers already follow some of these; the type finds every one.
  expect(traced(files)).toContainEqual(expect.stringMatching(`^${file} ${call} (type|analyzer)$`));
  expect(typedStripeClients(repository(files)).clients).toContainEqual(
    expect.objectContaining({ file, source: 'type' }),
  );
});

it.each([
  ['an as-cast', `const stripe = (globalThis as any).stripe as Stripe;`],
  ['an angle-bracket cast', `const stripe = <Stripe>(<unknown>globalThis.stripeClient);`],
  [
    'an any value under a declared type',
    `declare const anything: any;\nconst stripe: Stripe = anything;`,
  ],
  ['a cast inside a factory', `function make() { return {} as Stripe; }\nconst stripe = make();`],
  ['a Proxy over a cast target', `const stripe = new Proxy({} as Stripe, {});`],
  [
    'a cast written to a lazy holder',
    `let stripe: Stripe | null = null;\nstripe = JSON.parse('{}') as Stripe;`,
  ],
])('leaves a client typed by %s untraced', (_name, client) => {
  const calls = traced({
    'src/use.ts': `${STRIPE_MODULE}declare global { var stripeClient: unknown }\n${client}
export const charge = () => stripe!.paymentIntents.create({ amount: 1, currency: 'usd' });`,
  });
  expect(calls).toEqual([]);
});

it('leaves a JavaScript factory traced by its return at lower confidence', () => {
  const files = {
    'lib/stripe.js': `const Stripe = require('stripe');
let client;
function getStripe() { if (!client) client = Stripe(process.env.KEY); return client; }
module.exports = getStripe;`,
    'routes/pay.js': `const getStripe = require('../lib/stripe');
exports.pay = () => getStripe().paymentIntents.create({ amount: 1, currency: 'usd' });`,
  };
  expect(traced(files)).toEqual(['routes/pay.js paymentIntents.create js-return']);
  // Its findings stay for review, like an optional call's.
  const removal = {
    id: 'amount',
    schema: 'payment_intent',
    property: 'amount',
    pointer: '/amount',
  };
  const source = repository({
    ...files,
    'routes/read.js': `const getStripe = require('../lib/stripe');
exports.amount = async () => (await getStripe().paymentIntents.retrieve('pi')).amount;`,
  });
  const findings = analyzeRepository(source, [removal], STRIPE, {}, [], [], [], [], {
    typedClients: typedStripeClients(source).clients,
  }).findings.filter((finding) => finding.changeId === 'amount');
  expect(findings.length).toBeGreaterThan(0);
  expect(findings.every((finding) => !finding.untraced && finding.confidence === 'review')).toBe(
    true,
  );
});

it('keeps the analyzer as the source of calls it already traces', () => {
  expect(
    traced({
      'src/direct.ts': `${STRIPE_MODULE}const stripe = new Stripe('key');
export const customer = () => stripe.customers.retrieve('cus_1');`,
    }),
  ).toEqual(['src/direct.ts customers.retrieve analyzer']);
});

it('reports a repository too large to type-check', () => {
  const files = Object.fromEntries(
    Array.from({ length: 2_001 }, (_, index) => [`src/f${index}.ts`, 'export {};']),
  );
  expect(typedStripeClients(repository(files)).skipped).toBe('too-large');
});

it('splits coverage by trace source', () => {
  const sites = measureCoverage(
    repository({
      'src/context.ts': `${STRIPE_MODULE}export interface Context { stripe: Stripe }`,
      'src/router.ts': `import type { Context } from './context';
export const list = (ctx: Context) => ctx.stripe.invoices.list();`,
    }),
    'stripe',
    { typeTracing: true },
  );
  expect(sites.filter((site) => site.traced).map((site) => site.traceSource)).toEqual(['type']);
});

it('trusts a typed call only where every Stripe construction is safe', () => {
  const removal = {
    id: 'charges',
    schema: 'payment_intent',
    property: 'charges',
    pointer: '/charges',
  };
  const confidence = (construction: string) => {
    const source = repository({
      'src/context.ts': `${STRIPE_MODULE}export interface Context { stripe: Stripe }
declare const args: [string, Stripe.StripeConfig];
export const client = ${construction};`,
      'src/read.ts': `import type { Context } from './context';
export async function history(ctx: Context) {
  const intent = await ctx.stripe.paymentIntents.retrieve('pi');
  return intent.charges.data;
}`,
    });
    return analyzeRepository(source, [removal], STRIPE, {}, [], [], [], [], {
      typedClients: typedStripeClients(source).clients,
    })
      .findings.filter((finding) => finding.changeId === 'charges')
      .map((finding) => finding.confidence);
  };
  expect(confidence(`new Stripe('key')`)).toEqual(['confirmed']);
  expect(confidence(`new Stripe(...args)`)).toEqual(['review']);
});
