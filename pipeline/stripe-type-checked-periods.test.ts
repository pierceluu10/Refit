import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import { applySourceEdits } from './patches.ts';
import { STRIPE } from './providers.ts';
import { createReviewArtifacts } from './review.ts';
import { runPipeline } from './run.ts';
import { digest, findRemovedProperties } from './specifications.ts';
import { typeCheckedPeriodReads } from './validation.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const string = { type: 'string' };
const integer = { type: 'integer' };
const ref = (schema: string) => ({ $ref: `#/components/schemas/${schema}` });
// Reduced 2025-03-31.basil contracts: the period moves from the subscription to its items.
const schemas = (after: boolean): Record<string, unknown> => ({
  subscription: {
    type: 'object',
    properties: {
      id: string,
      items: {
        type: 'object',
        properties: { data: { type: 'array', items: ref('subscription_item') } },
      },
      ...(after ? {} : { current_period_start: integer, current_period_end: integer }),
    },
  },
  subscription_item: {
    type: 'object',
    properties: {
      id: string,
      price: ref('price'),
      ...(after ? { current_period_start: integer, current_period_end: integer } : {}),
    },
  },
  price: { type: 'object', properties: { id: string } },
  customer: { type: 'object', properties: { id: string } },
});
// Like the benchmark's generated adapter, which maps no list operation: a list's items are untraced.
const provider = {
  ...STRIPE,
  id: 'stripe-full',
  operations: [{ resource: 'customers', method: 'retrieve', schema: 'customer' }],
};

// Kanba-co/kanba app/api/stripe/webhook/route.ts: the newest subscription of a `subscriptions.list`
// call, whose period reads stripe-node 23 rejects.
const listed = `import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2023-10-16' });

export async function syncCustomerFromStripe(customerId: string) {
  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    limit: 1,
    status: 'all',
    expand: ['data.default_payment_method'],
  });
  if (subscriptions.data.length === 0) return null;
  const subscription = subscriptions.data[0];
  const subscriptionData: any = {
    subscription_id: subscription.id,
    price_id: subscription.items.data[0].price.id,
    current_period_start: subscription.current_period_start,
    current_period_end: subscription.current_period_end,
  };
  return subscriptionData;
}
`;
// iggy-tech/product-hunt-clone-final lib/stripe.ts: a server-actions module whose client has no
// version option; the read sits in arithmetic.
const action = `"use server";

import Stripe from "stripe";

const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY as string,
);

export const getNextPayment = async (email: string) => {
  const customers = await stripe.customers.list({ email });
  const customer = customers.data[0];
  const subscriptions = await stripe.subscriptions.list({
    customer: customer.id,
    status: 'active',
  });
  const subscription = subscriptions.data[0];
  const nextPaymentDate = new Date(subscription.current_period_end * 1000);
  return nextPaymentDate.toLocaleDateString('en-US');
};
`;

// The offset of the property name in each `.<name>` read the type check rejected.
const readsOf = (content: string, file: string, ...reads: string[]) =>
  reads.map((read) => ({
    file,
    position: content.indexOf(read) + read.lastIndexOf('.') + 1,
  }));

function analyze(content: string, typeCheckedPeriodReads?: { file: string; position: number }[]) {
  const result = analyzeRepository(
    {
      root: '/type-checked',
      files: [{ path: 'route.ts', content }],
      dependencies: [],
      lockfiles: [],
      warnings: [],
    },
    findRemovedProperties(schemas(false), schemas(true), provider.id),
    provider,
    schemas(false),
    [],
    [],
    [],
    [],
    { typeCheckedPeriodReads },
  );
  return {
    ...result,
    patched: applySourceEdits(
      content,
      result.edits.filter((edit) => edit.file === 'route.ts'),
    ),
  };
}

it('leaves period reads on an untraced list item for review without type-check positions', () => {
  const result = analyze(listed);
  const periods = result.findings.filter((finding) => /current_period/.test(finding.expression));
  expect(periods.map((finding) => [finding.expression, finding.confidence])).toEqual([
    ['.current_period_start', 'review'],
    ['.current_period_end', 'review'],
  ]);
  expect(result.edits).toEqual([]);
});

it('reads the periods the type check rejected through the version-tolerant helper', () => {
  const result = analyze(
    listed,
    readsOf(
      listed,
      'route.ts',
      'subscription.current_period_start',
      'subscription.current_period_end',
    ),
  );
  const periods = result.findings.filter((finding) => /current_period/.test(finding.expression));
  expect(periods).toMatchObject([
    { expression: '.current_period_start', confidence: 'confirmed', typeChecked: true },
    { expression: '.current_period_end', confidence: 'confirmed', typeChecked: true },
  ]);
  expect(periods.every((finding) => !finding.untraced)).toBe(true);
  // Refit cannot see which item this code treats as its plan, so mixed periods stay undefined.
  expect(periods.map((finding) => finding.subscriptionPeriod)).toEqual([
    { rareCase: 'flagged' },
    { rareCase: 'flagged' },
  ]);
  // The helpers are written into the file that calls them.
  expect(result.patched).toContain('function getSubscriptionPeriodStart(');
  expect(result.patched).toContain('function getSubscriptionPeriodEnd(');
  expect(result.patched).toContain(
    '    current_period_start: (getSubscriptionPeriodStart(subscription)),\n    current_period_end: (getSubscriptionPeriodEnd(subscription)),',
  );
  // The request and the other reads are unchanged.
  expect(result.patched).toContain("    expand: ['data.default_payment_method'],");
  expect(result.patched).toContain('    price_id: subscription.items.data[0].price.id,');
});

it('moves only the reads the type check rejected', () => {
  const result = analyze(listed, readsOf(listed, 'route.ts', 'subscription.current_period_end'));
  const periods = result.findings.filter((finding) => /current_period/.test(finding.expression));
  expect(periods.map((finding) => [finding.confidence, Boolean(finding.typeChecked)])).toEqual([
    ['review', false],
    ['confirmed', true],
  ]);
  expect(result.patched).toContain(
    '    current_period_start: subscription.current_period_start,\n    current_period_end: (getSubscriptionPeriodEnd(subscription)),',
  );
});

it('imports the helper after a "use server" directive and keeps the arithmetic', () => {
  const result = analyze(action, readsOf(action, 'route.ts', 'subscription.current_period_end'));
  expect(result.findings.filter((finding) => finding.typeChecked)).toHaveLength(1);
  expect(result.patched.startsWith(`"use server";\n\nimport Stripe from "stripe";\n`)).toBe(true);
  expect(result.patched.indexOf('function getSubscriptionPeriodEnd(')).toBeGreaterThan(
    result.patched.indexOf('import Stripe from "stripe";'),
  );
  expect(result.patched).toContain(
    'const nextPaymentDate = new Date((getSubscriptionPeriodEnd(subscription)) * 1000);',
  );
});

it('keeps a rejected read the helper cannot take for review', () => {
  // A call receiver cannot be repeated inside the helper call.
  const content = listed.replace(
    'current_period_end: subscription.current_period_end,',
    'current_period_end: subscriptions.data.find((entry) => entry.id)!.current_period_end,',
  );
  const result = analyze(content, readsOf(content, 'route.ts', ')!.current_period_end'));
  const end = result.findings.find((finding) => finding.expression === '.current_period_end');
  expect(end).toMatchObject({ confidence: 'review' });
  expect(end?.typeChecked).toBeUndefined();
  expect(result.edits).toEqual([]);
});

it('maps a patched type-check position back across the proposal edits', () => {
  const original = `const a = invoice.subscription; const b = subscription.current_period_end;\n`;
  const edits = [
    {
      file: 'route.ts',
      start: 0,
      end: 0,
      replacement: "import { getInvoiceSubscription } from './stripeSubscriptionPeriod';\n",
      changeId: 'helper',
      rule: 'stripe-invoice-subscription-helper' as const,
    },
    {
      file: 'route.ts',
      start: original.indexOf('invoice.subscription'),
      end: original.indexOf('invoice.subscription') + 'invoice.subscription'.length,
      replacement: '(getInvoiceSubscription(invoice))',
      changeId: 'invoice.subscription',
      rule: 'stripe-invoice-subscription-helper' as const,
    },
  ];
  const patched = applySourceEdits(original, edits);
  const line = patched.split('\n')[1];
  const error = {
    file: 'route.ts',
    line: 2,
    column: line.indexOf('current_period_end') + 1,
    code: 'TS2339',
    message: "Property 'current_period_end' does not exist on type 'Subscription'.",
  };
  const files = (content: string) => [{ path: 'route.ts', content }];
  expect(typeCheckedPeriodReads([error], files(patched), files(original), edits)).toEqual([
    { file: 'route.ts', position: original.indexOf('current_period_end') },
  ]);
  // Inside an edit's replacement, another error code, another type, or a patched file that is not
  // exactly the original with these edits: nothing to map.
  expect(
    typeCheckedPeriodReads(
      [{ ...error, line: 1, column: 10 }],
      files(patched),
      files(original),
      edits,
    ),
  ).toBeUndefined();
  expect(
    typeCheckedPeriodReads([{ ...error, code: 'TS2322' }], files(patched), files(original), edits),
  ).toBeUndefined();
  expect(
    typeCheckedPeriodReads(
      [{ ...error, message: "Property 'current_period_end' does not exist on type 'Plan'." }],
      files(patched),
      files(original),
      edits,
    ),
  ).toBeUndefined();
  expect(
    typeCheckedPeriodReads([error], files(`${patched}// edited\n`), files(original), edits),
  ).toBeUndefined();
});

it('proposes the type-checked reads with the version bump and says so in the draft', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-type-checked-'));
  roots.push(root);
  await writeFile(join(root, 'route.ts'), listed);
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'app', dependencies: { stripe: '14.25.0' } }),
  );
  const contract = (after: boolean) => ({
    openapi: '3.0.3',
    info: {
      title: 'Simulated Stripe contract',
      version: after ? '2025-03-31.basil' : '2023-10-16',
    },
    paths: {},
    components: { schemas: schemas(after) },
  });
  await writeFile(join(root, 'before.json'), JSON.stringify(contract(false)));
  await writeFile(join(root, 'after.json'), JSON.stringify(contract(true)));
  await writeFile(join(root, 'provider.json'), JSON.stringify(provider));
  const options = {
    repository: root,
    before: join(root, 'before.json'),
    after: join(root, 'after.json'),
    providerConfig: join(root, 'provider.json'),
    apiVersion: '2023-10-16',
    proposePatch: true,
  };
  // The checker proves both reads at scan time (typeProvenReads), as validation's type check does.
  const first = await runPipeline(options);
  expect(first.patch).toMatchObject({ status: 'proposed', unresolvedFindings: 0 });
  const report = await runPipeline({
    ...options,
    typeCheckedPeriodReads: readsOf(
      listed,
      'route.ts',
      'subscription.current_period_start',
      'subscription.current_period_end',
    ),
  });
  expect(report.patch).toMatchObject({ status: 'proposed', unresolvedFindings: 0 });
  const diff = 'diff' in report.patch ? report.patch.diff : '';
  expect(diff).toContain(
    "+const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2025-03-31.basil' });",
  );
  expect(diff).toContain('+    current_period_end: (getSubscriptionPeriodEnd(subscription)),');
  expect(diff).toContain('+function getSubscriptionPeriodEnd(');
  if (!('diff' in report.patch)) throw new Error('Expected a patch');
  const draft = createReviewArtifacts({
    ...report,
    publicationFiles: [],
    patch: { ...report.patch, validation: 'passed' },
    validation: {
      status: 'passed',
      revision: 'a'.repeat(40),
      image: `sha256:${'b'.repeat(64)}`,
      runtime: {
        configured: 'node:22-alpine',
        image: 'node:22-alpine',
        nodeVersion: '22.23.3',
        declarations: [],
        reason: 'The repository declares no Node.js version.',
      },
      command: ['npx', 'tsc', '--noEmit'],
      baselineCommand: ['npx', 'tsc', '--noEmit'],
      archiveHash: 'c'.repeat(64),
      patchHash: digest(report.patch.diff),
      baseline: { status: 'passed', exitCode: 0, stdout: '', stderr: '' },
      patched: { status: 'passed', exitCode: 0, stdout: '', stderr: '' },
      limits: {
        timeoutMs: 120_000,
        outputBytes: 1024 * 1024,
        network: 'none',
        workspace: '512m' as const,
        memory: '1g' as const,
      },
      publishable: false,
      attempts: [],
      repair: { limit: 0, requested: 0, stopReason: 'not-needed-or-disabled', error: null },
      reason: 'Synthetic check results for PR text.',
    },
  }).files['pull-request.md'];
  expect(draft).toContain(
    "Reads 2 subscription periods at `route.ts:16`, `route.ts:17` through the generated period helper: Refit's tracer did not reach these reads, but the upgraded stripe-node types reject them on `Subscription`.",
  );
});
