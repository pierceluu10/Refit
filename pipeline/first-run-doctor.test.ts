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
    'Run refit run --human to see where each removed parameter is still sent, and change those calls yourself: Refit replaces only the owner-approved Stripe payment_method_types lists in docs/STRIPE-PAYMENT-METHOD-TYPES.md, including the keep-listed opt-in.',
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

it('tells the person to commit or remove a submodule, not to commit or stash files', async () => {
  const app = await repository({ formatVersion: 2, integrations: [integration('catalog')] });
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
  });
});
