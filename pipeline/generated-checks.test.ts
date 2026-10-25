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
  generatedImportMap,
  generatedResults,
  stageMockDocument,
  typescriptDirectory,
  writeHarness,
} from './generated-checks.ts';
import { readRepository } from './repository.ts';
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
  const command = generatedCommand().join(' ');
  expect(command).not.toContain('strip-types');
  expect(command).toContain('--import /refit/generated/redirect.mjs');
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
    error: expect.stringContaining("Cannot find module '"),
  });
});
