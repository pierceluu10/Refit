import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { inspectRepositoryReadiness } from './readiness.ts';
import { renderReadiness } from './readiness-presentation.ts';

// Messages a new user meets on the way from a fresh checkout to a clear doctor verdict
// (docs/FIRST-RUN.md). Each assertion pins the exact text that replaced a vaguer one.
const execute = promisify(execFile);
const roots: string[] = [];
const fixture = resolve('pipeline/fixtures/endpoint-replacement');

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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
    '-qm',
    'test: seed',
  ]);
}

async function repository(configuration?: object) {
  const root = await mkdtemp(join(tmpdir(), 'refit-first-run-doctor-'));
  roots.push(root);
  const repository = join(root, 'app');
  await cp(join(fixture, 'repository'), repository, { recursive: true });
  for (const file of ['before.json', 'after.json', 'provider.json'])
    await cp(join(fixture, file), join(repository, file));
  if (configuration)
    await writeFile(join(repository, '.refit.json'), JSON.stringify(configuration));
  const binaries = join(root, 'binaries');
  await mkdir(binaries);
  await writeFile(join(binaries, 'docker'), `#!/bin/sh\necho sha256:${'a'.repeat(64)}\n`, {
    mode: 0o755,
  });
  // A test can make the fake report breaking changes through REFIT_TEST_OASDIFF.
  await writeFile(
    join(binaries, 'oasdiff'),
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo oasdiff-test; else echo "${REFIT_TEST_OASDIFF:-[]}"; fi\n',
    { mode: 0o755 },
  );
  vi.stubEnv('PATH', `${binaries}:${process.env.PATH}`);
  await execute('git', ['-C', repository, 'init', '-qb', 'main']);
  await commit(repository);
  return repository;
}

const integration = (id: string, before = './before.json', after = './after.json') => ({
  id,
  before,
  after,
  providerConfig: './provider.json',
  apiVersion: '1',
  image: 'node:22-alpine',
  command: ['npm', 'test'],
});

it('sends a new user to refit agents when the repository has no .refit.json', async () => {
  const app = await repository();
  const report = await inspectRepositoryReadiness({ repository: app });
  expect(report.checks).toEqual([
    {
      id: 'configuration',
      title: 'Workflow configuration',
      status: 'blocked',
      detail: `No .refit.json in ${app} yet, and Refit found no Stripe package to generate one for.`,
      action:
        'Run refit agents to see which provider agents apply, then refit agents --add <id> to write .refit.json.',
    },
  ]);
  const lines = renderReadiness(report).split('\n');
  // Before: "could not access a required file or executable" and four lines of caveats.
  expect(lines[0]).toBe('Refit setup needs attention: 1 of 1 check blocked');
  expect(lines[1]).toBe(
    'Next: Run refit agents to see which provider agents apply, then refit agents --add <id> to write .refit.json.',
  );
  // Before: "Configuration  <app>/.refit.json", a file that does not exist.
  expect(lines[3]).toBe('Configuration  this repository commits no .refit.json');
  expect(report).toMatchObject({ missing: true, configuration: join(app, '.refit.json') });
  expect(lines.at(-1)).toBe(
    'Doctor only reads files: it runs no code, installs and downloads nothing, and the configuration is not approved or activated. Passing checks permit a validation attempt, not proof the migration is correct. Only bounded ESM/CommonJS client patterns and configured SDK mappings are inspected, so other usage can remain undetected; SDK/API-version rollout and effective account versions still need review.',
  );
  expect(
    (await inspectRepositoryReadiness({ repository: join(app, 'typo') })).checks[0],
  ).toMatchObject({
    detail: `${join(app, 'typo')} does not exist.`,
    action: 'Check the --repository path, or run refit doctor from inside the repository.',
  });
  const missing = join(app, 'elsewhere.json');
  expect((await inspectRepositoryReadiness({ config: missing })).checks[0]).toMatchObject({
    detail: `${missing} does not exist.`,
    action: "Check the --config path, or omit --config to use the repository's .refit.json.",
  });
});

it('uses the only integration and says which --integration to run when there are several', async () => {
  const single = await repository({ formatVersion: 2, integrations: [integration('catalog')] });
  const report = await inspectRepositoryReadiness({ repository: single });
  expect(report).toMatchObject({ status: 'ready-for-validation', integration: 'catalog' });
  const several = await repository({
    formatVersion: 2,
    integrations: [integration('catalog'), integration('billing')],
  });
  expect((await inspectRepositoryReadiness({ repository: several })).checks[0]).toEqual({
    id: 'configuration',
    title: 'Workflow configuration',
    status: 'blocked',
    detail:
      'This configuration has 2 integrations; choose one with --integration: catalog, billing.',
    action: 'Run refit doctor --integration catalog, and once for each other integration listed.',
  });
});

it('names the uncommitted files and the commands that save missing contracts', async () => {
  const app = await repository({
    formatVersion: 2,
    integrations: [
      integration('stripe', './refit/stripe-before.json', './refit/stripe-after.json'),
    ],
  });
  await writeFile(join(app, 'notes.md'), 'draft');
  const report = await inspectRepositoryReadiness({ repository: app });
  expect(report.checks.find((check) => check.id === 'repository')).toMatchObject({
    status: 'blocked',
    detail:
      'Validation requires a clean committed repository, including untracked files; not committed: notes.md.',
  });
  const contracts =
    'Save the contracts: refit stripe-snapshot --revision <stripe/openapi commit for the API version your code pins> --output refit/stripe-before.json and refit stripe-snapshot --latest --output refit/stripe-after.json. Then run refit doctor again.';
  expect(report.checks.find((check) => check.id === 'analysis')).toMatchObject({
    status: 'blocked',
    detail: 'Missing contracts: refit/stripe-before.json, refit/stripe-after.json.',
    action: contracts,
  });
  // Committing comes last, so the summary points at the contracts first.
  expect(renderReadiness(report).split('\n').slice(0, 2)).toEqual([
    'Refit setup needs attention: 2 of 5 checks blocked',
    `Next: ${contracts}`,
  ]);
});

// Shaped like Stripe's dahlia and endive Checkout Session create bodies (card-payment-methods.test.ts).
const checkoutContract = (version: string, fields: string[]) => ({
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

const checkoutProvider = {
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
};
const stripeConfiguration = {
  formatVersion: 2,
  integrations: [
    {
      id: 'stripe',
      before: './refit/stripe-before.json',
      after: './refit/stripe-after.json',
      providerConfig: './refit/stripe.provider.json',
      image: 'node:22-alpine',
      command: ['npm', 'test'],
    },
  ],
};

it('tells a configured Stripe app where the removed parameter is sent and which apiVersion to add', async () => {
  const app = await repository();
  await mkdir(join(app, 'refit'));
  const files = {
    'package.json': JSON.stringify({ dependencies: { stripe: '22.6.2' } }),
    'checkout.js':
      "import Stripe from 'stripe';\nconst stripe = new Stripe(process.env.STRIPE_KEY);\nexport const checkout = () => stripe.checkout.sessions.create({ mode: 'subscription', payment_method_types: ['card', 'paypal'] });\n",
    'refit/stripe-before.json': JSON.stringify(
      checkoutContract('2026-08-26.dahlia', ['mode', 'payment_method_types']),
    ),
    'refit/stripe-after.json': JSON.stringify(
      checkoutContract('2026-09-30.endive', ['mode', 'allowed_payment_method_types']),
    ),
    'refit/stripe.provider.json': JSON.stringify(checkoutProvider),
    '.refit.json': JSON.stringify(stripeConfiguration),
  };
  for (const [path, content] of Object.entries(files)) await writeFile(join(app, path), content);
  await commit(app);
  const report = await inspectRepositoryReadiness({ repository: app });
  expect(report.checks.find((check) => check.id === 'source-provenance')?.action).toBe(
    'Run refit run --human to see where each removed parameter is still sent, and change those calls yourself: Refit replaces only the owner-approved Stripe payment_method_types lists in docs/STRIPE-PAYMENT-METHOD-TYPES.md, including listed and computed lists.',
  );
  // Before: "Verify the application client/account version and configure an exact
  // before-contract API-version pin."
  expect(report.checks.find((check) => check.id === 'api-version')?.action).toBe(
    'Confirm your client and account use 2026-08-26.dahlia, then add "apiVersion": "2026-08-26.dahlia" to the stripe integration in .refit.json.',
  );
});

it('tells the person which changes Refit cannot migrate, without asking for an adapter rule first', async () => {
  const app = await repository();
  await mkdir(join(app, 'refit'));
  vi.stubEnv(
    'REFIT_TEST_OASDIFF',
    JSON.stringify([
      {
        id: 'response-media-type-removed',
        level: 3,
        text: 'removed the media type application/json from the response',
        operation: 'POST',
        operationId: 'PostCheckoutSessions',
        path: '/v1/checkout/sessions',
      },
    ]),
  );
  const files = {
    'package.json': JSON.stringify({ dependencies: { stripe: '22.6.2' } }),
    'checkout.js':
      "import Stripe from 'stripe';\nconst stripe = new Stripe(process.env.STRIPE_KEY, { apiVersion: '2026-08-26.dahlia' });\nexport const checkout = () => stripe.checkout.sessions.create({ mode: 'subscription' });\n",
    'refit/stripe-before.json': JSON.stringify(checkoutContract('2026-08-26.dahlia', ['mode'])),
    'refit/stripe-after.json': JSON.stringify(checkoutContract('2026-09-30.endive', ['mode'])),
    'refit/stripe.provider.json': JSON.stringify(checkoutProvider),
    '.refit.json': JSON.stringify(stripeConfiguration),
  };
  for (const [path, content] of Object.entries(files)) await writeFile(join(app, path), content);
  await commit(app);
  const report = await inspectRepositoryReadiness({ repository: app });
  // Before: "The supplied contracts contain unresolved breaking changes without a supported
  // migration rule." with no count, versions or place.
  expect(report.checks.find((check) => check.id === 'migration-coverage')).toMatchObject({
    detail:
      'The contracts list 1 breaking change from API version 2026-08-26.dahlia to 2026-09-30.endive that no Refit rule migrates, including changes to 1 operation the code calls: POST /v1/checkout/sessions at checkout.js:3.',
    action:
      'Run refit run --human to see each change and where the code reaches it, and migrate those calls by hand. Refit has no reviewed rule for these changes, so it stops before validation.',
  });
});

it('says when Refit traced no API call, as when the client only goes to a library', async () => {
  const app = await repository();
  await mkdir(join(app, 'refit'));
  const files = {
    'package.json': JSON.stringify({ dependencies: { stripe: '19.3.1' } }),
    // WalterIt/Better-Auth-Template auth.ts: the only use of the client is @better-auth/stripe.
    'auth.ts': `import { betterAuth } from "better-auth"
import { stripe } from "@better-auth/stripe"
import Stripe from "stripe"

const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: "2026-08-26.dahlia",
})

export const auth = betterAuth({ plugins: [stripe({ stripeClient })] })
`,
    'refit/stripe-before.json': JSON.stringify(checkoutContract('2026-08-26.dahlia', ['mode'])),
    'refit/stripe-after.json': JSON.stringify(checkoutContract('2026-09-30.endive', ['mode'])),
    'refit/stripe.provider.json': JSON.stringify(checkoutProvider),
    '.refit.json': JSON.stringify(stripeConfiguration),
  };
  for (const [path, content] of Object.entries(files)) await writeFile(join(app, path), content);
  await commit(app);
  const report = await inspectRepositoryReadiness({ repository: app });
  // Before: "0 of 0 observed SDK API calls have configured mappings."
  expect(report.checks.find((check) => check.id === 'sdk-coverage')).toEqual({
    id: 'sdk-coverage',
    title: 'SDK call mapping',
    status: 'blocked',
    detail:
      'Refit traced no stripe API call in this code, so it cannot tell what the migration changes. Calls made inside another library, or through a client Refit cannot follow, are not counted.',
    action:
      'If the code reaches stripe only through another library, upgrade that library instead. Otherwise run refit run --human to see which clients Refit found, and call the API through one it can follow.',
  });
});

it('names the tsconfig extends Refit does not read when shared clients stop for it', async () => {
  const app = await repository();
  await mkdir(join(app, 'refit'));
  await mkdir(join(app, 'site'));
  const files = {
    'package.json': JSON.stringify({ dependencies: { stripe: '19.3.1' } }),
    // hideokamoto/stripe-testing-mcp-tools: the docs site under site/ extends Astro's own tsconfig.
    'site/tsconfig.json': `{
  "extends": "astro/tsconfigs/strict",
  "include": [".astro/types.d.ts", "**/*"],
  "exclude": ["dist"]
}
`,
    'site/astro.config.mjs': `// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: process.env.SITE_URL ?? 'https://stripe-fixtures.pages.dev',
});
`,
    'src/index.ts': `import Stripe from 'stripe';

const createStripeClient = (apiKey?: string) => {
  const stripe = new Stripe(apiKey!, {
    apiVersion: '2026-08-26.dahlia',
  });
  return stripe;
};

export const createSession = () =>
  createStripeClient(process.env.STRIPE_SECRET_KEY).checkout.sessions.create({ mode: 'payment' });
`,
    'refit/stripe-before.json': JSON.stringify(checkoutContract('2026-08-26.dahlia', ['mode'])),
    'refit/stripe-after.json': JSON.stringify(checkoutContract('2026-09-30.endive', ['mode'])),
    'refit/stripe.provider.json': JSON.stringify(checkoutProvider),
    '.refit.json': JSON.stringify(stripeConfiguration),
  };
  for (const [path, content] of Object.entries(files)) await writeFile(join(app, path), content);
  await commit(app);
  const report = await inspectRepositoryReadiness({ repository: app });
  // Before: "site/tsconfig.json: source alias resolution is unverified (invalid configuration,
  // unavailable extends, project references or unsupported resolution options). …"
  expect(report.checks.find((check) => check.id === 'source-resolution')).toEqual({
    id: 'source-resolution',
    title: 'Shared client resolution',
    status: 'blocked',
    detail:
      'Refit cannot verify how imports resolve, because site/tsconfig.json extends astro/tsconfigs/strict, which Refit does not read, so it stops at clients shared between files.',
    action:
      'Nothing in your code needs to change: Refit reads only committed tsconfig files that an extends names by a relative path, so it stops here until it can read astro/tsconfigs/strict.',
  });
});

it('names each method Refit does not map, at its first call, when it maps none', async () => {
  const app = await repository();
  await mkdir(join(app, 'refit'), { recursive: true });
  await mkdir(join(app, 'app/api/payment'), { recursive: true });
  const files = {
    'package.json': JSON.stringify({ dependencies: { stripe: '14.25.0' } }),
    // michaelshimeles/guru-catcher app/api/payment/route.ts, cut to its Stripe calls.
    'app/api/payment/route.ts': `import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("param");

  // Initialize Stripe
  const stripe = new Stripe(id!, {
    apiVersion: "2026-08-26.dahlia", // Use the latest API version
  });

  const invoices = await stripe.invoices.list({ status: "open", limit: 100 });
  const more = await stripe.invoices.list({ status: "draft", limit: 100 });
  const subscriptionSchedules = await stripe.subscriptionSchedules.list({ limit: 100 });
  return NextResponse.json([...invoices.data, ...more.data, ...subscriptionSchedules.data]);
}
`,
    'refit/stripe-before.json': JSON.stringify(checkoutContract('2026-08-26.dahlia', ['mode'])),
    'refit/stripe-after.json': JSON.stringify(checkoutContract('2026-09-30.endive', ['mode'])),
    'refit/stripe.provider.json': JSON.stringify(checkoutProvider),
    '.refit.json': JSON.stringify(stripeConfiguration),
  };
  for (const [path, content] of Object.entries(files)) await writeFile(join(app, path), content);
  await commit(app);
  const report = await inspectRepositoryReadiness({ repository: app });
  // Before: "0 of 3 observed SDK API calls have configured mappings. Unmapped calls are outside
  // automatic coverage." and "Confirm the SDK constructor/import mapping and supported client
  // pattern, then inspect scan evidence before attempting a migration."
  expect(report.checks.find((check) => check.id === 'sdk-coverage')).toEqual({
    id: 'sdk-coverage',
    title: 'SDK call mapping',
    status: 'blocked',
    detail:
      'Refit traced 3 stripe API calls, and it maps none of their methods to an operation in the contracts: invoices.list at app/api/payment/route.ts:13, subscriptionSchedules.list at app/api/payment/route.ts:15.',
    action:
      'Check these calls against the stripe changes from 2026-08-26.dahlia to 2026-09-30.endive by hand. Refit cannot tell what the migration changes for a method it does not map, so it stops before validation.',
  });
});

it('tells the person to commit or remove a submodule, not to commit or stash files', async () => {
  const app = await repository({ formatVersion: 2, integrations: [integration('catalog')] });
  // .gitmodules declares it, so clones fetch files this commit does not hold.
  await writeFile(
    join(app, '.gitmodules'),
    '[submodule "plugin"]\n\tpath = vendor/plugin\n\turl = https://example.invalid/plugin.git\n',
  );
  await execute('git', ['-C', app, 'add', '.gitmodules']);
  await execute('git', [
    '-C',
    app,
    'update-index',
    '--add',
    '--cacheinfo',
    `160000,${'b'.repeat(40)},vendor/plugin`,
  ]);
  // An uninitialized submodule, as a shallow clone without submodules leaves it: an empty directory.
  await mkdir(join(app, 'vendor/plugin'), { recursive: true });
  // Commit the index as is: `git add .` would stage the gitlink's removal.
  await execute('git', [
    '-C',
    app,
    '-c',
    'user.name=Refit Tests',
    '-c',
    'user.email=tests@refit.local',
    'commit',
    '-qm',
    'test: add a submodule',
  ]);
  expect(
    (await inspectRepositoryReadiness({ repository: app })).checks.find(
      (check) => check.id === 'repository',
    ),
  ).toMatchObject({
    status: 'blocked',
    detail:
      'Validation does not accept submodules; vendor/plugin is one. Refit checks committed files only, so commit its files to the repository or remove the submodule.',
    action:
      "Commit the submodule's files into this repository, or remove the submodule, then run refit doctor again.",
  }); // Owner decision 1: the root is checked without the submodule, and the check says so.
  expect(
    (await inspectRepositoryReadiness({ repository: app, allowUntested: true })).checks.find(
      (check) => check.id === 'repository',
    ),
  ).toMatchObject({
    status: 'passed',
    detail: expect.stringMatching(
      /^Clean committed root at [0-9a-f]{12}\. Refit checks it without the submodule vendor\/plugin, and each draft says so\.$/,
    ),
  });
});
