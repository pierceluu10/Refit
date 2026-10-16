import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import { applySourceEdits } from './patches.ts';
import { STRIPE } from './providers.ts';
import { runPipeline } from './run.ts';
import { digest, findRemovedProperties } from './specifications.ts';
import { createReviewArtifacts } from './review.ts';
import { subscriptionPeriodHelperModule } from './stripe-subscription-periods.ts';
import ts from 'typescript-compiler';
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

function helper(planText?: string) {
  const module: { exports: Record<string, (subscription: object, plan?: unknown) => unknown> } = {
    exports: {},
  };
  new Function('module', subscriptionPeriodHelperModule('cjs'))(module);
  const plan = planText ? new Function(`return ${planText};`)() : undefined;
  return (subscription: object) => module.exports.getSubscriptionPeriodEnd(subscription, plan);
}
const planOf = (replacement: string) => /, (\(items\) => .*)\)\)$/.exec(replacement)?.[1];
const item = (end: number, price = 'price_basic') => ({
  current_period_end: end,
  price: { id: price },
});

it('reads every subscription period through the generated helper', () => {
  const result = analyze(`export async function period(id: string) {
  const subscription = await stripe.subscriptions.retrieve(id);
  return [subscription.current_period_start, subscription?.current_period_end];
}`);
  expect(result.findings.map((finding) => finding.confidence)).toEqual(['confirmed', 'confirmed']);
  expect(result.edits.every((edit) => edit.rule === 'stripe-subscription-periods-helper')).toBe(
    true,
  );
  expect(result.patched).toContain(
    "import { getSubscriptionPeriodStart, getSubscriptionPeriodEnd } from './stripe-subscription-period';",
  );
  expect(result.patched).toContain(
    'return [(getSubscriptionPeriodStart(subscription)), (subscription == null ? undefined : getSubscriptionPeriodEnd(subscription))];',
  );
  expect(result.patched).not.toMatch(/Math\.(max|min)/);
  expect(
    result.edits.find((edit) => edit.file === 'stripe-subscription-period.ts')?.replacement,
  ).toBe(subscriptionPeriodHelperModule('ts'));
  expect(result.findings.map((finding) => finding.subscriptionPeriod)).toEqual([
    { rareCase: 'flagged' },
    { rareCase: 'flagged' },
  ]);
});

it('returns the old field, a shared period or undefined, never a widest period', () => {
  const read = helper();
  expect(read({ current_period_end: 100, items: { data: [item(200)] } })).toBe(100);
  expect(read({ items: { data: [item(200)] } })).toBe(200);
  expect(read({ items: { data: [item(300), item(300, 'price_addon')] } })).toBe(300);
  expect(read({ items: { data: [item(300), item(400, 'price_addon')] } })).toBeUndefined();
  expect(read({ items: { data: [{ price: { id: 'price_basic' } }] } })).toBeUndefined();
  expect(read({ items: { data: [] } })).toBeUndefined();
  expect(read({})).toBeUndefined();
});

it('uses the item the same function selects by index for mixed periods', () => {
  const result = analyze(`export async function access(id: string) {
  const subscription = await stripe.subscriptions.retrieve(id);
  return { price: subscription.items.data[1].price.id, ends: subscription.current_period_end };
}`);
  expect(result.findings[0].subscriptionPeriod).toEqual({
    rareCase: 'item-in-code',
    selection: 'items.data[1]',
  });
  const call = result.edits.find((edit) => edit.replacement.includes('getSubscriptionPeriodEnd('))!;
  expect(planOf(call.replacement)).toBe('(items) => items[1]');
  expect(
    helper(planOf(call.replacement))({ items: { data: [item(300), item(400, 'price_addon')] } }),
  ).toBe(400);
});

it.each([
  ['a top-level constant', `const PRO = 'price_pro';\n`, 'PRO'],
  ['an environment variable', '', 'process.env.STRIPE_PRO_PRICE'],
  ['a literal', '', "'price_pro'"],
])('uses the item the code compares with %s for mixed periods', (_label, declaration, value) => {
  const result = analyze(`${declaration}export async function access(id: string) {
  const subscription = await stripe.subscriptions.retrieve(id);
  const paid = subscription.items.data.some((entry) => entry.price.id === ${value});
  return paid ? subscription.current_period_end : 0;
}`);
  expect(result.findings[0].subscriptionPeriod).toEqual({
    rareCase: 'item-in-code',
    selection: `price.id === ${value}`,
  });
  const plan = planOf(
    result.edits.find((edit) => edit.replacement.includes('getSubscriptionPeriodEnd('))!
      .replacement,
  );
  expect(plan).toBe(`(items) => items.find((item) => item.price?.id === ${value})`);
  if (value === "'price_pro'")
    expect(helper(plan)({ items: { data: [item(300), item(400, 'price_pro')] } })).toBe(400);
});

it('uses the configured price policy item when the code selects none', () => {
  const content = `${header}export async function ends(id: string) {
  const subscription = await stripe.subscriptions.retrieve(id);
  return subscription.current_period_end;
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
  expect(result.findings[0].subscriptionPeriod).toEqual({
    rareCase: 'price-policy',
    selection: 'price.id === "price_primary"',
  });
  const plan = planOf(
    result.edits.find((edit) => edit.replacement.includes('getSubscriptionPeriodEnd('))!
      .replacement,
  );
  expect(helper(plan)({ items: { data: [item(300), item(400, 'price_primary')] } })).toBe(400);
});

it('reads webhook payloads and Stripe-typed values through the helper', () => {
  const result = analyze(`export function fromWebhook(body: string, signature: string) {
  const event = stripe.webhooks.constructEvent(body, signature, 'whsec');
  if (event.type === 'customer.subscription.updated') {
    const subscription = event.data.object as Stripe.Subscription;
    return subscription.current_period_end;
  }
}
export function fromParameter(subscription: Stripe.Subscription) {
  return subscription.current_period_start;
}`);
  expect(result.findings.filter((finding) => finding.confidence === 'confirmed')).toHaveLength(2);
  expect(result.findings.find((finding) => finding.webhook)?.webhook?.migration).toEqual({
    rule: 'stripe-subscription-periods-helper',
  });
  expect(result.patched).toContain('return (getSubscriptionPeriodEnd(subscription));');
  expect(result.patched).toContain('return (getSubscriptionPeriodStart(subscription));');
});

it('writes a CommonJS helper for CommonJS files', () => {
  const content = `const Stripe = require('stripe');
const stripe = new Stripe('sk', { apiVersion: '2024-06-20' });
async function ends(id) {
  const subscription = await stripe.subscriptions.retrieve(id);
  return subscription.current_period_end;
}
module.exports = { ends };
`;
  const result = analyzeRepository(
    {
      root: '/field-moves',
      files: [{ path: 'lib/billing.js', content }],
      dependencies: [],
      lockfiles: [],
      warnings: [],
    },
    findRemovedProperties(schemas(false), schemas(true), provider.id),
    provider,
    schemas(false),
  );
  const patched = applySourceEdits(
    content,
    result.edits.filter((edit) => edit.file === 'lib/billing.js'),
  );
  expect(patched).toContain(
    "const Stripe = require('stripe');\nconst { getSubscriptionPeriodEnd } = require('./stripe-subscription-period');\nconst stripe = new Stripe(",
  );
  expect(
    result.edits.find((edit) => edit.file === 'lib/stripe-subscription-period.js')?.replacement,
  ).toBe(subscriptionPeriodHelperModule('cjs'));
});

it('generates a TypeScript helper that compiles strictly without Stripe types', () => {
  const files = new Map([
    ['/check/helper.ts', subscriptionPeriodHelperModule('ts')],
    [
      '/check/use.ts',
      `import { getSubscriptionPeriodEnd } from './helper';
const subscription = { items: { data: [{ price: { id: 'p' }, current_period_end: 1 }] } };
export const ends: number = getSubscriptionPeriodEnd(subscription, (items) => items.find((item) => item.price?.id === 'p'));
export const first: number = getSubscriptionPeriodEnd(subscription, (items) => items[0]);
`,
    ],
  ]);
  const options = {
    strict: true,
    noEmit: true,
    noLib: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  host.readFile = (name) => files.get(name) ?? read(name);
  host.fileExists = (name) => files.has(name) || ts.sys.fileExists(name);
  host.directoryExists = (name) => name === '/check' || ts.sys.directoryExists(name);
  const getSource = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version) =>
    files.has(name)
      ? ts.createSourceFile(name, files.get(name)!, version, true)
      : getSource(name, version);
  const program = ts.createProgram([...files.keys()], options, host);
  expect(
    ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
  ).toEqual([]);
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

it('reads a webhook invoice.subscription through the generated helper for either version', async () => {
  const report = await run(mixed);
  expect(report.findings.find((finding) => finding.webhook)).toMatchObject({
    confidence: 'confirmed',
    expression: '.subscription',
    webhook: { migration: { rule: 'stripe-invoice-subscription-helper' } },
  });
  expect(report.patch).toMatchObject({ status: 'proposed', unresolvedFindings: 0 });
  const diff = 'diff' in report.patch ? report.patch.diff : '';
  expect(diff).toContain('getSubscriptionPeriodEnd(subscription)');
  expect(diff).toContain('+    return (getInvoiceSubscription(invoice));');
  expect(diff).toContain(
    "+import { getSubscriptionPeriodEnd, getInvoiceSubscription } from './stripe-subscription-period';",
  );
  const helper = subscriptionPeriodHelperModule('cjs');
  const { getInvoiceSubscription } = new Function('module', `${helper}; return module.exports;`)(
    {},
  );
  expect(getInvoiceSubscription({ subscription: 'sub_old' })).toBe('sub_old');
  expect(getInvoiceSubscription({ subscription: null })).toBeNull();
  expect(
    getInvoiceSubscription({ parent: { subscription_details: { subscription: 'sub_new' } } }),
  ).toBe('sub_new');
  expect(getInvoiceSubscription({ parent: null })).toBeNull();
});

it('leaves invoice.subscription unresolved when it is expanded', async () => {
  const report = await run(
    `${mixed}
export const paid = (id: string) => stripe.invoices.retrieve(id, { expand: ['subscription'] });`,
  );
  expect(report.patch).toMatchObject({ status: 'proposed', unresolvedFindings: 1 });
  const diff = 'diff' in report.patch ? report.patch.diff : '';
  expect(diff).toContain('+    return invoice.subscription;');
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
    edits: 4,
    unresolvedFindings: 0,
    source:
      'https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end',
  });
  const diff = 'diff' in report.patch ? report.patch.diff : '';
  expect(diff).toContain("+const stripe = new Stripe('sk', { apiVersion: '2025-03-31.basil' });");
  expect(diff).toContain('return (getSubscriptionPeriodEnd(subscription));');
  expect(diff).toContain(
    'diff --git "a/stripe-subscription-period.ts" "b/stripe-subscription-period.ts"\nnew file mode 100644\n--- /dev/null',
  );
});

it('migrates reads for a client on the account default version without pinning one', async () => {
  const report = await run(periodRead, true, undefined, '{ apiVersion: null }');
  expect(report.findings).toMatchObject([{ confidence: 'confirmed' }]);
  expect(report.patch).toMatchObject({ status: 'proposed', edits: 3, unresolvedFindings: 0 });
  const diff = 'diff' in report.patch ? report.patch.diff : '';
  expect(diff).toContain('getSubscriptionPeriodEnd(subscription)');
  expect(diff).not.toContain('2025-03-31.basil');
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
  expect(report.patch).toMatchObject({ status: 'proposed', edits: 5, unresolvedFindings: 0 });
  const diff = 'diff' in report.patch ? report.patch.diff : '';
  expect(diff).toContain('invoice.confirmation_secret');
  expect(diff).toContain('getSubscriptionPeriodEnd(subscription)');
  expect(diff).toContain("apiVersion: '2025-03-31.basil'");
});

it('lists mixed-period reads without a selection in the pull request text', async () => {
  const scan = await run(periodRead);
  if (!('diff' in scan.patch)) throw new Error('Expected a patch');
  expect(scan.findings[0].subscriptionPeriod).toEqual({ rareCase: 'flagged' });
  const body = createReviewArtifacts({
    ...scan,
    publicationFiles: [],
    patch: { ...scan.patch, validation: 'passed' },
    validation: {
      status: 'passed',
      revision: 'a'.repeat(40),
      image: `sha256:${'b'.repeat(64)}`,
      command: ['npm', 'test'],
      baselineCommand: ['npm', 'test'],
      archiveHash: 'c'.repeat(64),
      patchHash: digest(scan.patch.diff),
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
  expect(body).toContain(
    'Subscriptions with items on different billing periods are not handled; set `stripeSubscriptionPeriods` to choose the item at',
  );
  expect(body).toContain('`billing.ts:5`');
});

it('returns the rule patch without calling the model when rules cover every finding', async () => {
  const fetch = vi.fn(() => {
    throw new Error('Rules cover every finding; the model must not be called.');
  });
  vi.stubGlobal('fetch', fetch);
  const report = await run(periodRead, true, { apiKey: 'test-key', model: 'test-model' });
  expect(report.patch).toMatchObject({
    status: 'proposed',
    generator: 'deterministic',
    unresolvedFindings: 0,
  });
  expect(fetch).not.toHaveBeenCalled();
});

// Reduced 2025-02-24.acacia → 2025-03-31.basil invoicing contracts for moves without a rule.
function invoicingSchemas(after: boolean): Record<string, unknown> {
  return {
    invoice: {
      type: 'object',
      properties: {
        id: string,
        lines: list('line_item'),
        ...(after
          ? { confirmation_secret: string }
          : { payment_intent: { anyOf: [string, ref('payment_intent')], nullable: true } }),
      },
    },
    payment_intent: { type: 'object', properties: { id: string } },
    line_item: {
      type: 'object',
      properties: {
        id: string,
        amount: integer,
        ...(after ? {} : { type: string, price: { anyOf: [ref('price')], nullable: true } }),
      },
    },
    price: { type: 'object', properties: { id: string, nickname: string } },
  };
}

it('leaves invoicing moves without a behaviour-preserving read unresolved with their reason', () => {
  const content = `${header}export async function lines(id: string) {
  const invoice = await stripe.invoices.retrieve(id);
  const line = invoice.lines.data[0];
  return [invoice.payment_intent, line.type, line.price?.nickname, line.amount];
}`;
  const result = analyzeRepository(
    {
      root: '/field-moves',
      files: [{ path: 'billing.ts', content }],
      dependencies: [],
      lockfiles: [],
      warnings: [],
    },
    findRemovedProperties(invoicingSchemas(false), invoicingSchemas(true), provider.id),
    provider,
    invoicingSchemas(false),
  );
  expect(result.edits).toEqual([]);
  expect(
    result.findings.map((finding) => [finding.expression, finding.confidence, finding.reason]),
  ).toEqual([
    ['.payment_intent', 'confirmed', expect.stringContaining('invoice.confirmation_secret')],
    ['.type', 'confirmed', expect.stringContaining('documents no mapping between the values')],
    ['.price', 'confirmed', expect.stringContaining('holds only the price ID')],
  ]);
  expect(result.findings[0].reason).toMatch(
    /^Removed field read on a statically traced stripe-moves invoice response\. Stripe 2025-03-31\.basil removed invoice\.payment_intent.*add-support-for-multiple-partial-payments-on-invoices$/,
  );
});
