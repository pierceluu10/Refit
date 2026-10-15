import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import {
  compareGeneratedRuns,
  generatedCommand,
  generatedEntryPoints,
  generatedResults,
  writeHarness,
} from './generated-checks.ts';
import { parseWorkflowConfiguration } from './workflow-configuration.ts';
import type { Finding } from './types.ts';

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

it('strips TypeScript only when an entry point needs it', () => {
  expect(generatedCommand([{ file: 'a.js', name: 'x', parameters: 0 }]).join(' ')).not.toContain(
    'strip-types',
  );
  expect(generatedCommand([{ file: 'a.ts', name: 'x', parameters: 0 }]).join(' ')).toContain(
    '--experimental-strip-types',
  );
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
    await rm(join(tools, 'entries.json'));
    await rm(join(tools, 'harness.mjs'));
    await rm(join(tools, 'redirect.mjs'));
    const broken = await run('broken');
    expect(generatedResults(broken.stdout).get('src/billing.mjs#broken')).toEqual({
      ok: false,
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

it('excludes functions that cannot run on the original code and gates only regressions', () => {
  const entries = ['a', 'b', 'c'].map((name) => ({ file: 'x.js', name, parameters: 1 }));
  const output = (results: Record<string, boolean>) => ({
    status: 'passed' as const,
    exitCode: 0,
    stderr: '',
    stdout: Object.entries(results)
      .map(
        ([name, ok]) =>
          `REFIT_GENERATED_RESULT=${JSON.stringify({ id: `x.js#${name}`, ok, ...(ok ? {} : { error: 'Error: database unavailable' }) })}`,
      )
      .join('\n'),
  });
  const clean = compareGeneratedRuns(
    entries,
    output({ a: true, b: false, c: true }),
    output({ a: true, b: false, c: true }),
  );
  expect(clean).toMatchObject({
    notRunnable: [{ id: 'x.js#b', error: 'Error: database unavailable' }],
    regressions: [],
    baseline: { status: 'passed' },
    patched: { status: 'passed' },
  });
  const regressed = compareGeneratedRuns(
    entries,
    output({ a: true, b: false, c: true }),
    output({ a: true, b: true, c: false }),
  );
  expect(regressed.regressions).toEqual([{ id: 'x.js#c', error: 'Error: database unavailable' }]);
  expect(regressed.patched.status).toBe('failed');
  const crashed = compareGeneratedRuns(
    entries,
    { status: 'failed', exitCode: 1, stdout: '', stderr: 'stripe-mock did not start' },
    output({ a: true, b: true, c: true }),
  );
  expect(crashed.baseline.status).toBe('failed');
});
