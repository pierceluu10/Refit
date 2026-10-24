import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  proposalContent,
  proposeStripeConfiguration,
  stripeNodeDefaultVersion,
} from './enrollment-proposal.ts';

// Each client below is copied from a repository in the P3 enrollment sample
// (docs/overnight/P3.md), with its manifest and lockfile cut to what the proposal reads.
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-proposal-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const manifest = (stripe: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: 'app', dependencies: { stripe }, ...extra });
const npmLock = (stripe: string) =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { stripe: `^${stripe}` } },
      'node_modules/stripe': { version: stripe },
    },
  });
const TESTS = { scripts: { test: 'vitest run' } };

// Ankit-Sharma1011/Quill src/lib/stripe.ts
const QUILL = `import Stripe from "stripe";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "", {
  apiVersion: "2026-04-22.dahlia",
  typescript: true,
});
`;

it('proposes the version the code pins, Refit’s newest contract and the repository’s tests', async () => {
  const root = await repository({
    'package.json': manifest('^22.1.1', TESTS),
    'package-lock.json': npmLock('22.1.1'),
    'src/lib/stripe.ts': QUILL,
  });
  const { proposal, stops } = await proposeStripeConfiguration(root);
  expect(stops).toEqual([]);
  expect(proposal).toMatchObject({
    apiVersion: { value: '2026-04-22.dahlia', source: 'set at src/lib/stripe.ts:3' },
    target: '2026-09-30.endive',
    checks: { kind: 'tests', source: 'the test script in package.json, run with npm' },
  });
  expect(proposalContent(proposal!)).toBe(`{
  "formatVersion": 2,
  "integrations": [
    {
      "id": "stripe",
      "before": "./refit/stripe-2026-04-22.dahlia.json",
      "after": "./refit/stripe-2026-09-30.endive.json",
      "apiVersion": "2026-04-22.dahlia",
      "image": "node:22-alpine",
      "prepareDependencies": true,
      "command": [
        "npm",
        "test"
      ]
    }
  ]
}
`);
});

it('checks a TypeScript repository without tests by new type errors, with its package manager', async () => {
  const root = await repository({
    'package.json': manifest('^22.1.1', { devDependencies: { typescript: '^5' } }),
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    'tsconfig.json': '{}',
    'src/lib/stripe.ts': QUILL,
  });
  const { proposal } = await proposeStripeConfiguration(root);
  expect(proposal?.checks).toEqual({
    kind: 'typecheck',
    source: 'tsc over tsconfig.json, failing only on new type errors',
  });
  expect(proposal?.configuration.integrations[0]).toMatchObject({
    command: ['npx', '--no-install', 'tsc', '--noEmit', '--pretty', 'false', '-p', '.'],
    compareTypeErrors: true,
  });
  const tested = await repository({
    'package.json': manifest('^22.1.1', TESTS),
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    'src/lib/stripe.ts': QUILL,
  });
  expect(
    (await proposeStripeConfiguration(tested)).proposal?.configuration.integrations[0],
  ).toMatchObject({
    command: ['pnpm', 'test'],
  });
});

it('reads the literal of a client handed to a plugin, and says the tracer cannot follow it', async () => {
  // WalterIt/Better-Auth-Template auth.ts: the client escapes into @better-auth/stripe.
  const root = await repository({
    'package.json': manifest('^19.3.0', TESTS),
    'package-lock.json': npmLock('19.3.1'),
    'auth.ts': `import { betterAuth } from "better-auth"
import { stripe } from "@better-auth/stripe"
import Stripe from "stripe"

const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: "2025-10-29.clover", // Latest API version as of Stripe SDK v19
})

export const auth = betterAuth({
  plugins: [
    stripe({
      stripeClient,
      stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
    }),
  ],
})
`,
  });
  const { proposal, stops } = await proposeStripeConfiguration(root);
  expect(stops).toEqual([]);
  expect(proposal?.apiVersion).toEqual({
    value: '2025-10-29.clover',
    source:
      'set at auth.ts:5; Refit cannot follow every use of the client at auth.ts:5, so check that no request there sends another version',
  });
});

it('uses the default of the locked stripe-node release for a client with no apiVersion', async () => {
  // CapChris20/Retronix-Wallpapers-Startup: both functions create the client without options.
  const files = {
    'package-lock.json': npmLock('18.2.1'),
    'extras/functions/index.js': `require('dotenv').config();
const express = require("express");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
`,
    'retronix/netlify/functions/create-checkout-session.js': `const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event, context) => {
  const session = await stripe.checkout.sessions.create({ mode: 'payment' });
  return { statusCode: 200, body: JSON.stringify({ id: session.id }) };
};
`,
  };
  // As committed: no test script and no TypeScript, so nothing would check a change.
  const committed = await proposeStripeConfiguration(
    await repository({ ...files, 'package.json': manifest('^18.2.1') }),
  );
  expect(committed).toEqual({
    proposal: null,
    stops: [
      {
        id: 'no-checks',
        detail:
          'This repository has no test script and no TypeScript type check, so Refit has nothing that shows a change still works.',
        action:
          'Add a "test" script to package.json, or a tsconfig.json with typescript in devDependencies.',
      },
    ],
  });
  const tested = await proposeStripeConfiguration(
    await repository({ ...files, 'package.json': manifest('^18.2.1', TESTS) }),
  );
  expect(tested.proposal?.apiVersion).toEqual({
    value: '2025-05-28.basil',
    source:
      'the default of stripe-node 18.2.1, which the lockfile records; Refit cannot follow every use of the client at retronix/netlify/functions/create-checkout-session.js:1, so check that no request there sends another version',
  });
});

it('stops on a version read from the environment, and names the line', async () => {
  // kevinknielsen/superfan-core lib/stripe.ts
  const root = await repository({
    'package.json': manifest('^14.5.0', TESTS),
    'package-lock.json': npmLock('14.25.0'),
    'lib/stripe.ts': `import Stripe from 'stripe';

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('STRIPE_SECRET_KEY environment variable is required');
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: process.env.STRIPE_API_VERSION || '2023-10-16',
});
`,
  });
  expect(await proposeStripeConfiguration(root)).toEqual({
    proposal: null,
    stops: [
      {
        id: 'api-version-unreadable',
        detail:
          'Refit cannot tell which Stripe API version the client at lib/stripe.ts:7 uses: its apiVersion is not a string literal Refit can read.',
        action:
          "Write the apiVersion at lib/stripe.ts:7 as a string literal, for example new Stripe(secretKey, { apiVersion: '<your API version>' }), or commit a .refit.json that sets it (docs/REPOSITORY-SETUP.md).",
      },
    ],
  });
});

it('stops when clients send different versions, naming each', async () => {
  const root = await repository({
    'package.json': manifest('^22.1.1', TESTS),
    'package-lock.json': npmLock('22.1.1'),
    'src/lib/stripe.ts': QUILL,
    // karanchhina/playground0 lib/stripe.js
    'lib/stripe.js': `import Stripe from 'stripe';

export async function createProduct(access_token, name) {
      const stripe = new Stripe(access_token, {
        apiVersion: '2023-10-16',
      });
      return stripe.products.create({ name });
}
`,
  });
  expect((await proposeStripeConfiguration(root)).stops).toEqual([
    {
      id: 'api-version-several',
      detail:
        'This repository sends more than one Stripe API version (2023-10-16 at lib/stripe.js:4; 2026-04-22.dahlia at src/lib/stripe.ts:3), and Refit moves one version at a time.',
      action:
        'Use the same apiVersion for every Stripe client and request, then Refit moves them together.',
    },
  ]);
});

it('stops without a lockfile, and when stripe is only in a workspace package', async () => {
  const unlocked = await repository({
    'package.json': manifest('^22.1.1', TESTS),
    'src/lib/stripe.ts': QUILL,
  });
  expect((await proposeStripeConfiguration(unlocked)).stops).toEqual([
    {
      id: 'no-lockfile',
      detail:
        'Refit installs dependencies only from a committed lockfile, and this repository has none at its root.',
      action:
        'Run npm install, pnpm install or yarn install once and commit the lockfile it writes.',
    },
  ]);
  const workspace = await repository({
    'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['apps/*'] }),
    'package-lock.json': npmLock('22.1.1'),
    'apps/api/package.json': manifest('^22.1.1', TESTS),
    'apps/api/src/stripe.ts': QUILL,
  });
  expect(await proposeStripeConfiguration(workspace)).toEqual({
    proposal: null,
    stops: [
      {
        id: 'workspace-package',
        detail:
          'stripe is declared in apps/api/package.json, not in the root package.json, and Refit runs checks only from the root.',
        action:
          "Commit a .refit.json whose checks run that package's tests from the root (docs/REPOSITORY-SETUP.md).",
      },
    ],
  });
});

it('knows a release’s default only inside a major the release table covers', () => {
  expect(stripeNodeDefaultVersion('14.5.0')).toBe('2023-10-16');
  expect(stripeNodeDefaultVersion('17.3.1')).toBe('2024-10-28.acacia');
  expect(stripeNodeDefaultVersion('18.2.1')).toBe('2025-05-28.basil');
  // Before 12 the SDK sends no version; 21 is not in the table; 23.1.0 is newer than it.
  expect(stripeNodeDefaultVersion('11.18.0')).toBeUndefined();
  expect(stripeNodeDefaultVersion('21.0.0')).toBeUndefined();
  expect(stripeNodeDefaultVersion('23.1.0')).toBeUndefined();
  expect(stripeNodeDefaultVersion('18.2.1-beta.1')).toBeUndefined();
});
