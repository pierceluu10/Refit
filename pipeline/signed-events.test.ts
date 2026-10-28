import { execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import {
  changedStripeLines,
  compareBehaviourRuns,
  writeBehaviourHarness,
} from './behaviour-tests.ts';
import { typescriptDirectory } from './generated-checks.ts';
import { readRepository } from './repository.ts';
import { compareSignedEvents, prepareSignedEvents, standIns } from './signed-events.ts';
import { carryMoves, overlay, stripeSignedEventAdapter } from './stripe-signed-events.ts';
import type { Finding, Repository } from './types.ts';
import type { CheckResult } from './validation.ts';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// A stand-in for stripe-node: constructEvent verifies Stripe-Signature as Stripe documents
// (https://docs.stripe.com/webhooks#verify-manually), and subscriptions.retrieve sends a request to
// api.stripe.com, which the sandbox redirects to the (simulated) mock.
const STRIPE = `import { createHmac, timingSafeEqual } from 'node:crypto';
import https from 'node:https';
const get = (path) => new Promise((resolve, reject) => {
  const req = https.request({ host: 'api.stripe.com', port: 443, path, method: 'GET', agent: new https.Agent() });
  req.on('response', (res) => { let data = ''; res.on('data', (chunk) => (data += chunk)); res.on('end', () => resolve(JSON.parse(data))); });
  req.on('error', reject);
  req.end();
});
export default class Stripe {
  constructor() {
    this.webhooks = {
      constructEvent(payload, header, secret, tolerance = 300) {
        const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload;
        const parts = String(header ?? '').split(',').map((part) => part.split('='));
        const timestamp = Number(parts.find(([key]) => key === 't')?.[1]);
        const expected = Buffer.from(createHmac('sha256', secret).update(timestamp + '.' + text, 'utf8').digest('hex'));
        const signed = parts.filter(([key]) => key === 'v1').some(([, value]) => value.length === expected.length && timingSafeEqual(Buffer.from(value), expected));
        if (!signed) throw new Error('No signatures found matching the expected signature for payload');
        if (Math.abs(Date.now() / 1000 - timestamp) > tolerance) throw new Error('Timestamp outside the tolerance zone');
        return JSON.parse(text);
      },
    };
    this.subscriptions = {
      retrieve(id) {
        if (typeof id !== 'string') throw new Error('Stripe: Argument "id" must be a string, but got: ' + id);
        return get('/v1/subscriptions/' + id);
      },
    };
  }
}
`;

// Stripe's acacia and basil shapes, as fixtures3.json gives them, cut to what the handlers read.
const SUBSCRIPTION_BEFORE = {
  id: 'sub_1',
  object: 'subscription',
  customer: 'cus_1',
  current_period_end: 1702592000,
  items: { object: 'list', data: [{ id: 'si_1', object: 'subscription_item' }] },
};
const SUBSCRIPTION_AFTER = {
  id: 'sub_2',
  object: 'subscription',
  customer: 'cus_2',
  items: {
    object: 'list',
    data: [{ id: 'si_2', object: 'subscription_item', current_period_end: 1800000000 }],
  },
};
const FIXTURES = {
  before: {
    resources: {
      'checkout.session': {
        id: 'cs_1',
        object: 'checkout.session',
        metadata: {},
        subscription: null,
        customer: 'cus_1',
      },
      invoice: { id: 'in_1', object: 'invoice', customer: 'cus_1', subscription: 'sub_1' },
      subscription: SUBSCRIPTION_BEFORE,
    },
  },
  after: {
    resources: {
      'checkout.session': {
        id: 'cs_2',
        object: 'checkout.session',
        metadata: {},
        subscription: null,
        customer: 'cus_2',
      },
      invoice: {
        id: 'in_2',
        object: 'invoice',
        customer: 'cus_2',
        parent: null,
      },
      subscription: SUBSCRIPTION_AFTER,
    },
  },
};
const SPECIFICATION = {
  components: {
    schemas: {
      'checkout.session': {
        properties: { subscription: { 'x-expansionResources': { oneOf: [] } } },
      },
    },
  },
};

const route = (body: string, imports = '', guard = '') => `import Stripe from 'stripe';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { stripe } from '../../../lib/stripe';
import prismadb from '../../../lib/prismadb';
${imports}
export async function POST(req: Request) {
  ${guard}
  const body = await req.text();
  const signature = headers().get('Stripe-Signature') as string;
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (error: any) {
    return new NextResponse('Webhook Error: ' + error.message, { status: 400 });
  }
  const session = event.data.object as Stripe.Checkout.Session;
  if (event.type === 'checkout.session.completed') {
    const subscription = await stripe.subscriptions.retrieve(session.subscription as string);
    if (!session?.metadata?.userId) return new NextResponse('User id is required', { status: 400 });
${body}
  }
  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object as Stripe.Invoice;
    await prismadb.userSubscription.update({ where: { customer: invoice.customer as string }, data: { paid: true } });
  }
  return new NextResponse(null, { status: 200 });
}
`;

const LIBRARIES = {
  'package.json': JSON.stringify({ type: 'module' }),
  'node_modules/stripe/package.json': JSON.stringify({
    name: 'stripe',
    type: 'module',
    main: 'index.js',
  }),
  'node_modules/stripe/index.js': STRIPE,
  'lib/stripe.ts':
    "import Stripe from 'stripe';\nexport const stripe = new Stripe(process.env.STRIPE_API_KEY!);\n",
  'lib/prismadb.ts':
    "import { PrismaClient } from '@prisma/client';\nconst prismadb = new PrismaClient();\nexport default prismadb;\n",
};
const ORIGINAL = {
  ...LIBRARIES,
  'app/api/webhook/route.ts': route(`    await prismadb.userSubscription.create({
      data: { userId: session.metadata.userId, stripeCurrentPeriodEnd: new Date(subscription.current_period_end * 1000) },
    });`),
};
const HELPER = {
  'lib/stripeSubscriptionPeriod.ts': `export function getSubscriptionPeriodEnd(subscription: any): number {
  if (typeof subscription.current_period_end === 'number') return subscription.current_period_end;
  return subscription.items.data[0].current_period_end;
}
`,
};
// The rules' patch: the period read goes through the helper, which reads either version.
const CORRECT = {
  ...LIBRARIES,
  ...HELPER,
  'app/api/webhook/route.ts': route(
    `    await prismadb.userSubscription.create({
      data: { userId: session.metadata.userId, stripeCurrentPeriodEnd: new Date(getSubscriptionPeriodEnd(subscription) * 1000) },
    });`,
    "import { getSubscriptionPeriodEnd } from '../../../lib/stripeSubscriptionPeriod';",
  ),
};
const FINDINGS = [{ file: 'app/api/webhook/route.ts', line: 23 }] as unknown as Finding[];

async function scratch() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'refit-signed-events-')));
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

// stripe-mock serving one version's subscription.
async function simulatedStripeMock() {
  let side: 'before' | 'after' = 'before';
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(side === 'before' ? SUBSCRIPTION_BEFORE : SUBSCRIPTION_AFTER));
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

// Prepares the signed-event test as validation does and runs the sandbox runner outside Docker on
// both sides.
async function signedRun(
  originalFiles: Record<string, string>,
  patchedFiles: Record<string, string>,
) {
  const root = await scratch();
  const original = await writeApp(join(root, 'original'), originalFiles);
  const patched = await writeApp(join(root, 'patched'), patchedFiles);
  const changed = changedStripeLines(original, patched, FINDINGS);
  const changedFiles = [
    ...new Set([...Object.keys(changed.original), ...Object.keys(changed.patched)]),
  ];
  const adapter = stripeSignedEventAdapter({
    beforeFixtures: FIXTURES.before,
    afterFixtures: FIXTURES.after,
    beforeVersion: '2024-09-30.acacia',
    afterVersion: '2025-03-31.basil',
    beforeSpecification: SPECIFICATION,
  });
  const prepared = prepareSignedEvents({
    adapter,
    original,
    patched,
    findings: FINDINGS,
    changedFiles,
  });
  expect(prepared.test).toBeDefined();
  const tests = [prepared.test!];
  const tools = join(root, 'tools');
  await mkdir(tools);
  await writeBehaviourHarness(tools, tests, changed, { original, patched });
  const mock = await simulatedStripeMock();
  const run = async (side: 'before' | 'after', app: string): Promise<CheckResult> => {
    mock.use(side);
    await mkdir(join(app, 'refit-behaviour'), { recursive: true });
    await writeFile(join(app, tests[0].path), tests[0].content);
    const { stdout, stderr } = await execute(process.execPath, [join(tools, 'behaviour.mjs')], {
      env: {
        ...process.env,
        REFIT_STRIPE_MOCK_PORT: mock.port,
        REFIT_GENERATED_ROOT: `${app}/`,
        REFIT_GENERATED_SIDE: side,
        REFIT_TYPESCRIPT: join(typescriptDirectory(), 'lib', 'typescript.js'),
        STRIPE_API_KEY: 'sk_test_123',
      },
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { status: 'passed', exitCode: 0, stdout, stderr };
  };
  try {
    const behaviour = compareBehaviourRuns({
      tests,
      changed,
      sources: { original, patched },
      original: await run('before', original.root),
      patched: await run('after', patched.root),
    });
    return {
      prepared,
      result: compareSignedEvents({
        sites: prepared.sites,
        original: behaviour.sides.original.records ?? [],
        patched: behaviour.sides.patched.records ?? [],
        missing: behaviour.coverage.missing,
        changedFiles,
      }),
    };
  } finally {
    await mock.close();
  }
}

it('signs a payload the way Stripe documents, so a verifier with the same secret accepts it', () => {
  const adapter = stripeSignedEventAdapter({
    beforeFixtures: FIXTURES.before,
    afterFixtures: FIXTURES.after,
    beforeVersion: 'a',
    afterVersion: 'b',
  });
  const sign = new Function('createHmac', `return ${adapter.signer}`)(createHmac) as (
    payload: string,
    secret: string,
    timestamp: number,
  ) => string;
  const secret = adapter.newSecret();
  expect(secret).toMatch(/^whsec_refit_[0-9a-f]{48}$/);
  expect(adapter.newSecret()).not.toBe(secret);
  const payload = '{"id":"evt_1"}';
  expect(sign(payload, 'whsec_test', 1700000000)).toBe(
    `t=1700000000,v1=${createHmac('sha256', 'whsec_test').update('1700000000.{"id":"evt_1"}').digest('hex')}`,
  );
  expect(sign(payload, 'whsec_other', 1700000000)).not.toBe(
    sign(payload, 'whsec_test', 1700000000),
  );
});

it('builds both versions of an event with the same values, moved fields carried to their new place', () => {
  const adapter = stripeSignedEventAdapter({
    beforeFixtures: FIXTURES.before,
    afterFixtures: FIXTURES.after,
    beforeVersion: '2024-09-30.acacia',
    afterVersion: '2025-03-31.basil',
  });
  const site = {
    file: 'route.ts',
    exportName: 'POST',
    secretEnv: 'X',
    eventTypes: ['invoice.paid', 'customer.subscription.updated'],
  };
  const [invoice, subscription] = adapter.events(site).map((event) => ({
    before: JSON.parse(event.before),
    after: JSON.parse(event.after),
  }));
  expect(invoice.before).toMatchObject({ api_version: '2024-09-30.acacia', type: 'invoice.paid' });
  expect(invoice.before.data.object).toEqual(FIXTURES.before.resources.invoice);
  expect(invoice.after.api_version).toBe('2025-03-31.basil');
  expect(invoice.after.data.object).toEqual({
    id: 'in_1',
    object: 'invoice',
    customer: 'cus_1',
    parent: { subscription_details: { subscription: 'sub_1' } },
  });
  expect(subscription.after.data.object).toEqual({
    id: 'sub_1',
    object: 'subscription',
    customer: 'cus_1',
    items: {
      object: 'list',
      data: [{ id: 'si_1', object: 'subscription_item', current_period_end: 1702592000 }],
    },
  });
  // A field whose kind changed keeps the new version's value.
  expect(overlay({ a: { b: 1 } }, { a: 'x' })).toEqual({ a: { b: 1 } });
  const after = { object: 'line_item', pricing: null };
  carryMoves({ object: 'line_item', price: { id: 'price_1' } }, after, 'line_item');
  expect(after).toEqual({
    object: 'line_item',
    pricing: { price_details: { price: 'price_1' } },
  });
});

it('replaces backends with recording stand-ins, but never the Stripe client or changed code', async () => {
  const root = await scratch();
  const repository = await writeApp(root, CORRECT);
  expect(
    standIns({
      repository,
      handlerFiles: ['app/api/webhook/route.ts'],
      sdkPackages: ['stripe'],
      keep: new Set(['lib/stripeSubscriptionPeriod.ts']),
    }),
  ).toEqual({ modules: { 'lib/prismadb.ts': ['default'] }, packages: {} });
  // Without the patch's own module in `keep`, the helper (it imports nothing) would be replaced.
  expect(
    standIns({
      repository,
      handlerFiles: ['app/api/webhook/route.ts'],
      sdkPackages: ['stripe'],
      keep: new Set(),
    }).modules,
  ).toHaveProperty(['lib/stripeSubscriptionPeriod.ts']);
  const adapter = stripeSignedEventAdapter({
    beforeFixtures: FIXTURES.before,
    afterFixtures: FIXTURES.after,
    beforeVersion: 'a',
    afterVersion: 'b',
  });
  expect(adapter.sites(repository, FINDINGS, ['app/api/webhook/route.ts']).sites).toEqual([
    {
      file: 'app/api/webhook/route.ts',
      exportName: 'POST',
      secretEnv: 'STRIPE_WEBHOOK_SECRET',
      eventTypes: ['checkout.session.completed', 'invoice.payment_succeeded'],
    },
  ]);
});

it('covers a handler whose patched code handles both versions the same way (simulated stripe-mock)', async () => {
  const { result } = await signedRun(ORIGINAL, CORRECT);
  expect(result.regressions).toEqual([]);
  expect(result.unresolved).toEqual([]);
  expect(result.status).toBe('passed');
  expect(result.covered).toEqual(['app/api/webhook/route.ts']);
  const [checkout, invoice] = result.handlers[0].events;
  expect(checkout).toMatchObject({
    result: 'same',
    original: { before: 'returned 200', after: 'returned 200' },
    patched: { before: 'returned 200', after: 'returned 200' },
  });
  expect(invoice.result).toBe('same');
}, 60_000);

it('counts a patch that breaks the handler on new-version events as a regression (simulated stripe-mock)', async () => {
  // The patch reads the invoice's customer from a place only some versions have.
  const broken = {
    ...CORRECT,
    'app/api/webhook/route.ts': CORRECT['app/api/webhook/route.ts'].replace(
      'invoice.customer as string',
      '(invoice as any).parent?.subscription_details?.subscription ?? (invoice as any).customer_missing',
    ),
  };
  const { result } = await signedRun(ORIGINAL, broken);
  expect(result.status).toBe('regression');
  expect(result.regressions).toEqual([
    {
      id: 'app/api/webhook/route.ts invoice.payment_succeeded',
      error: expect.stringContaining('calls[0].args[0].where.customer'),
    },
  ]);
  expect(result.covered).toEqual([]);
}, 60_000);

it('leaves a handler both versions of the code handle differently in the new version unresolved (simulated stripe-mock)', async () => {
  // Neither side migrates a webhook read of the removed invoice.subscription.
  const read = (files: Record<string, string>) => ({
    ...files,
    'app/api/webhook/route.ts': files['app/api/webhook/route.ts'].replace(
      'invoice.customer as string',
      '(invoice as any).subscription',
    ),
  });
  const { result } = await signedRun(read(ORIGINAL), read(CORRECT));
  expect(result.status).toBe('unresolved');
  expect(result.regressions).toEqual([]);
  expect(result.unresolved[0].error).toContain(
    '"<string>" on the old-version event, "<undefined>"',
  );
  expect(result.covered).toEqual([]);
}, 60_000);

it('does not count a handler that returns before it reaches the changed Stripe code (simulated stripe-mock)', async () => {
  const guard = 'if (!process.env.REFIT_NEVER_SET) return new NextResponse(null, { status: 200 });';
  const unreached = (files: Record<string, string>) => ({
    ...files,
    'app/api/webhook/route.ts': files['app/api/webhook/route.ts'].replace(
      'export async function POST(req: Request) {\n',
      `export async function POST(req: Request) {\n  ${guard}\n`,
    ),
  });
  const { result } = await signedRun(unreached(ORIGINAL), unreached(CORRECT));
  expect(result.regressions).toEqual([]);
  expect(result.covered).toEqual([]);
  expect(result.handlers[0].linesNotRun?.length).toBeGreaterThan(0);
}, 60_000);

it('skips handlers it cannot call, with the reason', async () => {
  const root = await scratch();
  const repository: Repository = await writeApp(root, {
    ...LIBRARIES,
    'pages/api/webhook.ts': `import { stripe } from '../../lib/stripe';
export default async function handler(req: any, res: any) {
  const event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET!);
  if (event.type === 'invoice.paid') res.status(200).end();
}
`,
    'app/api/other/route.ts': `import { stripe } from '../../../lib/stripe';
import { env } from '../../../env';
export async function POST(req: Request) {
  const event = stripe.webhooks.constructEvent(await req.text(), '', env.SECRET);
  if (event.type === 'invoice.paid') return new Response(null);
}
`,
  });
  const adapter = stripeSignedEventAdapter({
    beforeFixtures: FIXTURES.before,
    afterFixtures: FIXTURES.after,
    beforeVersion: 'a',
    afterVersion: 'b',
  });
  const { sites, skipped } = adapter.sites(
    repository,
    [],
    ['pages/api/webhook.ts', 'app/api/other/route.ts'],
  );
  expect(sites).toEqual([]);
  expect(skipped).toEqual([
    {
      file: 'app/api/other/route.ts',
      reason: 'The signing secret is not read from an environment variable Refit can trace.',
    },
    { file: 'pages/api/webhook.ts', reason: expect.stringContaining('no exported POST') },
  ]);
});
