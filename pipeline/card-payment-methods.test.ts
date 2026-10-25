import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  CARD_PAYMENT_METHOD_WARNING,
  listedPaymentMethodWarning,
  movedPaymentMethodWarning,
} from './patches.ts';
import { createReviewArtifacts } from './review.ts';
import { runPipeline } from './run.ts';
import { digest } from './specifications.ts';
import { SUBSCRIPTION_PERIOD_RULE } from './stripe-subscription-periods.ts';
import { droppedRequestParameters } from './validation.ts';
import { removedParameterSites } from './migration-review.ts';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
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

async function run(
  files: Record<string, string>,
  proposePatch = true,
  keepListedPaymentMethods?: boolean,
) {
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
    proposePatch,
    ...(keepListedPaymentMethods === undefined ? {} : { keepListedPaymentMethods }),
  });
}

const checkout = (
  methods: string,
  options = "{ apiVersion: '2026-08-26.dahlia' }",
) => `import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_KEY, ${options});
export const checkout = () => stripe.checkout.sessions.create({ mode: 'subscription', payment_method_types: ${methods} });
`;

// O1's reproduction: the price-policy fixture is a configured subscription-period migration
// (acacia to basil), whose patch carries neither the pin nor the stripe-node upgrade, so the
// rename would ship allowed_payment_method_types on acacia, which rejects it.
it('keeps the card stop on a configured-migration patch, which never moves the pin', async () => {
  const fixture = resolve('pipeline/fixtures/stripe-webhooks');
  const read = (path: string) => readFile(join(fixture, path), 'utf8');
  const merged = async (path: string, version: string, fields: string[]) => {
    const projection = JSON.parse(await read(path));
    const card = contract(version, fields);
    return JSON.stringify({
      ...projection,
      paths: { ...projection.paths, ...card.paths },
      components: { schemas: { ...projection.components.schemas, ...card.components.schemas } },
    });
  };
  const provider = JSON.parse(await read('provider-price-policy.json'));
  provider.operations.push({
    resource: 'checkout.sessions',
    method: 'create',
    schema: 'checkout.session',
    operationId: 'PostCheckoutSessions',
  });
  const root = await mkdtemp(join(tmpdir(), 'refit-card-configured-'));
  directories.push(root);
  for (const [path, content] of Object.entries({
    'package.json': await read('repository/package.json'),
    'client.js': await read('repository/client.js'),
    'entitlements.js': await read('repository/entitlements.js'),
    'checkout.js': `import { stripe } from './client.js';
export const checkout = () => stripe.checkout.sessions.create({ mode: 'subscription', payment_method_types: ['card'] });
`,
    'before.json': await merged('before.json', '2025-02-24.acacia', [
      'mode',
      'payment_method_types',
    ]),
    'after.json': await merged('after.json', '2025-03-31.basil', [
      'mode',
      'allowed_payment_method_types',
    ]),
    'provider.json': JSON.stringify(provider),
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
  expect(
    report.findings.some(
      (finding) => finding.webhook?.migration?.rule === SUBSCRIPTION_PERIOD_RULE,
    ),
  ).toBe(true);
  expect('diff' in report.patch ? report.patch.diff : '').not.toContain(
    'allowed_payment_method_types',
  );
  expect(report.findings.find((finding) => finding.requestParameter)).toMatchObject({
    file: 'checkout.js',
    requestParameter: { parameter: 'payment_method_types' },
    reason: expect.stringContaining(
      'but this patch applies a configured migration, which does not move the API version.',
    ),
  });
});

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
    'when another call sends card and PayPal and keep-listed is turned off',
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
  const report = await run(files, true, false);
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
    // A full comparison also records removals this code never reads.
    changes: [
      ...report.changes,
      { id: 'unread', schema: 'charge', property: 'legacy_field', pointer: '/charge/legacy_field' },
    ],
    publicationFiles: [{ path: 'checkout.js', mode: '100644', content: 'export {};' }],
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
  expect(description).not.toContain('legacy_field');
  expect(description).toContain('confirm cards stay enabled in the Stripe Dashboard');
  // The code sends the removed parameter; it reads no removed response field.
  expect(description).toContain(
    'Stripe API 2026-09-30.endive removes request fields this code sends.',
  );
  expect(description).toContain(
    '- `checkout.js`: Sends `allowed_payment_method_types` in place of the removed `payment_method_types`.',
  );
  expect(description).not.toContain('response fields');
  expect(description).not.toContain('Migrates reads');
});

it('lets the validation preflight through without a patch request when the pin moves', async () => {
  const report = await run({ 'checkout.js': checkout("['card']") }, false);
  expect(report.patch).toMatchObject({ status: 'not-generated' });
  expect(report.findings[0].requestParameter).toBeUndefined();
  // A client without the option follows the package's pin; the upgrade is checked with the patch.
  const sdkPinned = await run({ 'checkout.js': checkout("['card']", '{}') }, false);
  expect(sdkPinned.findings[0].requestParameter).toBeUndefined();
  const accountDefault = await run(
    { 'checkout.js': checkout("['card']", '{ apiVersion: null }') },
    false,
  );
  expect(accountDefault.findings[0].requestParameter).toBeDefined();
});

// Shaped like an npm v3 lockfile on stripe-node 22 and the registry's stripe 23.0.0 metadata.
const INTEGRITY = `sha512-${'A'.repeat(86)}==`;
const npmProject = {
  'package.json': `${JSON.stringify({ name: 'app', dependencies: { stripe: '^22.6.2' } }, null, 2)}\n`,
  'package-lock.json': `${JSON.stringify(
    {
      name: 'app',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'app', dependencies: { stripe: '^22.6.2' } },
        'node_modules/stripe': {
          version: '22.6.2',
          resolved: 'https://registry.npmjs.org/stripe/-/stripe-22.6.2.tgz',
          integrity: INTEGRITY,
        },
      },
    },
    null,
    2,
  )}\n`,
};
function registry() {
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
}

it('moves the card rename with the stripe-node upgrade when no client sets apiVersion', async () => {
  registry();
  const report = await run({ ...npmProject, 'checkout.js': checkout("['card']", '{}') });
  expect(report.patch).toMatchObject({
    status: 'proposed',
    generator: 'deterministic',
    sdkUpgrade: { from: '22.6.2', to: '23.0.0' },
  });
  if (!('diff' in report.patch)) throw new Error('Expected a patch');
  expect(report.patch.diff).toContain('allowed_payment_method_types');
  expect(report.patch.diff).toContain('"stripe": "^23.0.0"');
  expect(report.patch.diff).not.toContain('apiVersion');
  expect(report.findings[0].requestParameter).toBeUndefined();
});

it.each([
  ['an account-default client', '{ apiVersion: null }', ''],
  ['an old setApiVersion call', '{}', "stripe.setApiVersion('2026-08-26.dahlia');\n"],
])('keeps stopping for review with %s', async (_case, options, extra) => {
  registry();
  const report = await run({ ...npmProject, 'checkout.js': checkout("['card']", options) + extra });
  expect(report.patch).toMatchObject({ status: 'not-generated' });
  expect(report.findings.some((finding) => finding.requestParameter)).toBe(true);
});

it('upgrades the package when a pinned and an unpinned client share a JavaScript project', async () => {
  registry();
  const report = await run({
    ...npmProject,
    'checkout.js': checkout("['card']"),
    'other.js': checkout("['card']", '{}').replace('checkout =', 'other ='),
  });
  expect(report.patch).toMatchObject({ status: 'proposed', sdkUpgrade: { to: '23.0.0' } });
});

it('lets an AI repair keep the card-only renames without counting them as dropped parameters', () => {
  const original = [
    {
      content:
        "a({ payment_method_types: ['card'] }); b({ payment_method_types: ['card', 'paypal'] });",
    },
  ];
  const renamed = [
    {
      content:
        "a({ allowed_payment_method_types: ['card'] }); b({ payment_method_types: ['card', 'paypal'] });",
    },
  ];
  const cardEdit = {
    file: 'a.ts',
    start: 0,
    end: 1,
    replacement: 'allowed_payment_method_types',
    changeId: 'request-parameter:PostCheckoutSessions.payment_method_types',
    rule: 'stripe-card-allowed-payment-method-types' as const,
  };
  expect(droppedRequestParameters(['payment_method_types'], original, renamed, [cardEdit])).toEqual(
    [],
  );
  expect(droppedRequestParameters(['payment_method_types'], original, renamed, [])).toEqual([
    'payment_method_types',
  ]);
  const dropsPaypal = [{ content: "a({ allowed_payment_method_types: ['card'] }); b({});" }];
  expect(
    droppedRequestParameters(['payment_method_types'], original, dropsPaypal, [cardEdit]),
  ).toEqual(['payment_method_types']);
});

it('keeps a listed card-plus-methods value by default, and not when keep-listed is off', async () => {
  const files = { 'checkout.js': checkout("['card', 'paypal']") };
  expect((await run(files, true, false)).patch).toMatchObject({ status: 'not-generated' });
  const report = await run(files);
  expect(report.patch).toMatchObject({ status: 'proposed', generator: 'deterministic' });
  if (!('diff' in report.patch)) throw new Error('Expected a patch');
  expect(report.patch.diff).toContain(
    "+export const checkout = () => stripe.checkout.sessions.create({ mode: 'subscription', allowed_payment_method_types: ['card', 'paypal'] });",
  );
  expect(report.patch.summary).toBe(
    'Replace payment_method_types with allowed_payment_method_types and update the pinned Stripe API version.',
  );
  expect(report.patch.warnings).toContain(listedPaymentMethodWarning(['card', 'paypal']));
  expect(report.patch.warnings).not.toContain(CARD_PAYMENT_METHOD_WARNING);
  expect(listedPaymentMethodWarning(['card', 'paypal'])).toContain(
    'so paypal may no longer be offered to some customers',
  );
  const check = { status: 'passed' as const, exitCode: 0, stdout: '', stderr: '' };
  const description = createReviewArtifacts({
    ...report,
    publicationFiles: [{ path: 'checkout.js', mode: '100644', content: 'export {};' }],
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
    'Moves `[card, paypal]` from `payment_method_types` to `allowed_payment_method_types` with the same methods, under the owner decision of 2026-10-24 to keep listed payment methods.',
  );
  expect(description).toContain('so `paypal` may no longer be offered to some customers');
});

// Owner decision (2026-10-24): a computed list, a spread or a list without `card` moves with its
// expression unchanged. The shapes are the ones the Push 279 repositories send (see the PR).
it.each([
  ['a variable', 'methods', "const methods = ['card', 'link'];"],
  [
    'a function call',
    'paymentMethods(country)',
    "const paymentMethods = (c) => (c === 'NL' ? ['card', 'ideal'] : ['card']);\nconst country = 'NL';",
  ],
  ['a spread', "[...methods, 'klarna']", "const methods = ['card'];"],
  ['a conditional', "wallet ? ['card', 'cashapp'] : ['card']", 'const wallet = true;'],
  ['a list without card', "['paypal']", ''],
  ['a property', 'config.methods', "const config = { methods: ['card', 'us_bank_account'] };"],
])('moves %s to allowed_payment_method_types unchanged', async (_shape, methods, setup) => {
  const files = { 'checkout.js': `${setup}\n${checkout(methods)}` };
  expect((await run(files, true, false)).patch).toMatchObject({ status: 'not-generated' });
  const report = await run(files);
  expect(report.patch).toMatchObject({ status: 'proposed', generator: 'deterministic' });
  if (!('diff' in report.patch)) throw new Error('Expected a patch');
  expect(report.patch.diff).toContain(`allowed_payment_method_types: ${methods} });`);
  expect(report.patch.diff).not.toMatch(/^\+.*[^_]payment_method_types/m);
  expect(report.patch.warnings).toContain(movedPaymentMethodWarning(methods));
  expect(report.findings.some((finding) => finding.requestParameter)).toBe(false);
});

it('moves a shorthand list and names the moved expression in the draft', async () => {
  const files = {
    'checkout.js': `import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_KEY, { apiVersion: '2026-08-26.dahlia' });
export const checkout = (payment_method_types) => stripe.checkout.sessions.create({ mode: 'payment', payment_method_types });
`,
  };
  const report = await run(files, true, true);
  if (!('diff' in report.patch)) throw new Error('Expected a patch');
  expect(report.patch.diff).toContain(
    "create({ mode: 'payment', allowed_payment_method_types: payment_method_types });",
  );
  expect(report.patch.warnings).toContain(movedPaymentMethodWarning('payment_method_types'));
  const check = { status: 'passed' as const, exitCode: 0, stdout: '', stderr: '' };
  const description = createReviewArtifacts({
    ...report,
    publicationFiles: [{ path: 'checkout.js', mode: '100644', content: 'export {};' }],
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
    'Moves `payment_method_types` from `payment_method_types` to `allowed_payment_method_types` unchanged',
  );
  expect(description).toContain(
    'Refit cannot read which payment methods `payment_method_types` holds at runtime.',
  );
  expect(description).toContain('Confirm the runtime values of `payment_method_types`');
  expect(description).not.toContain('Confirm cards stay enabled');
  expect(description).not.toContain("`['card']` moves to");
});

it.each([
  ['an in-person literal', "['card_present']", ''],
  ['an in-person method in a list', "['card', 'interac_present']", ''],
  ['a repeated literal list', "['card', 'card']", ''],
  ['an in-person method listed after card', "['card', 'card_present']", ''],
  ['an empty list', '[]', ''],
  ['a variable naming an in-person method', 'methods', "const methods = ['card_present'];"],
  ['a spread of an in-person list', "[...terminal, 'card']", "const terminal = ['card_present'];"],
  [
    'a function returning an in-person list',
    'methods()',
    "function methods() { return ['card_present']; }",
  ],
  [
    'a property naming an in-person method',
    'config.methods',
    "const config = { methods: ['card_present'] };",
  ],
])('keeps stopping on %s even where the repository opted in', async (_shape, methods, setup) => {
  const report = await run({ 'checkout.js': `${setup}\n${checkout(methods)}` }, true, true);
  expect(report.patch).toMatchObject({ status: 'not-generated' });
  expect(report.findings.some((finding) => finding.requestParameter)).toBe(true);
});

it('keeps stopping on a body that already sends allowed_payment_method_types', async () => {
  const report = await run(
    {
      'checkout.js': checkout("['card', 'paypal'], allowed_payment_method_types: ['card']"),
    },
    true,
    true,
  );
  expect(report.patch).toMatchObject({ status: 'not-generated' });
  expect(report.findings.some((finding) => finding.requestParameter)).toBe(true);
});

// Shaped like two Push 279 repositories: a Checkout body built in a local `sessionConfig` with a
// computed list (geallenboy/ai-saas-template), and a typed SetupIntent params const with a list
// from the request (qesmsep/noir-crm-dashboard).
it('moves a computed list in a local body that only the creation call receives', async () => {
  const report = await run(
    {
      'checkout.js': `import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_KEY, { apiVersion: '2026-08-26.dahlia' });
export async function checkout(customerId, paymentMethods) {
  const sessionConfig = {
    customer: customerId,
    payment_method_types: paymentMethods,
    mode: 'payment',
  };
  sessionConfig.metadata = { source: 'app' };
  return stripe.checkout.sessions.create(sessionConfig);
}
`,
    },
    true,
    true,
  );
  expect(report.patch).toMatchObject({ status: 'proposed', generator: 'deterministic' });
  if (!('diff' in report.patch)) throw new Error('Expected a patch');
  expect(report.patch.diff).toContain('+    allowed_payment_method_types: paymentMethods,');
  expect(report.patch.warnings).toContain(movedPaymentMethodWarning('paymentMethods'));
  expect(report.findings.filter((finding) => finding.requestParameter)).toEqual([]);
});

it.each([
  [
    'a body a helper returns',
    `const params = (methods) => ({ mode: 'payment', payment_method_types: methods });
export const checkout = (methods) => stripe.checkout.sessions.create(params(methods));`,
  ],
  [
    'a list assigned onto the body',
    `export const checkout = (methods) => {
  const params = { mode: 'payment' };
  params.payment_method_types = methods;
  return stripe.checkout.sessions.create(params);
};`,
  ],
  [
    'an exported body',
    `export const params = { mode: 'payment', payment_method_types: ['card', 'paypal'] };
export const checkout = () => stripe.checkout.sessions.create(params);`,
  ],
  [
    'a body that reaches another call too',
    `export const checkout = (methods) => {
  const params = { mode: 'payment', payment_method_types: methods };
  log(params);
  return stripe.checkout.sessions.create(params);
};`,
  ],
])('keeps stopping on %s', async (_shape, code) => {
  const report = await run(
    {
      'checkout.js': `import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_KEY, { apiVersion: '2026-08-26.dahlia' });
const log = console.log;
${code}
`,
    },
    true,
    true,
  );
  expect(report.patch).toMatchObject({ status: 'not-generated' });
});
it('keeps the stop when another client sets a version the patch cannot move', async () => {
  const report = await run({
    'pinned.js': checkout("['card']"),
    'dynamic.js': checkout("['card']", '{ apiVersion: process.env.STRIPE_VERSION }'),
  });
  expect('diff' in report.patch && report.patch.diff).not.toContain('allowed_payment_method_types');
  expect(report.findings.filter((finding) => finding.requestParameter)).toHaveLength(2);
});

// Real shapes from the benchmark repositories (noorjsdivs/tulos_yt actions/createCheckoutSession.ts,
// hex22a/techwear-shop-nextjs app/lib/config.ts). Moving the pin while these still send the
// parameter makes Stripe answer 400, so a body Refit cannot trace stops for review.
const builtInVariable = `import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_KEY, { apiVersion: '2026-08-26.dahlia' });
export const quick = () => stripe.checkout.sessions.create({ mode: 'payment', payment_method_types: ['card'] });
export async function createCheckoutSession(customerId, email) {
  const sessionPayload = {
    mode: "payment",
    allow_promotion_codes: true,
    payment_method_types: ["card"],
  };
  if (customerId) {
    sessionPayload.customer = customerId;
  } else {
    sessionPayload.customer_email = email;
  }
  const session = await stripe.checkout.sessions.create(sessionPayload);
  return session.url;
}
`;
const exportedConfig = `export const STRIPE_SESSION_CREATE_PARAMS = {
  mode: "payment",
  submit_type: "pay",
  payment_method_types: ["card"],
  ui_mode: "hosted",
};
`;
const spreadConfig = `import Stripe from 'stripe';
import { STRIPE_SESSION_CREATE_PARAMS } from './config.js';
const stripe = new Stripe(process.env.STRIPE_KEY, { apiVersion: '2026-08-26.dahlia' });
export const quick = () => stripe.checkout.sessions.create({ mode: 'payment', payment_method_types: ['card'] });
export const checkout = (line_items) =>
  stripe.checkout.sessions.create({ ...STRIPE_SESSION_CREATE_PARAMS, line_items });
`;

it('moves card and PayPal in a variable the call receives, and stops when keep-listed is off', async () => {
  const files = { 'checkout.js': builtInVariable.replace('["card"]', '["card", "paypal"]') };
  const report = await run(files);
  if (!('diff' in report.patch)) throw new Error('Expected a patch');
  expect(report.patch.diff).toContain('+    allowed_payment_method_types: ["card", "paypal"],');
  expect(report.findings.filter((finding) => finding.requestParameter)).toEqual([]);
  expect((await run(files, true, false)).patch).toMatchObject({ status: 'not-generated' });
});

it.each([
  [
    'in a variable a wrapper receives',
    {
      'checkout.js': builtInVariable.replace(
        'stripe.checkout.sessions.create(sessionPayload)',
        'send(sessionPayload)',
      ),
    },
    'checkout.js',
    8,
  ],
  [
    'in a variable that also reaches Payment Links',
    {
      'checkout.js': builtInVariable.replace(
        'return session.url;',
        'await stripe.paymentLinks.create(sessionPayload);\n  return session.url;',
      ),
    },
    'checkout.js',
    8,
  ],
  [
    // A `case` clause's `const` is in scope for the clauses below it (O1's second reading).
    'in a case-clause const that falls through to Payment Links',
    {
      'checkout.js': `import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_KEY, { apiVersion: '2026-08-26.dahlia' });
export const quick = () => stripe.checkout.sessions.create({ mode: 'payment', payment_method_types: ['card'] });
export async function pay(kind) {
  switch (kind) {
    case 'session':
      const params = { mode: 'payment', payment_method_types: ['card'] };
      await stripe.checkout.sessions.create(params);
    case 'link':
      await stripe.paymentLinks.create(params);
  }
}
`,
    },
    'checkout.js',
    7,
  ],
  [
    'in a function-scoped var',
    { 'checkout.js': builtInVariable.replace('const sessionPayload', 'var sessionPayload') },
    'checkout.js',
    8,
  ],
  [
    'in a variable whose list is reassigned',
    {
      'checkout.js': builtInVariable.replace(
        'if (customerId) {',
        "sessionPayload.payment_method_types = ['card', 'paypal'];\n  if (customerId) {",
      ),
    },
    'checkout.js',
    8,
  ],
  [
    'in an exported config spread into the call',
    { 'checkout.js': spreadConfig, 'config.js': exportedConfig },
    'config.js',
    4,
  ],
  [
    'in a conditional spread inside a traced body',
    {
      'checkout.js': checkout("['card']", "{ apiVersion: '2026-08-26.dahlia' }").replace(
        "mode: 'subscription',",
        "mode: 'subscription', ...(card ? { payment_method_types: ['card', 'paypal'] } : {}),",
      ),
    },
    'checkout.js',
    3,
  ],
])('stops for review when the removed parameter is set %s', async (_case, files, file, line) => {
  const report = await run(files);
  expect(report.patch).toMatchObject({
    status: 'not-generated',
    reason: expect.stringMatching(/parameter the target API version removed/),
  });
  expect(report.findings).toContainEqual(
    expect.objectContaining({
      file,
      line,
      confidence: 'review',
      requestParameter: {
        operationId: 'PostCheckoutSessions',
        parameter: 'payment_method_types',
      },
    }),
  );
  // The stop names the site without calling it a traced call.
  expect(removedParameterSites(report.findings)).toMatch(
    new RegExp(
      `^Where: .*${file}:${line} sets payment_method_types outside a traced SDK request body`,
    ),
  );
});

it('ignores nested payment_settings lists, schema definitions and test files', async () => {
  const report = await run({
    'checkout.js': `${checkout("['card']")}export const subscription = { items: [], payment_settings: { payment_method_types: ['card'] } };
export const InvoiceSchema = { payment_method_types: { type: Array, required: false } };
`,
    'checkout.test.js': `export const expected = { mode: 'payment', payment_method_types: ['card'] };\n`,
  });
  expect(report.patch).toMatchObject({ status: 'proposed' });
  expect(report.findings.filter((finding) => finding.requestParameter)).toEqual([]);
});

// MeiyuTech/AET-App src/app/(frontend)/(aet-app)/api/stripe/create-payment-link/route.ts: endive
// keeps payment_method_types on POST /v1/payment_links.
it('leaves a variable that only reaches an SDK call still accepting the parameter', async () => {
  const report = await run({
    'checkout.js': `${checkout("['card']")}export async function link(price) {
  const paymentLinkParams = {
    payment_method_types: ['card', 'alipay'],
    line_items: [{ price: price.id, quantity: 1 }],
  };
  paymentLinkParams.metadata = { source: 'aet' };
  return stripe.paymentLinks.create(paymentLinkParams);
}
`,
  });
  expect(report.patch).toMatchObject({ status: 'proposed' });
  expect(report.findings.filter((finding) => finding.requestParameter)).toEqual([]);
});

it('renames an exact card list in a local body that only the Checkout call receives', async () => {
  const report = await run({ 'checkout.js': builtInVariable });
  expect(report.patch).toMatchObject({ status: 'proposed', generator: 'deterministic' });
  if (!('diff' in report.patch)) throw new Error('Expected a patch');
  expect(report.patch.diff).toContain('+    allowed_payment_method_types: ["card"],');
  expect(report.patch.diff).toContain(
    "+const stripe = new Stripe(process.env.STRIPE_KEY, { apiVersion: '2026-09-30.endive' });",
  );
  expect(report.patch.warnings).toContain(CARD_PAYMENT_METHOD_WARNING);
  expect(report.findings.filter((finding) => finding.requestParameter)).toEqual([]);
});

// kevinknielsen/superfan-core: `apiVersion: process.env.STRIPE_API_VERSION || '2023-10-16'`.
it('says which client keeps the card rename from riding with the pin', async () => {
  const report = await run({
    'checkout.js': checkout(
      "['card']",
      "{ apiVersion: process.env.STRIPE_API_VERSION || '2026-08-26.dahlia' }",
    ),
  });
  expect(report.patch).toMatchObject({ status: 'not-generated' });
  expect(report.findings).toMatchObject([
    {
      requestParameter: { parameter: 'payment_method_types' },
      reason: expect.stringContaining(
        'The owner-approved rename to allowed_payment_method_types applies to this value, but Refit cannot resolve the API version the client created at checkout.js:2 sends, so it cannot move every client to 2026-09-30.endive.',
      ),
    },
  ]);
});

// An assignment onto a body was invisible: the card rule moved the pin while it still sent the
// removed parameter. A Payment Links body still accepts it, as in a migration script that copies
// `link.payment_method_types` onto `createPaymentLinkParams` (helloworld9912/Stripe-Account-Migration).
it('stops on a list assigned onto a Checkout body and leaves one assigned onto a Payment Links body', async () => {
  const assigned = (call: string) => ({
    'checkout.js': `${checkout("['card']")}export async function other(link) {
  const params = { line_items: [] };
  params.payment_method_types = link.payment_method_types;
  return stripe.${call}(params);
}
`,
  });
  const stopped = await run(assigned('checkout.sessions.create'));
  expect(stopped.patch).toMatchObject({ status: 'not-generated' });
  expect(
    stopped.findings.filter((finding) => finding.requestParameter).map((finding) => finding.line),
  ).toEqual([6]);
  const links = await run(assigned('paymentLinks.create'));
  expect(links.patch).toMatchObject({ status: 'proposed' });
  expect(links.findings.filter((finding) => finding.requestParameter)).toEqual([]);
});
