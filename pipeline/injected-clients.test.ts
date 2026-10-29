import { expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import { STRIPE } from './providers.ts';
import { measureCoverage } from './sdk-coverage.ts';
import { specifierPackage } from './sdk-constructors.ts';
import type { Repository } from './types.ts';

const change = {
  id: 'charges',
  schema: 'payment_intent',
  property: 'charges',
  pointer: '/charges',
};
const options = `{ apiVersion: '2022-08-01' }`;
const peer = {
  file: 'package.json',
  section: 'peerDependencies',
  version: '>=14',
  lock: { status: 'unknown' as const, file: null, packagePath: null, version: null, reason: '' },
};
function scan(files: Record<string, string>, dependencies: Repository['dependencies'] = []) {
  const repository: Repository = {
    root: '/injected-fixture',
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
    dependencies,
    lockfiles: [],
    warnings: [],
  };
  const sites = measureCoverage(repository, 'stripe').filter((site) => site.likelySdk);
  const { findings } = analyzeRepository(repository, [change], STRIPE);
  return {
    // Traced call sites in files outside tests, by file.
    traced: sites
      .filter((site) => site.traced && !site.file.includes('.test.'))
      .map((site) => site.file),
    untraced: sites
      .filter((site) => !site.traced && !site.file.includes('.test.'))
      .map((site) => site.file),
    findings: findings.map((finding) => ({ file: finding.file, confidence: finding.confidence })),
  };
}
const read = (client: string) =>
  `const intent = await ${client}.paymentIntents.retrieve('pi'); return intent.charges.data;`;
const factory = `import Stripe from 'stripe';
let client: Stripe | null = null;
export function getStripe(): Stripe { client ??= new Stripe('key', ${options}); return client; }`;

it('names the package a Deno or CDN specifier imports', () => {
  expect(specifierPackage('npm:stripe@14.21.0')).toBe('stripe');
  expect(specifierPackage('https://esm.sh/stripe@14.21.0?target=deno')).toBe('stripe');
  expect(specifierPackage('https://esm.sh/v135/stripe@14.21.0/denonext/stripe.mjs')).toBe('stripe');
  expect(specifierPackage('https://cdn.jsdelivr.net/npm/stripe@14/+esm')).toBe('stripe');
  expect(specifierPackage('https://cdn.skypack.dev/stripe@14')).toBe('stripe');
  expect(specifierPackage('https://esm.sh/stripe-mock@1')).toBe('stripe-mock');
  expect(specifierPackage('https://example.com/stripe@14')).toBe('https://example.com/stripe@14');
  expect(specifierPackage('stripe')).toBe('stripe');
});

it.each([
  ['an esm.sh URL', 'https://esm.sh/stripe@14.21.0?target=deno'],
  ['an npm: specifier', 'npm:stripe@14.21.0'],
])('traces a client imported from %s and keeps its findings for review', (_name, specifier) => {
  const result = scan({
    'functions/refund.ts': `import Stripe from '${specifier}';
const stripe = new Stripe(Deno.env.get('KEY')!, ${options});
export async function history() { ${read('stripe')} }`,
  });
  expect(result.traced).toEqual(['functions/refund.ts']);
  expect(result.findings).toEqual([{ file: 'functions/refund.ts', confidence: 'review' }]);
});

it('does not take another package on a CDN for the SDK', () => {
  const result = scan({
    'functions/refund.ts': `import Stripe from 'https://esm.sh/stripe-mock@1';
const stripe = new Stripe('key');
export async function history() { ${read('stripe')} }`,
  });
  expect(result.traced).toEqual([]);
});

it('traces calls through an object of getters that forward to one client', () => {
  const result = scan({
    'client.ts': `${factory}
export const stripe = {
  get paymentIntents() { return getStripe().paymentIntents; },
  get customers() { return getStripe().customers; },
};`,
    'billing.ts': `import { stripe } from './client.ts';
export async function history() { ${read('stripe')} }`,
  });
  expect(result.traced).toEqual(['billing.ts']);
  expect(result.findings).toEqual([{ file: 'billing.ts', confidence: 'confirmed' }]);
});

it.each([
  [
    'a getter that returns another property',
    'get paymentIntents() { return getStripe().customers; }',
  ],
  [
    'a getter that does more than return',
    'get paymentIntents() { audit(); return getStripe().paymentIntents; }',
  ],
  [
    'a setter beside the getter',
    'get paymentIntents() { return getStripe().paymentIntents; }, set paymentIntents(value) {}',
  ],
  [
    'a method beside the getter',
    'get paymentIntents() { return getStripe().paymentIntents; }, reset() {}',
  ],
  [
    'getters over two clients',
    'get paymentIntents() { return getStripe().paymentIntents; }, get customers() { return other.customers; }',
  ],
])('leaves an object with %s untraced', (_name, members) => {
  const result = scan({
    'client.ts': `${factory}
declare const other: Stripe;
declare function audit(): void;
export const stripe = { ${members} };`,
    'billing.ts': `import { stripe } from './client.ts';
export async function history() { ${read('stripe')} }`,
  });
  expect(result.traced).toEqual([]);
});

it('traces a client a constructor parameter falls back to, for review, when no production code passes one', () => {
  const result = scan({
    'billing.ts': `import Stripe from 'stripe';
export class Billing {
  private readonly stripe: Stripe;
  constructor(stripe?: Stripe) { this.stripe = stripe ?? new Stripe('key', ${options}); }
  async history() { ${read('this.stripe')} }
}`,
    'index.ts': `import { Billing } from './billing.ts';
export const billing = new Billing();`,
    'billing.test.ts': `import { Billing } from './billing.ts';
const fake = { paymentIntents: { retrieve: async () => ({ charges: { data: [] } }) } };
new Billing(fake as never);`,
  });
  expect(result.traced).toEqual(['billing.ts']);
  expect(result.findings).toEqual([{ file: 'billing.ts', confidence: 'review' }]);
});

it.each([
  ['production code passes something else', `export const billing = new Billing(other);`],
  ['the class is passed as a value', `export const make = register(Billing);`],
  ['the class is subclassed', `export class Admin extends Billing {}`],
])('leaves a constructor fallback untraced when %s', (_name, use) => {
  const result = scan({
    'billing.ts': `import Stripe from 'stripe';
export class Billing {
  private readonly stripe: Stripe;
  constructor(stripe?: Stripe) { this.stripe = stripe ?? new Stripe('key', ${options}); }
  async history() { ${read('this.stripe')} }
}`,
    'index.ts': `import { Billing } from './billing.ts';
declare const other: any;
declare function register(value: unknown): unknown;
${use}`,
  });
  expect(result.traced).toEqual([]);
});

it('traces a factory whose constructor is a parameter every production call leaves to the SDK', () => {
  const result = scan({
    'client.js': `import Stripe from 'stripe';
export function makeStripe(key, Constructor = Stripe) { return new Constructor(key, ${options}); }`,
    'billing.js': `import { makeStripe } from './client.js';
const stripe = makeStripe(process.env.KEY);
export async function history() { ${read('stripe')} }`,
    'client.test.js': `import { makeStripe } from './client.js';
makeStripe('key', class Fake {});`,
  });
  expect(result.traced).toEqual(['billing.js']);
  expect(result.findings).toEqual([{ file: 'billing.js', confidence: 'review' }]);
});

it('leaves a constructor parameter untraced when production code passes another constructor', () => {
  const result = scan({
    'client.js': `import Stripe from 'stripe';
export function makeStripe(key, Constructor = Stripe) { return new Constructor(key); }`,
    'billing.js': `import { makeStripe } from './client.js';
class Other {}
const stripe = makeStripe(process.env.KEY, Other);
export async function history() { ${read('stripe')} }`,
  });
  expect(result.traced).toEqual([]);
});

it.each([
  ['a property', `refund({ stripe: getStripe(), id: 'pi' })`],
  ['a shorthand property', `const stripe = getStripe();\nrefund({ stripe, id: 'pi' })`],
  ['the property default', `refund({ id: 'pi' })`],
])('traces a destructured client passed as %s, for review', (_name, call) => {
  const result = scan({
    'client.ts': factory,
    'refund.ts': `import Stripe from 'stripe';
import { getStripe } from './client.ts';
export async function refund({ stripe = getStripe(), id }: { stripe?: Stripe; id: string }) {
  ${read('stripe')}
}`,
    'route.ts': `import { getStripe } from './client.ts';
import { refund } from './refund.ts';
export async function handle() { ${call}; }`,
    'refund.test.ts': `import { refund } from './refund.ts';
refund({ stripe: { paymentIntents: {} } as never, id: 'pi' });`,
  });
  expect(result.traced).toEqual(['refund.ts']);
  expect(result.findings).toEqual([{ file: 'refund.ts', confidence: 'review' }]);
});

it.each([
  ['a spread after the client', `const rest = {};\nrefund({ stripe: getStripe(), ...rest })`],
  [
    'an argument that is not an object literal',
    `const input = { stripe: getStripe() };\nrefund(input)`,
  ],
  ['another value in production', `refund({ stripe: {} as never })`],
  ['a callback', `[1].forEach(refund as never)`],
  ['.call', `refund.call(undefined, { stripe: getStripe() })`],
])('leaves a destructured client untraced with %s', (_name, call) => {
  const result = scan({
    'client.ts': factory,
    'refund.ts': `export async function refund({ stripe }: { stripe: any }) { ${read('stripe')} }`,
    'route.ts': `import { getStripe } from './client.ts';
import { refund } from './refund.ts';
export async function handle() { ${call}; }`,
  });
  expect(result.traced).toEqual([]);
});

it('traces a defaulted positional client and a const that falls back to a factory', () => {
  const result = scan({
    'client.ts': factory,
    'events.ts': `import Stripe from 'stripe';
import { getStripe } from './client.ts';
export async function history(stripe: Stripe = getStripe()) { ${read('stripe')} }
export async function health({ client }: { client?: Stripe } = {}) {
  const stripe = client || getStripe();
  ${read('stripe')}
}`,
    'route.ts': `import { history, health } from './events.ts';
export async function handle() { await history(); await health(); await health({}); }`,
  });
  expect(result.traced).toEqual(['events.ts', 'events.ts']);
  expect(result.findings.map((finding) => finding.confidence)).toEqual(['review', 'review']);
});

it('traces a factory passed as a default that every call leaves in place', () => {
  const result = scan({
    'client.ts': factory,
    'checkout.ts': `import { getStripe } from './client.ts';
export async function checkout({ make = getStripe }: { make?: typeof getStripe }) {
  const stripe = make();
  ${read('stripe')}
}`,
    'route.ts': `import { checkout } from './checkout.ts';
export async function handle() { await checkout({}); }`,
    'checkout.test.ts': `import { checkout } from './checkout.ts';
checkout({ make: () => ({}) as never });`,
  });
  expect(result.traced).toEqual(['checkout.ts']);
});

it('leaves parameters untraced where only tests call the function', () => {
  const result = scan({
    'client.ts': factory,
    'refund.ts': `import Stripe from 'stripe';
import { getStripe } from './client.ts';
export async function refund(stripe: Stripe = getStripe()) { ${read('stripe')} }`,
    'refund.test.ts': `import { refund } from './refund.ts';
refund();`,
  });
  expect(result.traced).toEqual([]);
});

it.each([
  ['a default export', 'export default async function handler(stripe = getStripe()) {'],
  ['a route handler', 'export async function POST(stripe = getStripe()) {'],
])('leaves the parameters of %s untraced: the framework calls it', (_name, head) => {
  const result = scan({
    'client.ts': factory,
    'route.ts': `import { getStripe } from './client.ts';
${head} ${read('stripe')} }`,
    'other.ts': `import handler, * as route from './route.ts';
export async function run() { await (handler as any)(); await (route as any).POST?.(); }`,
  });
  expect(result.traced).toEqual([]);
});

it("leaves a library's exported functions untraced: other applications call them", () => {
  const files = {
    'src/client.ts': factory,
    'src/events.ts': `import Stripe from 'stripe';
import { getStripe } from './client.ts';
export async function history(stripe: Stripe = getStripe()) { ${read('stripe')} }`,
    'src/index.ts': `import { history } from './events.ts';
export async function sync() { await history(); }`,
  };
  expect(scan(files, [peer]).traced).toEqual([]);
  expect(scan(files).traced).toEqual(['src/events.ts']);
});
