import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { type LocalReceiverOptions, localReceiverReads } from './stripe-type-evidence.ts';
import type { Repository } from './types.ts';

// Owner decision D2b, widened by the founder decision of 2026-10-28: an untraced read stops
// counting, with or without AI, only where Refit proves its receiver is not a Stripe object: a type
// the repository declares (behind a passing type check), an object literal the repository writes, or
// a type generated from the repository's own schema.

const STRIPE_TYPES = `declare namespace Stripe {
  interface InvoiceLineItem {
    price: { id: string } | null;
  }
}
declare class Stripe {
  constructor(key: string);
  invoiceItems: { retrieve(id: string): Promise<Stripe.InvoiceLineItem> };
}
export = Stripe;
`;

// The removed field the reads name: line_item.price.
const CHANGES = [{ id: 'line-item-price', schema: 'line_item' }];

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function checkout(files: Record<string, string>): Promise<Repository> {
  const root = await mkdtemp(join(tmpdir(), 'refit-local-receivers-'));
  directories.push(root);
  const all = {
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, esModuleInterop: true } }),
    'node_modules/stripe/package.json': JSON.stringify({ name: 'stripe', types: 'index.d.ts' }),
    'node_modules/stripe/index.d.ts': STRIPE_TYPES,
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return {
    root,
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
}

// The read of `.price` on the line holding `marker`, at the column where the access starts.
function read(content: string, file: string, receiver: string) {
  const lines = content.split('\n');
  const line = lines.findIndex((text) => text.includes(`${receiver}.price`));
  expect(line).toBeGreaterThanOrEqual(0);
  return {
    file,
    line: line + 1,
    column: lines[line].indexOf(`${receiver}.price`) + 1,
    expression: '.price',
    changeId: 'line-item-price',
  };
}

// The proof that clears the read, or undefined; the type check passed unless `options` says not.
async function proof(
  file: string,
  content: string,
  receiver: string,
  extra = {},
  options: LocalReceiverOptions = { typeChecked: () => true },
) {
  const repository = await checkout({ [file]: content, ...extra });
  return localReceiverReads(repository, [read(content, file, receiver)], {
    changes: CHANGES,
    ...options,
  })[0]?.proof;
}

async function cleared(file: string, content: string, receiver: string, extra = {}) {
  return (await proof(file, content, receiver, extra)) !== undefined;
}

const PLANS = `export const PLANS = [
  { slug: 'pro', price: { amount: 10, priceIds: { test: 'price_1' } } },
];
`;

it('clears a read of the application’s own plan table', async () => {
  // JensenMPillay/pdfai and aabhiyann/talkifydocs: `.price` on PLANS.find(...), a local config.
  const content = `import { PLANS } from './plans';
export function amount(slug: string) {
  const plan = PLANS.find((entry) => entry.slug === slug);
  return plan?.price.amount;
}
`;
  expect(await cleared('src/billing.ts', content, 'plan?', { 'src/plans.ts': PLANS })).toBe(true);
});

it('keeps a read on any, unknown and an unresolved import', async () => {
  expect(
    await cleared('src/a.ts', 'export function f(line: any) {\n  return line.price;\n}\n', 'line'),
  ).toBe(false);
  expect(
    await cleared(
      'src/u.ts',
      "export function f(line: unknown) {\n  if (typeof line === 'object' && line && 'price' in line) return line.price;\n}\n",
      'line',
    ),
  ).toBe(false);
  expect(
    await cleared(
      'src/m.ts',
      "import type { Line } from 'missing-package';\nexport function f(line: Line) {\n  return line.price;\n}\n",
      'line',
    ),
  ).toBe(false);
});

it('keeps a Stripe type read directly, through an alias and as a base', async () => {
  const direct = `import Stripe from 'stripe';
export function f(line: Stripe.InvoiceLineItem) {
  return line.price;
}
`;
  expect(await cleared('src/d.ts', direct, 'line')).toBe(false);
  const alias = `import Stripe from 'stripe';
type Line = Stripe.InvoiceLineItem;
type Row = Line;
export function f(row: Row) {
  return row.price;
}
`;
  expect(await cleared('src/alias.ts', alias, 'row')).toBe(false);
  // A local interface that redeclares the field but extends the Stripe type.
  const base = `import Stripe from 'stripe';
interface Row extends Stripe.InvoiceLineItem {
  price: { id: string } | null;
}
export function f(row: Row) {
  return row.price;
}
`;
  expect(await cleared('src/base.ts', base, 'row')).toBe(false);
});

it('keeps a cast receiver, an untyped JavaScript parameter and a declaration file', async () => {
  const cast = `interface Plan {
  price: number;
}
export function f(value: object) {
  return (value as Plan).price;
}
`;
  expect(await cleared('src/cast.ts', cast, '(value as Plan)')).toBe(false);
  const js = `export function amount(first) {
  return first.price;
}
`;
  expect(await cleared('src/plans.js', js, 'first')).toBe(false);
  const declared = `import type { Plan } from './plan';
export function f(plan: Plan) {
  return plan.price;
}
`;
  expect(
    await cleared('src/declared.ts', declared, 'plan', {
      'src/plan.d.ts': 'export interface Plan { price: number }\n',
    }),
  ).toBe(false);
});

it('needs a passing type check for a repository type', async () => {
  const content = `interface Plan {
  price: number;
}
function amount(plan: Plan) {
  return plan.price;
}
export const total = amount({ price: 10 });
`;
  expect(await proof('src/typed.ts', content, 'plan')).toBe('repository-type');
  expect(await proof('src/typed.ts', content, 'plan', {}, {})).toBeUndefined();
});

it('keeps a Stripe object passed to a helper that takes a repository type', async () => {
  // The local interface accepts a Stripe line item structurally, so tsc passes either way.
  const helper = (call: string, exported = '') => `import Stripe from 'stripe';
interface Line {
  price: { id: string } | null;
}
${exported}function priceOf(line: Line) {
  return line.price;
}
export async function load(stripe: Stripe, id: string) {
  return priceOf(${call});
}
`;
  expect(
    await cleared('src/helper.ts', helper('await stripe.invoiceItems.retrieve(id)'), 'line'),
  ).toBe(false);
  // Since a line item fits `Line`, a Stripe object could reach it by any write tsc accepts, so
  // even a helper whose only caller passes a literal stays held.
  expect(await cleared('src/local.ts', helper("{ price: { id: 'p' } }"), 'line')).toBe(false);
  // Callers outside the repository are not seen.
  expect(
    await cleared('src/exported.ts', helper("{ price: { id: 'p' } }", 'export '), 'line'),
  ).toBe(false);
  // A const annotated with the repository type over a Stripe value.
  const annotated = `import Stripe from 'stripe';
interface Line {
  price: { id: string } | null;
}
export async function load(stripe: Stripe, id: string) {
  const line: Line = await stripe.invoiceItems.retrieve(id);
  return line.price;
}
`;
  expect(await cleared('src/annotated.ts', annotated, 'line')).toBe(false);
});

it('keeps a Stripe object asserted to a repository type anywhere on its way', async () => {
  // createdbymax/Loopletter: `event.data.object as StripeInvoice` passed through two helpers.
  // `source` keeps Stripe's InvoiceLineItem from being assignable to Line, so only the path decides.
  const chain = (origin: string, after = '') => `import Stripe from 'stripe';
interface Line {
  price: { id: string } | null;
  source: 'local';
}
function store(line: Line) {
  return line.price;
}
function handle(line: Line) {
  return store(line);
}
export async function load(stripe: Stripe, id: string) {
  ${origin}
  return handle(line);
}
${after}`;
  const retrieved = 'const line = (await stripe.invoiceItems.retrieve(id)) as Line;';
  expect(await cleared('src/chain.ts', chain(retrieved), 'line')).toBe(false);
  const either =
    "const line = id ? ((await stripe.invoiceItems.retrieve(id)) as Line) : ({ price: null, source: 'local' } satisfies Line);";
  expect(await cleared('src/either.ts', chain(either), 'line')).toBe(false);
  const fetchLine = `async function fetchLine(stripe: Stripe, id: string) {
  return (await stripe.invoiceItems.retrieve(id)) as Line;
}
`;
  const returned = chain('const line = await fetchLine(stripe, id);', fetchLine);
  expect(await cleared('src/returned.ts', returned, 'line')).toBe(false);
  expect(
    await cleared(
      'src/literal.ts',
      chain("const line: Line = { price: null, source: 'local' };"),
      'line',
    ),
  ).toBe(true);
});

it('keeps a union with a Stripe type and a read traced to Stripe in the same function', async () => {
  const union = `import Stripe from 'stripe';
interface Plan {
  price: number;
}
export function f(row: Plan | Stripe.InvoiceLineItem) {
  return row.price;
}
`;
  expect(await cleared('src/union.ts', union, 'row')).toBe(false);
  const content = `const PLANS = [{ price: 10 }];
export function f(line: { price: unknown }) {
  const plan = PLANS[0];
  return [plan.price, line.price];
}
`;
  const file = 'src/same.ts';
  const repository = await checkout({ [file]: content });
  const planRead = read(content, file, 'plan');
  const lineRead = { ...planRead, column: content.split('\n')[3].indexOf('line') + 1 };
  expect(localReceiverReads(repository, [planRead])).toHaveLength(1);
  expect(localReceiverReads(repository, [planRead], { traced: [lineRead] })).toEqual([]);
});

it('clears a read of a constant plan list whose type Refit cannot resolve', async () => {
  // miljan-code/gpt-writer: the list's type is a zod inference, unresolved without node_modules.
  const plans = `import * as z from 'zod';
import { schema } from './schema';
type Plan = z.infer<typeof schema>;
export const creditPlans: Plan[] = [
  { id: 0, price: 6.99, stripePriceId: 'STRIPE_PLAN_100' },
  { id: 1, price: 11.99, stripePriceId: 'STRIPE_PLAN_200' },
];
`;
  const route = `import { creditPlans } from './plans';
export function amount(plan: string) {
  const creditPlan = creditPlans.find((entry) => entry.stripePriceId === plan);
  if (!creditPlan) return null;
  return creditPlan.price.toString();
}
`;
  const extra = { 'src/plans.ts': plans };
  expect(await proof('src/route.ts', route, 'creditPlan', extra, {})).toBe('literal-config');
  // The element parameter of a callback, by index, and in a JavaScript file.
  const callback = `import { creditPlans } from './plans';
export const prices = creditPlans.map((entry) => entry.price);
`;
  expect(await proof('src/callback.ts', callback, 'entry', extra, {})).toBe('literal-config');
  const js = `const PLANS = [{ slug: 'pro', price: 10 }];
export const first = PLANS[0];
export const amount = first.price;
`;
  expect(await proof('src/plans.js', js, 'first', {}, {})).toBe('literal-config');
});

it('keeps a constant list the repository adds to or replaces elements of', async () => {
  const route = `import { PLANS } from './plans';
export const amount = PLANS[0].price;
`;
  for (const write of [
    'PLANS.push(line);',
    'PLANS[0] = line;',
    'register(PLANS);',
    'PLANS.splice(0, 1, line);',
  ]) {
    const plans = `export const PLANS = [{ price: 10 }];
export function add(line: any) {
  ${write}
}
declare function register(list: unknown): void;
`;
    expect(await proof('src/route.ts', route, 'PLANS[0]', { 'src/plans.ts': plans }, {})).toBe(
      undefined,
    );
  }
  // A spread element or a `let` list may hold anything.
  const spread = `const extra: any = {};
const PLANS = [{ price: 10, ...extra }];
export const amount = PLANS[0].price;
`;
  expect(await proof('src/spread.ts', spread, 'PLANS[0]', {}, {})).toBeUndefined();
  const mutable = `let PLANS = [{ price: 10 }];
export const amount = PLANS[0].price;
`;
  expect(await proof('src/let.ts', mutable, 'PLANS[0]', {}, {})).toBeUndefined();
});

const PAYLOAD_TYPES = `/* tslint:disable */
/**
 * This file was automatically generated by Payload.
 * DO NOT MODIFY IT BY HAND. Instead, modify your source Payload config,
 * and re-run \`payload generate:types\` to regenerate this file.
 */
export interface Product {
  id: string;
  name: string;
  price: number;
}
`;

it('clears a read of a document asserted to a type Payload generated', async () => {
  // The DigitalHippo collection hook in seven l2-push-249 repositories.
  const hook = (operand = 'args.data', extra = '') => `import { Product } from '../payload-types';
import { stripe } from '../lib/stripe';
export const Products = {
  hooks: {
    beforeChange: [
      async (args: any) => {
        ${extra}
        const data = ${operand} as Product;
        return stripe.products.create({
          name: data.name,
          default_price_data: { currency: 'usd', unit_amount: Math.round(data.price * 100) },
        });
      },
    ],
  },
};
`;
  const extra = { 'src/payload-types.ts': PAYLOAD_TYPES };
  const file = 'src/collections/Products.ts';
  expect(await proof(file, hook(), 'data', extra, {})).toBe('generated-type');
  // A hand-written type, an event payload and a webhook handler keep stopping.
  expect(
    await proof(file, hook(), 'data', {
      'src/payload-types.ts': PAYLOAD_TYPES.replace(/\/\*[\s\S]*?\*\/\n/g, ''),
    }),
  ).toBeUndefined();
  expect(await proof(file, hook('args.event.data.object'), 'data', extra)).toBeUndefined();
  expect(
    await proof(
      file,
      hook('args.data', 'stripe.webhooks.constructEvent(args.body, args.signature, "whsec");'),
      'data',
      extra,
    ),
  ).toBeUndefined();
});
