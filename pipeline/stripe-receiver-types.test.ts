import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { type LocalReceiverOptions, localReceiverReads } from './stripe-type-evidence.ts';
import type { Repository } from './types.ts';

// The receiver-type proof: behind a passing type check, an untraced read clears where every part of
// its receiver's declared type is not the Stripe object of the schema the change removes the field
// from, and no assertion, annotation or return type hides a value Refit cannot see.

const STRIPE_TYPES = `declare namespace Stripe {
  interface InvoiceLineItem { id: string; price: { id: string } | null; type: string }
  interface Invoice { id: string; subscription: string | null }
  interface UpcomingInvoice { subscription: string | null }
  interface Product { id: string; features: { name: string }[] }
  interface Subscription { id: string; current_period_end: number }
  interface ApiList<T> { data: T[] }
  namespace errors {
    class StripeError extends Error { type: string; code?: string }
    class StripeCardError extends StripeError {}
  }
}
declare class Stripe {
  constructor(key: string);
  invoices: { retrieve(id: string): Promise<Stripe.Invoice> };
  products: { list(): Promise<Stripe.ApiList<Stripe.Product>> };
  invoiceItems: { list(): Promise<Stripe.ApiList<Stripe.InvoiceLineItem>> };
  static errors: typeof Stripe.errors;
}
export = Stripe;
`;

// A generated ORM client in node_modules, as Prisma writes one.
const PRISMA_TYPES = `export type Subscription = { id: string; userId: string; price: string; status: string };
export declare class PrismaClient {
  subscription: { findFirst(args?: { where?: { userId?: string } }): Promise<Subscription | null> };
}
`;

// Removed fields as the analyzer names them: change ids and the schema each removes from.
const CHANGES = [
  { id: 'line-item-price', schema: 'line_item' },
  { id: 'line-item-type', schema: 'line_item' },
  { id: 'invoice-subscription', schema: 'invoice' },
  { id: 'product-features', schema: 'product' },
  { id: 'subscription-period', schema: 'subscription' },
];
const CHANGE_OF: Record<string, string> = {
  price: 'line-item-price',
  type: 'line-item-type',
  subscription: 'invoice-subscription',
  features: 'product-features',
  current_period_end: 'subscription-period',
};

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function checkout(files: Record<string, string>): Promise<Repository> {
  const root = await mkdtemp(join(tmpdir(), 'refit-receiver-types-'));
  directories.push(root);
  const all = {
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, esModuleInterop: true } }),
    'node_modules/stripe/package.json': JSON.stringify({ name: 'stripe', types: 'index.d.ts' }),
    'node_modules/stripe/index.d.ts': STRIPE_TYPES,
    'node_modules/@prisma/client/package.json': JSON.stringify({
      name: '@prisma/client',
      types: 'index.d.ts',
    }),
    'node_modules/@prisma/client/index.d.ts': PRISMA_TYPES,
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

// The proof for the read of `.<property>` on the line marked `// read`, whose access starts at
// `start`. A type the repository declares throughout is lane 1's repository-type proof.
async function proof(
  content: string,
  start: string,
  property: string,
  extra: Record<string, string> = {},
  options: LocalReceiverOptions = { typeChecked: () => true, changes: CHANGES },
) {
  const file = 'src/app.ts';
  const repository = await checkout({ [file]: content, ...extra });
  const lines = content.split('\n');
  const line = lines.findIndex((text) => text.includes('// read'));
  expect(line).toBeGreaterThanOrEqual(0);
  const column = lines[line].indexOf(start);
  expect(column).toBeGreaterThanOrEqual(0);
  expect(lines[line].slice(column)).toContain(`.${property}`);
  const read = {
    file,
    line: line + 1,
    column: column + 1,
    expression: `.${property}`,
    changeId: CHANGE_OF[property],
  };
  return localReceiverReads(repository, [read], options)[0]?.proof;
}

it('clears a read on a Prisma row, an ORM type declared outside the repository', async () => {
  const content = `import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
export async function plan(userId: string) {
  const row = await prisma.subscription.findFirst({ where: { userId } });
  if (!row) return null;
  return row.price; // read
}
`;
  expect(await proof(content, 'row', 'price')).toBe('receiver-type');
});

it('clears error.type on a StripeError narrowed with instanceof', async () => {
  const content = `import Stripe from 'stripe';
export function message(error: unknown) {
  if (error instanceof Stripe.errors.StripeError) return error.type; // read
  return 'unknown';
}
`;
  expect(await proof(content, 'error.type', 'type')).toBe('receiver-type');
  const caught = `import Stripe from 'stripe';
export async function charge(run: () => Promise<void>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof Stripe.errors.StripeCardError) console.log(error.type); // read
  }
}
`;
  expect(await proof(caught, 'error.type', 'type')).toBe('receiver-type');
});

it('clears a cart item parameter only when every caller passes a non-Stripe value', async () => {
  const helper = `interface CartItem { name: string; price: number; quantity: number }
function toLineItems(items: CartItem[]) {
  return items.map((item) => ({
    quantity: item.quantity,
    price_data: { currency: 'usd', unit_amount: item.price }, // read
  }));
}
`;
  const cart = `const cart: CartItem[] = [{ name: 'Mug', price: 1200, quantity: 1 }];
export const lineItems = toLineItems(cart);
`;
  expect(await proof(helper + cart, 'item', 'price')).toBeDefined();
  // A caller that casts what it passes, or passes Stripe line items the annotation accepts.
  const cast = `declare const body: any;
export const lineItems = toLineItems(body.items as CartItem[]);
`;
  expect(await proof(helper + cast, 'item', 'price')).toBeUndefined();
  const stripeItems = `import Stripe from 'stripe';
type LooseItem = { name?: string; price: unknown; quantity?: number };
function names(items: LooseItem[]) {
  return items.map((item) => item.price); // read
}
export const run = (list: Stripe.ApiList<Stripe.InvoiceLineItem>) => names(list.data);
`;
  expect(await proof(stripeItems, 'item', 'price')).toBeUndefined();
});

it('clears a plan picked from a constant list and a locally mapped product', async () => {
  const plans = `const PLANS = [
  { id: 'basic', price: 900 },
  { id: 'pro', price: 2900 },
];
export function priceOf(id: string) {
  return PLANS.find((plan) => plan.id === id)?.price; // read
}
`;
  expect(await proof(plans, 'PLANS.find', 'price')).toBeDefined();
  const mapped = `import Stripe from 'stripe';
const stripe = new Stripe('sk_test');
export async function catalog() {
  const products = (await stripe.products.list()).data.map((product) => ({
    name: product.id,
    features: product.features.map((feature) => feature.name),
  }));
  return products.map((product) => product.features.join(', ')); // read
}
`;
  expect(await proof(mapped, 'product.features.join', 'features')).toBeDefined();
});

it('clears a webhook handler read on a local object and keeps the event payload', async () => {
  const local = `interface Account { subscription: string | null }
const accounts = new Map<string, Account>();
export function handle(event: { type: string; data: { object: unknown } }, id: string) {
  const account = accounts.get(id);
  if (event.type === 'invoice.paid' && account) return account.subscription; // read
}
`;
  expect(await proof(local, 'account.subscription', 'subscription')).toBeDefined();
  const payload = `import Stripe from 'stripe';
export function handle(event: { data: { object: unknown } }) {
  const invoice = event.data.object as Stripe.Invoice;
  return invoice.subscription; // read
}
`;
  expect(await proof(payload, 'invoice', 'subscription')).toBeUndefined();
});

it("keeps a receiver typed as the changed schema's Stripe object", async () => {
  const content = `import Stripe from 'stripe';
export function renewsAt(subscription: Stripe.Subscription) {
  return subscription.current_period_end; // read
}
`;
  expect(await proof(content, 'subscription', 'current_period_end')).toBeUndefined();
  const union = `import Stripe from 'stripe';
interface Local { subscription: string | null }
export function owner(invoice: Stripe.Invoice | Local) {
  return invoice.subscription; // read
}
`;
  expect(await proof(union, 'invoice', 'subscription')).toBeUndefined();
});

it('keeps any, a hand-written cast, an unmapped Stripe interface and a picked Stripe type', async () => {
  const anyReceiver = `export function priceOf(x: any) {
  return x.price; // read
}
`;
  expect(await proof(anyReceiver, 'x', 'price')).toBeUndefined();
  const cast = `interface Product { features: string[] }
export function features(data: unknown) {
  const product = data as Product;
  return product.features; // read
}
`;
  expect(await proof(cast, 'product', 'features')).toBeUndefined();
  const upcoming = `import Stripe from 'stripe';
const preview = {} as unknown as { next: Stripe.UpcomingInvoice };
export const owner = () => preview.next.subscription; // read
`;
  expect(await proof(upcoming, 'preview.next', 'subscription')).toBeUndefined();
  const picked = `import Stripe from 'stripe';
type Priced = Pick<Stripe.InvoiceLineItem, 'price'>;
export function priceOf(item: Priced) {
  return item.price; // read
}
export const run = (item: Priced) => priceOf(item);
`;
  expect(await proof(picked, 'item', 'price')).toBeUndefined();
});

it('keeps a type from another Stripe package and a return annotation over a cast', async () => {
  const content = `import type { Invoice } from '@stripe/stripe-like';
export function owner(invoice: Invoice) {
  return invoice.subscription; // read
}
`;
  const related = {
    'node_modules/@stripe/stripe-like/package.json': JSON.stringify({
      name: '@stripe/stripe-like',
      types: 'index.d.ts',
    }),
    'node_modules/@stripe/stripe-like/index.d.ts':
      'export interface Invoice { subscription: string | null }\n',
  };
  expect(await proof(content, 'invoice', 'subscription', related)).toBeUndefined();
  const returned = `interface Plan { price: number }
declare const raw: unknown;
function current(): Plan {
  return raw as Plan;
}
export const amount = () => current().price; // read
`;
  expect(await proof(returned, 'current()', 'price')).toBeUndefined();
});

it('needs a passing type check and the change the read names', async () => {
  const content = `import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
export const plan = async () => (await prisma.subscription.findFirst())?.price; // read
`;
  const start = '(await prisma';
  expect(await proof(content, start, 'price')).toBe('receiver-type');
  expect(
    await proof(content, start, 'price', {}, { typeChecked: () => false, changes: CHANGES }),
  ).toBeUndefined();
  expect(await proof(content, start, 'price', {}, { typeChecked: () => true })).toBeUndefined();
});
