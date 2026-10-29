import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { accountRetrieveCurrentEdits } from './operation-reach.ts';
import { applySourceEdits } from './patches.ts';
import { STRIPE } from './providers.ts';
import { runPipeline } from './run.ts';
import type { Repository } from './types.ts';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function edited(content: string, calls: { line: number; column: number; method: string }[]) {
  const repository: Repository = {
    root: '/refit-accounts',
    files: [{ path: 'account.ts', content }],
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
  const edits = accountRetrieveCurrentEdits({
    repository,
    calls: calls.map((call) => ({ file: 'account.ts', ...call })),
  });
  return applySourceEdits(content, edits);
}

it('renames only a traced, argument-free accounts.retrieve call', () => {
  const content = [
    'const a = await stripe.accounts.retrieve();',
    "const b = await stripe.accounts.retrieve('acct_1');",
    'const c = await stripe.accounts.retrieve(null);',
    'const d = await stripe.accounts?.retrieve?.();',
    'const e = await other.accounts.retrieve();',
  ].join('\n');
  const traced = [1, 2, 3, 4].map((line) => ({
    line,
    column: 17,
    method: 'accounts.retrieve',
  }));
  expect(edited(content, traced).split('\n')).toEqual([
    'const a = await stripe.accounts.retrieveCurrent();',
    "const b = await stripe.accounts.retrieve('acct_1');",
    'const c = await stripe.accounts.retrieve(null);',
    'const d = await stripe.accounts?.retrieve?.();',
    'const e = await other.accounts.retrieve();',
  ]);
});

const form = (properties: string[]) => ({
  content: {
    'application/x-www-form-urlencoded': {
      schema: {
        type: 'object',
        properties: Object.fromEntries(properties.map((name) => [name, {}])),
      },
    },
  },
});
const object = { content: { 'application/json': { schema: { type: 'object' } } } };
// Reduced from Stripe's clover and endive OpenAPI documents.
const contract = (version: string, parameter: string) => ({
  openapi: '3.0.0',
  info: { version },
  paths: {
    '/v1/checkout/sessions': {
      post: {
        operationId: 'PostCheckoutSessions',
        requestBody: form(['mode', parameter]),
        responses: { '200': object },
      },
    },
    '/v1/accounts/{account}': {
      get: { operationId: 'GetAccountsAccount', responses: { '200': object } },
    },
  },
  components: {
    schemas: {
      'checkout.session': { type: 'object', properties: { id: { type: 'string' } } },
      account: { type: 'object', properties: { id: { type: 'string' } } },
    },
  },
});

// Shaped like an npm v3 lockfile on stripe-node 20 and the registry's stripe 23.0.0 metadata.
const INTEGRITY = `sha512-${'B'.repeat(86)}==`;
function npm(locked: string) {
  const dependencies = { stripe: `^${locked}` };
  return {
    'package.json': `${JSON.stringify({ name: 'shop', dependencies }, null, 2)}\n`,
    'package-lock.json': `${JSON.stringify(
      {
        name: 'shop',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { name: 'shop', dependencies },
          'node_modules/stripe': {
            version: locked,
            resolved: `https://registry.npmjs.org/stripe/-/stripe-${locked}.tgz`,
            integrity: INTEGRITY,
          },
        },
      },
      null,
      2,
    )}\n`,
  };
}

async function run(source: string) {
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
  const root = await mkdtemp(join(tmpdir(), 'refit-accounts-'));
  roots.push(root);
  const files = {
    ...npm('20.4.0'),
    'shop.ts': `import Stripe from 'stripe';
const stripe = new Stripe('sk', { apiVersion: '2026-02-25.clover' });
${source}`,
    'provider.json': JSON.stringify({
      ...STRIPE,
      id: 'stripe-accounts',
      operations: [
        {
          resource: 'checkout.sessions',
          method: 'create',
          schema: 'checkout.session',
          operationId: 'PostCheckoutSessions',
        },
        {
          resource: 'accounts',
          method: 'retrieve',
          schema: 'account',
          operationId: 'GetAccountsAccount',
        },
      ],
    }),
    'before.json': JSON.stringify(contract('2026-02-25.clover', 'payment_method_types')),
    'after.json': JSON.stringify(contract('2026-09-30.endive', 'allowed_payment_method_types')),
  };
  for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content);
  const report = await runPipeline({
    repository: root,
    before: join(root, 'before.json'),
    after: join(root, 'after.json'),
    providerConfig: join(root, 'provider.json'),
    apiVersion: '2026-02-25.clover',
    proposePatch: true,
  });
  return report.patch;
}

const account = 'export const me = () => stripe.accounts.retrieve();\n';

it('calls retrieveCurrent alongside a rules patch that upgrades stripe-node', async () => {
  const patch = await run(
    `export const pay = () => stripe.checkout.sessions.create({ mode: 'payment', payment_method_types: ['card'] });\n${account}`,
  );
  expect(patch).toMatchObject({ status: 'proposed', sdkUpgrade: { to: '23.0.0' } });
  const diff = 'diff' in patch ? patch.diff : '';
  expect(diff).toContain('+export const me = () => stripe.accounts.retrieveCurrent();');
  expect('warnings' in patch ? patch.warnings : []).toContainEqual(
    expect.stringContaining('GET /v1/account'),
  );
});

it('never makes a patch from the rename alone', async () => {
  const patch = await run(account);
  expect('diff' in patch ? patch.diff : '').not.toContain('retrieveCurrent');
});
