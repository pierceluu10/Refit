import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import { publicationWaiver } from './publication.ts';
import { createReviewArtifacts } from './review.ts';
import { runPipeline } from './run.ts';
import { digest } from './specifications.ts';
import { STRIPE } from './providers.ts';
import type { validateMigration } from './validation.ts';

const OLD = '2024-06-20';
const TARGET = '2026-09-30.endive';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function constructors(files: Record<string, string>) {
  const analysis = analyzeRepository(
    {
      root: '/version-tracing',
      files: Object.entries(files).map(([path, content]) => ({ path, content })),
      dependencies: [],
      lockfiles: [],
      warnings: [],
    },
    [],
    STRIPE,
  );
  return {
    declarations: analysis.apiVersionDeclarations
      .filter((declaration) => declaration.kind === 'constructor')
      .map(({ file, status, value, absent, environment }) => ({
        file,
        status,
        value,
        ...(absent ? { absent } : {}),
        ...(environment ? { environment } : {}),
      })),
    moved: analysis.apiVersionLiterals.map(({ file, value }) => ({ file, value })),
  };
}

const client = (options: string) =>
  `import Stripe from 'stripe';\nexport const stripe = new Stripe('key', ${options});\nawait stripe.customers.retrieve('cus');\n`;

it.each([
  `{ apiVersion: process.env.STRIPE_API_VERSION ?? '${OLD}' }`,
  `{ apiVersion: (process.env.STRIPE_API_VERSION || '${OLD}') as Stripe.LatestApiVersion }`,
  `{ apiVersion: process.env['STRIPE_API_VERSION'] ?? '${OLD}' }`,
])('reads the repository default behind an environment variable: %s', (options) => {
  expect(constructors({ 'stripe.ts': client(options) })).toEqual({
    declarations: [
      { file: 'stripe.ts', status: 'literal', value: OLD, environment: 'STRIPE_API_VERSION' },
    ],
    moved: [{ file: 'stripe.ts', value: OLD }],
  });
});

it('follows an environment default through a constant and a config object in another module', () => {
  expect(
    constructors({
      'config.ts': `const fallback = '${OLD}';\nexport const config = { stripe: { version: process.env.STRIPE_VERSION ?? fallback } };\n`,
      'stripe.ts': `import { config } from './config';\n${client('{ apiVersion: config.stripe.version }')}`,
    }),
  ).toEqual({
    declarations: [
      { file: 'stripe.ts', status: 'literal', value: OLD, environment: 'STRIPE_VERSION' },
    ],
    moved: [{ file: 'config.ts', value: OLD }],
  });
});

it('names the variable of a version that only the environment sets, and moves nothing', () => {
  expect(
    constructors({ 'stripe.ts': client('{ apiVersion: process.env.STRIPE_API_VERSION as any }') }),
  ).toEqual({
    declarations: [
      { file: 'stripe.ts', status: 'unknown', value: null, environment: 'STRIPE_API_VERSION' },
    ],
    moved: [],
  });
});

it('reads a pin from an exported config object in another module as a literal pin', () => {
  expect(
    constructors({
      'config.ts': `export const settings = { stripe: { apiVersion: '${OLD}' as const } };\n`,
      'stripe.ts': `import { settings } from './config';\n${client('{ apiVersion: settings.stripe.apiVersion }')}`,
    }),
  ).toEqual({
    declarations: [{ file: 'stripe.ts', status: 'literal', value: OLD }],
    moved: [{ file: 'config.ts', value: OLD }],
  });
});

it('does not treat a local binding named process as the environment', () => {
  const source = `const process = { env: { STRIPE_API_VERSION: undefined as string | undefined } };\n${client(`{ apiVersion: process.env.STRIPE_API_VERSION ?? '${OLD}' }`)}`;
  expect(constructors({ 'stripe.ts': source }).declarations).toEqual([
    { file: 'stripe.ts', status: 'unknown', value: null },
  ]);
});

// stripe-node sends `apiVersion || DEFAULT_API_VERSION` in every release from 11.18.0 to 23.0.0.
it('treats an explicit null apiVersion as no version set', () => {
  expect(constructors({ 'stripe.ts': client('{ apiVersion: null }') }).declarations).toEqual([
    { file: 'stripe.ts', status: 'unknown', value: null, absent: true },
  ]);
});

// Shaped like Stripe's Checkout Session create body before and after endive.
const CONTRACT = (version: string, fields: string[]) => ({
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
});

async function draft(files: Record<string, string>, movedAttempt?: { failed: string[] }) {
  const root = await mkdtemp(join(tmpdir(), 'refit-version-tracing-'));
  roots.push(root);
  const repository = join(root, 'repository');
  for (const [path, content] of Object.entries({
    'package.json': JSON.stringify({ dependencies: { stripe: '16.12.0' } }),
    ...files,
  })) {
    await mkdir(dirname(join(repository, path)), { recursive: true });
    await writeFile(join(repository, path), content);
  }
  await writeFile(
    join(root, 'before.json'),
    JSON.stringify(CONTRACT(OLD, ['mode', 'payment_method_types'])),
  );
  await writeFile(
    join(root, 'after.json'),
    JSON.stringify(CONTRACT(TARGET, ['mode', 'allowed_payment_method_types'])),
  );
  await writeFile(
    join(root, 'provider.json'),
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
  const scanned = await runPipeline({
    repository,
    before: join(root, 'before.json'),
    after: join(root, 'after.json'),
    providerConfig: join(root, 'provider.json'),
    apiVersion: OLD,
    proposePatch: true,
    leaveReviewedFindings: true,
  });
  if (!('diff' in scanned.patch)) throw new Error(`Expected a patch: ${scanned.patch.reason}`);
  // The scan with passing checks, as validation reports them; no Docker ran.
  const ran = { status: 'passed' as const, exitCode: 0, stdout: '', stderr: '' };
  const report = {
    ...scanned,
    patch: {
      ...scanned.patch,
      validation: 'passed',
      ...(movedAttempt ? { keptApiVersion: true } : {}),
    },
    publicationFiles: [{ path: 'lib/stripe.js', mode: '100644', content: 'patched' }],
    validation: {
      status: 'passed',
      revision: 'a'.repeat(40),
      command: ['npm', 'test'],
      baselineCommand: ['npm', 'test'],
      patchHash: digest(scanned.patch.diff),
      baseline: ran,
      patched: ran,
      ...(movedAttempt ? { movedAttempt } : {}),
    },
  } as unknown as Awaited<ReturnType<typeof validateMigration>>;
  const reviews = publicationWaiver(report, true) ?? [];
  return {
    diff: scanned.patch.diff,
    reviews,
    gates: reviews.map(({ gate }) => gate),
    body: createReviewArtifacts(report, 'github', undefined, reviews).files['pull-request.md'],
  };
}

// Founder decision (2026-10-28): a version set only where the code is deployed is a note in the
// draft, not a hold; a repository default behind the variable moves like a literal pin.
it('moves the pins it can and names the environment variable in the draft instead of holding it', async () => {
  const { diff, gates, body } = await draft({
    'lib/stripe.js': `import Stripe from 'stripe';\nexport const stripe = new Stripe(process.env.STRIPE_KEY, { apiVersion: process.env.STRIPE_API_VERSION || '${OLD}' });\nexport const checkout = () => stripe.checkout.sessions.create({ mode: 'payment', payment_method_types: ['card'] });\n`,
    'scripts/report.js': `import Stripe from 'stripe';\nconst admin = new Stripe(process.env.STRIPE_KEY, { apiVersion: process.env.REPORT_STRIPE_VERSION });\nexport const portal = () => admin.checkout.sessions.create({ mode: 'setup' });\n`,
  });
  expect(diff).toContain(`process.env.STRIPE_API_VERSION || '${TARGET}'`);
  expect(diff).not.toMatch(/^[-+].*REPORT_STRIPE_VERSION/m);
  expect(gates).not.toContain('api-version-untraced');
  expect(body).toContain(
    'The API version comes from `STRIPE_API_VERSION`, `REPORT_STRIPE_VERSION` where you deploy (`lib/stripe.js:2`, `scripts/report.js:2`), which Refit cannot read. This patch moves the default the code falls back to; a value set in the environment still overrides it.',
  );
  expect(body).toContain(
    `- [ ] Set \`STRIPE_API_VERSION\`, \`REPORT_STRIPE_VERSION\` to \`${TARGET}\` in every environment you deploy to, or confirm they are already.`,
  );
});

// The retry without the version move used to blame the check command whatever failed.
it.each([
  [['generated'], 'the generated stripe-mock checks found regressions'],
  [
    ['checks', 'signedEvents'],
    '`npm test` failed, the signed webhook event checks found regressions',
  ],
  [[], '`npm test` failed'],
])('names what failed on the patch that moved the version: %s', async (failed, words) => {
  const { reviews } = await draft(
    {
      'lib/stripe.js': `import Stripe from 'stripe';\nexport const stripe = new Stripe(process.env.STRIPE_KEY, { apiVersion: '${OLD}' });\nexport const checkout = () => stripe.checkout.sessions.create({ mode: 'payment', payment_method_types: ['card'] });\n`,
    },
    { failed },
  );
  expect(reviews.find(({ gate }) => gate === 'api-version-kept')?.reason).toMatch(
    new RegExp(
      `^${words.replace(/[.*+?^${}()|[\]\\`]/g, '\\$&')} on the patch that moved the API version to`,
    ),
  );
});
