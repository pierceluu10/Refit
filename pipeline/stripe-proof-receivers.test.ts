import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { type LocalReceiverOptions, localReceiverReads } from './stripe-type-evidence.ts';
import type { Repository } from './types.ts';

// Founder decision (Otabek, 2026-10-28; docs/PROOF-BASED-VALIDATION.md): an untraced read stops
// counting where Refit proves it is not on the changed Stripe object. These proofs cover a sort
// comparator's elements, a table of plans keyed by name, a Stripe object behind a cast to `any`, and
// a Prisma model delegate whose generated client a clean checkout lacks.

const STRIPE_TYPES = `declare namespace Stripe {
  interface Price { id: string; object: 'price'; unit_amount: number | null }
  interface InvoiceItem { id: string; object: 'invoiceitem'; unit_amount: number | null; price: Stripe.Price | null }
  interface Invoice { id: string; subscription: string | null }
  interface Product { id: string; default_price: string | Stripe.Price | null; features: { name: string }[] }
  interface ApiList<T> { data: T[] }
}
declare class Stripe {
  constructor(key: string);
  products: { list(): Promise<Stripe.ApiList<Stripe.Product>> };
  invoiceItems: { list(): Promise<Stripe.ApiList<Stripe.InvoiceItem>> };
}
export = Stripe;
`;

// Each resource has its `object` discriminant, as in stripe-node, so one is not assignable to another.
// Removed fields as the analyzer names them: change ids and the schema each removes from.
const CHANGES = [
  { id: 'invoiceitem-unit-amount', schema: 'invoiceitem' },
  { id: 'invoiceitem-price', schema: 'invoiceitem' },
  { id: 'invoice-subscription', schema: 'invoice' },
  { id: 'product-features', schema: 'product' },
];
const CHANGE_OF: Record<string, string> = {
  unit_amount: 'invoiceitem-unit-amount',
  price: 'invoiceitem-price',
  subscription: 'invoice-subscription',
  features: 'product-features',
};

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

// No node_modules/@prisma/client: the generated client is missing, as in a clean checkout.
async function checkout(files: Record<string, string>): Promise<Repository> {
  const root = await mkdtemp(join(tmpdir(), 'refit-proof-receivers-'));
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

// The proof for the read of `.<property>` on the line marked `// read`, whose access starts at
// `start`, behind a passing type check.
async function proof(
  content: string,
  start: string,
  property: string,
  extra: Record<string, string> = {},
  options: LocalReceiverOptions = {},
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
  return localReceiverReads(repository, [read], {
    typeChecked: () => true,
    changes: CHANGES,
    ...options,
  })[0]?.proof;
}

it("clears both elements of a sort comparator over the repository's own objects", async () => {
  const content = `import Stripe from 'stripe';
const stripe = new Stripe('sk_test');
export async function cheapestFirst() {
  return (await stripe.products.list()).data
    .map((product) => ({ id: product.id, price: product.features.length }))
    .sort((a, b) => a.price - b.price); // read
}
`;
  expect(await proof(content, 'a.price', 'price')).toBe('repository-type');
  expect(await proof(content, 'b.price', 'price')).toBe('repository-type');
  // The elements of a list of Stripe invoice items keep their reads.
  const stripeItems = `import Stripe from 'stripe';
const stripe = new Stripe('sk_test');
export async function byPrice() {
  return (await stripe.invoiceItems.list()).data
    .sort((a, b) => String(a.price).localeCompare(String(b.price))); // read
}
`;
  expect(await proof(stripeItems, 'b.price', 'price')).toBeUndefined();
});

const PLAN_TABLE = `export function features(plan: string | null) {
  const plans: Record<string, any> = {
    pro: { name: 'Pro', features: ['Unlimited projects'] },
    team: { name: 'Team', features: ['Seats'] },
  };
  const selected = plan ? plans[plan] : null;
  return selected.features; // read
}
`;

it('clears a plan read from a constant table of object literals by name', async () => {
  expect(await proof(PLAN_TABLE, 'selected.features', 'features')).toBe('literal-config');
  // A table entry the code replaces could be anything.
  const written = PLAN_TABLE.replace(
    '  const selected',
    '  plans[plan ?? "pro"] = JSON.parse("{}");\n  const selected',
  );
  expect(await proof(written, 'selected.features', 'features')).toBeUndefined();
  // So could an entry that is not an object literal.
  const computed = PLAN_TABLE.replace(
    "team: { name: 'Team', features: ['Seats'] }",
    'team: JSON.parse("{}")',
  );
  expect(await proof(computed, 'selected.features', 'features')).toBeUndefined();
});

it('clears a read through a cast to any where the value is another Stripe object', async () => {
  // product.default_price is a Price, not the invoice item whose unit_amount the change removes.
  const content = `import Stripe from 'stripe';
const stripe = new Stripe('sk_test');
export async function amounts() {
  return (await stripe.products.list()).data.map(
    (product) => (product as any).default_price?.unit_amount / 100, // read
  );
}
`;
  expect(await proof(content, '(product as any).default_price?.unit_amount', 'unit_amount')).toBe(
    'receiver-type',
  );
  // The same read on the changed object keeps counting.
  const changed = `import Stripe from 'stripe';
const stripe = new Stripe('sk_test');
export async function amounts() {
  return (await stripe.invoiceItems.list()).data.map(
    (item) => (item as any).unit_amount, // read
  );
}
`;
  expect(await proof(changed, '(item as any).unit_amount', 'unit_amount')).toBeUndefined();
  // A property the type does not declare could be anything at runtime.
  const undeclared = content.replace('default_price?.unit_amount', 'latest_price?.unit_amount');
  expect(await proof(undeclared, '(product as any).latest_price', 'unit_amount')).toBeUndefined();
  // A value that was any before the cast says nothing.
  const untyped = `export function amount(product: any) {
  return (product as { default_price: unknown } as any).default_price.unit_amount; // read
}
`;
  expect(await proof(untyped, '(product as', 'unit_amount')).toBeUndefined();
});

const PRISMA_GLOBAL = `import { PrismaClient } from '@prisma/client';
declare global {
  var prisma: PrismaClient | undefined;
}
export const db = globalThis.prisma || new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalThis.prisma = db;
`;
const PRISMA_HOLDER = `import { PrismaClient } from '@prisma/client';
const globalForPrisma = global as unknown as { prisma: PrismaClient };
export const prisma = globalForPrisma.prisma || new PrismaClient({ log: ['query'] });
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
`;
const MODELS = { prismaModels: ['User', 'Subscription', 'Price'] };

it('clears a Prisma model delegate on a client the repository constructs', async () => {
  const global = `import { db } from './db';
export async function save(id: string) {
  await db.price.upsert({ where: { id } }); // read
}
`;
  expect(await proof(global, 'db.price', 'price', { 'src/db.ts': PRISMA_GLOBAL }, MODELS)).toBe(
    'prisma-client',
  );
  const holder = `import { prisma } from './prisma';
export async function cancel(id: string) {
  await prisma.subscription.delete({ where: { id } }); // read
}
`;
  expect(
    await proof(
      holder,
      'prisma.subscription',
      'subscription',
      { 'src/prisma.ts': PRISMA_HOLDER },
      MODELS,
    ),
  ).toBe('prisma-client');
  // Not a model the schema declares.
  expect(
    await proof(
      global,
      'db.price',
      'price',
      { 'src/db.ts': PRISMA_GLOBAL },
      { prismaModels: ['User'] },
    ),
  ).toBeUndefined();
  // A holder the code fills with something other than a client.
  const filled = PRISMA_HOLDER.replace(
    "if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;",
    'globalForPrisma.prisma = JSON.parse("{}");',
  );
  expect(
    await proof(holder, 'prisma.subscription', 'subscription', { 'src/prisma.ts': filled }, MODELS),
  ).toBeUndefined();
  // A client from another package, or a let the code can reassign.
  const other = PRISMA_HOLDER.replace("from '@prisma/client'", "from './billing-client'");
  expect(
    await proof(holder, 'prisma.subscription', 'subscription', { 'src/prisma.ts': other }, MODELS),
  ).toBeUndefined();
  const reassigned = PRISMA_HOLDER.replace('export const prisma', 'export let prisma');
  expect(
    await proof(
      holder,
      'prisma.subscription',
      'subscription',
      { 'src/prisma.ts': reassigned },
      MODELS,
    ),
  ).toBeUndefined();
});

// Wrong clears an adversarial review found in the first version of these proofs; each must keep
// counting. The Stripe value is always an invoice item, whose `price` and `unit_amount` the change
// removes.
const ITEM = `import Stripe from 'stripe';
const stripe = new Stripe('sk_test');
export async function firstItem(): Promise<any> {
  return (await stripe.invoiceItems.list()).data[0];
}
`;

it('keeps a table entry something else can replace or fill', async () => {
  const table = `export const plans = { pro: { name: 'Pro' }, team: { name: 'Team' } };
export function price(plan: string) {
  const selected = plans[plan as 'pro'] as any;
  return selected.price; // read
}
`;
  // Through a namespace import.
  const namespace = `import * as config from './app';
import { firstItem } from './item';
export async function fill() {
  config.plans.pro = await firstItem();
}
`;
  expect(
    await proof(table, 'selected.price', 'price', {
      'src/item.ts': ITEM,
      'src/fill.ts': namespace,
    }),
  ).toBeUndefined();
  // Or by copying into one entry.
  const assignedEntry = table.replace(
    'export function price',
    "import { firstItem } from './item';\nexport async function fill() {\n  Object.assign(plans.pro, await firstItem());\n}\nexport function price",
  );
  expect(
    await proof(assignedEntry, 'selected.price', 'price', { 'src/item.ts': ITEM }),
  ).toBeUndefined();
});

it('keeps a cast read on a repository holder written with a Stripe value', async () => {
  const content = `import { firstItem } from './item';
interface Row { unit_amount: number | null; label: string }
const cache = { row: null as Row | null };
export async function load() {
  cache.row = await firstItem();
  return (cache.row as any).unit_amount; // read
}
`;
  expect(
    await proof(content, '(cache.row as any)', 'unit_amount', { 'src/item.ts': ITEM }),
  ).toBeUndefined();
});

it('keeps a Prisma holder the code writes another value into, however it writes', async () => {
  const read = `import { db } from './db';
export async function save(id: string) {
  await db.price.upsert({ where: { id } }); // read
}
`;
  for (const write of [
    'prisma = JSON.parse("{}");',
    '(globalThis as any).prisma = JSON.parse("{}");',
  ])
    expect(
      await proof(
        read,
        'db.price',
        'price',
        { 'src/db.ts': PRISMA_GLOBAL, 'src/other.ts': `export {};\n${write}\n` },
        MODELS,
      ),
    ).toBeUndefined();
});

it("keeps a comparator on a class's own sort, which need not pass array elements", async () => {
  const content = `import { firstItem } from './item';
interface Row { price: number }
class Table {
  rows: any[] = [];
  sort(compare: (a: Row, b: Row) => number) {
    return this.rows.sort(compare);
  }
}
export async function sorted() {
  const table = new Table();
  table.rows = [await firstItem()];
  return table.sort((a, b) => a.price - b.price); // read
}
`;
  expect(await proof(content, 'b.price', 'price', { 'src/item.ts': ITEM })).toBeUndefined();
});
