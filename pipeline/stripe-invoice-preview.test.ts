import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import { migrationReviewReason } from './migration-review.ts';
import { applySourceEdits } from './patches.ts';
import { STRIPE } from './providers.ts';
import { runPipeline } from './run.ts';
import { INVOICE_PREVIEW_RULE, invoicePreviewMove } from './stripe-invoice-preview.ts';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const string = { maxLength: 5000, type: 'string' };
const unix = { format: 'unix-time', type: 'integer' };
const item = (extra: Record<string, unknown> = {}) => ({
  type: 'array',
  items: { type: 'object', properties: { id: string, price: string, ...extra } },
});
const prorationBehavior = { enum: ['always_invoice', 'create_prorations', 'none'], type: 'string' };
const invoice = {
  content: { 'application/json': { schema: { $ref: '#/components/schemas/invoice' } } },
};

// Reduced from GET /v1/invoices/upcoming (2025-02-24.acacia) and POST /v1/invoices/create_preview
// (2026-09-30.endive) in Stripe's OpenAPI documents (stripe/openapi).
function contract(version: string, after: boolean, upcomingToo = false) {
  const upcoming = {
    get: {
      operationId: 'GetInvoicesUpcoming',
      parameters: [
        { in: 'query', name: 'customer', schema: string, style: 'form' },
        { in: 'query', name: 'subscription', schema: string, style: 'form' },
        { in: 'query', name: 'subscription_items', schema: item(), style: 'deepObject' },
        { in: 'query', name: 'subscription_proration_date', schema: unix, style: 'form' },
        {
          in: 'query',
          name: 'subscription_billing_cycle_anchor',
          schema: { anyOf: [{ enum: ['now', 'unchanged'], type: 'string' }, unix] },
        },
        { in: 'query', name: 'coupon', schema: string, style: 'form' },
        {
          in: 'query',
          name: 'subscription_details',
          style: 'deepObject',
          schema: {
            type: 'object',
            properties: {
              items: item(),
              proration_behavior: prorationBehavior,
              proration_date: unix,
            },
          },
        },
      ],
      responses: { '200': invoice },
    },
  };
  const preview = {
    post: {
      operationId: 'PostInvoicesCreatePreview',
      requestBody: {
        content: {
          'application/x-www-form-urlencoded': {
            schema: {
              type: 'object',
              properties: {
                customer: string,
                subscription: string,
                subscription_details: {
                  type: 'object',
                  properties: {
                    // endive adds an optional field to items, which every old value still fits.
                    items: item({
                      current_trial: { type: 'object', properties: { trial_offer: string } },
                    }),
                    proration_behavior: prorationBehavior,
                    proration_date: unix,
                    // endive changed this one's shape, so it does not move.
                    billing_cycle_anchor: { type: 'object', properties: { type: string } },
                  },
                },
              },
            },
          },
        },
      },
      responses: { '200': invoice },
    },
  };
  return {
    openapi: '3.0.0',
    info: { version },
    paths: after
      ? {
          '/v1/invoices/create_preview': preview,
          ...(upcomingToo ? { '/v1/invoices/upcoming': upcoming } : {}),
        }
      : { '/v1/invoices/upcoming': upcoming },
    components: {
      schemas: {
        invoice: { type: 'object', properties: { id: string, amount_due: { type: 'integer' } } },
      },
    },
  };
}
const before = contract('2025-02-24.acacia', false);
const after = contract('2026-09-30.endive', true);

function analyze(body: string) {
  const content = `import Stripe from 'stripe';\nconst stripe = new Stripe('sk', { apiVersion: '2025-02-24.acacia' });\n${body}`;
  const result = analyzeRepository(
    {
      root: '/invoice-preview',
      files: [{ path: 'billing.ts', content }],
      dependencies: [],
      lockfiles: [],
      warnings: [],
    },
    [],
    STRIPE,
    {},
    [],
    [],
    [],
    [],
    { invoicePreview: invoicePreviewMove(before, after) },
  );
  return { ...result, patched: applySourceEdits(content, result.edits) };
}

it('maps the upcoming parameters create_preview still accepts, and only those', () => {
  const move = invoicePreviewMove(before, after)!;
  expect(Object.fromEntries(move.keys)).toEqual({
    customer: ['customer'],
    subscription: ['subscription'],
    subscription_items: ['subscription_details', 'items'],
    subscription_proration_date: ['subscription_details', 'proration_date'],
  });
  expect([...move.details]).toEqual(['items', 'proration_behavior', 'proration_date']);
  // Not removed yet, or never present: no move.
  expect(invoicePreviewMove(before, contract('2026-09-30.endive', true, true))).toBeUndefined();
  expect(invoicePreviewMove(after, after)).toBeUndefined();
});

it('rewrites the real upcoming invoice previews and stops on customer-wide ones', () => {
  // yuga-hashimoto/ai-tool-navigator src/lib/subscriptions/stripe-service.ts and
  // kondax-com/Bocker convex/tenant/subscription/action.ts pass subscription_* parameters;
  // EngMajdSayedTaha/reelspy lib/billing/plan-change.ts already passes subscription_details;
  // internxt/payments-server src/services/payment.service.ts previews by customer only.
  const result =
    analyze(`export async function previewSubscriptionChange(subscriptionId: string, newPriceId: string) {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const invoice = await stripe.invoices.retrieveUpcoming({
    customer: subscription.customer as string,
    subscription: subscriptionId,
    subscription_items: [
      {
        id: subscription.items.data[0].id,
        price: newPriceId,
      },
    ],
  });
  return invoice.amount_due;
}
export async function bocker(args: { customer: string; subscription: string }, items: [], prorationDate: number) {
  return await stripe.invoices.retrieveUpcoming({
    customer: args.customer,
    subscription: args.subscription,
    subscription_items: items,
    subscription_proration_date: prorationDate,
  });
}
export async function reelspy(sub: { id: string; customer: string }, itemId: string, priceId: string, prorationDate: number) {
  return await stripe.invoices.retrieveUpcoming({
    customer: sub.customer,
    subscription: sub.id,
    subscription_details: {
      items: [{ id: itemId, price: priceId }],
      proration_behavior: "always_invoice",
      proration_date: prorationDate,
    },
  });
}
export async function internxt(customerId: string) {
  return await stripe.invoices.retrieveUpcoming({ customer: customerId });
}`);
  expect(result.patched).toContain(`  const invoice = await stripe.invoices.createPreview({
    customer: subscription.customer as string,
    subscription: subscriptionId,
    subscription_details: { items: [
      {
        id: subscription.items.data[0].id,
        price: newPriceId,
      },
    ] },
  });`);
  expect(result.patched).toContain(`  return await stripe.invoices.createPreview({
    customer: args.customer,
    subscription: args.subscription,
    subscription_details: { items: items, proration_date: prorationDate },
  });`);
  expect(result.patched).toContain(`  return await stripe.invoices.createPreview({
    customer: sub.customer,
    subscription: sub.id,
    subscription_details: {`);
  expect(result.patched).toContain(
    'return await stripe.invoices.retrieveUpcoming({ customer: customerId });',
  );
  expect(result.findings.map(({ line, confidence }) => [line, confidence])).toEqual([
    [5, 'confirmed'],
    [18, 'confirmed'],
    [26, 'confirmed'],
    [37, 'confirmed'],
  ]);
  expect(result.findings[3].contractReview).toMatch(/across all subscriptions/);
  expect(result.edits.every((edit) => edit.rule === INVOICE_PREVIEW_RULE)).toBe(true);
});

it('keeps parameters create_preview reads differently, spreads and optional calls for review', () => {
  const result =
    analyze(`export async function preview(customer: string, subscription: string, params: object) {
  await stripe.invoices.retrieveUpcoming({ customer, subscription, coupon: 'SPRING' });
  await stripe.invoices.retrieveUpcoming({ customer, subscription, subscription_billing_cycle_anchor: 'now' });
  await stripe.invoices.retrieveUpcoming({ customer, subscription, ...params });
  await stripe.invoices.retrieveUpcoming({
    customer,
    subscription,
    subscription_proration_date: 1,
    subscription_details: { proration_behavior: 'none' },
  });
  await stripe?.invoices.retrieveUpcoming({ customer, subscription });
}`);
  expect(result.edits).toEqual([]);
  expect(
    result.findings.map((finding) => [finding.confidence, finding.contractReview?.split('. ')[1]]),
  ).toEqual([
    ['confirmed', 'coupon has no equivalent create_preview parameter; the call needs review.'],
    [
      'confirmed',
      'subscription_billing_cycle_anchor has no equivalent create_preview parameter; the call needs review.',
    ],
    ['confirmed', 'Spreads, computed or repeated parameters need review.'],
    [
      'confirmed',
      'It sends subscription_details and subscription_* parameters; merging them needs review.',
    ],
    ['review', undefined],
  ]);
  expect(result.findings[4].contractReview).toMatch(/removed the upcoming invoice API/);
  expect(migrationReviewReason(result)).toMatch(/removed the upcoming invoice API/);
});

it('keeps the createPreview rewrite only with the pin and the stripe-node upgrade', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-invoice-preview-'));
  roots.push(root);
  await writeFile(
    join(root, 'billing.js'),
    `import Stripe from 'stripe';
const stripe = new Stripe('sk', { apiVersion: '2025-02-24.acacia' });
export const preview = (customer, subscription) => stripe.invoices.retrieveUpcoming({ customer, subscription });
`,
  );
  // No lockfile: the stripe-node upgrade cannot be prepared, so the rewrite is not kept.
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ dependencies: { stripe: '17.7.0' } }),
  );
  await writeFile(
    join(root, 'provider.json'),
    JSON.stringify({
      ...STRIPE,
      id: 'stripe-invoices',
      operations: [{ resource: 'invoices', method: 'retrieve', schema: 'invoice' }],
    }),
  );
  await writeFile(join(root, 'before.json'), JSON.stringify(before));
  await writeFile(join(root, 'after.json'), JSON.stringify(after));
  const report = await runPipeline({
    repository: root,
    before: join(root, 'before.json'),
    after: join(root, 'after.json'),
    providerConfig: join(root, 'provider.json'),
    apiVersion: '2025-02-24.acacia',
    proposePatch: true,
  });
  expect('diff' in report.patch ? report.patch.diff : '').not.toContain('createPreview');
  expect(report.findings).toEqual([
    expect.objectContaining({
      expression: 'invoices.retrieveUpcoming',
      contractReview: expect.stringContaining('needs review'),
    }),
  ]);
});

// Shaped like an npm v3 lockfile on stripe-node 17 and the registry's stripe 23.0.0 metadata.
const INTEGRITY = `sha512-${'A'.repeat(86)}==`;
const npmFiles = (dependencies: Record<string, string>, locked: string) => ({
  'package.json': `${JSON.stringify({ name: 'app', dependencies }, null, 2)}\n`,
  'package-lock.json': `${JSON.stringify(
    {
      name: 'app',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'app', dependencies },
        'node_modules/stripe': {
          version: locked,
          resolved: `https://registry.npmjs.org/stripe/-/stripe-${locked}.tgz`,
          integrity: INTEGRITY,
        },
      },
    },
    null,
    2,
  )}\n`,
});

it('rewrites retrieveUpcoming with the pin and the stripe-node upgrade in JavaScript', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            name: 'stripe',
            version: '23.0.0',
            license: 'MIT',
            dependencies: {},
            engines: { node: '>=20' },
            dist: {
              tarball: 'https://registry.npmjs.org/stripe/-/stripe-23.0.0.tgz',
              integrity: INTEGRITY,
            },
          }),
        ),
    ),
  );
  const root = await mkdtemp(join(tmpdir(), 'refit-invoice-preview-'));
  roots.push(root);
  // stripe-node 17 has no invoices.createPreview, so the rewrite needs the upgrade even though
  // the client sets its API version.
  for (const [path, content] of Object.entries({
    ...npmFiles({ stripe: '^17.7.0' }, '17.7.0'),
    'billing.js': `import Stripe from 'stripe';
const stripe = new Stripe('sk', { apiVersion: '2025-02-24.acacia' });
export const preview = (customer, subscription) => stripe.invoices.retrieveUpcoming({ customer, subscription });
`,
    'provider.json': JSON.stringify({
      ...STRIPE,
      id: 'stripe-invoices',
      operations: [{ resource: 'invoices', method: 'retrieve', schema: 'invoice' }],
    }),
    'before.json': JSON.stringify(before),
    'after.json': JSON.stringify(after),
  }))
    await writeFile(join(root, path), content);
  const report = await runPipeline({
    repository: root,
    before: join(root, 'before.json'),
    after: join(root, 'after.json'),
    providerConfig: join(root, 'provider.json'),
    apiVersion: '2025-02-24.acacia',
    proposePatch: true,
  });
  expect(report.patch).toMatchObject({
    status: 'proposed',
    unresolvedFindings: 0,
    sdkUpgrade: { from: '17.7.0', to: '23.0.0' },
  });
  const diff = 'diff' in report.patch ? report.patch.diff : '';
  expect(diff).toContain('stripe.invoices.createPreview({ customer, subscription })');
  expect(diff).toContain("apiVersion: '2026-09-30.endive'");
  expect(diff).toContain('"stripe": "^23.0.0"');
  expect(report.findings[0].contractReview).toBeUndefined();
});
