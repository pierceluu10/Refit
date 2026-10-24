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
          "Refit cannot tell which Stripe API version the client at lib/stripe.ts:7 uses: its apiVersion is process.env.STRIPE_API_VERSION || '2023-10-16', which Refit cannot trace to one version.",
        action:
          "Write the apiVersion at lib/stripe.ts:7 as a string literal, for example new Stripe(secretKey, { apiVersion: '<your API version>' }), or commit a .refit.json that sets it (docs/REPOSITORY-SETUP.md).",
      },
    ],
  });
});

it('names the options a client is created with when Refit cannot read them', async () => {
  const cases: { files: Record<string, string>; at: string; unread: string }[] = [
    {
      // hex22a/techwear-shop-nextjs app/lib/stripe.ts, app/lib/config.ts and app/lib/stripe.test.ts,
      // whose require('./stripe') is what keeps the tracer from following the client.
      files: {
        'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }),
        'app/lib/stripe.test.ts': `import { STRIPE_CONFIG } from '@/app/lib/config';

describe('stripe', () => {
  test('constructor', () => {
    const expectedStripeConfig = STRIPE_CONFIG;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const actualStripe: typeof module = require('./stripe').stripe;
    expect(actualStripe).toBeDefined();
    expect(expectedStripeConfig).toBeDefined();
  });
});
`,
        'app/lib/stripe.ts': `import Stripe from "stripe";
import { STRIPE_CONFIG } from './config';

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, STRIPE_CONFIG);
`,
        'app/lib/config.ts': `import { Stripe } from 'stripe';

export const STRIPE_CONFIG: Stripe.StripeConfig = {
  // https://github.com/stripe/stripe-node#configuration
  apiVersion: '2025-11-17.clover',
  appInfo: {
    name: 'techwear-shop-demo',
    url: 'https://techwear-shop-nextjs.vercel.app/',
  },
};
`,
      },
      at: 'app/lib/stripe.ts:4',
      unread: 'its options are STRIPE_CONFIG, which Refit cannot trace to an apiVersion',
    },
    {
      // ahmedaliofficial/latest-nestjs-stripe lib/utils/stripe.utils.ts
      files: {
        'lib/utils/stripe.utils.ts': `import Stripe from 'stripe'
import { StripeClient } from './stripe.interface'
import { OPTIONS_TYPE } from './stripe.module-definition'

export function createStripeClient({
  apiKey,
  config
}: typeof OPTIONS_TYPE): StripeClient {
  const client = new Stripe(apiKey, config)
  return client
}
`,
      },
      at: 'lib/utils/stripe.utils.ts:9',
      unread: 'its options are config, which Refit cannot trace to an apiVersion',
    },
    {
      // wevm/curl.md src/api.ts
      files: {
        'src/api.ts': `import Stripe from 'stripe'
import * as StripeUtils from '#lib/stripe.ts'

export async function paymentMethods(c: any, customer: string) {
  const stripe = new Stripe(
    c.env.STRIPE_SECRET_KEY,
    StripeUtils.stripeOptions(c.env.STRIPE_API_URL),
  )
  return stripe.paymentMethods.list({ customer, type: 'card' })
}
`,
      },
      at: 'src/api.ts:5',
      unread:
        'its options are StripeUtils.stripeOptions(c.env.STRIPE_API_URL), which Refit cannot trace to an apiVersion',
    },
  ];
  for (const sample of cases) {
    const root = await repository({
      'package.json': manifest('^20.0.0', TESTS),
      'package-lock.json': npmLock('20.0.0'),
      ...sample.files,
    });
    expect((await proposeStripeConfiguration(root)).stops).toEqual([
      {
        id: 'api-version-unreadable',
        detail: `Refit cannot tell which Stripe API version the client at ${sample.at} uses: ${sample.unread}.`,
        action: `Write the apiVersion at ${sample.at} as a string literal, for example new Stripe(secretKey, { apiVersion: '<your API version>' }), or commit a .refit.json that sets it (docs/REPOSITORY-SETUP.md).`,
      },
    ]);
  }
});

it('names the request argument it cannot read, with the version every client sends', async () => {
  // BeigeTechLA/beige-tech-mobile-web-api-2 src/services/payment.service.js
  const root = await repository({
    'package.json': manifest('^12.18.0', TESTS),
    'package-lock.json': npmLock('12.18.0'),
    'src/services/payment.service.js': `const config = require("../config/config");
const stripe = require("stripe")(config.stripe.secretKey);

const updatePayment = async (paymentId, updateObject) => {
  const updatedPayment = await Payment.findByIdAndUpdate(paymentId, updateObject, { new: true }).exec();
  if (updatedPayment) {
    const updatedPaymentIntent = await stripe.paymentIntents.update(
      updatedPayment.intent_id,
      updateObject
    );
    return updatedPaymentIntent;
  }
};

module.exports = { updatePayment };
`,
  });
  expect((await proposeStripeConfiguration(root)).stops).toEqual([
    {
      id: 'api-version-unreadable',
      detail:
        'Refit cannot tell which Stripe API version the request at src/services/payment.service.js:7 uses: it passes updateObject, and Refit cannot tell whether that sets apiVersion.',
      action:
        'If updateObject sets no apiVersion, commit a .refit.json that sets "apiVersion": "2022-11-15", the version your clients send (docs/REPOSITORY-SETUP.md).',
    },
  ]);
});

it('reports an unreadable request together with clients and requests on different versions', async () => {
  // deniaiapp/deni-ai: stripe-node 23 clients with no apiVersion, checkout requests pinned to dahlia,
  // and a portal tool that passes computed parameters.
  const root = await repository({
    'package.json': manifest('^23.0.0', TESTS),
    'package-lock.json': npmLock('23.0.0'),
    'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
    'src/lib/stripe.ts': `import Stripe from "stripe";

const stripeSecretKey = process.env.STRIPE_SECRET_KEY ?? "";

export const stripe = new Stripe(stripeSecretKey);
`,
    'src/lib/stripe-checkout.ts': `import type Stripe from "stripe";

export const customCheckoutRequestOptions: Stripe.RequestOptions = {
  apiVersion: "2026-03-25.dahlia",
};
`,
    'src/server/api/routers/billing.ts': `import { stripe } from "@/lib/stripe";
import { customCheckoutRequestOptions } from "@/lib/stripe-checkout";

export async function checkoutSession(checkoutSessionId: string) {
  const session = await stripe.checkout.sessions.retrieve(
    checkoutSessionId,
    {},
    customCheckoutRequestOptions,
  );
  return session;
}
`,
    'tools/stripe-portal-setup.ts': `import Stripe from "stripe";

const secret = process.env.STRIPE_SECRET_KEY ?? "";
const stripe = new Stripe(secret);

function portalConfigurationParams(): Stripe.BillingPortal.ConfigurationCreateParams {
  return { name: "Deni AI (plan changes in app)", features: {} };
}

async function setup(existing?: { id: string }) {
  const params = portalConfigurationParams();
  const configuration = existing
    ? await stripe.billingPortal.configurations.update(existing.id, params)
    : await stripe.billingPortal.configurations.create(params);
  return configuration;
}

void setup();
`,
  });
  expect((await proposeStripeConfiguration(root)).stops).toEqual([
    {
      id: 'api-version-unreadable',
      detail:
        'Refit cannot tell which Stripe API version the request at tools/stripe-portal-setup.ts:13 uses: it passes params, and Refit cannot tell whether that sets apiVersion.',
      action:
        'If params sets no apiVersion, commit a .refit.json that sets the version your clients send (docs/REPOSITORY-SETUP.md).',
    },
    {
      id: 'api-version-several',
      detail:
        "This repository sends more than one Stripe API version (2026-03-25.dahlia at src/server/api/routers/billing.ts:5; stripe-node 23.0.0's default 2026-09-30.endive at src/lib/stripe.ts:5, tools/stripe-portal-setup.ts:4), and Refit moves one version at a time.",
      action:
        'Use the same apiVersion for every Stripe client and request, then Refit moves them together.',
    },
  ]);
});

it('keeps the literal fix for a request that sets apiVersion from a variable', async () => {
  // Constructed: no repository in the sample sets a request apiVersion this way.
  const root = await repository({
    'package.json': manifest('^22.1.1', TESTS),
    'package-lock.json': npmLock('22.1.1'),
    'src/lib/stripe.ts': QUILL,
    'src/customers.ts': `import { stripe } from './lib/stripe';

export function createCustomer(email: string, version: string) {
  return stripe.customers.create({ email }, { apiVersion: version });
}
`,
  });
  expect((await proposeStripeConfiguration(root)).stops).toEqual([
    {
      id: 'api-version-unreadable',
      detail:
        'Refit cannot tell which Stripe API version the request at src/customers.ts:4 uses: it sets apiVersion: version, which Refit cannot trace to one version.',
      action:
        "Write the request's apiVersion at src/customers.ts:4 as a string literal, or remove it so the request uses the client's version, or commit a .refit.json that sets it (docs/REPOSITORY-SETUP.md).",
    },
  ]);
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

it('stops without a lockfile', async () => {
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
});

// pnpm and Yarn lockfiles cut to the importer and entry Refit reads for one workspace package.
const pnpmLock = (directory: string, stripe: string) => `lockfileVersion: '9.0'
importers:
  .: {}
  ${directory}:
    dependencies:
      stripe:
        specifier: ^${stripe}
        version: ${stripe}
packages:
  stripe@${stripe}:
    resolution: {integrity: sha512-test}
snapshots:
  stripe@${stripe}: {}
`;
const yarnLock = (
  stripe: string,
) => `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


stripe@^${stripe}:
  version "${stripe}"
  resolved "https://registry.yarnpkg.com/stripe/-/stripe-${stripe}.tgz"
  integrity sha512-test
`;

it('generates for stripe declared only in a workspace package, checked from the root', async () => {
  // manucoffin/faster-fixes: a pnpm workspace whose root test script runs turbo.
  const root = await repository({
    'package.json': JSON.stringify({ name: 'faster-fixes', scripts: { test: 'turbo run test' } }),
    'pnpm-workspace.yaml': 'packages:\n  - "apps/*"\n  - "packages/*"\n',
    'pnpm-lock.yaml': pnpmLock('apps/web', '20.2.0'),
    'apps/web/package.json': manifest('^20.2.0', { name: 'web', scripts: { test: 'vitest run' } }),
    // apps/web/src/server/stripe/index.ts
    'apps/web/src/server/stripe/index.ts': `import "server-only";

import Stripe from "stripe";

// Only throw if Stripe is actually accessed, not during module import
// This allows the Better Auth CLI to import the config without needing env vars
const stripeSecretKey = process.env.STRIPE_SECRET_KEY ?? "";

export const stripeApi = new Stripe(
  stripeSecretKey === "" ? "sk_test_placeholder" : stripeSecretKey,
  { apiVersion: "2025-12-15.clover" },
);
`,
  });
  const { proposal, stops } = await proposeStripeConfiguration(root);
  expect(stops).toEqual([]);
  expect(proposal).toMatchObject({
    apiVersion: {
      value: '2025-12-15.clover',
      source: 'set at apps/web/src/server/stripe/index.ts:9',
    },
    checks: { kind: 'tests', source: 'the test script in package.json, run with pnpm' },
  });
  expect(proposal?.configuration.integrations[0]).toMatchObject({ command: ['pnpm', 'test'] });
});

it('takes the default of the release locked for the package a client is in', async () => {
  // acm-uiuc/core: Yarn workspaces; src/api/functions/stripe.ts creates clients with no apiVersion.
  const root = await repository({
    'package.json': JSON.stringify({
      name: 'core',
      workspaces: ['src/api', 'src/ui'],
      devDependencies: { typescript: '^6.0.3' },
    }),
    'tsconfig.json': '{}',
    'yarn.lock': yarnLock('22.6.2'),
    'src/api/package.json': manifest('^22.6.2', { name: 'infra-core-api' }),
    'src/api/functions/stripe.ts': `import Stripe from "stripe";

export const createStripeLink = async ({ stripeApiKey }: { stripeApiKey: string }) => {
  const stripe = new Stripe(stripeApiKey);
  const product = await stripe.products.create({ name: "Payment for Invoice" });
  return product.id;
};
`,
  });
  const { proposal, stops } = await proposeStripeConfiguration(root);
  expect(stops).toEqual([]);
  expect(proposal).toMatchObject({
    apiVersion: {
      value: '2026-08-26.dahlia',
      source: 'the default of stripe-node 22.6.2, which the lockfile records',
    },
    checks: { kind: 'typecheck' },
  });
  // A second package locked to another release sends another default, and Refit names both.
  const two = await repository({
    'package.json': manifest('^14.25.0', { workspaces: ['packages/*'], ...TESTS }),
    'package-lock.json': JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { workspaces: ['packages/*'], dependencies: { stripe: '^14.25.0' } },
        'node_modules/stripe': { version: '14.25.0' },
        'packages/billing': { name: 'billing', dependencies: { stripe: '^17.3.1' } },
        'packages/billing/node_modules/stripe': { version: '17.3.1' },
        'node_modules/billing': { resolved: 'packages/billing', link: true },
      },
    }),
    'packages/billing/package.json': manifest('^17.3.1', { name: 'billing' }),
    'lib/stripe.js': "const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);\n",
    'packages/billing/index.js':
      "const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);\n",
  });
  expect((await proposeStripeConfiguration(two)).stops).toEqual([
    {
      id: 'api-version-several',
      detail:
        "This repository sends more than one Stripe API version (stripe-node 14.25.0's default 2023-10-16 at lib/stripe.js:1; stripe-node 17.3.1's default 2024-10-28.acacia at packages/billing/index.js:1), and Refit moves one version at a time.",
      action:
        'Use the same apiVersion for every Stripe client and request, then Refit moves them together.',
    },
  ]);
});

it('stops on a project the root lockfile does not install, or with no root package.json', async () => {
  // c-riq/ipvote: two Lambda functions, each its own npm project beside the root one.
  const lambdas = await repository({
    'package.json': JSON.stringify({ name: 'ipvote', scripts: { test: 'vitest run' } }),
    'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }),
    'serverless/payment/checkStripeSession/package.json': manifest('^14.0.0'),
    'serverless/payment/createStripeSession/package.json': manifest('^14.0.0'),
  });
  expect((await proposeStripeConfiguration(lambdas)).stops).toEqual([
    {
      id: 'nested-project',
      detail:
        'stripe is declared in serverless/payment/checkStripeSession/package.json, serverless/payment/createStripeSession/package.json, which the root lockfile does not install, so Refit cannot prepare those projects.',
      action:
        'Refit installs and checks only from the root package.json and its lockfile: make those projects a workspace of the root and commit the lockfile, or commit a .refit.json with a custom image (docs/DEPENDENCIES.md).',
    },
  ]);
  // bolg55/fastify_starter: fastify/ and frontend/ are separate projects, with no root manifest.
  const starter = await repository({
    'fastify/package.json': manifest('^17.7.0', TESTS),
    'fastify/pnpm-lock.yaml': pnpmLock('.', '17.7.0'),
  });
  expect((await proposeStripeConfiguration(starter)).stops).toEqual([
    {
      id: 'nested-project',
      detail:
        'stripe is declared in fastify/package.json, and this repository has no package.json at its root.',
      action:
        'Refit installs and checks only from the root package.json and its lockfile: make that project a workspace of the root and commit the lockfile, or commit a .refit.json with a custom image (docs/DEPENDENCIES.md).',
    },
  ]);
});

it('names a project beside a root that declares stripe with the checks, and still generates', async () => {
  // papotte/stundenzettel: Firebase functions/ is an npm project of its own next to the root app.
  const root = await repository({
    'package.json': manifest('^18.2.1', TESTS),
    'package-lock.json': npmLock('18.2.1'),
    'functions/package.json': manifest('^18.2.1'),
    'functions/package-lock.json': npmLock('18.2.1'),
    'src/lib/stripe.ts': `import Stripe from 'stripe';

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2025-05-28.basil' });
`,
  });
  const { proposal, stops } = await proposeStripeConfiguration(root);
  expect(stops).toEqual([]);
  expect(proposal?.checks).toEqual({
    kind: 'tests',
    source:
      'the test script in package.json, run with npm; Refit does not install functions/package.json, which the root lockfile leaves out',
  });
  // CapChris20/Retronix-Wallpapers-Startup: that project's client sets no apiVersion, and only its
  // own lockfile records the stripe-node release.
  const functions = await repository({
    'package.json': manifest('^18.3.0', TESTS),
    'package-lock.json': npmLock('18.3.0'),
    'extras/functions/package.json': manifest('^14.25.0'),
    'extras/functions/package-lock.json': npmLock('14.25.0'),
    'extras/functions/index.js': `require('dotenv').config();
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

exports.customers = functions.https.onRequest(async (request, response) => {
  response.json(await stripe.customers.list({ limit: 10 }));
});
`,
  });
  expect((await proposeStripeConfiguration(functions)).stops).toEqual([
    {
      id: 'stripe-not-locked',
      detail:
        'The Stripe client at extras/functions/index.js:6 sets no apiVersion, and Refit reads only the root lockfile, which does not install extras/functions/package.json, so it cannot tell which stripe-node release sends the default.',
      action: 'Set apiVersion at extras/functions/index.js:6.',
    },
  ]);
});

it('says which tsconfig extends it does not read when that hides every client', async () => {
  // manucoffin/faster-fixes: apps/web extends the workspace's shared tsconfig package.
  const workspace = await repository({
    'package.json': JSON.stringify({ name: 'faster-fixes', scripts: { test: 'turbo run test' } }),
    'pnpm-workspace.yaml': 'packages:\n  - "apps/*"\n  - "packages/*"\n',
    'pnpm-lock.yaml': pnpmLock('apps/web', '20.2.0'),
    'apps/web/package.json': manifest('^20.2.0', { name: 'web' }),
    'apps/web/tsconfig.json': JSON.stringify({
      extends: '@workspace/typescript-config/nextjs.json',
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } },
    }),
    'apps/web/src/server/stripe/index.ts': `import "server-only";

import Stripe from "stripe";

const stripeSecretKey = process.env.STRIPE_SECRET_KEY ?? "";

export const stripeApi = new Stripe(
  stripeSecretKey === "" ? "sk_test_placeholder" : stripeSecretKey,
  { apiVersion: "2025-12-15.clover" },
);
`,
  });
  expect((await proposeStripeConfiguration(workspace)).stops).toEqual([
    {
      id: 'source-resolution',
      detail:
        'Refit found no Stripe client it can follow, because apps/web/tsconfig.json extends @workspace/typescript-config/nextjs.json, which Refit does not read, so it cannot tell how imports resolve.',
      action:
        'Nothing in your code needs to change: Refit reads only committed tsconfig files that an extends names by a relative path, so it stops here until it can read @workspace/typescript-config/nextjs.json.',
    },
  ]);
  // tarkovtracker-org/TarkovTracker: Nuxt writes .nuxt/tsconfig.json at build time.
  const nuxt = await repository({
    'package.json': manifest('^22.3.1', { ...TESTS, devDependencies: { typescript: '^6.0.3' } }),
    'package-lock.json': npmLock('22.3.1'),
    'tsconfig.json': JSON.stringify({
      extends: './.nuxt/tsconfig.json',
      compilerOptions: { types: ['node', 'vitest'] },
    }),
    'app/server/api/stripe/checkout.post.ts': `import { createError, defineEventHandler, readBody } from 'h3';
import Stripe from 'stripe';

export default defineEventHandler(async (event) => {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) throw createError({ statusCode: 500, message: 'Stripe is not configured' });
  const stripe = new Stripe(stripeSecretKey);
  return stripe.checkout.sessions.create(await readBody(event));
});
`,
  });
  expect((await proposeStripeConfiguration(nuxt)).stops).toMatchObject([
    {
      id: 'source-resolution',
      detail:
        'Refit found no Stripe client it can follow, because tsconfig.json extends ./.nuxt/tsconfig.json, which Refit does not read, so it cannot tell how imports resolve.',
    },
  ]);
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
