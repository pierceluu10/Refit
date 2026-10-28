import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { typescriptDirectory } from './generated-checks.ts';
import { notStripe, readReceiverProbe, writeReceiverProbe } from './receiver-probe.ts';

// Owner decision D2b: the probe runs in the sandbox, where the repository's dependencies are
// installed, and says what object each untraced read reads. Only `own` and `library` receivers
// are not a Stripe type; everything else keeps the read unresolved.

const run = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

const FILES: Record<string, string> = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, esModuleInterop: true } }),
  'node_modules/stripe/package.json': JSON.stringify({ name: 'stripe', types: 'index.d.ts' }),
  'node_modules/stripe/index.d.ts': `declare namespace Stripe {
  interface InvoiceLineItem { price: { id: string } | null; }
}
declare class Stripe { constructor(key: string); }
export = Stripe;
`,
  'node_modules/@stripe/stripe-js/package.json': JSON.stringify({
    name: '@stripe/stripe-js',
    types: 'index.d.ts',
  }),
  'node_modules/@stripe/stripe-js/index.d.ts': 'export interface LineItem { price: string; }\n',
  'node_modules/schema-kit/package.json': JSON.stringify({
    name: 'schema-kit',
    types: 'index.d.ts',
  }),
  'node_modules/schema-kit/index.d.ts':
    'export type Infer<T> = { [K in keyof T]: T[K] };\nexport declare function row<T>(shape: T): Infer<T>;\n',
  'src/plans.ts': "export const PLANS = [{ slug: 'pro', price: { amount: 10 } }];\n",
  'src/reads.ts': `import Stripe from 'stripe';
import type { LineItem } from '@stripe/stripe-js';
import { row } from 'schema-kit';
import { PLANS } from './plans';
import { other } from './missing';
interface Product { price: number }
export function reads(line: Stripe.InvoiceLineItem, client: LineItem, data: unknown, loose: any) {
  const plan = PLANS[0];
  const record = row({ price: 3 });
  const cast = data as Product;
  return [plan.price, record.price, line.price, client.price, cast.price, loose.price, other.price];
}
`,
};

async function probe() {
  const root = await mkdtemp(join(tmpdir(), 'refit-receiver-probe-'));
  directories.push(root);
  for (const [path, content] of Object.entries(FILES)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const input = await mkdtemp(join(tmpdir(), 'refit-receiver-input-'));
  directories.push(input);
  const lines = FILES['src/reads.ts'].split('\n');
  const line = lines.findIndex((text) => text.includes('plan.price')) + 1;
  const reads = ['plan', 'record', 'line', 'client', 'cast', 'loose', 'other'].map((receiver) => ({
    file: 'src/reads.ts',
    line,
    column: lines[line - 1].indexOf(`${receiver}.price`) + 1,
    expression: '.price',
  }));
  const command = await writeReceiverProbe(input, input, ['src/plans.ts', 'src/reads.ts'], reads);
  expect(command).toBeDefined();
  const { stdout } = await run(command![0], command!.slice(1), {
    cwd: root,
    env: { ...process.env, REFIT_TYPESCRIPT: join(typescriptDirectory(), 'lib/typescript.js') },
  });
  return readReceiverProbe(stdout)!;
}

it('labels each receiver and clears only types that are not Stripe types', async () => {
  const labels = await probe();
  expect(labels.map((read) => read.label)).toEqual([
    'own',
    'library',
    'stripe',
    'stripe',
    'asserted',
    'unknown',
    'unknown',
  ]);
  expect(labels.filter(notStripe)).toHaveLength(2);
  expect(labels[2].types.join(' ')).toContain('InvoiceLineItem');
});

it('probes only TypeScript reads and refuses output that is not its own', async () => {
  const input = await mkdtemp(join(tmpdir(), 'refit-receiver-input-'));
  directories.push(input);
  expect(
    await writeReceiverProbe(
      input,
      input,
      ['app.js'],
      [{ file: 'app.js', line: 1, column: 1, expression: '.price' }],
    ),
  ).toBeUndefined();
  expect(readReceiverProbe('not json')).toBeUndefined();
  expect(readReceiverProbe('[{"file":"a.ts"}]')).toBeUndefined();
});
