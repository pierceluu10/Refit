import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import {
  proposalContent,
  proposalSummary,
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

// Owner decision 1: with allowUntested a version stop is a reason each draft is titled [Needs
// review], and the configuration names the version it assumes.
async function reviewed(root: string) {
  const { proposal } = await proposeStripeConfiguration(root, { allowUntested: true });
  return { apiVersion: proposal?.apiVersion, reviews: proposal?.reviews.map((stop) => stop.id) };
}
const ASSUMED = (value: string, why: string, every = false) => ({
  id: 'api-version-assumed',
  detail: `Refit could not read ${every ? 'every' : 'which'} Stripe API version this code sends, so the configuration assumes ${value}, ${why}. Refit compares the ${value} contract with 2026-09-30.endive; if the code sends another version, what needs migrating can differ.`,
  action:
    'Confirm the version your code and Stripe account use before merging a draft, and set apiVersion in the code.',
});

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
    reason:
      'There is no test script. The type check (tsc over tsconfig.json) covers the Stripe code in src/lib/stripe.ts.',
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

// O1's second reading: the fallback for a client the tracer cannot follow read a computed key as
// absent and a repeated key by its first value, while the runtime sends the last.
it.each([
  [
    'a computed key',
    `{ ['apiVersion']: "2025-10-29.clover" }`,
    /its options include \['apiVersion'\]/,
  ],
  [
    'a repeated key',
    `{ apiVersion: "2025-10-29.clover", apiVersion: "2025-09-30.clover" }`,
    /its options set apiVersion 2 times/,
  ],
])('stops on %s in the options of a client handed to a plugin', async (_case, options, detail) => {
  const root = await repository({
    'package.json': manifest('^19.3.0', TESTS),
    'package-lock.json': npmLock('19.3.1'),
    'auth.ts': `import { betterAuth } from "better-auth"
import { stripe } from "@better-auth/stripe"
import Stripe from "stripe"

const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!, ${options})

export const auth = betterAuth({ plugins: [stripe({ stripeClient })] })
`,
  });
  const { proposal, stops } = await proposeStripeConfiguration(root);
  expect(proposal).toBeNull();
  expect(stops).toMatchObject([
    { id: 'api-version-unreadable', detail: expect.stringMatching(detail) },
  ]);
  // The lockfile's importer differs from package.json, so Refit reads no locked release either.
  const why = 'the oldest version Refit has a contract for';
  expect(await reviewed(root)).toEqual({
    apiVersion: { value: '2022-08-01', source: `assumed: ${why}` },
    reviews: ['api-version-unreadable', 'api-version-assumed'],
  });
  const assumed = (await proposeStripeConfiguration(root, { allowUntested: true })).proposal;
  expect(assumed!.reviews[1]).toEqual(ASSUMED('2022-08-01', why));
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

it('joins a pinned client and a release default that send the same version', async () => {
  const root = await repository({
    'package.json': manifest('^18.2.1', TESTS),
    'package-lock.json': npmLock('18.2.1'),
    'src/lib/stripe.ts': QUILL.replace('2026-04-22.dahlia', '2025-05-28.basil'),
    'src/admin.ts': `import Stripe from "stripe";\n\nexport const admin = new Stripe(process.env.STRIPE_SECRET_KEY ?? "");\n`,
  });
  const { proposal, stops } = await proposeStripeConfiguration(root);
  expect(stops).toEqual([]);
  // Before: "set at src/lib/stripe.ts:3 and the default of stripe-node 18.2.1, …"
  expect(proposal?.apiVersion).toEqual({
    value: '2025-05-28.basil',
    source:
      'set at src/lib/stripe.ts:3, and the default of stripe-node 18.2.1, which the lockfile records',
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
  expect(await reviewed(root)).toEqual({
    apiVersion: {
      value: '2022-08-01',
      source: 'assumed: the oldest version Refit has a contract for',
    },
    reviews: ['api-version-unreadable', 'api-version-assumed'],
  });
});

// Constructed from the two clients above with a lockfile that matches package.json: a client whose
// version Refit cannot read may send its stripe-node default when the variable is unset.
it.each([
  "{ apiVersion: process.env.STRIPE_API_VERSION || '2023-10-16' }",
  "{ ['apiVersion']: '2025-10-29.clover' }",
])('assumes the locked stripe-node default for a client it cannot read: %s', async (options) => {
  const root = await repository({
    'package.json': manifest('^22.6.2', TESTS),
    'package-lock.json': npmLock('22.6.2'),
    'lib/stripe.ts': `import Stripe from 'stripe';\nexport const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, ${options});\n`,
  });
  expect((await proposeStripeConfiguration(root)).proposal).toBeNull();
  const why = 'the version stripe-node 22.6.2 sends by default, which the lockfile records';
  const { proposal } = await proposeStripeConfiguration(root, { allowUntested: true });
  expect(proposal!.apiVersion).toEqual({ value: '2026-08-26.dahlia', source: `assumed: ${why}` });
  expect(proposal!.reviews.map((stop) => stop.id)).toEqual([
    'api-version-unreadable',
    'api-version-assumed',
  ]);
  expect(proposal!.reviews[1]).toEqual(ASSUMED('2026-08-26.dahlia', why));
  expect(proposalSummary(proposal!)).toContain(
    'Each draft Refit opens with it is titled [Needs review]: Refit cannot tell which Stripe API version the client at lib/stripe.ts:2 uses',
  );
});

it('stops on a file that imports stripe and does not parse, naming it with the other stops', async () => {
  const root = await repository({
    'package.json': manifest('^22.1.1', TESTS),
    'src/lib/stripe.ts': QUILL,
    'src/billing.ts': "import Stripe from 'stripe';\nconst total = ;\n",
  });
  expect(await proposeStripeConfiguration(root)).toEqual({
    proposal: null,
    stops: [
      expect.objectContaining({ id: 'no-lockfile' }),
      {
        id: 'source-does-not-parse',
        detail:
          'src/billing.ts imports stripe but does not parse (Expression expected.), so Refit cannot read its Stripe calls or the API version it sends.',
        action: 'Fix the syntax error in src/billing.ts and commit it.',
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
  const source = 'the default of stripe-node 12.18.0, which the lockfile records';
  expect(await reviewed(root)).toEqual({
    apiVersion: { value: '2022-11-15', source },
    reviews: ['api-version-unreadable', 'api-version-assumed'],
  });
  const { proposal } = await proposeStripeConfiguration(root, { allowUntested: true });
  expect(proposal!.reviews[1]).toEqual(
    ASSUMED('2022-11-15', `the oldest version Refit can read (${source})`, true),
  );
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
        "This repository sends more than one Stripe API version (2026-03-25.dahlia at src/server/api/routers/billing.ts:5; stripe-node 23.0.0's default 2026-09-30.endive at src/lib/stripe.ts:5 and tools/stripe-portal-setup.ts:4), and Refit moves one version at a time.",
      action:
        'Use the same apiVersion for every Stripe client and request, then Refit moves them together.',
    },
  ]);
  expect(await reviewed(root)).toMatchObject({
    apiVersion: { value: '2026-03-25.dahlia' },
    reviews: ['api-version-unreadable', 'api-version-several', 'api-version-assumed'],
  });
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
  expect(await reviewed(root)).toEqual({
    apiVersion: { value: '2026-04-22.dahlia', source: 'set at src/lib/stripe.ts:3' },
    reviews: ['api-version-unreadable', 'api-version-assumed'],
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
  const { proposal } = await proposeStripeConfiguration(root, { allowUntested: true });
  expect(proposal).toMatchObject({
    apiVersion: {
      value: '2023-10-16',
      source: 'the oldest version set at lib/stripe.js:4 and src/lib/stripe.ts:3',
    },
    reviews: [
      {
        id: 'api-version-several',
        detail:
          'This repository sends more than one Stripe API version (2023-10-16 at lib/stripe.js:4; 2026-04-22.dahlia at src/lib/stripe.ts:3). The configuration starts from the oldest, 2023-10-16, and each draft moves every pin it can trace to 2026-09-30.endive and lists them.',
        action: 'Check each pin the draft lists before merging it.',
      },
    ],
  });
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

it('proposes a configuration without a lockfile or checks only when asked, keeping why', async () => {
  const unlocked = await repository({
    'package.json': manifest('^22.1.1', TESTS),
    'src/lib/stripe.ts': QUILL,
  });
  const refused = await proposeStripeConfiguration(unlocked);
  expect(refused.proposal).toBeNull();
  const untested = await proposeStripeConfiguration(unlocked, { allowUntested: true });
  expect(untested.stops).toEqual(refused.stops);
  expect(untested.proposal).toMatchObject({
    apiVersion: { value: '2026-04-22.dahlia' },
    checks: { kind: 'tests', source: 'the test script in package.json, run with npm' },
    reviews: refused.stops,
  });
  // Preparation then fails on the missing lockfile, so the patch is published untested.
  expect(untested.proposal!.configuration.integrations[0]).toMatchObject({
    prepareDependencies: true,
    command: ['npm', 'test'],
  });
  expect(proposalSummary(untested.proposal!)).toBe(
    'No .refit.json is committed, so Refit generated one: Stripe API version 2026-04-22.dahlia (set at src/lib/stripe.ts:3), moving to 2026-09-30.endive, checked by the test script in package.json, run with npm. No test imports Stripe code, so the tests show only that the rest of the code still works. TypeScript is not installed, so no type check runs with them. Each draft Refit opens with it is titled [Needs review]: Refit installs dependencies only from a committed lockfile, and this repository has none at its root. Run npm install, pnpm install or yarn install once and commit the lockfile it writes.',
  );

  // No test script, and a client only require() loads, which no type check can cover.
  const unchecked = await repository({
    'package.json': manifest('^22.1.1'),
    'package-lock.json': npmLock('22.1.1'),
    'src/lib/stripe.js': QUILL.replace(
      'import Stripe from "stripe";',
      'const Stripe = require("stripe");',
    ),
  });
  expect((await proposeStripeConfiguration(unchecked)).proposal).toBeNull();
  const noop = (await proposeStripeConfiguration(unchecked, { allowUntested: true })).proposal!;
  // The no-op check is the one the draft names as testing nothing (pipeline/publication.ts).
  expect(noop.configuration.integrations[0]).toEqual({
    id: 'stripe',
    before: './refit/stripe-2026-04-22.dahlia.json',
    after: './refit/stripe-2026-09-30.endive.json',
    apiVersion: '2026-04-22.dahlia',
    image: 'node:22-alpine',
    prepareDependencies: true,
    command: ['node', '-e', '0'],
  });
  expect(noop.checks).toEqual({
    kind: 'none',
    source: 'node -e 0, which tests nothing',
    reason:
      'There is no test script. Stripe is loaded with require() (src/lib/stripe.js), which TypeScript leaves untyped, so no type check can cover the Stripe code.',
  });
  expect(noop.reviews.map((stop) => stop.id)).toEqual(['no-checks']);
});

it('still refuses an untested repository for any other reason, and names every reason', async () => {
  const unparsed = await repository({
    'package.json': manifest('^22.1.1', TESTS),
    'src/lib/stripe.ts': QUILL,
    'src/billing.ts': "import Stripe from 'stripe';\nconst total = ;\n",
  });
  expect(await proposeStripeConfiguration(unparsed, { allowUntested: true })).toEqual(
    await proposeStripeConfiguration(unparsed),
  );
  // Without the lockfile stop in the way, the workspace-package stop is reached and still refuses.
  const workspace = await repository({
    'package.json': JSON.stringify({ name: 'faster-fixes', scripts: { test: 'turbo run test' } }),
    'pnpm-workspace.yaml': 'packages:\n  - "apps/*"\n',
    'apps/web/package.json': manifest('^20.2.0', { name: 'web' }),
    'apps/web/src/stripe.ts': `import Stripe from "stripe";
export const stripe = new Stripe("", { apiVersion: "2025-12-15.clover" });
`,
  });
  expect((await proposeStripeConfiguration(workspace)).stops.map((stop) => stop.id)).toEqual([
    'no-lockfile',
  ]);
  const allowed = await proposeStripeConfiguration(workspace, { allowUntested: true });
  expect(allowed.proposal).toBeNull();
  expect(allowed.stops.map((stop) => stop.id)).toEqual(['no-lockfile', 'workspace-package']);
});

// pnpm and Yarn lockfiles cut to the importer and entry Refit reads for one workspace package.
const pnpmLock = (directory: string, stripe: string) => `lockfileVersion: '9.0'
importers:
${directory === '.' ? '' : '  .: {}\n'}  ${directory}:
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

it('stops for stripe declared only in a workspace package, which generation does not cover yet', async () => {
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
  expect(await proposeStripeConfiguration(root)).toEqual({
    proposal: null,
    stops: [
      {
        id: 'workspace-package',
        detail:
          'stripe is declared in apps/web/package.json, not in the root package.json, and Refit does not yet generate a configuration that checks a workspace package from the root.',
        action:
          "Commit a .refit.json whose checks run that package's tests from the root (docs/REPOSITORY-SETUP.md).",
      },
    ],
  });
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
  // With stripe only in the workspace package, generation stops; the rooted layout below still
  // takes each package's own release.
  expect((await proposeStripeConfiguration(root)).stops).toMatchObject([
    { id: 'workspace-package' },
  ]);
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
        'stripe is declared in serverless/payment/checkStripeSession/package.json and serverless/payment/createStripeSession/package.json, which the root lockfile does not install, so Refit cannot prepare those projects.',
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
    reason:
      'No test imports Stripe code, so the tests show only that the rest of the code still works. TypeScript is not installed, so no type check runs with them.',
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
  // The root lockfile does not install that client, so its default is not assumed.
  expect(await reviewed(functions)).toEqual({
    apiVersion: {
      value: '2022-08-01',
      source: 'assumed: the oldest version Refit has a contract for',
    },
    reviews: ['stripe-not-locked', 'api-version-assumed'],
  });
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

// The P3 held-out sample (docs/overnight/P3.md): repositories no slice was written against.
// jackytea/parameters-dev src/lib/billing/stripe.ts
const LAZY_CLIENT = `import Stripe from 'stripe'

let client: Stripe | null = null

const stripeClient = (): Stripe => {
  if (client) {
    return client
  }

  const secretKey = process.env.STRIPE_SECRET_KEY

  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not configured on this instance')
  }

  client = new Stripe(secretKey)

  return client
}

const isStripeConfigured = (): boolean => {
  return Boolean(process.env.STRIPE_SECRET_KEY)
}

export { isStripeConfigured, stripeClient }
`;
// Adarshagupta/cheatbit-desktop backend/server.js, lines 8, 102, 176, 1392 to 1397 and 2254, cut.
// The tracer follows this client until the file reads require.main.
const MAIN_MODULE_CLIENT = `const Stripe = require("stripe");

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const stripe = STRIPE_SECRET_KEY ? Stripe(STRIPE_SECRET_KEY) : null;

if (require.main === module) {
  startNodeServer().catch((error) => {
    console.error("Failed to initialize PostgreSQL backend:", error);
    process.exit(1);
  });
}

async function createCheckout(customer) {
  const session = await stripe.checkout.sessions.create({ customer, mode: "subscription" });
  return session.url;
}
`;
const UNFOLLOWED_ACTION =
  "Nothing in your code needs to change: Refit follows a client created directly in a const declaration, such as const stripe = new Stripe(secretKey, { apiVersion: '<your API version>' }), so it stops here until it can follow this one.";

it('blames a tsconfig only when it hides a client, and names a client it sees but cannot follow', async () => {
  // cheatbit-desktop: mobile/ extends Expo's base tsconfig, but the only client is in backend/.
  const desktop = await repository({
    'package.json': manifest('^18.5.0', TESTS),
    'package-lock.json': npmLock('18.5.0'),
    'tsconfig.json': JSON.stringify({
      compilerOptions: { allowJs: true },
      include: ['electron/**/*', 'src/**/*'],
    }),
    'mobile/tsconfig.json': JSON.stringify({
      extends: 'expo/tsconfig.base',
      compilerOptions: { strict: true },
    }),
    'backend/server.js': MAIN_MODULE_CLIENT,
  });
  expect((await proposeStripeConfiguration(desktop)).stops).toEqual([
    {
      id: 'no-stripe-client',
      detail:
        'Refit sees a Stripe client created at backend/server.js:4, but cannot follow it to the calls that use it.',
      action: UNFOLLOWED_ACTION,
    },
  ]);
  // Constructed from the one above: several unfollowed clients are named together.
  const both = await repository({
    'package.json': manifest('^18.5.0', TESTS),
    'package-lock.json': npmLock('18.5.0'),
    'backend/server.js': MAIN_MODULE_CLIENT,
    'backend/worker.js': MAIN_MODULE_CLIENT,
  });
  expect((await proposeStripeConfiguration(both)).stops).toEqual([
    {
      id: 'no-stripe-client',
      detail:
        'Refit sees Stripe clients created at backend/server.js:4 and backend/worker.js:4, but cannot follow them to the calls that use them.',
      action: UNFOLLOWED_ACTION.replace('this one', 'these'),
    },
  ]);
  // jackytea/parameters-dev: tsconfig.json references "tsconfig.vite.json" without "./", which
  // Refit does not read, so no import resolves under it; the client itself is followed elsewhere.
  const referenced = await repository({
    'package.json': manifest('^17.7.0', TESTS),
    'pnpm-lock.yaml': pnpmLock('.', '17.7.0'),
    'tsconfig.json': JSON.stringify({
      compilerOptions: { strict: true, allowJs: true, paths: { '@/*': ['./src/*'] } },
      include: ['**/*.ts', '**/*.tsx'],
      references: [{ path: 'tsconfig.vite.json' }],
    }),
    'tsconfig.vite.json': JSON.stringify({
      compilerOptions: { composite: true, module: 'ESNext', moduleResolution: 'bundler' },
      include: ['vite.config.ts'],
    }),
    'src/lib/billing/stripe.ts': LAZY_CLIENT,
  });
  expect((await proposeStripeConfiguration(referenced)).stops).toEqual([
    {
      id: 'source-resolution',
      detail:
        'Refit found no Stripe client it can follow, because it cannot verify how imports resolve under tsconfig.json.',
      action:
        'Nothing in your code needs to change: Refit stops here until it can verify how tsconfig.json resolves imports.',
    },
  ]);
  // Without that tsconfig, Refit follows the same client and generates.
  const unreferenced = await repository({
    'package.json': manifest('^17.7.0', TESTS),
    'pnpm-lock.yaml': pnpmLock('.', '17.7.0'),
    'src/lib/billing/stripe.ts': LAZY_CLIENT,
  });
  expect((await proposeStripeConfiguration(unreferenced)).stops).toEqual([]);
});

it('says a pinning stripe-node release Refit does not record sends its own version', async () => {
  // uzzaidev/Convoca src/lib/stripe.ts, on stripe-node 21.0.1, a major the release table skips.
  const pinning = await repository({
    'package.json': manifest('^21.0.1', TESTS),
    'pnpm-lock.yaml': pnpmLock('.', '21.0.1'),
    'src/lib/stripe.ts': `import Stripe from "stripe";

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error(
        "STRIPE_SECRET_KEY não está definida. " +
          "Configure no .env.local ou no dashboard da Vercel."
      );
    }
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      typescript: true,
    });
  }
  return _stripe;
}
`,
  });
  expect((await proposeStripeConfiguration(pinning)).stops).toEqual([
    {
      id: 'api-version-account-default',
      detail:
        "The Stripe client at src/lib/stripe.ts:13 sets no apiVersion, so it sends the API version stripe-node 21.0.1 pins, and Refit's table of stripe-node releases does not record which one that is.",
      action:
        'Set apiVersion at src/lib/stripe.ts:13 to the version stripe-node 21.0.1 pins (its changelog names it), or commit a .refit.json that sets it (docs/REPOSITORY-SETUP.md).',
    },
  ]);
  const oldest = {
    apiVersion: {
      value: '2022-08-01',
      source: 'assumed: the oldest version Refit has a contract for',
    },
    reviews: ['api-version-account-default', 'api-version-assumed'],
  };
  expect(await reviewed(pinning)).toEqual(oldest);
  // Mangoz1x/GptRewrite pages/api/intent/[plan].js: stripe-node 11 sends the account's default.
  const account = await repository({
    'package.json': manifest('^11.10.0', TESTS),
    'package-lock.json': npmLock('11.10.0'),
    'pages/api/intent/[plan].js': `import { getCookies } from 'cookies-next';
import db from "../../../mongo/interact";
import { decrypt } from "../../../helpers/decrypt";
import gateway from "stripe";

const stripe = gateway(process.env.STRIPE_KEY);
`,
  });
  expect((await proposeStripeConfiguration(account)).stops).toEqual([
    {
      id: 'api-version-account-default',
      detail:
        "The Stripe client at pages/api/intent/[plan].js:6 sets no apiVersion, and Refit does not know which version stripe-node 11.10.0 sends by default, so requests may use your Stripe account's default version.",
      action:
        'Set apiVersion at pages/api/intent/[plan].js:6 to the version your account uses, or commit a .refit.json that sets it (docs/REPOSITORY-SETUP.md).',
    },
  ]);
  expect(await reviewed(account)).toEqual(oldest);
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

// A checked-out submodule's files are not in `git archive`, which validation reads, so enrollment
// leaves them out too: enroll, doctor and the worker (which checks out none) propose the same.
it.each<{ path: string; files: Record<string, string> }>([
  { path: 'vendor/lib', files: { 'stripe.js': QUILL.replace('2026-04-22.dahlia', '2024-06-20') } },
  {
    path: 'packages/ui',
    files: {
      'package.json': manifest('^14.25.0'),
      'src/stripe.ts': QUILL.replace('2026-04-22.dahlia', '2023-10-16'),
    },
  },
])('leaves the files of a checked-out submodule at $path out', async ({ path, files }) => {
  const git = (directory: string, ...args: string[]) =>
    promisify(execFile)('git', [
      '-C',
      directory,
      '-c',
      'user.name=Refit Tests',
      '-c',
      'user.email=tests@refit.local',
      '-c',
      'protocol.file.allow=always',
      ...args,
    ]);
  const library = await repository(files);
  await git(library, 'init', '-qb', 'main');
  await git(library, 'add', '.');
  await git(library, 'commit', '-qm', 'library');
  const root = await repository({
    'package.json': manifest('^22.1.1', TESTS),
    'package-lock.json': npmLock('22.1.1'),
    'src/lib/stripe.ts': QUILL,
  });
  await git(root, 'init', '-qb', 'main');
  await git(root, 'submodule', '-q', 'add', library, path);
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'app');
  const { proposal, stops } = await proposeStripeConfiguration(root, { allowUntested: true });
  expect(stops).toEqual([]);
  expect(proposal!.apiVersion).toEqual({
    value: '2026-04-22.dahlia',
    source: 'set at src/lib/stripe.ts:3',
  });
});
