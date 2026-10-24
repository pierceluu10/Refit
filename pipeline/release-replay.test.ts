import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startFakeGitHub, type FakeGitHub } from './fixtures/fake-github.ts';
import {
  approveRepositoryEnrollment,
  inspectRepositoryEnrollment,
  readRepositoryApproval,
} from './repository-enrollment.ts';
import { pollServiceTarget, summarizePoll } from './service-worker.ts';
import { validateMigration } from './validation.ts';

vi.mock('node:child_process', async (original) =>
  (await import('./fixtures/fake-github-git.ts')).throughFakeGitHub(await original()),
);
// Docker is not available here: validation is the real scan and patch, applied with git apply,
// with controlled passing evidence. Everything else (enrollment, the watcher, the workflow and
// publication as the GitHub App) is the code the local service runs.
vi.mock('./validation.ts', async (original) => ({
  ...(await original<typeof import('./validation.ts')>()),
  validateMigration: vi.fn(async (options) =>
    (await import('./fixtures/publication-report.ts')).simulatedValidation(options),
  ),
}));

const execute = promisify(execFile);
const APP_ID = 321;
const REPOSITORY = 'example/billing';
const isolated = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};
const ACACIA = '2025-02-24.acacia';
const BASIL = '2025-04-30.basil';
const ENDIVE = '2026-09-30.endive';
let github: FakeGitHub;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'refit-release-replay-'));
  github = await startFakeGitHub({ appId: APP_ID, webhookSecret: 'unused-webhook-secret' });
  vi.stubGlobal('fetch', github.fetch);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  await github.close();
  await rm(root, { recursive: true, force: true });
});

// Stripe's published acacia and basil invoice excerpts (fixtures/stripe-basil-moves), each with a
// Checkout Session create body shaped like Stripe's: payment_method_types until endive,
// allowed_payment_method_types from 2026-09-30.endive. The endive document reuses the basil
// excerpt, so its only change is that Checkout field.
async function release(excerpt: 'before' | 'after', version: string, field: string) {
  const document = JSON.parse(
    await readFile(`pipeline/fixtures/stripe-basil-moves/${excerpt}.json`, 'utf8'),
  );
  document.info.version = version;
  document.paths['/v1/checkout/sessions'] = {
    post: {
      operationId: 'PostCheckoutSessions',
      requestBody: {
        content: {
          'application/x-www-form-urlencoded': {
            schema: { type: 'object', properties: { mode: {}, [field]: {} } },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/checkout.session' } },
          },
        },
      },
    },
  };
  document.components.schemas['checkout.session'] = {
    type: 'object',
    properties: { id: { type: 'string' } },
  };
  return `${JSON.stringify(document)}\n`;
}

const ADAPTER = {
  id: 'stripe-billing',
  packageName: 'stripe',
  defaultImport: true,
  namedExport: 'Stripe',
  constructorCalls: true,
  apiVersion: { constructorArgument: 1, property: 'apiVersion', requestArguments: [1, 2] },
  operations: [
    {
      resource: 'invoices',
      method: 'retrieve',
      schema: 'invoice',
      operationId: 'GetInvoicesInvoice',
    },
    {
      resource: 'checkout.sessions',
      method: 'create',
      schema: 'checkout.session',
      operationId: 'PostCheckoutSessions',
    },
  ],
};

// A customer repository on acacia that reads a field basil moved and sends a parameter endive
// removed, enrolled with an approval as `refit enroll` and `refit approve` record it.
async function customer() {
  const checkout = join(root, 'customer');
  await mkdir(join(checkout, 'stripe'), { recursive: true });
  const files = {
    'package.json': `${JSON.stringify({ name: 'billing', dependencies: { stripe: '17.7.0' } })}\n`,
    'billing.js': `import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '${ACACIA}' });

export async function invoiceSubscription(id) {
  const invoice = await stripe.invoices.retrieve(id);
  return invoice.subscription;
}

export const checkout = () =>
  stripe.checkout.sessions.create({ mode: 'subscription', payment_method_types: ['card'] });
`,
    'stripe/acacia.json': await release('before', ACACIA, 'payment_method_types'),
    'stripe/provider.json': `${JSON.stringify(ADAPTER)}\n`,
    '.refit.json': `${JSON.stringify({
      formatVersion: 1,
      before: './stripe/acacia.json',
      after: './stripe/acacia.json',
      providerConfig: './stripe/provider.json',
      apiVersion: ACACIA,
      image: 'node:22-alpine',
      command: ['npm', 'test'],
      fullDiff: false,
    })}\n`,
  };
  for (const [path, content] of Object.entries(files))
    await writeFile(join(checkout, path), content);
  const git = (args: string[]) => execute('git', ['-C', checkout, ...args], { env: isolated });
  await git(['init', '--quiet', '--initial-branch=main']);
  await git(['add', '.']);
  await git([
    '-c',
    'user.name=Customer',
    '-c',
    'user.email=customer@example.test',
    'commit',
    '--quiet',
    '-m',
    'feat: billing',
  ]);
  await github.publish(REPOSITORY, checkout);
  github.installations.set(654, {
    id: 654,
    login: 'example',
    repositories: [REPOSITORY],
    suspended: false,
  });
  const enrollment = await inspectRepositoryEnrollment({
    repository: checkout,
    github: REPOSITORY,
    base: 'main',
  });
  const output = join(root, 'approval.json');
  await approveRepositoryEnrollment({ enrollment, fingerprint: enrollment.fingerprint, output });
  return readRepositoryApproval(output);
}

// The approved target as `refit serve` polls it, with the newest contract Stripe has published as
// the watcher's source.
async function service(settings: { supersedeDrafts?: boolean } = {}) {
  const approval = await customer();
  const latest = join(root, 'stripe-latest.json');
  const target = {
    id: 'billing',
    repository: REPOSITORY,
    base: 'main',
    documentationSources: [],
    approval,
    source: { kind: 'file' as const, path: latest },
  };
  const state = join(root, 'state');
  return {
    publish: async (excerpt: 'before' | 'after', version: string, field: string) =>
      writeFile(latest, await release(excerpt, version, field)),
    poll: async () => {
      const result = summarizePoll(
        await pollServiceTarget({
          target,
          app: github.app,
          stateDirectory: state,
          signal: new AbortController().signal,
          repairAttempts: 0,
          publishDraft: true,
          ...settings,
        }),
      );
      console.log(`poll: ${result.status}: ${result.message}`);
      return result;
    },
    baseline: async () =>
      JSON.parse(await readFile(join(state, 'state.json'), 'utf8')).baseline?.apiVersion,
  };
}

const pulls = () =>
  github.pulls(REPOSITORY).map(({ number, state, merged }) => ({ number, state, merged }));
const issues = () => github.issues(REPOSITORY)?.size;
const draftDiff = (pull: { baseSha: string; headSha: string }, ...options: string[]) =>
  execute(
    'git',
    ['-C', github.remote(REPOSITORY), 'diff', ...options, pull.baseSha, pull.headSha],
    {
      env: isolated,
    },
  ).then(({ stdout }) => stdout);

it('opens one draft per Stripe release, advances after each merge and stays quiet in between', async () => {
  const { publish, poll, baseline } = await service();
  const quiet = () => {
    expect(github.comments(REPOSITORY)).toEqual([]);
    expect(issues()).toBe(0);
  };

  // Stripe publishes basil: one draft moves the invoice read and the pin.
  await publish('after', BASIL, 'payment_method_types');
  expect(await poll()).toMatchObject({ status: 'draft-created' });
  const [basil] = github.pulls(REPOSITORY);
  expect(basil).toMatchObject({ number: 1, state: 'open', draft: true, base: 'main' });
  expect(await poll()).toMatchObject({ status: 'draft-created' });
  expect(pulls()).toEqual([{ number: 1, state: 'open', merged: false }]);
  expect(validateMigration).toHaveBeenCalledTimes(1);

  // The customer merges it. The next poll finds the target reached and moves the baseline.
  await github.merge(REPOSITORY, 1, 'squash');
  expect(await poll()).toMatchObject({
    status: 'up-to-date',
    message: `The code already sends ${BASIL} and uses none of what it breaks.`,
  });
  expect(await baseline()).toBe(BASIL);
  // A customer commit before the next release is quiet too.
  const clone = join(root, 'clone');
  await execute('git', ['clone', '--quiet', github.remote(REPOSITORY), clone], { env: isolated });
  await writeFile(join(clone, 'README.md'), 'Billing\n');
  await execute('git', ['-C', clone, 'add', 'README.md'], { env: isolated });
  await execute(
    'git',
    [
      '-C',
      clone,
      '-c',
      'user.name=Customer',
      '-c',
      'user.email=customer@example.test',
      'commit',
      '--quiet',
      '-m',
      'docs: readme',
    ],
    { env: isolated },
  );
  await github.pushBranch(REPOSITORY, 'main', clone);
  expect(await poll()).toMatchObject({ status: 'up-to-date' });
  expect(pulls()).toEqual([{ number: 1, state: 'closed', merged: true }]);
  expect(validateMigration).toHaveBeenCalledTimes(1);
  quiet();

  // Stripe publishes endive: one new draft, compared with basil, moves only the Checkout field
  // and the pin.
  await publish('after', ENDIVE, 'allowed_payment_method_types');
  expect(await poll()).toMatchObject({ status: 'draft-created' });
  const endive = github.pulls(REPOSITORY)[1];
  expect(endive).toMatchObject({ number: 2, state: 'open', draft: true });
  expect(endive.head).not.toBe(basil.head);
  expect(await draftDiff(endive, '--name-only')).toBe('billing.js\n');
  const merged = await draftDiff(endive);
  expect(merged).toContain(
    `+const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '${ENDIVE}' });`,
  );
  expect(merged).toContain("allowed_payment_method_types: ['card']");
  expect(merged).not.toContain('invoice.subscription');
  expect(validateMigration).toHaveBeenCalledTimes(2);

  await github.merge(REPOSITORY, 2, 'squash');
  expect(await poll()).toMatchObject({
    status: 'up-to-date',
    message: `The code already sends ${ENDIVE} and uses none of what it breaks.`,
  });
  expect(await baseline()).toBe(ENDIVE);
  expect(await poll()).toMatchObject({ status: 'up-to-date' });
  expect(pulls()).toEqual([
    { number: 1, state: 'closed', merged: true },
    { number: 2, state: 'closed', merged: true },
  ]);
  expect(validateMigration).toHaveBeenCalledTimes(2);
  quiet();
}, 60_000);

it.each([
  ['leaves the older draft open by default', false],
  ['closes the older draft with --supersede-drafts', true],
])(
  'opens one cumulative draft when the next release lands first, and %s',
  async (_case, supersedeDrafts) => {
    const { publish, poll, baseline } = await service({ supersedeDrafts });
    await publish('after', BASIL, 'payment_method_types');
    expect(await poll()).toMatchObject({ status: 'draft-created' });

    // Endive lands before the customer merges basil's draft: one draft takes the code from acacia
    // to endive. Superseding is off by default (owner decision, 2026-10-24); with it, the basil
    // draft is closed with a link to the new one.
    await publish('after', ENDIVE, 'allowed_payment_method_types');
    expect(await poll()).toMatchObject({ status: 'draft-created' });
    expect(pulls()).toEqual([
      { number: 1, state: supersedeDrafts ? 'closed' : 'open', merged: false },
      { number: 2, state: 'open', merged: false },
    ]);
    const superseded = supersedeDrafts
      ? [
          {
            issue: 1,
            user: 'refit-acceptance[bot]',
            body: `Superseded by #2. Refit keeps one draft per integration and updates it in place; that draft migrates this code to ${ENDIVE} on the current \`main\`.\n\n<!-- refit-superseded -->`,
          },
        ]
      : [];
    expect(github.comments(REPOSITORY)).toEqual(superseded);
    const cumulative = await draftDiff(github.pulls(REPOSITORY)[1]);
    expect(cumulative).toContain(`apiVersion: '${ENDIVE}'`);
    expect(cumulative).toContain('getInvoiceSubscription(invoice)');
    expect(cumulative).toContain("allowed_payment_method_types: ['card']");

    await github.merge(REPOSITORY, 2, 'squash');
    expect(await poll()).toMatchObject({ status: 'up-to-date' });
    expect(await baseline()).toBe(ENDIVE);
    expect(github.comments(REPOSITORY)).toEqual(superseded);
    expect(issues()).toBe(0);
  },
  60_000,
);
