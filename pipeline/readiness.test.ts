import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import {
  inspectRepositoryReadiness,
  type ReadinessReport,
  sortBlockedChecks,
  UnclassifiedCheckError,
} from './readiness.ts';
import { renderReadiness } from './readiness-presentation.ts';
import { digest, stripeSpecificationUrl } from './specifications.ts';

const execute = promisify(execFile);
const roots: string[] = [];
const fixture = resolve('pipeline/fixtures/endpoint-replacement');
const bin = resolve('bin/refit.mjs');
const imageId = `sha256:${'a'.repeat(64)}`;

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(options: { prepareDependencies?: boolean; latestStripe?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'refit-readiness-'));
  roots.push(root);
  const repository = join(root, 'repository');
  await cp(join(fixture, 'repository'), repository, { recursive: true });
  for (const file of ['before.json', 'after.json', 'provider.json'])
    await cp(join(fixture, file), join(repository, file));
  if (options.latestStripe) {
    const content = await readFile(resolve('pipeline/fixtures/before.json'), 'utf8');
    const revision = 'b'.repeat(40);
    await writeFile(
      join(repository, 'before.json'),
      JSON.stringify({
        formatVersion: 1,
        kind: 'refit-snapshot',
        provider: 'stripe',
        revision,
        url: stripeSpecificationUrl(revision),
        hash: digest(content),
        content,
      }),
    );
    await writeFile(
      join(repository, 'src/items.ts'),
      `import Stripe from 'stripe';\nconst stripe = new Stripe('private-value');\nawait stripe.paymentIntents.retrieve('pi_1');`,
    );
  }
  const configuration = {
    formatVersion: 1,
    before: './before.json',
    ...(options.latestStripe ? { latestStripe: true } : { after: './after.json' }),
    image: 'local-test-image',
    ...(options.latestStripe ? {} : { providerConfig: './provider.json' }),
    apiVersion: options.latestStripe ? '2022-08-01' : '1',
    prepareDependencies: options.prepareDependencies ?? false,
    command: [
      'node',
      '-e',
      `require('fs').writeFileSync('application-executed', 'private-command-value')`,
    ],
  };
  await writeFile(join(repository, '.refit.json'), JSON.stringify(configuration));
  const binaries = join(root, 'binaries');
  await mkdir(binaries);
  const log = join(root, 'tool-calls.jsonl');
  for (const tool of ['docker', 'oasdiff'])
    await writeFile(
      join(binaries, tool),
      `#!${process.execPath}
require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({tool: ${JSON.stringify(tool)}, args: process.argv.slice(2)}) + '\\n');
${tool === 'docker' ? `if (process.argv.slice(2).join(' ') !== 'image inspect --format {{.Id}} local-test-image') process.exit(90); console.log(${JSON.stringify(imageId)});` : `console.log(process.argv[2] === '--version' ? 'oasdiff-test' : '[]');`}
`,
      { mode: 0o755 },
    );
  vi.stubEnv('PATH', `${binaries}:${process.env.PATH}`);
  await execute('git', ['-C', repository, 'init', '-b', 'main']);
  await commit(repository);
  return { root, repository, configuration, log, binaries };
}

async function commit(repository: string) {
  await execute('git', ['-C', repository, 'add', '.']);
  await execute('git', [
    '-C',
    repository,
    '-c',
    'user.name=Refit Tests',
    '-c',
    'user.email=tests@refit.local',
    'commit',
    '-m',
    'test: seed readiness repository',
  ]);
}

it('inspects a committed repository configuration and never executes app code, installs or makes requests', async () => {
  const sample = await setup();
  const fetch = vi.fn(() => {
    throw new Error('Readiness must not make HTTP requests');
  });
  vi.stubGlobal('fetch', fetch);
  const result = await inspectRepositoryReadiness({ repository: sample.repository });
  expect(result).toMatchObject({
    status: 'ready-for-validation',
    provider: { id: 'catalog-endpoint-example', packageName: '@example/catalog' },
    image: imageId,
    currentSourceChecked: true,
    sdkCoverage: { observedCalls: 1, mappedCalls: 1, unmappedMethods: [] },
  });
  expect(result.revision).toMatch(/^[a-f0-9]{40}$/);
  expect(fetch).not.toHaveBeenCalled();
  await expect(readFile(join(sample.repository, 'application-executed'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect((await execute('git', ['-C', sample.repository, 'status', '--porcelain'])).stdout).toBe(
    '',
  );
  const calls = (await readFile(sample.log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(calls.filter((call) => call.tool === 'docker')).toEqual([
    { tool: 'docker', args: ['image', 'inspect', '--format', '{{.Id}}', 'local-test-image'] },
  ]);
  expect(JSON.stringify(result)).not.toContain('private-command-value');
  expect(renderReadiness(result)).toContain('ready to attempt validation');
  expect(renderReadiness(result)).toContain('not approved or activated');
});

it('aggregates dirty Git, API-version and Docker setup failures with actionable checks', async () => {
  const sample = await setup();
  await writeFile(
    join(sample.repository, '.refit.json'),
    JSON.stringify({ ...sample.configuration, apiVersion: 'wrong-version' }),
  );
  await writeFile(join(sample.binaries, 'docker'), `#!${process.execPath}\nprocess.exit(1);`, {
    mode: 0o755,
  });
  const result = await inspectRepositoryReadiness({ repository: sample.repository });
  expect(result.status).toBe('needs-attention');
  expect(
    result.checks.filter((check) => check.status === 'blocked').map((check) => check.id),
  ).toEqual(['repository', 'api-version', 'docker']);
  expect(
    result.checks.filter((check) => check.status === 'blocked').every((check) => check.action),
  ).toBe(true);
});

it('passes the API-version check for a version the service already watches, as after a merged draft', async () => {
  const sample = await setup();
  const providerPath = join(sample.repository, 'provider.json');
  const provider = JSON.parse(await readFile(providerPath, 'utf8'));
  provider.apiVersion = { constructorArgument: 0, property: 'apiVersion', requestArguments: [] };
  await writeFile(providerPath, JSON.stringify(provider));
  // The committed configuration still pins 1; the merged draft moved the client to 2.
  await writeFile(
    join(sample.repository, 'src/client.ts'),
    "import { Catalog } from '@example/catalog'; export const catalog = new Catalog({ apiVersion: '2' });",
  );
  await commit(sample.repository);
  const versionCheck = async (acceptedApiVersions?: string[]) =>
    (
      await inspectRepositoryReadiness({ repository: sample.repository, acceptedApiVersions })
    ).checks.find((check) => check.id === 'api-version');
  expect(await versionCheck()).toMatchObject({ status: 'blocked' });
  expect(await versionCheck(['3'])).toMatchObject({ status: 'blocked' });
  expect(await versionCheck(['2'])).toMatchObject({
    status: 'passed',
    action: null,
    detail: expect.stringContaining('The code declares 2, which this service already watches'),
  });
});

it('lets a merged draft past migration coverage while a change no rule covers still blocks', async () => {
  const sample = await setup();
  for (const file of ['before.json', 'after.json'])
    await cp(resolve(`pipeline/fixtures/${file}`), join(sample.repository, file));
  // billing.ts as the merged draft leaves it: the charges read migrated and the pin moved.
  await writeFile(
    join(sample.repository, 'billing.ts'),
    `import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2022-11-15' });
export async function chargeHistory(paymentIntentId: string) {
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
  return (await stripe.charges.list({ payment_intent: intent.id })).data;
}
`,
  );
  const { providerConfig: _providerConfig, ...configuration } = sample.configuration;
  await writeFile(
    join(sample.repository, '.refit.json'),
    JSON.stringify({ ...configuration, apiVersion: '2022-08-01', fullDiff: true }),
  );
  await commit(sample.repository);
  const removal = {
    id: 'response-optional-property-removed',
    text: 'removed the optional property `charges` from the response with the `200` status',
    level: 2,
    responseSchema: 'payment_intent',
    removedProperty: 'charges',
  };
  const coverage = async (...changes: unknown[]) => {
    await writeFile(
      join(sample.binaries, 'oasdiff'),
      `#!${process.execPath}\nconsole.log(process.argv[2] === '--version' ? 'oasdiff-test' : ${JSON.stringify(JSON.stringify(changes))});`,
      { mode: 0o755 },
    );
    const result = await inspectRepositoryReadiness({
      repository: sample.repository,
      acceptedApiVersions: ['2022-11-15'],
    });
    expect(result.checks.find((check) => check.id === 'api-version')?.status).toBe('passed');
    return result.checks.find((check) => check.id === 'migration-coverage')?.status;
  };
  expect(await coverage(removal)).toBeUndefined();
  expect(
    await coverage(removal, {
      id: 'new-required-request-parameter',
      text: 'added the new required request parameter',
      level: 3,
    }),
  ).toBe('blocked');
});

it('accepts version-tolerant webhook period reads without a price policy', async () => {
  const sample = await setup();
  const webhook = resolve('pipeline/fixtures/stripe-webhooks');
  for (const file of ['before.json', 'after.json'])
    await cp(join(webhook, file), join(sample.repository, file));
  await cp(join(webhook, 'repository/client.js'), join(sample.repository, 'client.js'));
  await cp(join(webhook, 'repository/entitlements.js'), join(sample.repository, 'entitlements.js'));
  const { providerConfig: _provider, ...configuration } = sample.configuration;
  await writeFile(
    join(sample.repository, '.refit.json'),
    JSON.stringify({ ...configuration, apiVersion: '2025-02-24.acacia' }),
  );
  await commit(sample.repository);
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const result = await inspectRepositoryReadiness({ repository: sample.repository });
  expect(result.status).toBe('ready-for-validation');
  expect(result.checks).toContainEqual(
    expect.objectContaining({
      id: 'webhook-migration',
      status: 'passed',
      detail: expect.stringContaining('both the old and the new payload shape'),
    }),
  );
  expect(result.sdkCoverage).toMatchObject({
    observedCalls: 1,
    mappedCalls: 0,
    localHelperCalls: 1,
    unmappedMethods: [],
  });
  expect(result.checks).toContainEqual(
    expect.objectContaining({
      id: 'sdk-coverage',
      status: 'passed',
      detail: expect.stringContaining('local webhook signature constructor'),
    }),
  );
  expect(fetch).not.toHaveBeenCalled();
  await expect(readFile(join(sample.repository, 'application-executed'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

// A repository with the webhook fixture's client and contracts, pinned to their before version.
async function stripeRepository(files: Record<string, string>, settings: object = {}) {
  const sample = await setup();
  const webhook = resolve('pipeline/fixtures/stripe-webhooks');
  for (const file of ['before.json', 'after.json'])
    await cp(join(webhook, file), join(sample.repository, file));
  await cp(join(webhook, 'repository/client.js'), join(sample.repository, 'client.js'));
  const { providerConfig: _provider, ...configuration } = sample.configuration;
  await writeFile(
    join(sample.repository, '.refit.json'),
    JSON.stringify({ ...configuration, apiVersion: '2025-02-24.acacia', ...settings }),
  );
  for (const [path, content] of Object.entries(files))
    await writeFile(join(sample.repository, path), content);
  await commit(sample.repository);
  return sample.repository;
}

// Mcgyver-ai/DMForge's handler: without a secret it accepts the unsigned body (for the Stripe CLI),
// so `event` is assigned twice and Refit cannot confirm the payload, although the period helper
// covers this read when the event comes from constructEvent alone.
const DMFORGE = [
  "import { stripe } from './client.js';",
  'export function handleWebhook(body, signature, secret) {',
  '  let event;',
  '  if (secret) event = stripe.webhooks.constructEvent(body, signature, secret);',
  '  else event = JSON.parse(body);',
  "  if (event.type !== 'customer.subscription.updated') return;",
  '  const subscription = event.data.object;',
  '  return subscription.current_period_end;',
  '}',
  '',
].join('\n');

it('says Refit cannot confirm a webhook read on an event assigned twice, not that no rule applies', async () => {
  const repository = await stripeRepository({ 'webhook.js': DMFORGE });
  const report = await inspectRepositoryReadiness({ repository });
  expect(report.checks.find((check) => check.id === 'webhook-migration')).toMatchObject({
    status: 'blocked',
    detail:
      'Webhook code reads a field that API version 2025-03-31.basil removes: .current_period_end at webhook.js:8 (customer.subscription.updated). Refit cannot confirm what this read receives, so its rules do not migrate it.',
    action:
      "Refit's rules migrate a webhook read only once Refit confirms the event it reads, such as one stripe.webhooks.constructEvent result that nothing reassigns. A changed read must accept both payload shapes: Stripe renders an event in its webhook endpoint's API version, not in the client's apiVersion (docs/STRIPE-WEBHOOKS.md).",
  });
  // The same handler with one signed event no longer stops: the helper migrates the read.
  const signed = await stripeRepository({
    'webhook.js': DMFORGE.replace('  let event;\n', '').replace(
      /  if \(secret\) event = (.*)\n  else event = JSON.parse\(body\);/,
      '  const event = $1',
    ),
  });
  expect(
    (await inspectRepositoryReadiness({ repository: signed })).checks.find(
      (check) => check.id === 'webhook-migration',
    ),
  ).toMatchObject({ status: 'passed' });
});

it('pairs each stopped webhook read with its own events and cause', async () => {
  // The before contract also has subscription.plan, which no Refit rule migrates.
  const before = JSON.parse(
    await readFile(resolve('pipeline/fixtures/stripe-webhooks/before.json'), 'utf8'),
  );
  before.components.schemas.subscription.properties.plan = { type: 'string' };
  const repository = await stripeRepository({
    'before.json': JSON.stringify(before),
    'webhook.js': DMFORGE,
    'plans.js': [
      "import { stripe } from './client.js';",
      'export function handlePlan(body, signature, secret) {',
      '  const event = stripe.webhooks.constructEvent(body, signature, secret);',
      "  if (event.type !== 'customer.subscription.deleted') return;",
      '  return event.data.object.plan;',
      '}',
      '',
    ].join('\n'),
  });
  const report = await inspectRepositoryReadiness({ repository });
  expect(report.checks.find((check) => check.id === 'webhook-migration')).toMatchObject({
    status: 'blocked',
    detail:
      'Webhook code reads fields that API version 2025-03-31.basil removes: .plan at plans.js:5 (customer.subscription.deleted) and .current_period_end at webhook.js:8 (customer.subscription.updated). Refit cannot confirm what some of these reads receive, and no Refit rule migrates the others.',
    action:
      "Refit's rules migrate a webhook read only once Refit confirms the event it reads, such as one stripe.webhooks.constructEvent result that nothing reassigns. Refit leaves the reads no rule migrates unchanged; check them before merging a draft. A changed read must accept both payload shapes: Stripe renders an event in its webhook endpoint's API version, not in the client's apiVersion (docs/STRIPE-WEBHOOKS.md).",
  });
});

it('says a declared-type read stops because Refit cannot confirm it', async () => {
  // A typed but unsigned event, as internxt/payments-server and zainulabedeen123/Best-Saas-Kit--V2
  // read Stripe fields on values only declared with Stripe types.
  const repository = await stripeRepository({
    'handler.ts': [
      "import type Stripe from 'stripe';",
      'export function handle(body: string) {',
      '  const event: Stripe.Event = JSON.parse(body);',
      "  if (event.type === 'customer.subscription.updated')",
      '    return event.data.object.current_period_end;',
      '}',
      '',
    ].join('\n'),
  });
  const report = await inspectRepositoryReadiness({ repository });
  expect(report.checks.find((check) => check.id === 'source-provenance')).toMatchObject({
    status: 'blocked',
    detail:
      'Refit could not confirm a read of a field that API version 2025-03-31.basil removes, on a value the code declares with a Stripe type: .current_period_end at handler.ts:5.',
    action:
      "Refit leaves it unchanged; check whether it reads a Stripe object before merging a draft. Refit's rules migrate such a read only when Refit can confirm it, and it cannot when the value may change before the read or come from an optional call, when the property name is computed, or when Refit cannot tell which Stripe object the value is.",
  });
});

it('names each file Refit could not parse with its diagnostic, without calling Flow a syntax error', async () => {
  const sample = await setup();
  await writeFile(join(sample.repository, 'src/broken.ts'), 'export const = 1;\n');
  await writeFile(
    join(sample.repository, 'src/total.js'),
    '// @flow\nexport function total(amount: number): number {\n  return amount;\n}\n',
  );
  await commit(sample.repository);
  const report = await inspectRepositoryReadiness({ repository: sample.repository });
  expect(report.checks.find((check) => check.id === 'source-provenance')).toMatchObject({
    status: 'blocked',
    detail:
      'Refit could not parse src/broken.ts (Variable declaration expected) and src/total.js (Type annotations can only be used in TypeScript files), so it did not scan those files.',
    action:
      'Refit parses only TypeScript and JavaScript, so it cannot check the Stripe code in a file it cannot parse, such as one in Flow; check that code before merging a draft.',
  });
});

// GET /v1/invoices/upcoming and POST /v1/invoices/create_preview, cut to what the move compares.
const invoiceContract = (version: string, upcoming: boolean) => {
  const text = { type: 'string' };
  const invoice = {
    content: { 'application/json': { schema: { $ref: '#/components/schemas/invoice' } } },
  };
  return {
    openapi: '3.0.0',
    info: { version },
    paths: upcoming
      ? {
          '/v1/invoices/upcoming': {
            get: {
              operationId: 'GetInvoicesUpcoming',
              parameters: ['customer', 'subscription', 'coupon'].map((name) => ({
                in: 'query',
                name,
                schema: text,
              })),
              responses: { '200': invoice },
            },
          },
        }
      : {
          '/v1/invoices/create_preview': {
            post: {
              operationId: 'PostInvoicesCreatePreview',
              requestBody: {
                content: {
                  'application/x-www-form-urlencoded': {
                    schema: { type: 'object', properties: { customer: text, subscription: text } },
                  },
                },
              },
              responses: { '200': invoice },
            },
          },
        },
    components: { schemas: { invoice: { type: 'object', properties: { id: text } } } },
  };
};

it('points a traced call the contracts stop at to its place, not to untraced usage', async () => {
  const repository = await stripeRepository(
    {
      'before.json': JSON.stringify(invoiceContract('2025-02-24.acacia', true)),
      'after.json': JSON.stringify(invoiceContract('2025-03-31.basil', false)),
      'provider.json': JSON.stringify({
        id: 'stripe-invoices',
        packageName: 'stripe',
        defaultImport: true,
        namedExport: 'Stripe',
        constructorCalls: true,
        apiVersion: { constructorArgument: 1, property: 'apiVersion', requestArguments: [1, 2] },
        operations: [
          {
            resource: 'invoices',
            method: 'retrieveUpcoming',
            schema: 'invoice',
            operationId: 'GetInvoicesUpcoming',
          },
        ],
      }),
      'billing.js':
        "import { stripe } from './client.js';\nexport const preview = () => stripe.invoices.retrieveUpcoming({ customer: 'cus_1', coupon: 'SAVE10' });\n",
    },
    { providerConfig: './provider.json' },
  );
  const report = await inspectRepositoryReadiness({ repository });
  expect(report.checks.find((check) => check.id === 'source-provenance')).toMatchObject({
    status: 'blocked',
    detail:
      'Stripe 2025-03-31.basil removed the upcoming invoice API (invoices.retrieveUpcoming) in favour of invoices.createPreview. coupon has no equivalent create_preview parameter; the call needs review.',
    action:
      'Refit does not migrate the code at billing.js:2 automatically; check it before merging a draft.',
  });
});

it('blocks activation when shared source alias configuration cannot be verified', async () => {
  const sample = await setup();
  await writeFile(join(sample.repository, 'tsconfig.json'), '{"extends":"@vendor/tsconfig"}');
  await commit(sample.repository);
  const report = await inspectRepositoryReadiness({ repository: sample.repository });
  expect(report.status).toBe('needs-attention');
  expect(report.checks.find((check) => check.id === 'source-resolution')).toMatchObject({
    status: 'blocked',
    detail:
      'Refit cannot verify how imports resolve, because tsconfig.json extends @vendor/tsconfig, which Refit does not read, so it stops at clients shared between files.',
    action:
      'Nothing in your code needs to change: Refit reads only committed tsconfig files that an extends names by a relative path, so it stops here until it can read @vendor/tsconfig.',
  });
  await expect(readFile(join(sample.repository, 'application-executed'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('says to fix an invalid tsconfig, and that nothing else needs to change for an ambiguous alias', async () => {
  const sample = await setup();
  // An "@/*" alias like gaurangkhera/Kinect's, with an import that matches two scanned files.
  await writeFile(
    join(sample.repository, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
  );
  await writeFile(join(sample.repository, 'src/client.js'), 'export default {};\n');
  await writeFile(
    join(sample.repository, 'src/consumer.ts'),
    "import billing from '@/client';\nexport const consumer = billing;\n",
  );
  await commit(sample.repository);
  const action =
    'Refit stops at clients shared between files until it can verify which file each import loads, which it cannot do under an invalid tsconfig or jsconfig.';
  const ambiguous = await inspectRepositoryReadiness({ repository: sample.repository });
  expect(ambiguous.checks.find((check) => check.id === 'source-resolution')).toMatchObject({
    status: 'blocked',
    detail: 'Ambiguous source alias target; shared clients require review.',
    action,
  });
  // TypeScript rejects this tsconfig, so here the configuration is what needs to change.
  await writeFile(join(sample.repository, 'tsconfig.json'), '{"compilerOptions": {');
  await commit(sample.repository);
  const invalid = await inspectRepositoryReadiness({ repository: sample.repository });
  expect(invalid.checks.find((check) => check.id === 'source-resolution')).toMatchObject({
    status: 'blocked',
    detail:
      'tsconfig.json: source alias resolution is unverified (invalid configuration, unavailable extends, project references or unsupported resolution options). Shared clients require review.',
    action,
  });
});

it('reports unmapped calls on the same shared client without claiming complete integration coverage', async () => {
  const sample = await setup();
  await writeFile(
    join(sample.repository, 'src/other.ts'),
    `import { catalog } from './client.ts';\nawait catalog.orders.create({});`,
  );
  await commit(sample.repository);
  const result = await inspectRepositoryReadiness({ repository: sample.repository });
  expect(result.sdkCoverage).toMatchObject({
    observedCalls: 2,
    mappedCalls: 1,
    unmappedMethods: ['orders.create'],
  });
  expect(result.checks.find((check) => check.id === 'sdk-coverage')).toMatchObject({
    status: 'review',
  });
  expect(renderReadiness(result)).toContain('Unmapped SDK methods: orders.create');
  expect(renderReadiness(result)).toContain('outside automatic coverage');
});

it('blocks a profile whose observed calls do not have any configured mappings', async () => {
  const sample = await setup();
  await writeFile(
    join(sample.repository, 'src/items.ts'),
    `import { catalog } from './client.ts';\nawait catalog.orders.create({});`,
  );
  await commit(sample.repository);
  const result = await inspectRepositoryReadiness({ repository: sample.repository });
  expect(result.status).toBe('needs-attention');
  expect(result.sdkCoverage).toMatchObject({ observedCalls: 1, mappedCalls: 0 });
  expect(result.checks.find((check) => check.id === 'sdk-coverage')?.status).toBe('blocked');
});

it('checks committed npm inputs through the same preparation gate without installing packages', async () => {
  const sample = await setup({ prepareDependencies: true });
  const manifest = JSON.parse(await readFile(join(sample.repository, 'package.json'), 'utf8'));
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: manifest.dependencies },
      'node_modules/@example/catalog': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/@example/catalog/-/catalog-1.0.0.tgz',
        integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
      },
    },
  };
  await writeFile(join(sample.repository, 'package-lock.json'), JSON.stringify(lock));
  await commit(sample.repository);
  const accepted = await inspectRepositoryReadiness({ repository: sample.repository });
  expect(accepted.checks.find((check) => check.id === 'dependencies')).toMatchObject({
    status: 'passed',
    detail: expect.stringContaining('Installation and engine compatibility were not tested'),
  });
  // A dependency the lockfile neither records nor locks; npm ci rejects it (a locked 1.0.0 would do).
  await writeFile(
    join(sample.repository, 'package-lock.json'),
    JSON.stringify({ ...lock, packages: { '': { dependencies: {} } } }),
  );
  await commit(sample.repository);
  vi.stubEnv('REFIT_REPOSITORY_INSTALL', '1');
  // A lockfile out of sync goes to the sandbox install too (gut plan SC-S2, 2026-10-31).
  const rejected = await inspectRepositoryReadiness({ repository: sample.repository });
  expect(rejected.checks.find((check) => check.id === 'dependencies')).toMatchObject({
    status: 'review',
    detail: expect.stringMatching(
      /differ from the committed package-lock\.json[\s\S]*Refit runs the repository's own install instead/,
    ),
  });
  // A package from a private registry: Refit runs the repository's own install instead, so
  // nothing blocks and nothing is asked of the customer (founder decision, 2026-10-28).
  const record = lock.packages['node_modules/@example/catalog'];
  await writeFile(
    join(sample.repository, 'package-lock.json'),
    JSON.stringify({
      ...lock,
      packages: {
        ...lock.packages,
        'node_modules/@example/catalog': {
          ...record,
          resolved: 'https://npm.pkg.github.com/@example/catalog/-/catalog-1.0.0.tgz',
        },
      },
    }),
  );
  await commit(sample.repository);
  const privateRegistry = await inspectRepositoryReadiness({ repository: sample.repository });
  expect(privateRegistry.checks.find((check) => check.id === 'dependencies')).toMatchObject({
    status: 'review',
    detail: expect.stringMatching(
      /npm\.pkg\.github\.com[\s\S]*Refit runs the repository's own install instead \(npm ci, from package\.json\)/,
    ),
    action: expect.stringMatching(/^Nothing to configure\./),
  });
  vi.stubEnv('REFIT_REPOSITORY_INSTALL', '0');
  const off = await inspectRepositoryReadiness({ repository: sample.repository });
  expect(off.checks.find((check) => check.id === 'dependencies')?.status).toBe('blocked');
});

it('leaves latest Stripe discovery untouched and clearly identifies a baseline-only inspection', async () => {
  const sample = await setup({ latestStripe: true });
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('No source download expected');
    }),
  );
  const result = await inspectRepositoryReadiness({ repository: sample.repository });
  expect(result.currentSourceChecked).toBe(false);
  expect(result.status).toBe('ready-for-validation');
  expect(result.checks.find((check) => check.id === 'analysis')?.detail).toContain(
    'only the baseline was inspected',
  );
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('blocks an unpinned live baseline and rejects a custom adapter combined with latest Stripe', async () => {
  const sample = await setup({ latestStripe: true });
  await cp(resolve('pipeline/fixtures/before.json'), join(sample.repository, 'before.json'));
  await commit(sample.repository);
  const unpinned = await inspectRepositoryReadiness({ repository: sample.repository });
  expect(unpinned.checks.find((check) => check.id === 'source-baseline')?.status).toBe('blocked');
  await writeFile(
    join(sample.repository, '.refit.json'),
    JSON.stringify({ ...sample.configuration, providerConfig: './provider.json' }),
  );
  const conflicting = await inspectRepositoryReadiness({ repository: sample.repository });
  expect(conflicting.checks).toMatchObject([
    {
      id: 'configuration',
      status: 'blocked',
      detail: expect.stringContaining('cannot be combined with a custom provider'),
    },
  ]);
});

it('does not expose credential values from invalid configuration fields', async () => {
  const sample = await setup();
  await writeFile(
    join(sample.repository, '.refit.json'),
    JSON.stringify({ ...sample.configuration, apiKey: 'private-credential-value' }),
  );
  const result = await inspectRepositoryReadiness({ repository: sample.repository });
  expect(result.status).toBe('needs-attention');
  expect(JSON.stringify(result)).not.toContain('private-credential-value');
  expect(renderReadiness(result)).toContain('Unknown run configuration fields: apiKey');
});

it('keeps unsupported breaking changes blocked even when an SDK call is mapped', async () => {
  const sample = await setup();
  await writeFile(
    join(sample.binaries, 'oasdiff'),
    `#!${process.execPath}\nconsole.log(process.argv[2] === '--version' ? 'oasdiff-test' : JSON.stringify([{id:'request-body-required', text:'request body became required', level:3, path:'/legacy/items/{id}', operation:'GET'}]));`,
    { mode: 0o755 },
  );
  const result = await inspectRepositoryReadiness({ repository: sample.repository });
  expect(result.status).toBe('needs-attention');
  expect(result.checks.find((check) => check.id === 'migration-coverage')?.status).toBe('blocked');
});

it('reports missing configuration and does not inspect tools before a workflow is selected', async () => {
  const sample = await setup();
  const result = await inspectRepositoryReadiness({ config: join(sample.root, 'missing.json') });
  expect(result.status).toBe('needs-attention');
  expect(result.checks).toHaveLength(1);
  expect(result.checks[0]).toMatchObject({ id: 'configuration', status: 'blocked' });
  await expect(readFile(sample.log)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('routes human and JSON diagnostics outside the repository and returns exit 2 for setup failures', async () => {
  const sample = await setup();
  await writeFile(join(sample.root, 'tsconfig.json'), 'not valid JSON');
  const argumentsList = [bin, 'doctor', '--config', join(sample.repository, '.refit.json')];
  // Runs that see the same files start together; each CLI start costs about 0.3 s.
  const [human, json] = await Promise.all([
    execute(process.execPath, argumentsList, { cwd: sample.root }),
    execute(process.execPath, [...argumentsList, '--json'], { cwd: sample.root }),
  ]);
  expect(human.stdout).toContain('Refit is ready to attempt validation');
  expect(JSON.parse(json.stdout).sdkCoverage).toMatchObject({ observedCalls: 1, mappedCalls: 1 });
  await writeFile(
    join(sample.repository, '.refit.json'),
    JSON.stringify({ ...sample.configuration, apiVersion: 'wrong' }),
  );
  await Promise.all([
    expect(
      execute(process.execPath, [...argumentsList, '--json'], { cwd: sample.root }),
    ).rejects.toMatchObject({ code: 2, stdout: expect.stringContaining('needs-attention') }),
    expect(
      execute(process.execPath, [...argumentsList, '--ai-patch'], { cwd: sample.root }),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Unknown option') }),
  ]);
}, 30_000);

it('sorts every check that can block by what owner decision 1 does with it', () => {
  const report = (ids: string[], missing = false): ReadinessReport => ({
    formatVersion: 1,
    kind: 'refit-readiness',
    status: 'needs-attention',
    configuration: '.refit.json',
    repository: null,
    revision: null,
    provider: null,
    image: null,
    currentSourceChecked: false,
    checks: [
      ...ids.map((id) => ({
        id,
        title: id,
        status: 'blocked' as const,
        detail: '',
        action: null,
      })),
      { id: 'contract-coverage', title: 'review', status: 'review', detail: '', action: null },
    ],
    ...(missing ? { missing: true as const } : {}),
    sdkCoverage: null,
    scope: [],
  });
  const ids = (checks: { id: string }[]) => checks.map((check) => check.id);
  const sorted = sortBlockedChecks(
    report([
      'configuration',
      'contracts',
      'repository',
      'analysis',
      'docker',
      'source-baseline',
      'source-provenance',
      'webhook-migration',
      'api-version',
      'migration-coverage',
      'dependencies',
      'source-resolution',
      'sdk-coverage',
    ]),
  );
  expect(ids(sorted.setup)).toEqual([
    'configuration',
    'contracts',
    'repository',
    'analysis',
    'docker',
    'source-baseline',
  ]);
  expect(ids(sorted.workflow)).toEqual([
    'source-provenance',
    'webhook-migration',
    'api-version',
    'migration-coverage',
    'dependencies',
  ]);
  expect(ids(sorted.review)).toEqual(['source-resolution', 'sdk-coverage']);
  // A generated configuration doctor could not check has no workflow, whatever its stops are named.
  expect(ids(sortBlockedChecks(report(['source-resolution', 'no-checks'], true)).setup)).toEqual([
    'source-resolution',
    'no-checks',
  ]);
  expect(() => sortBlockedChecks(report(['contract-coverage']))).toThrow(UnclassifiedCheckError);
});

it('checks the preparation inputs of the nested package that holds the SDK code', async () => {
  // Shaped like different-ai/embedbase at fb0afda5e8c2ad0212ea8c0dfa495be9865221d5 and
  // starmanv4/react-typescript-docker at 109c4528fba9c6c0efe67a250704ece82441bad9: no root
  // package.json, and the SDK code in a project with its own lockfile.
  const sample = await setup({ prepareDependencies: true });
  await mkdir(join(sample.repository, 'app'));
  for (const path of ['package.json', 'src', 'simulator'])
    await rename(join(sample.repository, path), join(sample.repository, 'app', path));
  await commit(sample.repository);
  const root = await inspectRepositoryReadiness({ repository: sample.repository });
  expect(root.checks.find((check) => check.id === 'dependencies')).toMatchObject({
    status: 'blocked',
    detail: expect.stringContaining('reads dependencies only from the repository root'),
  });
  const manifest = JSON.parse(await readFile(join(sample.repository, 'app/package.json'), 'utf8'));
  await writeFile(
    join(sample.repository, 'app/package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: manifest.dependencies },
        'node_modules/@example/catalog': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/@example/catalog/-/catalog-1.0.0.tgz',
          integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
        },
      },
    }),
  );
  await commit(sample.repository);
  const nested = await inspectRepositoryReadiness({ repository: sample.repository });
  expect(nested.checks.find((check) => check.id === 'dependencies')).toMatchObject({
    status: 'passed',
    detail:
      '1 locked package records in app passed preparation input checks. Installation and engine compatibility were not tested.',
  });
});
