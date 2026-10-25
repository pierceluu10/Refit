import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import {
  compareGeneratedRuns,
  generatedCommand,
  generatedEntryPoints,
  generatedEnvironment,
  generatedImportMap,
  generatedResults,
  stageMockDocument,
  typescriptDirectory,
  writeHarness,
} from './generated-checks.ts';
import { readRepository } from './repository.ts';
import { subscriptionPeriodHelperModule } from './stripe-subscription-periods.ts';
import { parseWorkflowConfiguration } from './workflow-configuration.ts';
import type { Finding } from './types.ts';
import { digest } from './specifications.ts';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function finding(file: string, content: string, marker: string): Finding {
  const index = content.indexOf(marker);
  const before = content.slice(0, index).split('\n');
  return {
    file,
    line: before.length,
    column: before.at(-1)!.length + 1,
    changeId: 'change',
    expression: '.subscription',
    confidence: 'confirmed',
    reason: 'test',
  };
}

const SOURCE = `import Stripe from 'stripe';
const stripe = new Stripe('sk_test_placeholder');

export async function direct(id) {
  const invoice = await stripe.invoices.retrieve(id);
  return invoice.subscription;
}

export const arrow = async (id: string) => (await stripe.invoices.retrieve(id)).quote;

export default async function (id) {
  const invoice = await stripe.invoices.retrieve(id);
  return invoice.lines.data.map((line) => line.subscription_item);
}

async function privateHelper(id) {
  return (await stripe.invoices.retrieve(id)).subscription;
}

export async function typed(request: Request) {
  return (await stripe.invoices.retrieve(request.url)).subscription;
}

export async function many(a, b, c, d) {
  return (await stripe.invoices.retrieve(a)).subscription;
}

const listedArrow = async (subscriptionId: string, customerId: string, createAction = false) =>
  (await stripe.subscriptions.retrieve(subscriptionId)).current_period_end;

async function listedDeclaration(id) {
  return (await stripe.invoices.retrieve(id)).payment_intent;
}

export { listedArrow, listedDeclaration as renamed };
`;

it('selects exported functions with placeholder-friendly parameters and counts the rest', () => {
  const repository = { root: '/r', files: [{ path: 'billing.ts', content: SOURCE }] } as never;
  const at = (marker: string) => finding('billing.ts', SOURCE, marker);
  const result = generatedEntryPoints(repository, [
    at('invoice.subscription;'),
    at(').quote'),
    at('line.subscription_item'),
    at('retrieve(id)).subscription'),
    at('retrieve(request.url)).subscription'),
    at('retrieve(a)).subscription'),
    at(').current_period_end'),
    at(').payment_intent'),
    { ...at(').quote'), confidence: 'review' },
  ]);
  expect(result.entries).toEqual([
    { file: 'billing.ts', name: 'direct', parameters: 1 },
    { file: 'billing.ts', name: 'arrow', parameters: 1 },
    { file: 'billing.ts', name: 'default', parameters: 1 },
    { file: 'billing.ts', name: 'listedArrow', parameters: 3 },
    { file: 'billing.ts', name: 'renamed', parameters: 1 },
  ]);
  expect(result.uncovered).toBe(3);
});

it('runs the harness through the bundled TypeScript compiler without type stripping', () => {
  const command = generatedCommand('after').join(' ');
  expect(command).not.toContain('strip-types');
  expect(command).toContain('--import /refit/generated/redirect.mjs');
  expect(command).toContain('REFIT_GENERATED_SIDE=after');
  expect(typescriptDirectory()).toMatch(/typescript-compiler$/);
});

// Mirrors stripe-node's NodeHttpClient: an HTTPS agent, and a body written after secureConnect.
const STRIPE_LIKE = `import https from 'node:https';
export async function invoiceSubscription(id) {
  const body = await new Promise((resolve, reject) => {
    const req = https.request({
      host: 'api.stripe.com', port: 443, path: '/v1/invoices/' + id, method: 'GET',
      agent: new https.Agent({ keepAlive: true }),
      headers: { Authorization: 'Bearer sk_live_application_key' },
    });
    req.setTimeout(2000, () => req.destroy(new Error('timeout')));
    req.on('response', (res) => { let data = ''; res.on('data', (c) => (data += c)); res.on('end', () => resolve(JSON.parse(data))); });
    req.on('error', reject);
    req.once('socket', (socket) => socket.once('secureConnect', () => req.end()));
  });
  return body.parent.subscription_details.subscription.toUpperCase();
}
export async function broken(id) {
  throw new TypeError('Cannot read properties of undefined (reading id) for ' + id);
}
`;

it('redirects Stripe SDK requests to the local mock with a test key and records thrown errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-generated-'));
  roots.push(root);
  const tools = join(root, 'tools');
  await mkdir(join(root, 'app', 'src'), { recursive: true });
  await mkdir(tools);
  await writeFile(join(root, 'app', 'src', 'billing.mjs'), STRIPE_LIKE);
  const requests: IncomingMessage[] = [];
  const server = createServer((request, response) => {
    requests.push(request);
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({ id: 'in_x', parent: { subscription_details: { subscription: 'sub_x' } } }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = String((server.address() as { port: number }).port);
  const run = async (name: string) => {
    await writeHarness(tools, [{ file: 'src/billing.mjs', name, parameters: 1 }]);
    return execute(
      process.execPath,
      ['--import', join(tools, 'redirect.mjs'), join(tools, 'harness.mjs')],
      {
        env: {
          ...process.env,
          REFIT_STRIPE_MOCK_PORT: port,
          REFIT_GENERATED_ROOT: `${join(root, 'app')}/`,
        },
        timeout: 10_000,
      },
    );
  };
  try {
    const passed = await run('invoiceSubscription');
    expect(generatedResults(passed.stdout).get('src/billing.mjs#invoiceSubscription')).toEqual({
      ok: true,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('/v1/invoices/refit_placeholder_1');
    expect(requests[0].headers.authorization).toBe('Bearer sk_test_123');
    await rm(tools, { recursive: true });
    await mkdir(tools);
    const broken = await run('broken');
    expect(generatedResults(broken.stdout).get('src/billing.mjs#broken')).toEqual({
      ok: false,
      phase: 'call',
      error: expect.stringContaining('Cannot read properties of undefined'),
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

it('parses generated checks only with all three settings and resolves fixture paths', () => {
  const base = {
    formatVersion: 1,
    before: './before.json',
    after: './after.json',
    image: 'node:22-alpine',
    command: ['npm', 'test'],
  };
  const parsed = parseWorkflowConfiguration(
    JSON.stringify({
      ...base,
      generatedChecks: {
        stripeMockImage: 'stripe/stripe-mock:latest',
        beforeFixtures: './fixtures/before.json',
        afterFixtures: './fixtures/after.json',
      },
    }),
    '/repo/.refit.json',
  );
  expect(parsed.generatedChecks).toEqual({
    stripeMockImage: 'stripe/stripe-mock:latest',
    beforeFixtures: '/repo/fixtures/before.json',
    afterFixtures: '/repo/fixtures/after.json',
  });
  for (const generatedChecks of [
    { stripeMockImage: 'stripe/stripe-mock:latest' },
    { stripeMockImage: '', beforeFixtures: 'a', afterFixtures: 'b' },
    { stripeMockImage: 'x', beforeFixtures: 'a', afterFixtures: 'b', extra: true },
    'stripe',
  ])
    expect(() =>
      parseWorkflowConfiguration(JSON.stringify({ ...base, generatedChecks }), '/repo/.refit.json'),
    ).toThrow('generatedChecks requires');
});

// Harness output: one result line per entry, then the completion marker unless `done` is false.
type Result = { ok: boolean; phase?: 'load' | 'call' | 'timeout'; error?: string };
const harnessOutput = (results: Record<string, Result>, done = true) => ({
  status: 'passed' as const,
  exitCode: 0,
  stderr: '',
  stdout: [
    ...Object.entries(results).map(
      ([id, result]) => `REFIT_GENERATED_RESULT=${JSON.stringify({ id, ...result })}`,
    ),
    ...(done ? ['REFIT_GENERATED_DONE'] : []),
  ].join('\n'),
});

// Entry points of two benchmark repositories: emman-tt/tilios-backend at b554dcb083a0
// (controller/payment/payment.js, an Express handler that reads req.user) and mahin67580/FoodieFrog
// at e71211a9aa8a (src/app/api/checkout/route.js, Next.js route handlers that read the request).
const HANDLER = 'controller/payment/payment.js#handlePayments';
const ROUTE_POST = 'src/app/api/checkout/route.js#POST';
const ROUTE_GET = 'src/app/api/checkout/route.js#GET';
const ENTRIES = [
  { file: 'controller/payment/payment.js', name: 'handlePayments', parameters: 3 },
  { file: 'src/app/api/checkout/route.js', name: 'POST', parameters: 1 },
  { file: 'src/app/api/checkout/route.js', name: 'GET', parameters: 1 },
];

it('reports a broken generated check as unavailable and never counts it against the patch', () => {
  const ran = harnessOutput({
    [HANDLER]: { ok: true },
    [ROUTE_POST]: { ok: true },
    [ROUTE_GET]: { ok: true },
  });
  // stripe-mock never listened: the harness throws before its first entry.
  const noMock = compareGeneratedRuns(
    ENTRIES,
    {
      status: 'failed',
      exitCode: 1,
      stdout: '',
      stderr: [
        'file:///refit/generated/harness.mjs:14',
        "  if (attempt > 100) throw new Error('stripe-mock did not start');",
        '                           ^',
        '',
        'Error: stripe-mock did not start',
        '    at file:///refit/generated/harness.mjs:14:28',
        '',
        'Node.js v22.21.0',
      ].join('\n'),
    },
    ran,
  );
  expect(noMock).toMatchObject({ status: 'unavailable', ran: 0, regressions: [] });
  expect(noMock.reason).toBe(
    'The before-version harness stopped before its last function (exit code 1): Error: stripe-mock did not start',
  );
  // The after-version container hit the time limit after every entry had passed before.
  const timedOut = compareGeneratedRuns(ENTRIES, ran, {
    status: 'error',
    exitCode: null,
    stdout: `REFIT_GENERATED_RESULT=${JSON.stringify({ id: HANDLER, ok: false, phase: 'call', error: 'TypeError: x' })}`,
    stderr: '',
    error: 'Check exceeded 120 seconds; the container was stopped.',
  });
  expect(timedOut).toMatchObject({
    status: 'unavailable',
    reason:
      'The after-version run did not finish: Check exceeded 120 seconds; the container was stopped.',
    regressions: [],
    unavailableEntries: [],
  });
  // Application code ended the patched process after one function: no completion marker.
  const exited = compareGeneratedRuns(
    ENTRIES,
    ran,
    harnessOutput({ [HANDLER]: { ok: false, phase: 'call', error: 'TypeError: y' } }, false),
  );
  expect(exited).toMatchObject({ status: 'unavailable', regressions: [] });
  expect(exited.reason).toBe(
    'The after-version harness stopped before its last function (exit code 0).',
  );
});

it('counts only a call that completed on the original code and threw on the patched code', () => {
  const entries = [
    ...ENTRIES,
    { file: 'libs/supabaseAdmin.ts', name: 'manageSubscriptionStatusChange', parameters: 3 },
    { file: 'libs/supabaseAdmin.ts', name: 'createOrRetrieveCustomer', parameters: 1 },
  ];
  const period = 'libs/supabaseAdmin.ts#manageSubscriptionStatusChange';
  const customer = 'libs/supabaseAdmin.ts#createOrRetrieveCustomer';
  const original = harnessOutput({
    [HANDLER]: {
      ok: false,
      phase: 'call',
      error: "TypeError: Cannot read properties of undefined (reading 'sub')",
    },
    [ROUTE_POST]: { ok: true },
    [ROUTE_GET]: { ok: true },
    [period]: { ok: true },
    [customer]: { ok: true },
  });
  const patched = harnessOutput({
    [HANDLER]: { ok: true },
    [ROUTE_POST]: {
      ok: false,
      phase: 'load',
      error: "Error: Cannot find module '/workspace/node_modules/stripe/esm/stripe.esm.node.js'",
    },
    [ROUTE_GET]: { ok: false, phase: 'timeout', error: 'Error: did not settle within 10 seconds' },
    [period]: { ok: false, phase: 'call', error: 'RangeError: Invalid time value' },
    [customer]: { ok: true },
  });
  expect(compareGeneratedRuns(entries, original, patched)).toMatchObject({
    status: 'regression',
    ran: 1,
    notRunnable: [
      {
        id: HANDLER,
        phase: 'call',
        error: "TypeError: Cannot read properties of undefined (reading 'sub')",
      },
    ],
    unavailableEntries: [
      {
        id: ROUTE_POST,
        phase: 'load',
        error: "Error: Cannot find module '/workspace/node_modules/stripe/esm/stripe.esm.node.js'",
      },
      { id: ROUTE_GET, phase: 'timeout', error: 'Error: did not settle within 10 seconds' },
    ],
    regressions: [{ id: period, phase: 'call', error: 'RangeError: Invalid time value' }],
  });
  // Without the throwing call, a load failure and a timeout on the patched side do not count.
  const loadOnly = compareGeneratedRuns(
    entries,
    original,
    harnessOutput({
      [HANDLER]: { ok: true },
      [ROUTE_POST]: { ok: false, phase: 'load', error: 'Error: Cannot find module' },
      [ROUTE_GET]: { ok: false, phase: 'timeout', error: 'Error: did not settle' },
      [period]: { ok: true },
      [customer]: { ok: true },
    }),
  );
  expect(loadOnly).toMatchObject({ status: 'passed', ran: 2, regressions: [] });
  expect(loadOnly.unavailableEntries.map((entry) => entry.id)).toEqual([ROUTE_POST, ROUTE_GET]);
  // Nothing ran on both sides: the check has no evidence either way.
  const nothing = compareGeneratedRuns(
    ENTRIES,
    harnessOutput({
      [HANDLER]: { ok: false, phase: 'call', error: 'TypeError: a' },
      [ROUTE_POST]: {
        ok: false,
        phase: 'call',
        error: 'TypeError: request.json is not a function',
      },
      [ROUTE_GET]: { ok: false, phase: 'call', error: 'TypeError: Invalid URL' },
    }),
    harnessOutput({}),
  );
  expect(nothing).toMatchObject({
    status: 'not-runnable',
    reason: 'None of the 3 exported functions ran on the original code in isolation.',
    ran: 0,
    regressions: [],
  });
  expect(compareGeneratedRuns([], harnessOutput({}), harnessOutput({})).status).toBe('not-run');
});

it('loads aliased, extensionless and type-only TypeScript imports through the resolved import map', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-generated-imports-'));
  roots.push(root);
  const app = join(root, 'app');
  const tools = join(root, 'tools');
  await mkdir(join(app, 'src', 'lib'), { recursive: true });
  await mkdir(tools);
  await writeFile(join(app, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(
    join(app, 'tsconfig.json'),
    '{\n  // comments are allowed\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } },\n}\n',
  );
  await writeFile(
    join(app, 'src', 'lib', 'client.ts'),
    `import https from 'node:https';
export function retrieve(path: string): Promise<{ parent: { subscription_details: { subscription: string } } }> {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: 'api.stripe.com', port: 443, path, method: 'GET', agent: new https.Agent() });
    req.on('response', (res) => { let data = ''; res.on('data', (c) => (data += c)); res.on('end', () => resolve(JSON.parse(data))); });
    req.on('error', reject);
    req.once('socket', (socket) => socket.once('secureConnect', () => req.end()));
  });
}
`,
  );
  await writeFile(
    join(app, 'src', 'types.ts'),
    'export interface Invoice { parent: { subscription_details: { subscription: string } } }\n',
  );
  await writeFile(
    join(app, 'src', 'format.ts'),
    'export const upper = (value: string): string => value.toUpperCase();\n',
  );
  await writeFile(
    join(app, 'src', 'billing.ts'),
    `import { retrieve } from '@/lib/client';
import { Invoice } from '@/types';
import { upper } from './format';
export async function invoiceSubscription(id: string): Promise<string> {
  const invoice: Invoice = await retrieve('/v1/invoices/' + id);
  return upper(invoice.parent.subscription_details.subscription);
}
`,
  );
  const repository = await readRepository(app, 'stripe');
  const imports = generatedImportMap(repository);
  expect(imports['src/billing.ts']).toEqual({
    '@/lib/client': 'src/lib/client.ts',
    '@/types': 'src/types.ts',
    './format': 'src/format.ts',
  });
  const server = createServer((_, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ parent: { subscription_details: { subscription: 'sub_x' } } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await writeHarness(
      tools,
      [{ file: 'src/billing.ts', name: 'invoiceSubscription', parameters: 1 }],
      imports,
    );
    const result = await execute(
      process.execPath,
      ['--import', join(tools, 'redirect.mjs'), join(tools, 'harness.mjs')],
      {
        env: {
          ...process.env,
          REFIT_STRIPE_MOCK_PORT: String((server.address() as { port: number }).port),
          REFIT_GENERATED_ROOT: `${await realpath(app)}/`,
          REFIT_TYPESCRIPT: join(typescriptDirectory(), 'lib', 'typescript.js'),
        },
        timeout: 10_000,
      },
    );
    expect(generatedResults(result.stdout).get('src/billing.ts#invoiceSubscription')).toEqual({
      ok: true,
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

it('stages a private contract as a read-only copy the sandbox user can read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-mock-document-'));
  roots.push(root);
  const contract = join(root, 'before.json');
  const content = '{"openapi":"3.0.0"}';
  await writeFile(contract, content, { mode: 0o600 });
  const copy = join(root, 'before-spec.json');
  expect(await stageMockDocument(contract, 'before contract', copy)).toBe(digest(content));
  expect(await readFile(copy, 'utf8')).toBe(content);
  expect((await stat(copy)).mode & 0o777).toBe(0o444);

  const yaml = join(root, 'after.yaml');
  await writeFile(yaml, 'openapi: 3.0.0\n');
  await expect(
    stageMockDocument(yaml, 'after contract', join(root, 'after-spec.json')),
  ).rejects.toThrow('Generated checks require a JSON after contract.');
});

it('resolves the extensionless imports a Next.js route relies on, as its bundler does', async () => {
  // Run 40117297608: 19 of 42 generated entry points (18 repositories) failed to load on
  // `Cannot find module '/workspace/node_modules/next/server'`, and @clerk/nextjs's ESM build
  // imports `./routeMatcher`. Both packages are reduced to what the route imports.
  const root = await mkdtemp(join(tmpdir(), 'refit-generated-'));
  roots.push(root);
  const tools = join(root, 'tools');
  const app = join(root, 'app');
  const files: Record<string, string> = {
    'node_modules/next/package.json': '{"name":"next","main":"./dist/server/next.js"}',
    // next 14.2.3's server.js: named exports assigned one by one, which Node's ESM loader reads.
    'node_modules/next/server.js': `const serverExports = {
  NextResponse: { json: (body) => ({ status: 200, body }) },
}
module.exports = serverExports
exports.NextResponse = serverExports.NextResponse
`,
    'node_modules/@clerk/nextjs/package.json':
      '{"name":"@clerk/nextjs","type":"module","exports":{"./server":"./dist/esm/server/index.js"}}',
    'node_modules/@clerk/nextjs/dist/esm/server/index.js':
      "export { createRouteMatcher } from './routeMatcher';\nexport const auth = async () => ({ userId: null });\n",
    'node_modules/@clerk/nextjs/dist/esm/server/routeMatcher.js':
      'export const createRouteMatcher = (routes) => (path) => routes.includes(path);\n',
    'app/api/checkout/route.mjs': `import { NextResponse } from 'next/server';
import { auth, createRouteMatcher } from '@clerk/nextjs/server';
export async function POST() {
  const { userId } = await auth();
  return NextResponse.json({ userId, public: createRouteMatcher(['/'])('/') });
}
`,
    'app/api/missing/route.mjs': "import { gone } from 'next/missing';\nexport const GET = gone;\n",
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(app, path)), { recursive: true });
    await writeFile(join(app, path), content);
  }
  await mkdir(tools);
  await writeHarness(tools, [
    { file: 'app/api/checkout/route.mjs', name: 'POST', parameters: 0 },
    { file: 'app/api/missing/route.mjs', name: 'GET', parameters: 0 },
  ]);
  // The harness waits for stripe-mock; these routes never call it.
  const server = createServer((_, response) => response.end('{}'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = String((server.address() as { port: number }).port);
  const { stdout } = await execute(
    process.execPath,
    ['--import', join(tools, 'redirect.mjs'), join(tools, 'harness.mjs')],
    {
      env: { ...process.env, REFIT_STRIPE_MOCK_PORT: port, REFIT_GENERATED_ROOT: `${app}/` },
      timeout: 10_000,
    },
  ).finally(() => new Promise((resolve) => server.close(resolve)));
  const results = generatedResults(stdout);
  console.log(stdout);
  expect(results.get('app/api/checkout/route.mjs#POST')).toEqual({ ok: true });
  expect(results.get('app/api/missing/route.mjs#GET')).toEqual({
    ok: false,
    phase: 'load',
    error: expect.stringContaining("Cannot find module '"),
  });
});

// Reduced from adityayaduvanshi/Full-Stack-Music-Web-App at
// 90e902f43863d09fc6451f8c7f50fed7c096bcc3: libs/supabaseAdmin.ts (manageSubscriptionStatusChange,
// exported through an export list, without its Supabase reads and writes) and libs/helper.ts
// (toDateTime, verbatim). The Stripe client is a stand-in with stripe-node's request pattern.
const PERIOD_FILES = {
  'libs/stripe.ts': `import https from 'node:https';
const request = (path: string): Promise<any> => new Promise((resolve, reject) => {
  const req = https.request({ host: 'api.stripe.com', port: 443, path, method: 'GET', agent: new https.Agent({ keepAlive: true }) });
  req.on('response', (res) => { let data = ''; res.on('data', (c) => (data += c)); res.on('end', () => resolve(JSON.parse(data))); });
  req.on('error', reject);
  req.once('socket', (socket) => socket.once('secureConnect', () => req.end()));
});
export const stripe = { subscriptions: { retrieve: (id: string, _params?: object) => request('/v1/subscriptions/' + id) } };
`,
  'libs/helper.ts': `export const toDateTime = (secs: number) => {
  var t = new Date('1970-01-01T00:30:00Z');
  t.setSeconds(secs);
  return t;
};
`,
  'libs/supabaseAdmin.ts': `import { stripe } from './stripe';
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
`,
};

// Refit's helper patch: the reads go through the generated module beside the file, imported
// without an extension, as the analyzer writes it for TypeScript.
const PERIOD_PATCHED = {
  ...PERIOD_FILES,
  'libs/supabaseAdmin.ts': PERIOD_FILES['libs/supabaseAdmin.ts']
    .replace(
      "import { toDateTime } from './helper';",
      "import { toDateTime } from './helper';\nimport { getSubscriptionPeriodEnd, getSubscriptionPeriodStart } from './stripe-subscription-period';",
    )
    .replace('subscription.current_period_start', 'getSubscriptionPeriodStart(subscription)')
    .replace('subscription.current_period_end', 'getSubscriptionPeriodEnd(subscription)'),
  'libs/stripe-subscription-period.ts': subscriptionPeriodHelperModule('ts'),
};

it('loads a patch that adds the helper module and counts only a throwing call (simulated stripe-mock)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-generated-sides-'));
  roots.push(root);
  const write = async (name: string, files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, name, path)), { recursive: true });
      await writeFile(join(root, name, path), content);
    }
    return readRepository(join(root, name), 'stripe');
  };
  const original = await write('original', PERIOD_FILES);
  const patched = await write('patched', PERIOD_PATCHED);
  // A wrong patch: everything but the period reads moved (here, nothing), so they read the
  // removed fields under the after version.
  const wrong = await write('wrong', PERIOD_FILES);
  const entries = [
    { file: 'libs/supabaseAdmin.ts', name: 'manageSubscriptionStatusChange', parameters: 3 },
  ];
  // Stripe's subscription shape before and after basil moved the periods onto the items.
  const shapes = {
    before: {
      id: 'sub_1',
      current_period_start: 1700000000,
      current_period_end: 1702592000,
      items: { data: [{ id: 'si_1' }] },
    },
    after: {
      id: 'sub_1',
      items: {
        data: [{ id: 'si_1', current_period_start: 1700000000, current_period_end: 1702592000 }],
      },
    },
  };
  let shape: keyof typeof shapes = 'before';
  const server = createServer((_, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(shapes[shape]));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = String((server.address() as { port: number }).port);
  const run = async (
    side: 'before' | 'after',
    repository: { root: string },
    patchedImports: Record<string, Record<string, string>>,
  ) => {
    shape = side;
    const tools = await mkdtemp(join(root, 'tools-'));
    await writeHarness(tools, entries, generatedImportMap(original), patchedImports);
    const { stdout } = await execute(
      process.execPath,
      ['--import', join(tools, 'redirect.mjs'), join(tools, 'harness.mjs')],
      {
        env: {
          ...process.env,
          REFIT_STRIPE_MOCK_PORT: port,
          REFIT_GENERATED_ROOT: `${await realpath(repository.root)}/`,
          REFIT_GENERATED_SIDE: side,
          REFIT_TYPESCRIPT: join(typescriptDirectory(), 'lib', 'typescript.js'),
        },
        timeout: 10_000,
      },
    );
    return { status: 'passed' as const, exitCode: 0, stdout, stderr: '' };
  };
  try {
    const before = await run('before', original, generatedImportMap(patched));
    expect(generatedResults(before.stdout).get(`${entries[0].file}#${entries[0].name}`)).toEqual({
      ok: true,
    });
    const migrated = await run('after', patched, generatedImportMap(patched));
    expect(compareGeneratedRuns(entries, before, migrated)).toMatchObject({
      status: 'passed',
      ran: 1,
      regressions: [],
    });
    // The original side's import map has no entry for the added module, so the patched module
    // did not load: before per-side maps, this counted as a regression of a correct patch.
    const unmapped = await run('after', patched, generatedImportMap(original));
    expect(compareGeneratedRuns(entries, before, unmapped)).toMatchObject({
      status: 'not-runnable',
      regressions: [],
      unavailableEntries: [
        {
          id: 'libs/supabaseAdmin.ts#manageSubscriptionStatusChange',
          phase: 'load',
          error: expect.stringContaining('stripe-subscription-period'),
        },
      ],
    });
    const regressed = await run('after', wrong, generatedImportMap(wrong));
    expect(compareGeneratedRuns(entries, before, regressed)).toMatchObject({
      status: 'regression',
      regressions: [
        {
          id: 'libs/supabaseAdmin.ts#manageSubscriptionStatusChange',
          phase: 'call',
          error: 'RangeError: Invalid time value',
        },
      ],
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

// ummarikar/boilerplate-club at b30b456ffbf67a32110999be6227244687c73227, lib/supabase/admin.ts:
// the Supabase client created at import; createClient is a stand-in with supabase-js's check.
const SUPABASE_ADMIN = `import { createClient } from "./client";
import { stripe } from "../stripe";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "",
);

export const subscriptionStatus = async (subscriptionId: string) =>
  (await stripe.subscriptions.retrieve(subscriptionId)).status;
`;
// emman-tt/tilios-backend at b554dcb083a058353c5d849d668d5ddf9c5159b2, services/stripe.js.
const TILIOS_STRIPE = `import Stripe from 'stripe'
import dotenv from 'dotenv'
dotenv.config()
export const stripe = new Stripe(process.env.STRIPE_SECRET)
`;

it('gives placeholders to the credentials and addresses the code reads, so clients created at import load', async () => {
  const repository = {
    root: '/r',
    files: [
      { path: 'lib/supabase/admin.ts', content: SUPABASE_ADMIN },
      { path: 'services/stripe.js', content: TILIOS_STRIPE },
      {
        path: 'server.js',
        content:
          "const { STRIPE_WEBHOOK_SECRET, PORT = 3000 } = process.env;\nconst flag = process.env['FEATURE_ENABLED'];\n",
      },
    ],
  } as never;
  expect(generatedEnvironment(repository)).toEqual({
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9/refit-placeholder',
    STRIPE_SECRET: 'refit_placeholder_secret',
    STRIPE_WEBHOOK_SECRET: 'refit_placeholder_secret',
    SUPABASE_SERVICE_ROLE_KEY: 'refit_placeholder_secret',
  });
  const root = await mkdtemp(join(tmpdir(), 'refit-generated-environment-'));
  roots.push(root);
  const app = join(root, 'app');
  const files: Record<string, string> = {
    'lib/supabase/admin.ts': SUPABASE_ADMIN,
    'lib/supabase/client.ts':
      "export const createClient = (url: string, key: string) => { if (!url) throw new Error('supabaseUrl is required.'); return { url, key }; };\n",
    'lib/stripe.ts': PERIOD_FILES['libs/stripe.ts'],
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(app, path)), { recursive: true });
    await writeFile(join(app, path), content);
  }
  const imports = generatedImportMap(await readRepository(app, 'stripe'));
  const server = createServer((_, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ id: 'sub_1', status: 'active' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const run = async (environment: Record<string, string>) => {
    const tools = await mkdtemp(join(root, 'tools-'));
    await writeHarness(
      tools,
      [{ file: 'lib/supabase/admin.ts', name: 'subscriptionStatus', parameters: 1 }],
      imports,
      imports,
      environment,
    );
    const { stdout } = await execute(
      process.execPath,
      ['--import', join(tools, 'redirect.mjs'), join(tools, 'harness.mjs')],
      {
        env: {
          ...process.env,
          REFIT_STRIPE_MOCK_PORT: String((server.address() as { port: number }).port),
          REFIT_GENERATED_ROOT: `${await realpath(app)}/`,
          REFIT_TYPESCRIPT: join(typescriptDirectory(), 'lib', 'typescript.js'),
        },
        timeout: 10_000,
      },
    );
    return generatedResults(stdout).get('lib/supabase/admin.ts#subscriptionStatus');
  };
  try {
    expect(await run({})).toEqual({
      ok: false,
      phase: 'load',
      error: 'Error: supabaseUrl is required.',
    });
    expect(await run(generatedEnvironment(repository))).toEqual({ ok: true });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
