import { expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';

const client = "import Stripe from 'stripe'; export const stripe = new Stripe('test');";
const consumer = `import { stripe as billing } from './client.js';
export async function history() {
  const intent = await billing.paymentIntents.retrieve('pi');
  return intent.charges.data;
}`;
const change = {
  id: 'removed',
  schema: 'payment_intent',
  property: 'charges',
  pointer: '/components/schemas/payment_intent/properties/charges',
};
function analyze(files: Record<string, string>) {
  return analyzeRepository(
    {
      root: '/virtual',
      files: Object.entries(files).map(([path, content]) => ({ path, content })),
      dependencies: [],
      lockfiles: [],
      warnings: [],
    },
    [change],
  );
}

it.each([false, true])(
  'traces a renamed imported client independent of file ordering: %s',
  (reverse) => {
    const files = { 'billing.ts': consumer, 'client.ts': client };
    const result = analyze(reverse ? Object.fromEntries(Object.entries(files).reverse()) : files);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ file: 'billing.ts', confidence: 'confirmed' });
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0].replacement).toBe(
      '(await billing.charges.list({ payment_intent: intent.id })).data',
    );
  },
);

it.each<Record<string, string>>([
  { 'client.ts': `${client}\nstripe.paymentIntents.retrieve = replacement;` },
  {
    'mutator.ts': "import {stripe} from './client'; stripe.paymentIntents.retrieve = replacement;",
  },
  { 'mutator.ts': "import {stripe} from './client'; const alias = stripe; mutate(alias);" },
  {
    'mutator.ts':
      "import * as clients from './client'; clients.stripe.paymentIntents.retrieve = replacement;",
  },
  { 'barrel.ts': "export {stripe} from './client';" },
  { 'client.ts': `${client}\nexport default stripe;` },
  { 'client.ts': `${client}\nexport function getClient() { return stripe; }` },
  { 'client.ts': `${client}\nexport const getClient = () => stripe;` },
  { 'client.ts': `${client}\nexport const getResource = () => stripe.paymentIntents;` },
  {
    'client.ts': `${client}\nlet alias = stripe; export const getResource = () => alias.paymentIntents;`,
  },
  { 'client.ts': `${client}\nexport function* clients() { yield stripe; }` },
  { 'client.ts': `${client}\nexport function fail() { throw stripe; }` },
  { 'client.ts': `${client}\nexport const getClient = () => flag ? (stripe as unknown) : null;` },
])('downgrades shared clients when another module mutates or exposes them: %j', (extra) => {
  const result = analyze({ 'billing.ts': consumer, 'client.ts': client, ...extra });
  expect(result.findings.find((finding) => finding.file === 'billing.ts')).toMatchObject({
    confidence: 'review',
  });
  expect(result.edits).toEqual([]);
});

it.each([
  consumer.replace("'./client.js'", "'@/client'"),
  consumer.replace('import {', 'import type {'),
  consumer.replace('stripe as', 'type stripe as'),
  consumer.replace("'./client.js'", "'./barrel'"),
])('does not confirm unsupported imports: %s', (content) => {
  const result = analyze({
    'billing.ts': content,
    'client.ts': client,
    'barrel.ts': "export {stripe} from './client';",
  });
  expect(result.findings.find((finding) => finding.file === 'billing.ts')?.confidence).toBe(
    'review',
  );
  expect(result.edits).toEqual([]);
});

it('declines ambiguous source/output pairs and mutable exported declarations', () => {
  expect(
    analyze({ 'billing.ts': consumer, 'client.ts': client, 'client.js': client }).edits,
  ).toEqual([]);
  expect(
    analyze({ 'billing.ts': consumer, 'client.ts': client.replace('export const', 'export let') })
      .edits,
  ).toEqual([]);
});

it('does not confuse a shadowing parameter with the imported client', () => {
  const result = analyze({
    'billing.ts': consumer.replace('history()', 'history(billing)'),
    'client.ts': client,
  });
  expect(result.findings[0].confidence).toBe('review');
  expect(result.edits).toEqual([]);
});
