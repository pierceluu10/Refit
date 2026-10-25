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

const lazy = `let instance: Stripe | null = null;
function getStripe(): Stripe { instance ??= new Stripe('key', ${options}); return instance; }`;

it.each([
  ['a Reflect.get method trap', 'get(_target, key) { return Reflect.get(getStripe(), key); }'],
  ['an element-access arrow trap', 'get: (_target, key) => getStripe()[key as keyof Stripe]'],
  [
    'a function trap over a constant client',
    'get: function (_target, key) { return (base as any)[key]; }',
  ],
  ['a Reflect.get receiver', 'get: (_t, key, receiver) => Reflect.get(getStripe(), key, receiver)'],
])('traces a Proxy export that forwards every read through %s', (_name, trap) => {
  const result = analyze({
    'client.ts': `import Stripe from 'stripe';\n${lazy}\nconst base = new Stripe('key', ${options});\nexport const stripe = new Proxy({} as Stripe, { ${trap} });`,
    'billing.ts': `import { stripe } from './client.ts';\n${read('stripe')}`,
  });
  expect(result.findings).toMatchObject([{ file: 'billing.ts', confidence: 'confirmed' }]);
});

it.each([
  ['another trap', 'get: (_t, key) => getStripe()[key], set: () => true'],
  ['a different key', "get: (_t, key) => getStripe()['customers']"],
  [
    'a trap that binds methods',
    'get(_t, key) { const value = getStripe()[key]; return typeof value === "function" ? value.bind(getStripe()) : value; }',
  ],
  [
    "a receiver that is not the trap's",
    'get: (_t, key, receiver) => Reflect.get(getStripe(), key, other)',
  ],
  ['a trap with another statement', 'get(_t, key) { console.log(key); return getStripe()[key]; }'],
  [
    'a trap that fills another variable',
    'get(_t, key) { other ??= getStripe(); return getStripe()[key]; }',
  ],
  ['a target that is not a client', 'get: (_t, key) => ({} as any)[key]'],
])('leaves a Proxy export untraced with %s', (_name, trap) => {
  const result = analyze({
    'client.ts': `import Stripe from 'stripe';\n${lazy}\nconst other: any = {};\nexport const stripe = new Proxy({} as Stripe, { ${trap} });`,
    'billing.ts': `import { stripe } from './client.ts';\n${read('stripe')}`,
  });
  expect(result.findings.filter((entry) => entry.confidence === 'confirmed')).toEqual([]);
});

// Lazy Proxy clients from the tuned Stripe sets, as written (messages shortened, version added).
it.each([
  // TAIRED1/hackerai app/api/stripe.ts
  [
    'a local client with methods bound by a ternary',
    `let stripeClient: Stripe | null = null;
export function getStripe(): Stripe {
  if (stripeClient) return stripeClient;
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }
  stripeClient = new Stripe(secretKey, ${options});
  return stripeClient;
}
export const stripe = new Proxy({} as Stripe, {
  get(_target, prop) {
    const client = getStripe();
    const value = Reflect.get(client, prop, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});`,
  ],
  // mwakidenis/TicketHub lib/stripe.ts
  [
    'a local client with methods bound by an if',
    `let stripeInstance: Stripe | null = null
export function getStripe(): Stripe {
  if (!stripeInstance) {
    stripeInstance = new Stripe(process.env.STRIPE_SECRET_KEY!, ${options})
  }
  return stripeInstance
}
export const stripe = new Proxy({} as Stripe, {
  get(_target, prop) {
    const instance = getStripe()
    const value = instance[prop as keyof Stripe]
    if (typeof value === 'function') {
      return value.bind(instance)
    }
    return value
  },
})`,
  ],
  // DIFFERENCECODE/product_landing_page src/lib/stripe.ts
  [
    'a cast local client',
    `let _stripe: Stripe | null = null;
export function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  _stripe = new Stripe(key, ${options});
  return _stripe;
}
export const stripe = new Proxy({} as Stripe, {
  get(_t, prop) {
    const client = getStripe() as unknown as Record<string | symbol, unknown>;
    const value = client[prop as string];
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(client) : value;
  },
}) as Stripe;`,
  ],
  // trentas/saas-scaffolding lib/stripe.ts
  [
    'a module holder filled in the trap',
    `function getStripeClient() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not set');
  }
  return new Stripe(process.env.STRIPE_SECRET_KEY, ${options});
}
let _stripe: Stripe | null = null;
export const stripe = new Proxy({} as Stripe, {
  get(_, prop) {
    if (!_stripe) _stripe = getStripeClient();
    return (_stripe as unknown as Record<string | symbol, unknown>)[prop];
  },
});`,
  ],
  // openshiporg/openfront-restaurant lib/stripe.ts
  [
    'a module holder filled in a block',
    `const getStripeClient = () => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    throw new Error('Stripe secret key not configured.');
  }
  return new Stripe(stripeKey, ${options});
};
let stripeClient: Stripe | null = null;
export const stripe = new Proxy({} as Stripe, {
  get(_, prop) {
    if (!stripeClient) {
      stripeClient = getStripeClient();
    }
    return (stripeClient as any)[prop];
  }
});`,
  ],
])('traces a lazy Proxy client with %s', (_name, client) => {
  const result = analyze({
    'client.ts': `import Stripe from 'stripe';\n${client}`,
    'billing.ts': `import { stripe } from './client.ts';\n${read('stripe')}`,
  });
  expect(result.findings).toMatchObject([{ file: 'billing.ts', confidence: 'confirmed' }]);
  expect(result.apiVersionDeclarations).toMatchObject([
    { file: 'client.ts', kind: 'constructor', status: 'literal', value: ORIGINAL },
    { file: 'billing.ts', kind: 'request', status: 'inherited' },
  ]);
});

it.each([
  [
    'methods bound to another object',
    'get(_t, key) { const client = getStripe(); const value = client[key]; return typeof value === "function" ? value.bind(other) : value; }',
  ],
  [
    'a function test on another value',
    'get(_t, key) { const client = getStripe(); const value = client[key]; return typeof other === "function" ? value.bind(client) : value; }',
  ],
  [
    'a ternary that returns something else',
    'get(_t, key) { const client = getStripe(); const value = client[key]; return typeof value === "function" ? value.bind(client) : other; }',
  ],
  [
    'an if that returns something else',
    'get(_t, key) { const client = getStripe(); const value = client[key]; if (typeof value === "function") return other; return value; }',
  ],
  [
    'a read from another object than the local',
    'get(_t, key) { const client = getStripe(); return other[key]; }',
  ],
  ['a local that is not a client', 'get(_t, key) { const client = other; return client[key]; }'],
  [
    'a Reflect.get receiver that is another object',
    'get(_t, key) { const client = getStripe(); return Reflect.get(client, key, other); }',
  ],
  [
    'a statement before the local',
    'get(_t, key) { console.log(key); const client = getStripe(); return client[key]; }',
  ],
  ['a mutable local', 'get(_t, key) { let client = getStripe(); return client[key]; }'],
])('leaves a lazy Proxy untraced with %s', (_name, trap) => {
  const result = analyze({
    'client.ts': `import Stripe from 'stripe';\n${lazy}\nconst other: any = {};\nexport const stripe = new Proxy({} as Stripe, { ${trap} });`,
    'billing.ts': `import { stripe } from './client.ts';\n${read('stripe')}`,
  });
  expect(result.findings.filter((entry) => entry.confidence === 'confirmed')).toEqual([]);
});

it('leaves a Proxy over a module holder untraced when the holder can hold something else', () => {
  const result = analyze({
    'client.ts': `import Stripe from 'stripe';
let _stripe: Stripe | null = null;
export function reset() { _stripe = {} as Stripe; }
export const stripe = new Proxy({} as Stripe, {
  get(_, prop) {
    if (!_stripe) _stripe = new Stripe('key', ${options});
    return (_stripe as any)[prop];
  },
});`,
    'billing.ts': `import { stripe } from './client.ts';\n${read('stripe')}`,
  });
  expect(result.findings.filter((entry) => entry.confidence === 'confirmed')).toEqual([]);
});

it.each([
  [
    'a destructured import',
    `const { getStripe } = await import('./client.ts');\n  const stripe = getStripe();`,
  ],
  [
    'a renamed destructured import',
    `const { getStripe: load } = await import('./client.ts');\n  const stripe = load();`,
  ],
  ['a property of the import', `const stripe = (await import('./client.ts')).getStripe();`],
])('traces a lazy factory loaded with %s', (_name, load) => {
  const result = analyze({
    'client.ts': `import Stripe from 'stripe';
let client: Stripe | null = null;
export function getStripe(): Stripe { if (!client) client = new Stripe('key', ${options}); return client; }`,
    'billing.ts': `export async function history() {
  ${load}
  const intent = await stripe.paymentIntents.retrieve('pi');
  return intent.charges.data;
}`,
  });
  expect(result.findings).toMatchObject([{ file: 'billing.ts', confidence: 'confirmed' }]);
});

it('does not trace a dynamically imported factory bound with let', () => {
  const result = analyze({
    'client.ts': `import Stripe from 'stripe';
export function getStripe(): Stripe { return new Stripe('key', ${options}); }`,
    'billing.ts': `export async function history() {
  let { getStripe } = await import('./client.ts');
  getStripe = () => ({}) as any;
  const stripe = getStripe();
  const intent = await stripe.paymentIntents.retrieve('pi');
  return intent.charges.data;
}`,
  });
  expect(result.findings.filter((entry) => entry.confidence === 'confirmed')).toEqual([]);
});

const wrapper = (body: string) => `export function lazy<T extends object>(factory: () => T): T {
  let instance: T | null = null;
  ${body}
  return new Proxy({} as T, {
    get(_target, prop, receiver) {
      if (!instance) instance = factory();
      return Reflect.get(instance as object, prop, receiver);
    },
  });
}`;

it('traces a client created through a generic lazy Proxy wrapper', () => {
  const result = analyze({
    'lazy-client.ts': wrapper(''),
    'route.ts': `import Stripe from 'stripe';\nimport { lazy } from './lazy-client.ts';\nconst stripe = lazy(() => new Stripe('key', ${options}));\n${read('stripe')}`,
  });
  expect(result.findings).toMatchObject([{ file: 'route.ts', confidence: 'confirmed' }]);
  expect(result.apiVersionDeclarations).toMatchObject([
    { file: 'route.ts', kind: 'constructor', status: 'literal', value: ORIGINAL },
    { file: 'route.ts', kind: 'request', status: 'inherited' },
  ]);
});

it.each([
  ['a local the wrapper also fills with something else', wrapper('instance = {} as T;')],
  [
    'two parameters',
    wrapper('').replace('factory: () => T)', 'factory: () => T, other?: () => T)'),
  ],
  [
    'a local filled with a call that passes arguments',
    wrapper('').replace('instance = factory();', 'instance = (factory as any)(1);'),
  ],
  [
    'a module holder instead of its own local',
    `let instance: any = null;\n${wrapper('').replace('let instance: T | null = null;', '')}`,
  ],
])('leaves a lazy wrapper untraced with %s', (_name, source) => {
  const result = analyze({
    'lazy-client.ts': source,
    'route.ts': `import Stripe from 'stripe';\nimport { lazy } from './lazy-client.ts';\nconst stripe = lazy(() => new Stripe('key', ${options}));\n${read('stripe')}`,
  });
  expect(result.findings.filter((entry) => entry.confidence === 'confirmed')).toEqual([]);
});

it('leaves a lazy wrapper call untraced when its function does not return a client', () => {
  const result = analyze({
    'lazy-client.ts': wrapper(''),
    'route.ts': `import Stripe from 'stripe';\nimport { lazy } from './lazy-client.ts';\nconst stripe = lazy(() => ({}) as Stripe);\n${read('stripe')}`,
  });
  expect(result.findings.filter((entry) => entry.confidence === 'confirmed')).toEqual([]);
});

it('traces a lazy wrapper whose trap binds methods to its own local', () => {
  const source = wrapper('').replace(
    'return Reflect.get(instance as object, prop, receiver);',
    "const value = Reflect.get(instance as object, prop, instance);\n      return typeof value === 'function' ? value.bind(instance) : value;",
  );
  const result = analyze({
    'lazy-client.ts': source,
    'route.ts': `import Stripe from 'stripe';\nimport { lazy } from './lazy-client.ts';\nconst stripe = lazy(() => new Stripe('key', ${options}));\n${read('stripe')}`,
  });
  expect(result.findings).toMatchObject([{ file: 'route.ts', confidence: 'confirmed' }]);
  expect(result.apiVersionDeclarations).toMatchObject([
    { file: 'route.ts', kind: 'constructor', status: 'literal', value: ORIGINAL },
    { file: 'route.ts', kind: 'request', status: 'inherited' },
  ]);
});

// A Proxy reads its holder on every access; a constant copies it once, before it is filled.
it('leaves a constant copy of a module holder untraced', () => {
  const result = analyze({
    'client.ts': `import Stripe from 'stripe';
let _stripe: Stripe | null = null;
export function init() { if (!_stripe) _stripe = new Stripe('key', ${options}); }
export const stripe = _stripe;`,
    'billing.ts': `import { stripe } from './client.ts';\n${read('stripe!')}`,
  });
  expect(result.findings.filter((entry) => entry.confidence === 'confirmed')).toEqual([]);
});

// Cached factories from the affected Stripe sets, as written (messages shortened, version set).
it.each([
  // EngMajdSayedTaha/reelspy lib/billing/stripe.ts
  [
    'a guarded block fill and an early null',
    `let cached: Stripe | null = null;
export function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  if (!cached) {
    cached = new Stripe(key, ${options});
  }
  return cached;
}`,
  ],
  // yuens1002/artisan-roast lib/services/stripe.ts
  [
    'an early return of the holder, two sources and a reset',
    `let _stripe: Stripe | null = null;
async function loadStripeCredentials() { return { secretKey: 'key' }; }
export async function getStripe(): Promise<Stripe | null> {
  if (_stripe) return _stripe;
  const envKey = process.env.STRIPE_SECRET_KEY;
  if (envKey) {
    _stripe = new Stripe(envKey, ${options});
    return _stripe;
  }
  const dbCreds = await loadStripeCredentials();
  if (dbCreds?.secretKey) {
    _stripe = new Stripe(dbCreds.secretKey, ${options});
    return _stripe;
  }
  return null;
}
export function resetStripeClient(): void {
  _stripe = null;
}`,
  ],
  [
    'a fill with ||=',
    `let cached: Stripe | undefined;
export async function getStripe() { cached ||= new Stripe('key', ${options}); return cached; }`,
  ],
])('traces a cached factory with %s', (_name, factory) => {
  const result = analyze({
    'client.ts': `import Stripe from 'stripe';\n${factory}`,
    'billing.ts': `import { getStripe } from './client.ts';\n${read('(await getStripe())!')}`,
  });
  expect(result.findings).toMatchObject([{ file: 'billing.ts', confidence: 'confirmed' }]);
  const constructors = result.apiVersionDeclarations.filter(
    (entry) => entry.kind === 'constructor',
  );
  expect(constructors.length).toBeGreaterThan(0);
  for (const entry of constructors)
    expect(entry).toMatchObject({ file: 'client.ts', status: 'literal', value: ORIGINAL });
});

// `let` holders used as the client itself, from the affected Stripe sets (messages shortened).
it.each([
  // createdbymax/Loopletter-Open-source-email-marketing-platform lib/stripe.server.ts
  [
    'a module holder set under a guard',
    `let stripe: Stripe | null = null;
if (typeof window === 'undefined') {
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', ${options});
}
export async function history() {
  if (!stripe) {
    throw new Error('Stripe is not initialized');
  }
  const intent = await stripe.paymentIntents.retrieve('pi');
  return intent.charges.data;
}`,
  ],
  // profullstack/vibe-stack src/routes/stripe-payments.js
  [
    'a module holder set in a try',
    `let stripe;
try {
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY, ${options});
} catch (error) {
  console.error('Failed to initialize Stripe client:', error);
}
${read('stripe')}`,
  ],
])('traces %s as the client with its version', (_name, source) => {
  const result = analyze({ 'billing.ts': `import Stripe from 'stripe';\n${source}` });
  expect(result.findings).toMatchObject([{ file: 'billing.ts', confidence: 'confirmed' }]);
  expect(result.apiVersionDeclarations).toMatchObject([
    { kind: 'constructor', status: 'literal', value: ORIGINAL },
    { kind: 'request', status: 'inherited' },
  ]);
});

// IramMcFly/kitchen-soft-platform app/api/webhooks/stripe/route.ts over its lib/stripe.ts.
it('traces a local holder filled from a cached factory in a try', () => {
  const result = analyze({
    'client.ts': `import Stripe from 'stripe';
let stripeClient: Stripe | null = null;
export function getStripeClient() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }
  if (!stripeClient) {
    stripeClient = new Stripe(secretKey, ${options});
  }
  return stripeClient;
}`,
    'billing.ts': `import { getStripeClient } from './client.ts';
export async function history() {
  let stripe;
  try {
    stripe = getStripeClient();
  } catch {
    return null;
  }
  const intent = await stripe.paymentIntents.retrieve('pi');
  return intent.charges.data;
}`,
  });
  expect(result.findings).toMatchObject([{ file: 'billing.ts', confidence: 'confirmed' }]);
  expect(result.apiVersionDeclarations).toMatchObject([
    { file: 'client.ts', kind: 'constructor', status: 'literal', value: ORIGINAL },
    { file: 'billing.ts', kind: 'request', status: 'inherited' },
  ]);
});

const holder = (extra: string, modifier = '') => `import Stripe from 'stripe';
${modifier}let stripe: Stripe | null = null;
export function getStripe() { if (!stripe) stripe = new Stripe('key', ${options}); return stripe; }
${extra}
${read('stripe!')}`;
it.each([
  ['exported', holder('', 'export ')],
  ['exported by name', holder('export { stripe };')],
  ['exported as the default', holder('export default stripe;')],
  ['reassigned to something else', holder('export function reset() { stripe = {} as Stripe; }')],
])('leaves a holder that is %s untraced, directly and through its getter', (_name, source) => {
  const result = analyze({
    'client.ts': source,
    'billing.ts': `import { getStripe } from './client.ts';\n${read('getStripe()!')}`,
  });
  expect(result.findings.filter((entry) => entry.confidence === 'confirmed')).toEqual([]);
});

it('leaves a static holder written from another module untraced', () => {
  const result = analyze({
    'client.ts': `import Stripe from 'stripe';
export class Billing {
  static client: Stripe | null = null;
  static get() { Billing.client ??= new Stripe('key', ${options}); return Billing.client; }
}`,
    'setup.ts': `import Stripe from 'stripe';\nimport { Billing } from './client.ts';\nBilling.client = new Stripe('other', { apiVersion: '2023-10-16' });`,
    'billing.ts': `import { Billing } from './client.ts';\n${read('Billing.get()!')}`,
  });
  expect(result.findings.filter((entry) => entry.confidence === 'confirmed')).toEqual([]);
});

it.each([
  ['passed to a function', 'console.log(stripe);'],
  ['copied', 'export const copy = stripe;'],
  ['stored in an object', 'export const clients = { stripe };'],
])('does not use a holder %s as the client itself', (_name, extra) => {
  const result = analyze({
    'billing.ts': `import Stripe from 'stripe';
let stripe: Stripe | null = null;
if (process.env.KEY) stripe = new Stripe(process.env.KEY, ${options});
${extra}
${read('stripe!')}`,
  });
  expect(result.findings.filter((entry) => entry.confidence === 'confirmed')).toEqual([]);
});
