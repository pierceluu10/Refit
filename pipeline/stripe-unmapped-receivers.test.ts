import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { localReceiverReads } from './stripe-type-evidence.ts';
import type { Repository } from './types.ts';

// A removed field on a nested Stripe sub-object that has no stripe-node type of its own
// (`payments_primitives_payment_records_resource_payment_method_card_details.description`): Refit
// proves a `.description` read is not on it only where the receiver requires the property and no
// stripe-node type that still declares it fits the receiver.

const CHANGES = [
  {
    id: 'card-details-description',
    schema: 'payments_primitives_payment_records_resource_payment_method_card_details',
  },
];

// The target version's types: the card details lost `description`, a Product still has it.
const TARGET = `declare namespace Stripe {
  interface Product { id: string; description: string | null }
  namespace PaymentRecord { interface CardDetails { brand: string } }
}
declare class Stripe {
  constructor(key: string);
  products: { retrieve(id: string): Promise<Stripe.Product> };
}
export = Stripe;
`;

// An installed version where the card details still declare `description`.
const OLDER = TARGET.replace('{ brand: string }', '{ brand: string; description: string }');

// A query builder whose rows a library types.
const ORM = `export interface Row { id: string; sku: string; description: string | null }
interface Query extends PromiseLike<Row[]> {
  from(table: string): Query;
  where(condition: string): Query;
  orderBy(column: string): Query;
  limit(count: number): Query;
  offset(count: number): Query;
}
export declare const db: { select(): Query };
`;

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function cleared(content: string, receiver: string, stripe = TARGET) {
  const root = await mkdtemp(join(tmpdir(), 'refit-unmapped-receivers-'));
  directories.push(root);
  const files = {
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, esModuleInterop: true } }),
    'node_modules/stripe/package.json': JSON.stringify({ name: 'stripe', types: 'index.d.ts' }),
    'node_modules/stripe/index.d.ts': stripe,
    'node_modules/orm/package.json': JSON.stringify({ name: 'orm', types: 'index.d.ts' }),
    'node_modules/orm/index.d.ts': ORM,
    'src/app.ts': content,
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  const repository: Repository = {
    root,
    files: [{ path: 'src/app.ts', content }],
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
  const lines = content.split('\n');
  const line = lines.findIndex((text) => text.includes(`${receiver}.description`));
  expect(line).toBeGreaterThanOrEqual(0);
  const read = {
    file: 'src/app.ts',
    line: line + 1,
    column: lines[line].indexOf(`${receiver}.description`) + 1,
    expression: '.description',
    changeId: 'card-details-description',
  };
  return (
    localReceiverReads(repository, [read], { changes: CHANGES, typeChecked: () => true }).length > 0
  );
}

it('clears a repository type that requires the property', async () => {
  const content = `function journal(input: { description: string; amount: number }) {
  return input.description;
}
journal({ description: 'rent', amount: 1 });
`;
  expect(await cleared(content, 'input')).toBe(true);
});

it('keeps a receiver whose property is optional', async () => {
  const content = `function journal(input: { description?: string }) {
  return input.description;
}
journal({ description: 'rent' });
`;
  expect(await cleared(content, 'input')).toBe(false);
});

it('keeps a receiver an installed type that still declares the property fits', async () => {
  const content = `function journal(input: { description: string }) {
  return input.description;
}
journal({ description: 'rent' });
`;
  expect(await cleared(content, 'input', OLDER)).toBe(false);
});

it('keeps a Stripe object that declares the property', async () => {
  const content = `import Stripe from 'stripe';
const stripe = new Stripe('sk');
export async function name(id: string) {
  const product = await stripe.products.retrieve(id);
  return product.description;
}
`;
  expect(await cleared(content, 'product')).toBe(false);
});

it('clears a library row read through a long query chain and a then callback', async () => {
  const content = `import { db } from 'orm';
export async function rows() {
  const all = await db.select().from('items').where('x').orderBy('id').limit(10).offset(5);
  const first = all.map((row) => row.description);
  const later = await db
    .select()
    .from('items')
    .then((found) => found.map((item) => item.description));
  return [first, later];
}
`;
  expect(await cleared(content, 'row')).toBe(true);
  expect(await cleared(content, 'item')).toBe(true);
});

it('keeps a then callback that receives a Stripe object', async () => {
  const content = `import Stripe from 'stripe';
const stripe = new Stripe('sk');
export function name(id: string) {
  return stripe.products.retrieve(id).then((product) => product.description);
}
`;
  expect(await cleared(content, 'product')).toBe(false);
});

it('keeps a repository type a Stripe object that declares the property fits', async () => {
  const content = `function label(input: { id: string; description: string | null }) {
  return input.description;
}
label({ id: 'a', description: null });
`;
  expect(await cleared(content, 'input')).toBe(false);
});
