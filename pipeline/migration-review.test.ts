import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runPipeline } from './run.ts';
import { runWorkflow } from './workflow.ts';
import { analyzeRepository } from './analyzer.ts';
import { STRIPE } from './providers.ts';
import { targetReached } from './migration-review.ts';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each(['declared-type', 'skipped-source', 'helper-client'] as const)(
  'blocks paid and executable automation with %s evidence',
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'refit-source-review-'));
    roots.push(root);
    const version = '2025-02-24.acacia';
    const before = resolve('pipeline/fixtures/stripe-webhooks/before.json');
    const after = resolve('pipeline/fixtures/stripe-webhooks/after.json');
    await writeFile(
      join(root, 'client.ts'),
      `import Stripe from 'stripe'; export const stripe = new Stripe('local-fixture', {apiVersion: '${version}'}); ${kind === 'declared-type' ? "export function end(value: unknown) {const subscription = value as Stripe.Subscription; subscription.status = 'active'; return subscription.current_period_end;}" : ''}
${
  kind === 'helper-client'
    ? `export async function end(sdk, id) { const subscription = await sdk.subscriptions.retrieve(id); return subscription.current_period_end; }
void end(stripe, 'sub');
const separate = new Stripe('local-fixture', {apiVersion: '${version}'});
async function direct(id) { const subscription = await separate.subscriptions.retrieve(id); return subscription.current_period_end; }`
    : ''
}`,
    );
    if (kind === 'skipped-source')
      await writeFile(join(root, 'broken.ts'), 'export const value = {,};');
    const fetch = vi.fn(() => {
      throw new Error('Source review must not request a model or GitHub.');
    });
    vi.stubGlobal('fetch', fetch);
    const providerConfig = kind === 'helper-client' ? join(root, 'provider.json') : undefined;
    if (providerConfig)
      await writeFile(
        providerConfig,
        JSON.stringify({
          id: 'stripe-helper-review',
          packageName: 'stripe',
          defaultImport: true,
          namedExport: 'Stripe',
          constructorCalls: true,
          operations: [{ resource: 'subscriptions', method: 'retrieve', schema: 'subscription' }],
        }),
      );
    const options = {
      repository: root,
      before,
      after,
      providerConfig,
      apiVersion: version,
      apiVersionPolicy:
        kind === 'helper-client' ? ('operator-pin' as const) : ('source-verified' as const),
    };
    const report = await runPipeline({
      ...options,
      proposePatch: true,
      aiPatch: { apiKey: 'unused', model: 'unused' },
      assessment: { apiKey: 'unused', model: 'unused' },
    });
    expect(report.patch).toMatchObject({ status: 'not-generated' });
    expect(report.assessment).toMatchObject({ status: 'blocked' });
    if (kind === 'declared-type')
      expect(report.findings).toMatchObject([
        { confidence: 'review', declaredType: { schema: 'subscription' } },
      ]);
    else if (kind === 'skipped-source') expect(report.skippedFiles).toHaveLength(1);
    else {
      expect(report.findings.some((finding) => finding.helperClient?.stability === 'review')).toBe(
        true,
      );
      expect(report.findings.some((finding) => finding.confidence === 'confirmed')).toBe(true);
      expect(report.patch).toMatchObject({
        reason: expect.stringContaining('helper-client provenance'),
      });
    }
    const workflow = await runWorkflow({
      ...options,
      image: 'must-not-inspect',
      command: ['must-not-execute'],
      output: join(tmpdir(), `refit-source-review-output-${root.split('/').at(-1)}`),
    });
    roots.push(workflow.directory);
    expect(workflow.manifest).toMatchObject({ status: 'needs-review', stage: 'scan' });
    expect(fetch).not.toHaveBeenCalled();
  },
);

it('does not let a type cast hide an optional SDK invocation', () => {
  const result = analyzeRepository(
    {
      root: '/type-cast-test',
      files: [
        {
          path: 'billing.ts',
          content: `import Stripe from 'stripe'; const stripe = new Stripe('fixture'); async function history(id) {return ((await stripe.paymentIntents?.retrieve(id)) as Stripe.PaymentIntent).charges;}`,
        },
      ],
      dependencies: [],
      lockfiles: [],
      warnings: [],
    },
    [
      {
        id: 'charges',
        schema: 'payment_intent',
        property: 'charges',
        pointer: '/payment_intent/charges',
      },
    ],
    STRIPE,
    { payment_intent: { type: 'object', properties: { charges: { type: 'object' } } } },
  );
  expect(result.findings).toMatchObject([{ confidence: 'review' }]);
  expect(result.edits).toEqual([]);
});

it('treats an unsigned typed event as a source hint when the contract omits Event', () => {
  const result = analyzeRepository(
    {
      root: '/typed-event-test',
      files: [
        {
          path: 'handler.ts',
          content: `import type Stripe from 'stripe'; function handle(body: string) { const event: Stripe.Event = JSON.parse(body); if(event.type === 'customer.subscription.updated') return event.data.object.current_period_end; }`,
        },
      ],
      dependencies: [],
      lockfiles: [],
      warnings: [],
    },
    [
      {
        id: 'period',
        schema: 'subscription',
        property: 'current_period_end',
        pointer: '/subscription/current_period_end',
      },
    ],
    STRIPE,
    { subscription: { type: 'object', properties: { current_period_end: { type: 'integer' } } } },
  );
  expect(result.findings).toMatchObject([{ confidence: 'review', declaredType: {} }]);
  expect(result.edits).toEqual([]);
});

it('reaches a target only when every breaking change outside the rules is a removed field the code no longer reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-target-reached-'));
  roots.push(root);
  await cp(resolve('pipeline/fixtures/repository'), root, { recursive: true });
  // billing.ts as a merged Refit draft leaves it: the read migrated and the pin moved to the target.
  await writeFile(
    join(root, 'billing.ts'),
    `import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2022-11-15' });
export async function chargeHistory(paymentIntentId: string) {
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
  return (await stripe.charges.list({ payment_intent: intent.id })).data;
}
`,
  );
  const scan = await runPipeline({
    repository: root,
    before: resolve('pipeline/fixtures/before.json'),
    after: resolve('pipeline/fixtures/after.json'),
    apiVersion: '2022-08-01',
  });
  expect(scan.findings).toEqual([]);
  expect(scan.changes.length).toBeGreaterThan(0);
  expect(targetReached(scan)).toBe(true);
  // The full comparison as oasdiff reports it: the removal Refit migrated stays reached.
  const [change] = scan.changes;
  const removal = {
    id: 'response-optional-property-removed',
    level: 3,
    responseSchema: change.schema,
    removedProperty: change.property,
  };
  const compared = (...changes: Record<string, unknown>[]) => ({
    ...scan,
    specificationDiff: {
      engine: 'oasdiff' as const,
      version: 'oasdiff-test',
      changes,
      coverage: 'Simulated full comparison.',
    },
  });
  expect(targetReached(compared(removal))).toBe(true);
  // A change no rule covers, such as a newly required request parameter, still stops for review.
  expect(targetReached(compared(removal, { id: 'new-required-request-parameter', level: 3 }))).toBe(
    false,
  );
  expect(
    targetReached(compared({ ...removal, removedProperty: `${change.property}_untracked` })),
  ).toBe(false);
});
