import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import type { BehaviourTest } from './behaviour-tests.ts';
import { readRepository } from './repository.ts';
import { subscriptionPeriodHelperModule } from './stripe-subscription-periods.ts';
import { runBehaviourTests } from './validation.ts';

const execute = promisify(execFile);
const IMAGE = process.env.REFIT_DOCKER_IMAGE;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Source: images.txt of refit-bench run 40144503063 (the stripe-mock every benchmark shard pulled),
// 2026-10-24.
const STRIPE_MOCK =
  'stripe/stripe-mock@sha256:aeb96b83e87a893d2ac005e363ac01ffa6e59a5ad85b49c155dfc9129de02e78';
// Source: data/stripe-openapi-versions.json (spec3.json commits and SHA-256) and the fixtures3.json
// beside each spec at the same commit, hashed 2026-10-24.
const VERSIONS = {
  before: {
    version: '2025-02-24.acacia',
    commit: '5c3d9081b4237de06dee3f6a6307a3dfe81b6c0f',
    spec: '1199cc3c55746cb73b7be5c67b6e41f9b30b6ac428ca6c6d5ac904fa0f7b6acd',
    fixtures: '732479cfe2cf2245c8c433be71d0870401946782faec63a3aef3b5b51d23ff11',
  },
  after: {
    version: '2026-09-30.endive',
    commit: 'ce576d4f145edeef361a64d9d51b2153e3696b0b',
    spec: '7cff4cc46d0654101a36a3302f7544640f5f73e4f3cad6f264f0e23c19fa1776',
    fixtures: 'e6822f7ee6fd71bdde6228537368aafcfb7191109340fe119d9aca27c6e9396d',
  },
};
const STRIPE_NODE = '19.1.0';

async function download(commit: string, file: string, sha256: string, destination: string) {
  const response = await fetch(
    `https://raw.githubusercontent.com/stripe/openapi/${commit}/openapi/${file}`,
  );
  const content = Buffer.from(await response.arrayBuffer());
  expect(createHash('sha256').update(content).digest('hex')).toBe(sha256);
  await writeFile(destination, content);
  return destination;
}

// The same reduced snippets as behaviour-tests.test.ts, on the real stripe-node client:
// emman-tt/tilios-backend at b554dcb083a058353c5d849d668d5ddf9c5159b2 (services/stripe.js without
// dotenv, controller/payment/payment.js verbatim), adityayaduvanshi/Full-Stack-Music-Web-App at
// 90e902f43863d09fc6451f8c7f50fed7c096bcc3 (libs/supabaseAdmin.ts without Supabase, libs/helper.ts)
// and Hombre2014/Genius at 375bbe751130abbe738dc67971560acba715f1f5 (app/api/webhook/route.ts, the
// invoice.payment_succeeded branch).
const PAYMENT = (parameter: string) => `import { Order } from '../../database/orders.js'
import { stripe } from '../../services/stripe.js'

export async function handlePayments (req, res, next) {
  try {
    const decoded = req.user
    const userId = decoded.sub
    const { allDetails, orderId } = req.details

    const line_items = allDetails.map(item => {
      return {
        price_data: {
          currency: 'usd',
          product_data: {
            name: item.product_name,
            images: [item.product_image]
          },
          unit_amount: Math.round(item.priceAtSale * 100)
        },
        quantity: item.product_quantity
      }
    })

    const session = await stripe.checkout.sessions.create({
      ${parameter}: ['card'],
      line_items: line_items,
      mode: 'payment',
      metadata: {
        orderId: orderId.toString(),
        userId: userId.toString()
      },
      success_url: \`\${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}\`,
      cancel_url: \`\${process.env.FRONTEND_URL}\`
    })

    await Order.update({ stripeSessionId: session.id }, { where: { id: orderId } })

    res.status(200).json({
      status: 'success',
      url: session.url
    })
  } catch (error) {
    return next(error)
  }
}
`;
const PERIODS = (
  start: string,
  end: string,
  extraImport = '',
) => `import { stripe } from './stripe';
import { toDateTime } from './helper';${extraImport}

const manageSubscriptionStatusChange = async (
  subscriptionId: string,
  customerId: string,
  createAction = false
) => {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['default_payment_method'],
  });

  return {
    id: subscription.id,
    current_period_start: toDateTime(
      ${start}
    ).toISOString(),
    current_period_end: toDateTime(
      ${end}
    ).toISOString(),
  };
};

export { manageSubscriptionStatusChange };
`;
const INVOICE = (
  subscription: string,
  end: string,
  extraImport = '',
) => `import { stripe } from '@/libs/stripe';${extraImport}

export async function invoicePaid(event: { type: string; data: { object: any } }) {
  const session = event.data.object;

  if (event.type === 'invoice.payment_succeeded') {
    const subscription = await stripe.subscriptions.retrieve(
      ${subscription} as string
    );

    return {
      stripeSubscriptionId: subscription.id,
      stripeCurrentPeriodEnd: new Date(
        ${end} * 1000
      ),
    };
  }
}
`;
const CLIENT = (version: string) =>
  `import Stripe from 'stripe';\nexport const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '${version}' as any });\n`;
const HELPERS =
  "\nimport { getInvoiceSubscription, getSubscriptionPeriodEnd, getSubscriptionPeriodStart } from './stripe-subscription-period';";

const ORIGINAL = {
  'package.json': JSON.stringify({ type: 'module', dependencies: { stripe: STRIPE_NODE } }),
  'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'] } } }),
  'services/stripe.js':
    "import Stripe from 'stripe'\nexport const stripe = new Stripe(process.env.STRIPE_SECRET)\n",
  'database/orders.js': 'export const Order = { update: async () => [1] };\n',
  'controller/payment/payment.js': PAYMENT('payment_method_types'),
  'libs/stripe.ts': CLIENT(VERSIONS.before.version),
  'libs/helper.ts':
    "export const toDateTime = (secs: number) => {\n  var t = new Date('1970-01-01T00:30:00Z');\n  t.setSeconds(secs);\n  return t;\n};\n",
  'libs/supabaseAdmin.ts': PERIODS(
    'subscription.current_period_start',
    'subscription.current_period_end',
  ),
  'app/api/webhook/invoice.ts': INVOICE('session.subscription', 'subscription.current_period_end'),
};
const CORRECT = {
  ...ORIGINAL,
  'controller/payment/payment.js': PAYMENT('allowed_payment_method_types'),
  'libs/stripe.ts': CLIENT(VERSIONS.after.version),
  'libs/stripe-subscription-period.ts': subscriptionPeriodHelperModule('ts'),
  'libs/supabaseAdmin.ts': PERIODS(
    'getSubscriptionPeriodStart(subscription)',
    'getSubscriptionPeriodEnd(subscription)',
    HELPERS,
  ),
  'app/api/webhook/invoice.ts': INVOICE(
    'getInvoiceSubscription(session)',
    'getSubscriptionPeriodEnd(subscription)',
    HELPERS.replace("'./", "'../../../libs/"),
  ),
};
const FINDINGS = [
  { file: 'controller/payment/payment.js' },
  { file: 'libs/supabaseAdmin.ts' },
  { file: 'app/api/webhook/invoice.ts' },
];

// Version-neutral: stripe-mock's fixtures differ between versions in value, so the tests assert what
// both versions must give (a session URL, valid dates), not fixture values.
const TESTS: BehaviourTest[] = [
  {
    path: 'refit-behaviour/payments.test.mjs',
    content: `import test from 'node:test';
import assert from 'node:assert/strict';
import { stripeRequests, resetStripeRequests } from 'refit:behaviour';
import { handlePayments } from '../controller/payment/payment.js';
test('creates a Checkout Session for the order and returns its URL', async () => {
  resetStripeRequests();
  let status;
  let body;
  let failure;
  const res = { status(code) { status = code; return this; }, json(value) { body = value; } };
  await handlePayments(
    { user: { sub: 7 }, details: { orderId: 42, allDetails: [{ product_name: 'Desk', product_image: 'https://example.test/desk.png', priceAtSale: 19.99, product_quantity: 2 }] } },
    res,
    (error) => { failure = error; },
  );
  assert.equal(failure, undefined);
  assert.equal(status, 200);
  assert.match(body.url, /^https:\\/\\/checkout\\.stripe\\.com\\//);
  assert.equal(stripeRequests[0].path, '/v1/checkout/sessions');
  assert.equal(stripeRequests[0].body.line_items[0].price_data.unit_amount, '1999');
  assert.deepEqual(stripeRequests[0].body.metadata, { orderId: '42', userId: '7' });
});
`,
  },
  {
    path: 'refit-behaviour/subscriptions.test.mjs',
    content: `import test from 'node:test';
import assert from 'node:assert/strict';
import { manageSubscriptionStatusChange } from '../libs/supabaseAdmin.ts';
import { invoicePaid } from '../app/api/webhook/invoice.ts';
test('records a valid billing period', async () => {
  const data = await manageSubscriptionStatusChange('sub_1', 'cus_1');
  assert.ok(!Number.isNaN(Date.parse(data.current_period_start)));
  assert.ok(!Number.isNaN(Date.parse(data.current_period_end)));
});
test('stores the period end of the subscription an old-version invoice event names', async () => {
  const written = await invoicePaid({ type: 'invoice.payment_succeeded', data: { object: { id: 'in_1', object: 'invoice', subscription: 'sub_1' } } });
  assert.equal(typeof written.stripeSubscriptionId, 'string');
  assert.ok(Number.isFinite(written.stripeCurrentPeriodEnd.getTime()));
});
`,
  },
];

it.skipIf(!IMAGE || !process.env.REFIT_NPM_PREPARE)(
  'gives grade A to a correct patch and catches wrong ones with real stripe-mock and stripe-node in offline Docker',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'refit-behaviour-docker-'));
    roots.push(root);
    await chmod(root, 0o755);
    await execute('docker', ['pull', '-q', STRIPE_MOCK], { timeout: 300_000 });
    const files = join(root, 'openapi');
    await mkdir(files);
    const contract = (side: 'before' | 'after', kind: 'spec' | 'fixtures') =>
      download(
        VERSIONS[side].commit,
        `${kind}3.json`,
        VERSIONS[side][kind],
        join(files, `${side}-${kind}.json`),
      );
    const contracts = {
      before: await contract('before', 'spec'),
      after: await contract('after', 'spec'),
    };
    const settings = {
      stripeMockImage: STRIPE_MOCK,
      beforeFixtures: await contract('before', 'fixtures'),
      afterFixtures: await contract('after', 'fixtures'),
    };
    // The real SDK, installed once on the runner, enters both sandboxes as prepared dependencies do.
    const install = join(root, 'install');
    await mkdir(install);
    await writeFile(join(install, 'package.json'), ORIGINAL['package.json']);
    await execute('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: install,
      timeout: 300_000,
    });
    const dependencies = join(root, 'dependencies.tar');
    await execute('tar', ['-cf', dependencies, '-C', install, 'node_modules']);
    await chmod(dependencies, 0o644);
    const app = async (name: string, content: Record<string, string>) => {
      const directory = join(root, name);
      for (const [path, text] of Object.entries(content)) {
        await mkdir(dirname(join(directory, path)), { recursive: true });
        await writeFile(join(directory, path), text);
      }
      await execute('chmod', ['-R', 'a+rX', directory]);
      return { directory, repository: await readRepository(directory, 'stripe') };
    };
    const original = await app('original', ORIGINAL);
    const run = async (name: string, content: Record<string, string>) => {
      const patched = await app(name, content);
      return runBehaviourTests({
        tests: TESTS,
        settings,
        image: IMAGE!,
        root,
        original: { ...original, contract: contracts.before, dependencies },
        patched: { ...patched, contract: contracts.after, dependencies },
        findings: FINDINGS,
      });
    };
    const correct = await run('correct', CORRECT);
    expect(correct.missing).toEqual([]);
    expect(correct).toMatchObject({ status: 'passed', grade: 'A', regressions: [] });
    expect(JSON.parse(await readFile(contracts.after, 'utf8')).info.version).toBe(
      VERSIONS.after.version,
    );
    const kept = await run('kept', {
      ...CORRECT,
      'controller/payment/payment.js': PAYMENT('payment_method_types'),
    });
    expect(kept).toMatchObject({ status: 'regression', grade: null });
    expect(kept.regressions.map((regression) => regression.id)).toEqual([
      'refit-behaviour/payments.test.mjs > creates a Checkout Session for the order and returns its URL',
    ]);
    expect(kept.regressions[0].error).toContain('payment_method_types');
    const newOnly = await run('new-only', {
      ...CORRECT,
      'app/api/webhook/invoice.ts': INVOICE(
        'session.parent.subscription_details.subscription',
        'getSubscriptionPeriodEnd(subscription)',
        HELPERS.replace("'./", "'../../../libs/"),
      ),
    });
    expect(newOnly).toMatchObject({ status: 'regression', grade: null });
    expect(newOnly.regressions.map((regression) => regression.id)).toEqual([
      'refit-behaviour/subscriptions.test.mjs > stores the period end of the subscription an old-version invoice event names',
    ]);
    const leftRead = await run('left-read', {
      ...CORRECT,
      'libs/supabaseAdmin.ts': PERIODS(
        'subscription.current_period_start',
        'subscription.current_period_end',
      ),
    });
    expect(leftRead).toMatchObject({ status: 'regression', grade: null });
    expect(leftRead.regressions).toEqual([
      {
        id: 'refit-behaviour/subscriptions.test.mjs > records a valid billing period',
        error: expect.stringContaining('Invalid time value'),
      },
    ]);
  },
  900_000,
);
