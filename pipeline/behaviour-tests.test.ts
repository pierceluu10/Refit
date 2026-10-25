import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import {
  behaviourGrade,
  changedStripeLines,
  compareBehaviourRuns,
  lineCoverage,
  validateBehaviourTests,
  writeBehaviourHarness,
  type BehaviourTest,
} from './behaviour-tests.ts';
import { gradeEvidence } from './check-selection.ts';
import { typescriptDirectory, writeHarness } from './generated-checks.ts';
import { readRepository } from './repository.ts';
import { subscriptionPeriodHelperModule } from './stripe-subscription-periods.ts';
import type { CheckResult } from './validation.ts';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'refit-behaviour-')));
  roots.push(root);
  return root;
}

async function writeApp(directory: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), content);
  }
  return readRepository(directory, 'stripe');
}

// A stand-in for stripe-node's Node HTTP client: form bodies with indexed brackets (encoded, as qs
// does), an HTTPS agent, the body written after secureConnect on a new socket, and an error on a
// non-2xx response.
const CLIENT = `import https from 'node:https';
const encode = (value, prefix) =>
  Array.isArray(value)
    ? value.flatMap((item, index) => encode(item, prefix + '[' + index + ']'))
    : value && typeof value === 'object'
      ? Object.entries(value).flatMap(([key, item]) => encode(item, prefix ? prefix + '[' + key + ']' : key))
      : [encodeURIComponent(prefix) + '=' + encodeURIComponent(String(value))];
const call = (method, path, params) =>
  new Promise((resolve, reject) => {
    const body = method === 'POST' ? encode(params ?? {}, '').join('&') : '';
    const req = https.request({ host: 'api.stripe.com', port: 443, path, method, agent: new https.Agent({ keepAlive: true }), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Stripe-Version': '2023-08-16' } });
    req.on('response', (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        const json = JSON.parse(data);
        if (res.statusCode >= 400) reject(Object.assign(new Error(json.error.message), { type: json.error.type }));
        else resolve(json);
      });
    });
    req.on('error', reject);
    // As stripe-node does: a reused keep-alive socket is already connected.
    req.once('socket', (socket) => (socket.connecting ? socket.once('secureConnect', () => req.end(body)) : req.end(body)));
  });
export const stripe = {
  checkout: { sessions: { create: (params) => call('POST', '/v1/checkout/sessions', params) } },
  subscriptions: { retrieve: (id) => call('GET', '/v1/subscriptions/' + id) },
};
`;

// emman-tt/tilios-backend at b554dcb083a058353c5d849d668d5ddf9c5159b2,
// controller/payment/payment.js, verbatim; its Sequelize models are stand-ins.
const PAYMENT = `import { CartProduct } from '../../database/cartProduct.js'
import { Order } from '../../database/orders.js'
import { Product } from '../../database/products.js'
import { User } from '../../database/user.js'
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
    // console.log(line_items)

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: line_items,
      mode: 'payment',
      metadata: {
        orderId: orderId.toString(),
        userId: userId.toString()
      },
      success_url: \`\${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}\`,
      cancel_url: \`\${process.env.FRONTEND_URL}\`
    })

    await Order.update(
      {
        stripeSessionId: session.id
      },
      {
        where: {
          id: orderId
        }
      }
    )

    res.status(200).json({
      status: 'success',
      url: session.url
    })
  } catch (error) {
    return next(error)
  }
}
`;

// adityayaduvanshi/Full-Stack-Music-Web-App at 90e902f43863d09fc6451f8c7f50fed7c096bcc3:
// libs/supabaseAdmin.ts's manageSubscriptionStatusChange without its Supabase calls, and
// libs/helper.ts's toDateTime verbatim.
const PERIODS = `import { stripe } from './stripe';
import { toDateTime } from './helper';

const manageSubscriptionStatusChange = async (
  subscriptionId: string,
  customerId: string,
  createAction = false
) => {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['default_payment_method'],
  });

  const subscriptionData = {
    id: subscription.id,
    current_period_start: toDateTime(
      subscription.current_period_start
    ).toISOString(),
    current_period_end: toDateTime(
      subscription.current_period_end
    ).toISOString(),
  };
  return subscriptionData;
};

export { manageSubscriptionStatusChange };
`;
const TO_DATE_TIME = `export const toDateTime = (secs: number) => {
  var t = new Date('1970-01-01T00:30:00Z');
  t.setSeconds(secs);
  return t;
};
`;

// Hombre2014/Genius at 375bbe751130abbe738dc67971560acba715f1f5, app/api/webhook/route.ts: the
// invoice.payment_succeeded branch, given the event and returning what it wrote with Prisma.
const INVOICE = `import { stripe } from '@/lib/stripe';

export async function invoicePaid(event: { type: string; data: { object: any } }) {
  const session = event.data.object;

  if (event.type === 'invoice.payment_succeeded') {
    const subscription = await stripe.subscriptions.retrieve(
      session.subscription as string
    );

    return {
      stripeSubscriptionId: subscription.id,
      stripePriceId: subscription.items.data[0].price.id,
      stripeCurrentPeriodEnd: new Date(
        subscription.current_period_end * 1000
      ),
    };
  }
}
`;

const ORIGINAL = {
  'package.json': JSON.stringify({ type: 'module' }),
  'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'] } } }),
  'services/stripe.js': CLIENT,
  'lib/stripe.ts': CLIENT,
  'libs/stripe.ts': CLIENT,
  'database/cartProduct.js': 'export const CartProduct = {};\n',
  'database/orders.js': 'export const Order = { update: async () => [1] };\n',
  'database/products.js': 'export const Product = {};\n',
  'database/user.js': 'export const User = {};\n',
  'controller/payment/payment.js': PAYMENT,
  'libs/helper.ts': TO_DATE_TIME,
  'libs/supabaseAdmin.ts': PERIODS,
  'app/api/webhook/invoice.ts': INVOICE,
};

// Refit's patch: the endive card rename, and the moved reads through the generated helper module.
const CORRECT = {
  ...ORIGINAL,
  'controller/payment/payment.js': PAYMENT.replace(
    "payment_method_types: ['card'],",
    "allowed_payment_method_types: ['card'],",
  ),
  'libs/supabaseAdmin.ts': PERIODS.replace(
    "import { toDateTime } from './helper';",
    "import { toDateTime } from './helper';\nimport { getSubscriptionPeriodEnd, getSubscriptionPeriodStart } from './stripe-subscription-period';",
  )
    .replace('subscription.current_period_start', 'getSubscriptionPeriodStart(subscription)')
    .replace('subscription.current_period_end', 'getSubscriptionPeriodEnd(subscription)'),
  'libs/stripe-subscription-period.ts': subscriptionPeriodHelperModule('ts'),
  'app/api/webhook/invoice.ts': INVOICE.replace(
    "import { stripe } from '@/lib/stripe';",
    "import { stripe } from '@/lib/stripe';\nimport { getInvoiceSubscription, getSubscriptionPeriodEnd } from '../../../libs/stripe-subscription-period';",
  )
    .replace('session.subscription as string', 'getInvoiceSubscription(session) as string')
    .replace(
      'subscription.current_period_end * 1000',
      'getSubscriptionPeriodEnd(subscription) * 1000',
    ),
};
const FINDINGS = [
  { file: 'controller/payment/payment.js' },
  { file: 'libs/supabaseAdmin.ts' },
  { file: 'app/api/webhook/invoice.ts' },
];

// Version-neutral behaviour tests: the same file runs on both sides and asserts only what both API
// versions must do. The invoice event has the shape the webhook endpoint receives at its pinned
// version, which Stripe keeps sending after the code's own version moves.
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
  assert.equal(body.url, 'https://checkout.stripe.com/c/pay/cs_test_1');
  assert.equal(stripeRequests.length, 1);
  assert.equal(stripeRequests[0].method, 'POST');
  assert.equal(stripeRequests[0].path, '/v1/checkout/sessions');
  assert.equal(stripeRequests[0].body.mode, 'payment');
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
import { toDateTime } from '../libs/helper.ts';
import { invoicePaid } from '@/app/api/webhook/invoice';

test('records the subscription billing period', async () => {
  const data = await manageSubscriptionStatusChange('sub_1', 'cus_1');
  assert.equal(data.current_period_start, toDateTime(1700000000).toISOString());
  assert.equal(data.current_period_end, toDateTime(1702592000).toISOString());
});

test('stores the period end of the paid invoice subscription', async () => {
  const written = await invoicePaid({ type: 'invoice.payment_succeeded', data: { object: { id: 'in_1', object: 'invoice', subscription: 'sub_1' } } });
  assert.equal(written.stripeSubscriptionId, 'sub_1');
  assert.equal(written.stripeCurrentPeriodEnd.toISOString(), new Date(1702592000 * 1000).toISOString());
});
`,
  },
];

// A simulated stripe-mock: the subscription shape before and after basil moved the periods onto the
// items, and stripe-mock's request validation of parameters the served version does not define.
async function simulatedStripeMock() {
  let side: 'before' | 'after' = 'before';
  const server = createServer((request: IncomingMessage, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      response.setHeader('Content-Type', 'application/json');
      const param = side === 'after' ? 'payment_method_types' : 'allowed_payment_method_types';
      const sent = body.split('&').some((pair) => decodeURIComponent(pair).startsWith(`${param}[`));
      if (request.url === '/v1/checkout/sessions' && sent) {
        response.statusCode = 400;
        response.end(
          JSON.stringify({
            // stripe-mock's wording (refit-bench run 40148812652), which names no parameter.
            error: {
              type: 'invalid_request_error',
              message:
                'Request validation error: validator failed: additional properties are not allowed',
            },
          }),
        );
        return;
      }
      if (request.url === '/v1/checkout/sessions') {
        response.end(
          JSON.stringify({
            id: 'cs_test_1',
            object: 'checkout.session',
            url: 'https://checkout.stripe.com/c/pay/cs_test_1',
          }),
        );
        return;
      }
      const period = { current_period_start: 1700000000, current_period_end: 1702592000 };
      const item = { id: 'si_1', price: { id: 'price_1' } };
      response.end(
        JSON.stringify(
          side === 'before'
            ? { id: 'sub_1', object: 'subscription', ...period, items: { data: [item] } }
            : { id: 'sub_1', object: 'subscription', items: { data: [{ ...item, ...period }] } },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: String((server.address() as { port: number }).port),
    use: (value: 'before' | 'after') => (side = value),
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// Runs the sandbox runner outside Docker against the simulated stripe-mock, as one side.
async function runSide(
  mock: Awaited<ReturnType<typeof simulatedStripeMock>>,
  side: 'before' | 'after',
  app: string,
  tools: string,
  tests: BehaviourTest[],
): Promise<CheckResult> {
  mock.use(side);
  await rm(join(app, 'refit-behaviour'), { recursive: true, force: true });
  await rm(join(app, '.refit-coverage'), { recursive: true, force: true });
  await mkdir(join(app, 'refit-behaviour'));
  for (const test of tests) await writeFile(join(app, test.path), test.content);
  const { stdout, stderr } = await execute(process.execPath, [join(tools, 'behaviour.mjs')], {
    env: {
      ...process.env,
      REFIT_STRIPE_MOCK_PORT: mock.port,
      REFIT_GENERATED_ROOT: `${app}/`,
      REFIT_GENERATED_SIDE: side,
      REFIT_TYPESCRIPT: join(typescriptDirectory(), 'lib', 'typescript.js'),
    },
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { status: 'passed', exitCode: 0, stdout, stderr };
}

async function behaviourRun(patchedFiles: Record<string, string>, tests = TESTS) {
  const root = await scratch();
  const original = await writeApp(join(root, 'original'), ORIGINAL);
  const patched = await writeApp(join(root, 'patched'), patchedFiles);
  const changed = changedStripeLines(original, patched, FINDINGS);
  const tools = join(root, 'tools');
  await mkdir(tools);
  await writeBehaviourHarness(tools, tests, changed, { original, patched });
  const mock = await simulatedStripeMock();
  try {
    const before = await runSide(mock, 'before', original.root, tools, tests);
    const after = await runSide(mock, 'after', patched.root, tools, tests);
    return compareBehaviourRuns({
      tests,
      changed,
      sources: { original, patched },
      original: before,
      patched: after,
    });
  } finally {
    await mock.close();
  }
}

it('takes changed Stripe lines from a line diff of whole-file hunks, per side', async () => {
  const root = await scratch();
  const original = await writeApp(join(root, 'original'), ORIGINAL);
  const patched = await writeApp(join(root, 'patched'), CORRECT);
  expect(changedStripeLines(original, patched, FINDINGS)).toEqual({
    original: {
      'app/api/webhook/invoice.ts': [8, 15],
      'controller/payment/payment.js': [29],
      'libs/supabaseAdmin.ts': [16, 19],
    },
    patched: {
      'app/api/webhook/invoice.ts': [2, 9, 16],
      'controller/payment/payment.js': [29],
      'libs/supabaseAdmin.ts': [3, 17, 20],
    },
  });
  // payment.js reaches Stripe through the application's own client module, so without Refit's
  // finding it is not Stripe code; the generated helper module never is.
  expect(changedStripeLines(original, patched, FINDINGS.slice(1)).original).not.toHaveProperty(
    'controller/payment/payment.js',
  );
});

it('accepts only refit-behaviour test files', () => {
  expect(() => validateBehaviourTests(TESTS)).not.toThrow();
  for (const path of [
    '../escape.test.mjs',
    'refit-behaviour/a.test.js',
    'refit-behaviour/x/y.test.mjs',
  ])
    expect(() => validateBehaviourTests([{ path, content: '' }])).toThrow(
      'must be a refit-behaviour/',
    );
  expect(() => validateBehaviourTests([])).toThrow('1 to 20 test files');
});

it('maps V8 coverage back to TypeScript and JavaScript lines, uncalled functions and branches included', async () => {
  const root = await scratch();
  const files = {
    'package.json': JSON.stringify({ type: 'module' }),
    'lib/billing.ts': `interface Plan { id: string }
export function used(id: string): string {
  if (id === 'never') {
    return 'not taken';
  }
  // a comment
  return id.toUpperCase();
}

export function unused(id: string): string {
  const value: Plan = { id };
  return value.id;
}
`,
    'lib/plain.js': `export function used(id) {
  if (id === 'never') {
    return 'not taken';
  }
  return id.toUpperCase();
}

export function unused(id) {
  return id;
}
`,
    'main.mjs':
      "import { used } from './lib/billing.ts';\nimport { used as plain } from './lib/plain.js';\nused('a');\nplain('a');\n",
  };
  const repository = await writeApp(root, files);
  const tools = join(root, 'tools');
  await mkdir(tools);
  await writeHarness(tools, []);
  await execute(
    process.execPath,
    ['--import', join(tools, 'redirect.mjs'), join(root, 'main.mjs')],
    {
      env: {
        ...process.env,
        NODE_V8_COVERAGE: join(root, 'coverage'),
        REFIT_GENERATED_ROOT: `${root}/`,
        REFIT_TYPESCRIPT: join(typescriptDirectory(), 'lib', 'typescript.js'),
      },
    },
  );
  const ranges = async (path: string) => {
    const result: [number, number, number][][] = [];
    for (const name of await readdir(join(root, 'coverage')))
      for (const script of JSON.parse(await readFile(join(root, 'coverage', name), 'utf8')).result)
        if (script.url.endsWith(`/${path}`))
          result.push(
            script.functions.flatMap(
              (entry: { ranges: { startOffset: number; endOffset: number; count: number }[] }) =>
                entry.ranges.map((range) => [range.startOffset, range.endOffset, range.count]),
            ),
          );
    return result;
  };
  const content = (path: string) => repository.files.find((file) => file.path === path)!.content;
  expect(
    lineCoverage(
      'lib/billing.ts',
      content('lib/billing.ts'),
      [1, 3, 4, 6, 7, 11, 12],
      await ranges('lib/billing.ts'),
    ),
  ).toEqual({ executed: [3, 7], missing: [4, 11, 12], notExecutable: [1, 6] });
  expect(
    lineCoverage(
      'lib/plain.js',
      content('lib/plain.js'),
      [2, 3, 4, 5, 9],
      await ranges('lib/plain.js'),
    ),
  ).toEqual({ executed: [2, 5], missing: [3, 9], notExecutable: [4] });
  // Coverage of other code than Refit maps (here: of the JavaScript file) is not used.
  expect(
    lineCoverage('lib/billing.ts', content('lib/billing.ts'), [3], await ranges('lib/plain.js')),
  ).toMatchObject({
    executed: [],
    missing: [3],
    mismatch: expect.stringContaining('ran a different'),
  });
});

it('gives grade A when both sides pass and every changed Stripe line ran on both (simulated stripe-mock)', async () => {
  const result = await behaviourRun(CORRECT);
  expect(result.missing).toEqual([]);
  expect(result).toMatchObject({
    status: 'passed',
    grade: 'A',
    regressions: [],
    coverage: {
      covered: {
        original: {
          'app/api/webhook/invoice.ts': [8, 15],
          'controller/payment/payment.js': [29],
          'libs/supabaseAdmin.ts': [16, 19],
        },
        patched: {
          'app/api/webhook/invoice.ts': [2, 9, 16],
          'controller/payment/payment.js': [29],
          'libs/supabaseAdmin.ts': [3, 17, 20],
        },
      },
      missing: { original: {}, patched: {} },
    },
  });
  expect(result.sides.patched.tests.map((test) => [test.id, test.ok])).toEqual([
    [
      'refit-behaviour/payments.test.mjs > creates a Checkout Session for the order and returns its URL',
      true,
    ],
    ['refit-behaviour/subscriptions.test.mjs > records the subscription billing period', true],
    [
      'refit-behaviour/subscriptions.test.mjs > stores the period end of the paid invoice subscription',
      true,
    ],
  ]);
  expect(result.tests.map((test) => test.path)).toEqual(TESTS.map((test) => test.path));
}, 60_000);

it('catches a patch that keeps payment_method_types and one that reads a moved field only at its new location (simulated stripe-mock)', async () => {
  const kept = await behaviourRun({
    ...CORRECT,
    'controller/payment/payment.js': PAYMENT,
  });
  expect(kept).toMatchObject({
    status: 'regression',
    grade: null,
    regressions: [
      {
        id: 'refit-behaviour/payments.test.mjs > creates a Checkout Session for the order and returns its URL',
        error: expect.stringContaining('additional properties are not allowed'),
      },
    ],
  });
  const newOnly = await behaviourRun({
    ...CORRECT,
    'app/api/webhook/invoice.ts': CORRECT['app/api/webhook/invoice.ts'].replace(
      'getInvoiceSubscription(session) as string',
      'session.parent.subscription_details.subscription as string',
    ),
  });
  expect(newOnly).toMatchObject({
    status: 'regression',
    grade: null,
    regressions: [
      {
        id: 'refit-behaviour/subscriptions.test.mjs > stores the period end of the paid invoice subscription',
        error: expect.stringContaining(
          "Cannot read properties of undefined (reading 'subscription_details')",
        ),
      },
    ],
  });
}, 60_000);

it('falls back below A when a changed line did not run, and never counts a test that fails on the original code (simulated stripe-mock)', async () => {
  const partial = await behaviourRun(CORRECT, [TESTS[0]]);
  expect(partial).toMatchObject({ status: 'passed', grade: null, regressions: [] });
  expect(partial.missing).toEqual([
    'app/api/webhook/invoice.ts lines 8, 15 did not run on the original code against the before-version stripe-mock.',
    'libs/supabaseAdmin.ts lines 16, 19 did not run on the original code against the before-version stripe-mock.',
    'app/api/webhook/invoice.ts lines 2, 9, 16 did not run on the patched code against the after-version stripe-mock.',
    'libs/supabaseAdmin.ts lines 3, 17, 20 did not run on the patched code against the after-version stripe-mock.',
  ]);
  const wrongTest = {
    path: 'refit-behaviour/wrong.test.mjs',
    content: `import test from 'node:test';
import assert from 'node:assert/strict';
import { manageSubscriptionStatusChange } from '../libs/supabaseAdmin.ts';
test('expects a field no version returns', async () => {
  assert.equal((await manageSubscriptionStatusChange('sub_1', 'cus_1')).trial_end, 1);
});
`,
  };
  const broken = await behaviourRun(CORRECT, [...TESTS, wrongTest]);
  expect(broken).toMatchObject({ status: 'not-passing', grade: null, regressions: [] });
  expect(broken.missing[0]).toMatch(
    /^refit-behaviour\/wrong\.test\.mjs > expects a field no version returns failed \(test\) on the original code against the before-version stripe-mock: /,
  );
}, 60_000);

it('reports a side that did not finish as unavailable and counts nothing', () => {
  const sources = {
    original: { root: '/r', files: [] },
    patched: { root: '/r', files: [] },
  } as never;
  const result = compareBehaviourRuns({
    tests: TESTS,
    changed: { original: {}, patched: {} },
    sources,
    original: {
      status: 'passed',
      exitCode: 0,
      stdout: `REFIT_BEHAVIOUR_TEST=${JSON.stringify({ file: 'refit-behaviour/payments.test.mjs', id: 'x', ok: true })}\nREFIT_BEHAVIOUR_DONE`,
      stderr: '',
    },
    patched: {
      status: 'failed',
      exitCode: 1,
      stdout: '',
      stderr:
        'Error: stripe-mock did not start\n    at file:///refit/generated/behaviour.mjs:16:28\n\nNode.js v22.21.0',
    },
  });
  expect(result).toMatchObject({
    status: 'unavailable',
    reason:
      'The behaviour harness on the patched code against the after-version stripe-mock stopped before finishing (exit code 1): Error: stripe-mock did not start',
    grade: null,
    regressions: [],
  });
});

it('gives gradeEvidence grade A only for a result that passed and ran every changed Stripe line', async () => {
  const repository = { root: '/nonexistent', files: [] } as never;
  const result = {
    status: 'passed',
    grade: 'A' as 'A' | null,
    missing: [] as string[],
    tests: [{ path: 'refit-behaviour/payments.test.mjs' }],
    coverage: {
      changedLines: {
        original: { 'controller/payment/payment.js': [29] },
        patched: { 'controller/payment/payment.js': [29], 'lib/stripe.ts': [3] },
      },
    },
  };
  const grade = (behaviour: typeof result) =>
    gradeEvidence({
      repository,
      command: ['node', '-e', '0'],
      changedFiles: ['controller/payment/payment.js'],
      behaviour: behaviourGrade(behaviour),
    });
  expect(await grade(result)).toEqual({
    letter: 'A',
    level: 'behaviour-tests',
    reason:
      'Behaviour tests (refit-behaviour/payments.test.mjs) passed on the original code against the before-version stripe-mock and on the patched code against the after-version stripe-mock, and ran every changed Stripe line on both sides (1 original, 2 patched).',
  });
  const partial = {
    ...result,
    grade: null,
    missing: [
      'lib/stripe.ts line 3 did not run on the patched code against the after-version stripe-mock.',
    ],
  };
  expect(behaviourGrade(partial)).toEqual({
    passed: true,
    coversEveryChangedLine: false,
    reason:
      'Behaviour tests did not give grade A: lib/stripe.ts line 3 did not run on the patched code against the after-version stripe-mock.',
  });
  expect((await grade(partial)).letter).toBe('D');
});

it('needs the same tests on both sides', () => {
  const sources = {
    original: { root: '/r', files: [] },
    patched: { root: '/r', files: [] },
  } as never;
  const output = (...ids: string[]) => ({
    status: 'passed' as const,
    exitCode: 0,
    stdout: [
      ...ids.map(
        (id) =>
          `REFIT_BEHAVIOUR_TEST=${JSON.stringify({ file: 'refit-behaviour/payments.test.mjs', id, ok: true })}`,
      ),
      'REFIT_BEHAVIOUR_EXIT=0',
      'REFIT_BEHAVIOUR_COVERAGE={}',
      'REFIT_BEHAVIOUR_DONE',
    ].join('\n'),
    stderr: '',
  });
  const result = compareBehaviourRuns({
    tests: TESTS,
    changed: { original: {}, patched: {} },
    sources,
    original: output('a', 'b'),
    patched: output('a'),
  });
  expect(result).toMatchObject({ status: 'not-passing', grade: null, regressions: [] });
  expect(result.missing[0]).toBe('b ran on one side only.');
});
