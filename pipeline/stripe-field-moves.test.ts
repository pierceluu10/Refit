import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import { applySourceEdits } from './patches.ts';
import { STRIPE } from './providers.ts';
import { runPipeline } from './run.ts';
import { findRemovedProperties } from './specifications.ts';
import { migrationReviewReason } from './migration-review.ts';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const string = { type: 'string' };
const integer = { type: 'integer' };
const ref = (schema: string) => ({ $ref: `#/components/schemas/${schema}` });
const list = (schema: string) => ({
  type: 'object',
  properties: { has_more: { type: 'boolean' }, data: { type: 'array', items: ref(schema) } },
});

// Reduced Stripe contracts for the 2025-03-31.basil field moves.
function schemas(after: boolean, moved = true): Record<string, unknown> {
  return {
    subscription: {
      type: 'object',
      properties: {
        id: string,
        items: list('subscription_item'),
        ...(after ? {} : { current_period_start: integer, current_period_end: integer }),
      },
    },
    subscription_item: {
      type: 'object',
      properties: {
        id: string,
        ...(after && moved ? { current_period_start: integer, current_period_end: integer } : {}),
      },
    },
    invoice: {
      type: 'object',
      properties: {
        id: string,
        ...(after
          ? {
              confirmation_secret: string,
              ...(moved ? { parent: { anyOf: [ref('invoice_parent')], nullable: true } } : {}),
            }
          : {
              payment_intent: string,
              subscription: { anyOf: [string, ref('subscription')], nullable: true },
            }),
      },
    },
    invoice_parent: {
      type: 'object',
      properties: { subscription_details: { anyOf: [ref('subscription_parent')], nullable: true } },
    },
    subscription_parent: {
      type: 'object',
      properties: { subscription: { anyOf: [string, ref('subscription')] } },
    },
  };
}

const provider = {
  ...STRIPE,
  id: 'stripe-moves',
  operations: [
    { resource: 'subscriptions', method: 'retrieve', schema: 'subscription' },
    { resource: 'invoices', method: 'retrieve', schema: 'invoice' },
  ],
};
const header = `import Stripe from 'stripe';\nconst stripe = new Stripe('sk', { apiVersion: '2024-06-20' });\n`;

function analyze(body: string) {
  const content = header + body;
  const repository = {
    root: '/field-moves',
    files: [{ path: 'billing.ts', content }],
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
  const result = analyzeRepository(
    repository,
    findRemovedProperties(schemas(false), schemas(true), provider.id),
    provider,
    schemas(false),
  );
  return { ...result, patched: applySourceEdits(content, result.edits) };
}

it('moves subscription period reads on SDK responses to the widest item period', () => {
  const result = analyze(`export async function period(id: string) {
  const subscription = await stripe.subscriptions.retrieve(id);
  return [subscription.current_period_start, subscription.current_period_end];
}`);
  expect(result.findings.map((finding) => finding.confidence)).toEqual(['confirmed', 'confirmed']);
  expect(result.edits.map((edit) => edit.rule)).toEqual([
    'stripe-subscription-periods-items',
    'stripe-subscription-periods-items',
  ]);
  expect(result.patched).toContain(
    'return [(Math.min(...subscription.items.data.map((item) => item.current_period_start))), (Math.max(...subscription.items.data.map((item) => item.current_period_end)))];',
  );
});

it('keeps an optional receiver optional and skips longer optional chains', () => {
  const result =
    analyze(`export async function period(id: string, holder?: { sub: Stripe.Subscription }) {
  const subscription = await stripe.subscriptions.retrieve(id);
  const wrapped = { sub: subscription } as { sub: typeof subscription } | undefined;
  return [subscription?.current_period_end, wrapped?.sub.current_period_end];
}`);
  expect(result.patched).toContain(
    '(subscription == null ? undefined : Math.max(...subscription.items.data.map((item) => item.current_period_end)))',
  );
  expect(result.patched).toContain('wrapped?.sub.current_period_end');
});

it('reads both period shapes on webhook payloads and Stripe-typed values', () => {
  const result = analyze(`export function fromWebhook(body: string, signature: string) {
  const event = stripe.webhooks.constructEvent(body, signature, 'whsec');
  if (event.type === 'customer.subscription.updated') {
    const subscription = event.data.object as Stripe.Subscription;
    return subscription.current_period_end;
  }
}
export function fromParameter(subscription?: Stripe.Subscription) {
  return subscription?.current_period_start;
}`);
  expect(result.findings.filter((finding) => finding.confidence === 'confirmed')).toHaveLength(2);
  expect(result.edits.map((edit) => edit.rule)).toEqual([
    'stripe-subscription-periods-either-version',
    'stripe-subscription-periods-either-version',
  ]);
  expect(result.findings.find((finding) => finding.webhook)?.webhook?.migration).toEqual({
    rule: 'stripe-subscription-periods-either-version',
  });
  expect(result.patched).toContain(
    "return (Reflect.get(subscription, 'current_period_end') ?? [Math.max(...(subscription.items?.data ?? []).map((item) => item.current_period_end))].find(Number.isFinite));",
  );
  expect(result.patched).toContain(
    "return (subscription == null ? undefined : Reflect.get(subscription, 'current_period_start') ?? [Math.min(...(subscription.items?.data ?? []).map((item) => item.current_period_start))].find(Number.isFinite));",
  );
});

it('evaluates the version-tolerant read against both payload shapes and missing periods', () => {
  const content = `${header}export function read(subscription: Stripe.Subscription) {
  return subscription.current_period_end;
}`;
  const result = analyze(content.slice(header.length));
  const expression = result.patched.slice(result.patched.indexOf('return ') + 7, -3);
  const read = new Function('subscription', `return ${expression};`) as (value: unknown) => unknown;
  expect(read({ current_period_end: 100, items: { data: [{}] } })).toBe(100);
  expect(
    read({ items: { data: [{ current_period_end: 200 }, { current_period_end: 300 }] } }),
  ).toBe(300);
  expect(read({ items: { data: [{}] } })).toBeUndefined();
  expect(read({ items: { data: [] } })).toBeUndefined();
  expect(read({})).toBeUndefined();
});

it('leaves the rule to a configured price-ID policy', () => {
  const content = `${header}export function fromWebhook(body: string, signature: string) {
  const event = stripe.webhooks.constructEvent(body, signature, 'whsec');
  if (event.type === 'customer.subscription.updated') {
    const subscription = event.data.object as Stripe.Subscription;
    return subscription.current_period_end;
  }
}`;
  const result = analyzeRepository(
    {
      root: '/field-moves',
      files: [{ path: 'billing.ts', content }],
      dependencies: [],
      lockfiles: [],
      warnings: [],
    },
    findRemovedProperties(schemas(false), schemas(true), provider.id),
    {
      ...provider,
      stripeSubscriptionPeriods: {
        priceId: 'price_primary',
        beforeApiVersion: '2025-02-24.acacia',
        afterApiVersion: '2025-03-31.basil',
      },
    },
    schemas(false),
  );
  expect(
    result.edits.some((edit) => edit.rule === 'stripe-subscription-periods-either-version'),
  ).toBe(false);
});

const mixed = `export async function ends(id: string) {
  const subscription = await stripe.subscriptions.retrieve(id);
  return subscription.current_period_end;
}
export function invoiceOwner(body: string, signature: string) {
  const event = stripe.webhooks.constructEvent(body, signature, 'whsec');
  if (event.type === 'invoice.paid') {
    const invoice = event.data.object as Stripe.Invoice;
    return invoice.subscription;
  }
}`;

it('patches around an unmigrated webhook read and leaves it unresolved', async () => {
  const report = await run(mixed);
  expect(report.findings.find((finding) => finding.webhook)).toMatchObject({
    confidence: 'confirmed',
    expression: '.subscription',
  });
  expect(report.patch).toMatchObject({ status: 'proposed', unresolvedFindings: 1 });
  const diff = 'diff' in report.patch ? report.patch.diff : '';
  expect(diff).toContain('item.current_period_end');
  expect(diff).not.toContain('parent');
  expect(migrationReviewReason(report)).toMatch(/incoming API-version/);
});

async function run(
  body: string,
  moved = true,
  aiPatch?: { apiKey: string; model: string },
  options = `{ apiVersion: '2024-06-20' }`,
) {
  const root = await mkdtemp(join(tmpdir(), 'refit-field-moves-'));
  roots.push(root);
  await writeFile(
    join(root, 'billing.ts'),
    header.replace(`{ apiVersion: '2024-06-20' }`, options) + body,
  );
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'app', dependencies: { stripe: '16.0.0' } }),
  );
  const contract = (after: boolean) => ({
    openapi: '3.0.3',
    info: {
      title: 'Simulated Stripe contract',
      version: after ? '2025-03-31.basil' : '2024-06-20',
    },
    paths: {},
    components: { schemas: schemas(after, moved) },
  });
  await writeFile(join(root, 'before.json'), JSON.stringify(contract(false)));
  await writeFile(join(root, 'after.json'), JSON.stringify(contract(true)));
  await writeFile(join(root, 'provider.json'), JSON.stringify(provider));
  return runPipeline({
    repository: root,
    before: join(root, 'before.json'),
    after: join(root, 'after.json'),
    providerConfig: join(root, 'provider.json'),
    apiVersion: '2024-06-20',
    ...(aiPatch ? { aiPatch } : { proposePatch: true }),
  });
}

const periodRead = `export async function ends(id: string) {
  const subscription = await stripe.subscriptions.retrieve(id);
  return subscription.current_period_end;
}`;

it('proposes the field move and the API-version bump as one patch', async () => {
  const report = await run(periodRead);
  expect(report.patch).toMatchObject({
    status: 'proposed',
    edits: 2,
    unresolvedFindings: 0,
    source:
      'https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end',
  });
  const diff = 'diff' in report.patch ? report.patch.diff : '';
  expect(diff).toContain("+const stripe = new Stripe('sk', { apiVersion: '2025-03-31.basil' });");
  expect(diff).toContain('item.current_period_end');
});

it('does not move reads when the client follows the account default version', async () => {
  const report = await run(periodRead, true, undefined, '{ apiVersion: null }');
  expect(report.findings).toMatchObject([{ confidence: 'confirmed' }]);
  expect(report.patch).toMatchObject({ status: 'unsupported', edits: 0 });
});

it('does not move a field the target contract does not define', async () => {
  const report = await run(periodRead, false);
  expect(report.findings).toMatchObject([{ confidence: 'confirmed' }]);
  expect(report.patch).toMatchObject({ status: 'unsupported', edits: 0 });
});

it('sends only rule-free findings to AI and returns one patch with rule, AI and version edits', async () => {
  let evidence: { findings: { id: string; expression: string }[] } | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      evidence = JSON.parse(JSON.parse(init.body).input[0].content);
      const finding = evidence!.findings.find((entry) => entry.expression === '.payment_intent')!;
      return new Response(
        JSON.stringify({
          id: 'resp_patch',
          model: 'test-model',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    summary: 'Read the confirmation secret.',
                    uncertainties: [],
                    edits: [
                      {
                        file: 'billing.ts',
                        findingId: finding.id,
                        original: 'invoice.payment_intent',
                        replacement: 'invoice.confirmation_secret',
                      },
                    ],
                  }),
                },
              ],
            },
          ],
        }),
      );
    }),
  );
  const report = await run(
    `${periodRead}
export async function secret(id: string) {
  const invoice = await stripe.invoices.retrieve(id);
  return invoice.payment_intent;
}`,
    true,
    { apiKey: 'test-key', model: 'test-model' },
  );
  expect(evidence!.findings.map((finding) => finding.expression)).toEqual(['.payment_intent']);
  expect(report.patch).toMatchObject({ status: 'proposed', edits: 3, unresolvedFindings: 0 });
  const diff = 'diff' in report.patch ? report.patch.diff : '';
  expect(diff).toContain('invoice.confirmation_secret');
  expect(diff).toContain('item.current_period_end');
  expect(diff).toContain("apiVersion: '2025-03-31.basil'");
});
