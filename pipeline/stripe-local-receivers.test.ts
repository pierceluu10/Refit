import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { localReceiverReads } from './stripe-type-evidence.ts';
import type { Repository } from './types.ts';

// Owner decision D2b: an AI "no change needed" clears an untraced read only where TypeScript shows
// the object read is the repository's own, never a Stripe type.

const STRIPE_TYPES = `declare namespace Stripe {
  interface InvoiceLineItem {
    price: { id: string } | null;
  }
}
declare class Stripe {
  constructor(key: string);
}
export = Stripe;
`;

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
  return { file, line: line + 1, column: lines[line].indexOf(receiver) + 1, expression: '.price' };
}

async function cleared(file: string, content: string, receiver: string, extra = {}) {
  const repository = await checkout({ [file]: content, ...extra });
  const result = localReceiverReads(repository, [read(content, file, receiver)]);
  console.log(file, receiver, result.length ? 'cleared' : 'kept');
  return result.length === 1;
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

it('keeps a cast receiver, a JavaScript file and a declaration file', async () => {
  const cast = `interface Plan {
  price: number;
}
export function f(value: object) {
  return (value as Plan).price;
}
`;
  expect(await cleared('src/cast.ts', cast, '(value as Plan)')).toBe(false);
  const js = `const PLANS = [{ slug: 'pro', price: 10 }];
export const first = PLANS[0];
export const amount = first.price;
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
