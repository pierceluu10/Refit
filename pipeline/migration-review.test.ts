import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runPipeline } from './run.ts';
import { analyzeRepository } from './analyzer.ts';
import { STRIPE } from './providers.ts';
import { removedParameterSites, targetReached } from './migration-review.ts';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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

it('names at most three calls that still send a removed parameter and counts the rest', () => {
  const sends = (line: number) => ({
    file: 'billing.js',
    line,
    column: 1,
    changeId: 'removed-payment-method-types',
    expression: 'checkout.sessions.create',
    confidence: 'review' as const,
    reason: 'Removed parameter.',
    requestParameter: { operationId: 'PostCheckoutSessions', parameter: 'payment_method_types' },
  });
  expect(removedParameterSites([sends(4)])).toBe(
    'The call: billing.js:4 sends payment_method_types.',
  );
  expect(removedParameterSites([1, 2, 3, 4, 5].map(sends))).toBe(
    'The calls: billing.js:1 sends payment_method_types; billing.js:2 sends payment_method_types; billing.js:3 sends payment_method_types; and 2 more in the run report.',
  );
});
