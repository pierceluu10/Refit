import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import {
  compareGeneratedRuns,
  generatedResults,
  usedStandIns,
  writeHarness,
} from './generated-checks.ts';
import {
  AUTH_STAND_INS,
  STAND_INS_RUNTIME,
  parsePrismaSchema,
  prismaSchemaPaths,
  runtimeStandIns,
} from './runtime-stand-ins.ts';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function directory(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-stand-ins-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const SCHEMA = `// Billing models
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id               String         @id @default(cuid())
  credits          Int            @default(0)
  stripeCustomerId String?        @unique // set after checkout
  plan             Plan           @default(FREE)
  createdAt        DateTime       @default(now())
  subscriptions    Subscription[]
  @@map("users")
}

model Subscription {
  id     String @id
  userId String
  user   User   @relation(fields: [userId], references: [id])
}

enum Plan {
  FREE
  PRO
  @@map("plans")
}
`;

it('reads models and enums from the committed Prisma schema where prisma generate finds it', async () => {
  expect(parsePrismaSchema(SCHEMA)).toEqual({
    models: {
      User: {
        id: { type: 'String' },
        credits: { type: 'Int' },
        stripeCustomerId: { type: 'String' },
        plan: { type: 'Plan' },
        createdAt: { type: 'DateTime' },
        subscriptions: { type: 'Subscription', list: true },
      },
      Subscription: { id: { type: 'String' }, userId: { type: 'String' }, user: { type: 'User' } },
    },
    enums: { Plan: ['FREE', 'PRO'] },
  });
  expect(await prismaSchemaPaths(await directory({ 'prisma/schema.prisma': SCHEMA }))).toEqual([
    'prisma/schema.prisma',
  ]);
  expect(
    await prismaSchemaPaths(
      await directory({ 'prisma/schema/billing.prisma': SCHEMA, 'prisma/schema/base.prisma': '' }),
    ),
  ).toEqual(['prisma/schema/base.prisma', 'prisma/schema/billing.prisma']);
  expect(
    await prismaSchemaPaths(
      await directory({
        'package.json': JSON.stringify({ prisma: { schema: './db/main.prisma' } }),
        'db/main.prisma': SCHEMA,
        'prisma/schema.prisma': SCHEMA,
      }),
    ),
  ).toEqual(['db/main.prisma']);
  // A configured path outside the repository is never read.
  expect(
    await prismaSchemaPaths(
      await directory({
        'package.json': JSON.stringify({ prisma: { schema: '../outside.prisma' } }),
        'prisma/schema.prisma': SCHEMA,
      }),
    ),
  ).toEqual([]);
  expect(await runtimeStandIns(await directory({ 'src/index.ts': '' }))).toEqual({});
});

it('never stands in for Stripe', () => {
  // Stand-ins answer only the placeholder origin and named session modules; the stripe module and
  // api.stripe.com reach the SDK and stripe-mock exactly as before.
  expect(Object.keys(AUTH_STAND_INS).some((name) => /stripe/i.test(name))).toBe(false);
  expect(STAND_INS_RUNTIME).not.toMatch(/stripe/i);
  expect(STAND_INS_RUNTIME).toContain("const PLACEHOLDER_ORIGIN = 'http://127.0.0.1:9';");
});

// Application code that reads a database, a Supabase table and a session before its Stripe call.
const APPLICATION = `import https from 'node:https';
import { PrismaClient, Plan } from '@prisma/client';
import NextAuth, { getServerSession, real } from 'next-auth';
import Stripe from 'stripe';
const prisma = new PrismaClient();
const stripeRequest = (path) => new Promise((resolve, reject) => {
  const req = https.request({ hostname: 'api.stripe.com', path, method: 'GET', headers: { Authorization: 'Bearer ' + process.env.STRIPE_SECRET_KEY } });
  req.on('response', (res) => { let data = ''; res.on('data', (c) => (data += c)); res.on('end', () => resolve(JSON.parse(data))); });
  req.on('error', reject);
  req.once('socket', (socket) => socket.once('secureConnect', () => req.end()));
});
export async function chargeCustomer(id) {
  const session = await getServerSession();
  if (!session?.user?.id) throw new Error('Unauthorized');
  const user = await prisma.user.findUnique({ where: { id }, include: { subscriptions: true } });
  if (user.plan !== Plan.FREE || user.subscriptions.length !== 1) throw new Error('unexpected record');
  const row = await (await fetch(process.env.SUPABASE_URL + '/rest/v1/customers?select=id,stripe_customer_id&id=eq.' + id, { headers: { accept: 'application/vnd.pgrst.object+json' } })).json();
  if (typeof NextAuth !== 'function' || !real || !Stripe.real) throw new Error('a real module was replaced');
  return stripeRequest('/v1/customers/' + user.stripeCustomerId + '?supabase=' + row.stripe_customer_id);
}
export async function ownFailure(id) {
  await prisma.user.findFirst({ where: { id } });
  throw new Error('the application still fails on its own');
}
`;

it('lets application code reach its Stripe call past a database, Supabase and a session', async () => {
  const root = await directory({
    'app/prisma/schema.prisma': SCHEMA,
    'app/src/billing.mjs': APPLICATION,
    'app/node_modules/next-auth/package.json': JSON.stringify({
      name: 'next-auth',
      type: 'module',
      main: 'index.js',
    }),
    'app/node_modules/next-auth/index.js':
      "export const real = true;\nexport function getServerSession() { throw new Error('no request scope'); }\nexport default function NextAuth() {}\n",
    'app/node_modules/stripe/package.json': JSON.stringify({
      name: 'stripe',
      type: 'module',
      main: 'index.js',
    }),
    'app/node_modules/stripe/index.js': 'export default { real: true };\n',
  });
  const tools = join(root, 'tools');
  await mkdir(tools);
  const requests: IncomingMessage[] = [];
  const server = createServer((request, response) => {
    requests.push(request);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ id: 'cus_x', object: 'customer' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await writeHarness(
      tools,
      [
        { file: 'src/billing.mjs', name: 'chargeCustomer', parameters: 1 },
        { file: 'src/billing.mjs', name: 'ownFailure', parameters: 1 },
      ],
      {},
      {},
      { SUPABASE_URL: 'http://127.0.0.1:9/refit-placeholder', STRIPE_SECRET_KEY: 'sk_test_123' },
      await runtimeStandIns(join(root, 'app')),
    );
    const { stdout } = await execute(
      process.execPath,
      ['--import', join(tools, 'redirect.mjs'), join(tools, 'harness.mjs')],
      {
        env: {
          ...process.env,
          REFIT_STRIPE_MOCK_PORT: String((server.address() as { port: number }).port),
          REFIT_GENERATED_ROOT: `${join(root, 'app')}/`,
        },
        timeout: 20_000,
      },
    );
    const results = generatedResults(stdout);
    expect(results.get('src/billing.mjs#chargeCustomer')).toEqual({ ok: true });
    // The Stripe request still reaches the mock, with the database's placeholder customer.
    expect(requests.map((request) => request.url)).toEqual([
      '/v1/customers/refit_placeholder_stripeCustomerId?supabase=refit_placeholder_stripe_customer_id',
    ]);
    expect(results.get('src/billing.mjs#ownFailure')).toEqual({
      ok: false,
      phase: 'call',
      error: 'Error: the application still fails on its own',
    });
    expect(usedStandIns(stdout)).toEqual(['next-auth', 'postgrest', 'prisma']);
    const run = { status: 'passed' as const, exitCode: 0, stdout, stderr: '' };
    expect(
      compareGeneratedRuns(
        [{ file: 'src/billing.mjs', name: 'chargeCustomer', parameters: 1 }],
        run,
        run,
      ),
    ).toMatchObject({ status: 'passed', ran: 1, standIns: ['next-auth', 'postgrest', 'prisma'] });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
