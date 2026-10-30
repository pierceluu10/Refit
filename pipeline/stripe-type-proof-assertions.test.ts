import { expect, it } from 'vitest';
import { typeProvenReads } from './stripe-type-evidence.ts';
import type { Finding, Removal, Repository } from './types.ts';

const removal: Removal = {
  id: 'invoice-payment-intent',
  schema: 'invoice',
  property: 'payment_intent',
  pointer: '#/components/schemas/invoice/properties/payment_intent',
};

// Line and column of `expandedInvoice.payment_intent` in `content`.
function proven(cast: string) {
  const content = `import Stripe from 'stripe';
const stripe = new Stripe('sk_test', { apiVersion: '2023-10-16' as any });
function clientSecret(subscription: Stripe.Subscription): string | null {
  const invoice = subscription.latest_invoice;
  if (!invoice || typeof invoice === 'string') return null;
  const expandedInvoice = ${cast};
  const paymentIntent = expandedInvoice.payment_intent;
  return paymentIntent && typeof paymentIntent !== 'string' ? paymentIntent.client_secret : null;
}
export async function create(customer: string) {
  const subscription = await stripe.subscriptions.create({ customer });
  return clientSecret(subscription);
}
`;
  const lines = content.split('\n');
  const line = lines.findIndex((text) => text.includes('expandedInvoice.payment_intent'));
  const finding: Finding = {
    file: 'server/routes.ts',
    line: line + 1,
    column: lines[line].indexOf('expandedInvoice') + 1,
    changeId: removal.id,
    expression: '.payment_intent',
    confidence: 'review',
    reason: 'declared type',
  };
  const repository: Repository = {
    root: '/nonexistent-repository',
    files: [{ path: finding.file, content }],
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
  return typeProvenReads(repository, [removal], [finding]);
}

// 0-CYBERDYNE-SYSTEMS-0/quorum server/routes.ts: an SDK subscription's expanded invoice, asserted to
// the Invoice type plus the field the newer stripe-node types no longer declare.
it('keeps provenance through an assertion that only adds inline members to the value type', () => {
  expect(
    proven('invoice as Stripe.Invoice & { payment_intent?: string | Stripe.PaymentIntent | null }'),
  ).toEqual([expect.objectContaining({ changeId: removal.id })]);
});

it('proves nothing through an assertion to another type, or one that adds a named type', () => {
  expect(proven('invoice as any as Stripe.Invoice & { payment_intent?: string }')).toEqual([]);
  expect(proven('(invoice as unknown) as Stripe.Invoice & { payment_intent?: string }')).toEqual(
    [],
  );
  expect(
    proven('invoice as Stripe.Invoice & Stripe.Customer & { payment_intent?: string }'),
  ).toEqual([]);
});
