import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CARD_PAYMENT_METHOD_WARNING } from './patches.ts';
import { createReviewArtifacts } from './review.ts';
import { runPipeline } from './run.ts';
import { digest } from './specifications.ts';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

// Shaped like Stripe's dahlia and endive Checkout Session create bodies.
function contract(version: string, fields: string[]) {
  return {
    openapi: '3.0.0',
    info: { version },
    paths: {
      '/v1/checkout/sessions': {
        post: {
          operationId: 'PostCheckoutSessions',
          requestBody: {
            content: {
              'application/x-www-form-urlencoded': {
                schema: {
                  type: 'object',
                  properties: Object.fromEntries(fields.map((name) => [name, {}])),
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: { 'checkout.session': { type: 'object', properties: { id: { type: 'string' } } } },
    },
  };
}

async function run(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-card-methods-'));
  directories.push(root);
  const repository = join(root, 'repository');
  await mkdir(repository);
  await writeFile(
    join(repository, 'package.json'),
    JSON.stringify({ dependencies: { stripe: '22.6.2' } }),
  );
  for (const [path, content] of Object.entries(files))
    await writeFile(join(repository, path), content);
  const before = join(root, 'before.json');
  const after = join(root, 'after.json');
  const providerConfig = join(root, 'provider.json');
  await writeFile(
    before,
    JSON.stringify(contract('2026-08-26.dahlia', ['mode', 'payment_method_types'])),
  );
  await writeFile(
    after,
    JSON.stringify(contract('2026-09-30.endive', ['mode', 'allowed_payment_method_types'])),
  );
  await writeFile(
    providerConfig,
    JSON.stringify({
      id: 'stripe-checkout',
      packageName: 'stripe',
      defaultImport: true,
      namedExport: 'Stripe',
      constructorCalls: true,
      apiVersion: { constructorArgument: 1, property: 'apiVersion', requestArguments: [1, 2] },
      operations: [
        {
          resource: 'checkout.sessions',
          method: 'create',
          schema: 'checkout.session',
          operationId: 'PostCheckoutSessions',
        },
      ],
    }),
  );
  return runPipeline({
    repository,
    before,
    after,
    providerConfig,
    apiVersion: '2026-08-26.dahlia',
    proposePatch: true,
  });
}

const checkout = (
  methods: string,
  options = "{ apiVersion: '2026-08-26.dahlia' }",
) => `import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_KEY, ${options});
export const checkout = () => stripe.checkout.sessions.create({ mode: 'subscription', payment_method_types: ${methods} });
`;

it("moves ['card'] to allowed_payment_method_types together with the endive pin", async () => {
  const report = await run({ 'checkout.js': checkout("['card']") });
  expect(report.patch).toMatchObject({ status: 'proposed', generator: 'deterministic' });
  if (!('diff' in report.patch)) throw new Error('Expected a patch');
  expect(report.patch.diff).toContain(
    "+export const checkout = () => stripe.checkout.sessions.create({ mode: 'subscription', allowed_payment_method_types: ['card'] });",
  );
  expect(report.patch.diff).toContain(
    "+const stripe = new Stripe(process.env.STRIPE_KEY, { apiVersion: '2026-09-30.endive' });",
  );
  expect(report.patch.summary).toBe(
    "Replace payment_method_types: ['card'] with allowed_payment_method_types and update the pinned Stripe API version.",
  );
  expect(report.patch.warnings).toContain(CARD_PAYMENT_METHOD_WARNING);
  expect(report.findings).toMatchObject([
    { changeId: 'request-parameter:PostCheckoutSessions.payment_method_types' },
  ]);
  expect(report.findings[0].requestParameter).toBeUndefined();
});

it.each([
  ['without a literal API version pin', { 'checkout.js': checkout("['card']", '{}') }],
  [
    'when another call sends card and PayPal',
    {
      'checkout.js':
        checkout("['card']") +
        checkout("['card', 'paypal']").split('\n')[2].replace('checkout =', 'paypal ='),
    },
  ],
  [
    'for a TypeScript project whose stripe package cannot be upgraded',
    { 'checkout.ts': checkout("['card']") },
  ],
])('keeps stopping for review %s', async (_case, files) => {
  const report = await run(files);
  expect(report.patch).toMatchObject({
    status: 'not-generated',
    reason: expect.stringMatching(/parameter the target API version removed/),
  });
  // A site the card rule could rename may be marked migratable, but any other site keeps the stop.
  expect(report.findings.some((finding) => finding.requestParameter)).toBe(true);
  if (!Object.values(files).join('').includes('paypal'))
    expect(report.findings.every((finding) => finding.requestParameter)).toBe(true);
});

it('tells the reviewer to keep cards enabled in the draft PR', async () => {
  const report = await run({ 'checkout.js': checkout("['card']") });
  if (!('diff' in report.patch)) throw new Error('Expected a patch');
  const check = { status: 'passed' as const, exitCode: 0, stdout: '', stderr: '' };
  const description = createReviewArtifacts({
    ...report,
    publicationFiles: [{ path: 'checkout.js', mode: '100644', content: 'export {};' }],
    patch: { ...report.patch, validation: 'passed' },
    validation: {
      status: 'passed',
      revision: 'a'.repeat(40),
      image: `sha256:${'b'.repeat(64)}`,
      command: ['npm', 'test'],
      baselineCommand: ['npm', 'test'],
      archiveHash: 'c'.repeat(64),
      patchHash: digest(report.patch.diff),
      baseline: check,
      patched: check,
      limits: {
        timeoutMs: 120_000,
        outputBytes: 1024 * 1024,
        network: 'none',
        workspace: '512m' as const,
        memory: '1g' as const,
      },
      publishable: true,
      attempts: [],
      repair: { limit: 0, requested: 0, stopReason: 'not-needed-or-disabled', error: null },
      reason: 'Synthetic check results for artifact formatting tests.',
    },
  }).files['pull-request.md'];
  expect(description).toContain(
    'moves to `allowed_payment_method_types` under the owner-approved policy',
  );
  expect(description).toContain('confirm cards stay enabled in the Stripe Dashboard');
});
