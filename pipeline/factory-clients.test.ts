import { expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import { STRIPE } from './providers.ts';
import type { Repository } from './types.ts';

const ORIGINAL = '2022-08-01';
const change = {
  id: 'charges',
  schema: 'payment_intent',
  property: 'charges',
  pointer: '/charges',
};
const options = `{ apiVersion: '${ORIGINAL}' }`;
function analyze(files: Record<string, string>) {
  const repository: Repository = {
    root: '/factory-fixture',
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
  return analyzeRepository(repository, [change], STRIPE);
}
const read = (client: string) =>
  `export async function history() { const intent = await ${client}.paymentIntents.retrieve('pi'); return intent.charges.data; }`;

it.each([
  [
    'lazy holder with ??=',
    `let client: Stripe | null = null;
export function getStripe(): Stripe { client ??= new Stripe('key', ${options}); return client; }`,
  ],
  [
    'lazy holder with a guard and a throw',
    `let client = null;
export function getStripe() {
  if (client) return client;
  if (!process.env.KEY) throw new Error('missing');
  client = new Stripe(process.env.KEY, ${options});
  return client;
}`,
  ],
  [
    'lazy holder that may return null',
    `let client: Stripe | null = null;
export function getStripe() {
  if (!process.env.KEY) return null;
  if (!client) { client = new Stripe(process.env.KEY, ${options}); }
  return client;
}`,
  ],
  ['arrow factory', `export const getStripe = (key: string) => new Stripe(key, ${options});`],
  ['plain factory', `export function getStripe() { return new Stripe('key', ${options}); }`],
  [
    'inline lazy return',
    `let client: Stripe | undefined;
export function getStripe() { return client ?? (client = new Stripe('key', ${options})); }`,
  ],
])('traces a %s across modules with its literal version', (_name, factory) => {
  const result = analyze({
    'client.ts': `import Stripe from 'stripe';\n${factory}`,
    'billing.ts': `import { getStripe } from './client.ts';\nconst stripe = getStripe();\n${read('stripe!')}`,
    'inline.ts': `import { getStripe } from './client.ts';\n${read("getStripe('key')!")}`,
  });
  expect(result.findings).toMatchObject([
    { file: 'billing.ts', confidence: 'confirmed' },
    { file: 'inline.ts', confidence: 'confirmed' },
  ]);
  expect(result.apiVersionDeclarations.filter((entry) => entry.kind === 'constructor')).toEqual([
    expect.objectContaining({ status: 'literal', value: ORIGINAL }),
  ]);
});

it('traces a conditional client constant and its version', () => {
  const result = analyze({
    'billing.ts': `import Stripe from 'stripe';
const stripe = process.env.KEY ? new Stripe(process.env.KEY, ${options}) : null;
${read('stripe!')}`,
  });
  expect(result.findings).toMatchObject([{ confidence: 'confirmed' }]);
  expect(result.apiVersionDeclarations.find((entry) => entry.kind === 'constructor')).toMatchObject(
    { status: 'literal', value: ORIGINAL },
  );
});

it.each([
  ['a holder also assigned a non-client', `client = {} as Stripe;`],
  ['a holder written by destructuring', `[client] = [{} as Stripe];`],
  ['a reassigned factory', `getStripe = () => new Stripe('other');`],
])('does not trace a factory with %s', (_name, write) => {
  const result = analyze({
    'billing.ts': `import Stripe from 'stripe';
let client: Stripe | null = null;
function getStripe() { client ??= new Stripe('key', ${options}); return client; }
export function reset() { ${write} }
${read('getStripe()')}`,
  });
  expect(result.findings.filter((entry) => entry.confidence === 'confirmed')).toEqual([]);
});

it('does not trace a factory that returns anything other than a client or null', () => {
  const result = analyze({
    'billing.ts': `import Stripe from 'stripe';
export function getStripe(fake: boolean) { return fake ? ({} as Stripe) : new Stripe('key', ${options}); }
${read('getStripe(false)')}`,
  });
  expect(result.findings.filter((entry) => entry.confidence === 'confirmed')).toEqual([]);
});

it.each([
  [
    'an awaited async factory',
    `export async function getStripe() { return new Stripe('key', ${options}); }`,
  ],
  [
    'an async lazy holder that awaits its key',
    `let client: Stripe | undefined;
async function secret() { return 'key'; }
export async function getStripe() {
  if (!client) { const key = await secret(); client = new Stripe(key, ${options}); }
  return client;
}`,
  ],
  ['an async arrow factory', `export const getStripe = async () => new Stripe('key', ${options});`],
])('traces %s with its literal version', (_name, factory) => {
  const result = analyze({
    'client.ts': `import Stripe from 'stripe';\n${factory}`,
    'billing.ts': `import { getStripe } from './client.ts';
export async function history() { const stripe = await getStripe(); const intent = await stripe.paymentIntents.retrieve('pi'); return intent.charges.data; }`,
    'inline.ts': `import { getStripe } from './client.ts';\n${read('(await getStripe())')}`,
  });
  expect(result.findings).toMatchObject([
    { file: 'billing.ts', confidence: 'confirmed' },
    { file: 'inline.ts', confidence: 'confirmed' },
  ]);
  expect(result.apiVersionDeclarations.filter((entry) => entry.kind === 'constructor')).toEqual([
    expect.objectContaining({ status: 'literal', value: ORIGINAL }),
  ]);
});

it.each([
  ['its promise is stored', `const pending = getStripe(); export { pending };`],
  [
    'its promise is passed on',
    `export function later(use: (p: unknown) => void) { use(getStripe()); }`,
  ],
  ['it is called optionally', `export async function maybe() { return await getStripe?.(); }`],
])('does not trace an async factory when %s', (_name, extra) => {
  const result = analyze({
    'billing.ts': `import Stripe from 'stripe';
export async function getStripe() { return new Stripe('key', ${options}); }
${extra}
export async function history() { const intent = await (await getStripe()).paymentIntents.retrieve('pi'); return intent.charges.data; }`,
  });
  expect(result.findings.filter((entry) => entry.confidence === 'confirmed')).toEqual([]);
});

it('does not treat an unawaited async factory call as the client', () => {
  const result = analyze({
    'billing.ts': `import Stripe from 'stripe';
export async function getStripe() { return new Stripe('key', ${options}); }
export async function history() { const stripe: any = getStripe(); const intent = await stripe.paymentIntents.retrieve('pi'); return intent.charges.data; }`,
  });
  expect(result.findings.filter((entry) => entry.confidence === 'confirmed')).toEqual([]);
});

it.each([
  ['a destructured default', `const { default: Sdk } = await import('stripe');`],
  ['a default property', `const Sdk = (await import('stripe')).default;`],
  ['the named export', `const { Stripe: Sdk } = await import('stripe');`],
])('traces an async factory that loads the SDK with %s', (_name, load) => {
  const result = analyze({
    'client.ts': `import type Stripe from 'stripe';
let client: Stripe | null = null;
export async function getStripe() {
  if (!client) {
    ${load}
    client = new Sdk('key', ${options});
  }
  return client;
}`,
    'billing.ts': `import { getStripe } from './client.ts';\nconst stripe = await getStripe();\n${read('stripe')}`,
  });
  expect(result.findings).toMatchObject([{ file: 'billing.ts', confidence: 'confirmed' }]);
  expect(result.apiVersionDeclarations.filter((entry) => entry.kind === 'constructor')).toEqual([
    expect.objectContaining({ status: 'literal', value: ORIGINAL }),
  ]);
});

it('does not treat the dynamically imported module namespace as the constructor', () => {
  const result = analyze({
    'billing.ts': `export async function history() {
  const Sdk = await import('stripe');
  const stripe = new (Sdk as any)('key');
  const intent = await stripe.paymentIntents.retrieve('pi');
  return intent.charges.data;
}`,
  });
  expect(result.findings.filter((entry) => entry.confidence === 'confirmed')).toEqual([]);
});

it.each([
  [
    'the class name',
    `export class Payments {
  private static client: Stripe | null = null;
  static get(): Stripe {
    if (!Payments.client) Payments.client = new Stripe('key', ${options});
    return Payments.client;
  }
}`,
  ],
  [
    'this',
    `export class Payments {
  static #unused = 0;
  private static client?: Stripe;
  static get() {
    this.client ??= new Stripe('key', ${options});
    return this.client;
  }
}`,
  ],
])('traces a static getter whose holder is written through %s', (_name, factory) => {
  const result = analyze({
    'client.ts': `import Stripe from 'stripe';\n${factory}`,
    'billing.ts': `import { Payments } from './client.ts';\n${read('Payments.get()')}`,
  });
  expect(result.findings).toMatchObject([{ file: 'billing.ts', confidence: 'confirmed' }]);
  expect(result.apiVersionDeclarations.filter((entry) => entry.kind === 'constructor')).toEqual([
    expect.objectContaining({ status: 'literal', value: ORIGINAL }),
  ]);
});

it.each([
  ['its holder is assigned another value', 'Payments.client = {} as Stripe;'],
  ['the method is replaced', 'Payments.get = () => ({}) as Stripe;'],
])('does not trace a static getter when %s', (_name, write) => {
  const result = analyze({
    'client.ts': `import Stripe from 'stripe';
export class Payments {
  static client: Stripe | null = null;
  static get(): Stripe {
    if (!Payments.client) Payments.client = new Stripe('key', ${options});
    return Payments.client;
  }
}
${write}`,
    'billing.ts': `import { Payments } from './client.ts';\n${read('Payments.get()')}`,
  });
  expect(result.findings.filter((entry) => entry.confidence === 'confirmed')).toEqual([]);
});
