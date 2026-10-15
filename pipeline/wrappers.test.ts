import { expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import { applySourceEdits } from './patches.ts';

const change = {
  id: 'removed',
  schema: 'payment_intent',
  property: 'charges',
  pointer: '/charges',
};
const client = "import Stripe from 'stripe'; export const stripe = new Stripe('test');";
const wrapper =
  "import { stripe } from './client.ts'; export function retrieve(id: string) { return stripe.paymentIntents.retrieve(id); }";
const history = `import { retrieve } from './payments.ts';
export class MissingHistory extends Error {}
export async function history(id: string) {
  const payment = await retrieve(id);
  if (!payment.charges) { throw new MissingHistory('Missing history'); }
  return payment.charges.data;
}`;
function repository(extra: Record<string, string> = {}) {
  return {
    root: '/virtual',
    files: Object.entries({
      'history.ts': history,
      'payments.ts': wrapper,
      'client.ts': client,
      ...extra,
    }).map(([path, content]) => ({ path, content })),
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
}

it.each([false, true])(
  'traces a transparent imported wrapper and migrates its guarded history, reverse=%s',
  (reverse) => {
    const input = repository();
    if (reverse) input.files.reverse();
    const result = analyzeRepository(input, [change]);
    expect(result.findings).toHaveLength(2);
    expect(result.findings.every((finding) => finding.confidence === 'confirmed')).toBe(true);
    expect(result.edits).toHaveLength(1);
    const migrated = {
      ...input,
      files: input.files.map((file) => ({
        ...file,
        content: applySourceEdits(
          file.content,
          result.edits.filter((edit) => edit.file === file.path),
        ),
      })),
    };
    const content = migrated.files.find((file) => file.path === 'history.ts')!.content;
    expect(content).toContain('from "./client.ts"');
    expect(content).toContain('await retrieve(id)');
    expect(content).toContain(
      'for await (const refitCharge of refitStripe.charges.list({ payment_intent: payment.id }))',
    );
    expect(analyzeRepository(migrated, [change]).findings).toEqual([]);
  },
);

it('does not treat passing SDK call results to assertions as client mutation', () => {
  const result = analyzeRepository(
    repository({
      'test.ts': `import {stripe} from './client.ts'; import {retrieve} from './payments.ts'; assert.rejects(stripe.refunds.create({})); assert.rejects(retrieve('missing'));`,
    }),
    [change],
  );
  expect(result.findings.every((finding) => finding.confidence === 'confirmed')).toBe(true);
  expect(result.edits).toHaveLength(1);
});

it.each([
  wrapper.replace('return stripe', 'log(id); return stripe'),
  wrapper.replace('retrieve(id);', 'retrieve(id, {expand: []});'),
  wrapper.replace(
    'return stripe.paymentIntents.retrieve(id);',
    'return transform(stripe.paymentIntents.retrieve(id));',
  ),
  wrapper.replace(
    'return stripe.paymentIntents.retrieve(id);',
    'return flag ? stripe.paymentIntents.retrieve(id) : {};',
  ),
  wrapper.replace('id: string', 'id: string = "pi_default"'),
  wrapper.replace('export function', 'export default function'),
])('declines non-transparent or unsupported wrappers: %s', (content) => {
  const result = analyzeRepository(repository({ 'payments.ts': content }), [change]);
  expect(result.findings.every((finding) => finding.confidence === 'review')).toBe(true);
  expect(result.edits).toEqual([]);
});

it.each([
  "import {stripe} from './client.ts'; stripe.paymentIntents.retrieve = replacement;",
  "import {retrieve} from './payments.ts'; retrieve = replacement;",
  "import * as payments from './payments.ts'; payments.retrieve = replacement;",
  "export {retrieve} from './payments.ts';",
])('downgrades mutation or re-exported wrapper/client bindings: %s', (content) => {
  const result = analyzeRepository(repository({ 'mutator.ts': content }), [change]);
  expect(result.findings.every((finding) => finding.confidence === 'review')).toBe(true);
  expect(result.edits).toEqual([]);
});

it('keeps wrapper responses confirmed when the wrapper is only passed to a call', () => {
  const result = analyzeRepository(
    repository({ 'mutator.ts': "import {retrieve} from './payments.ts'; mutate(retrieve);" }),
    [change],
  );
  expect(result.findings.some((finding) => finding.confidence === 'confirmed')).toBe(true);
});

it.each([
  history.replace(
    "throw new MissingHistory('Missing history');",
    "log(payment); throw new MissingHistory('Missing history');",
  ),
  history.replace('if (!payment.charges)', 'if (payment.charges)'),
  history.replace("throw new MissingHistory('Missing history');", 'throw recordFailure(payment);'),
  history.replace(
    'return payment.charges.data;',
    'return payment.charges.data.map(charge => charge.id);',
  ),
  history.replace('const payment', 'const refitStripe = other; const payment'),
])('does not rewrite unsupported guards or colliding names: %s', (content) => {
  expect(analyzeRepository(repository({ 'history.ts': content }), [change]).edits).toEqual([]);
});
