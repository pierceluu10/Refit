import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { aiSafetyStop } from './migration-review.ts';
import { createReviewArtifacts } from './review.ts';
import { runPipeline } from './run.ts';
import { STRIPE_SDK_RELEASES } from './stripe-package-upgrade.ts';
import { SUBSCRIPTION_PERIOD_RULE } from './stripe-subscription-periods.ts';
import { WEBHOOK_REVIEW_REASON } from './stripe-webhook-payloads.ts';
import type { Finding } from './types.ts';
import { movedLine } from './validation.ts';
import { runWorkflow } from './workflow.ts';

// Owner decisions 1 and 8: with AI on, the coverage stops let AI build on the rules' patch; the
// safety stops keep it out. Docker is a stand-in that fails the checks on code containing
// BREAKS_CHECKS, and OpenAI is a fetch stub.
const execute = promisify(execFile);
const roots: string[] = [];
const BEFORE = '2026-08-26.dahlia';
const AFTER = '2026-09-30.endive';
const BREAKS = 'BREAKS_CHECKS';
// gpt-6.1-sol prices (pipeline/ai-budget.ts): 1,000 input tokens at $2/M and 100 output at $10/M.
const MODEL = 'gpt-6.1-sol';
const REQUEST_COST = 0.003;
const OPENAI = 'https://api.openai.com/';
const SDK = STRIPE_SDK_RELEASES[AFTER];
const SHA512 = `sha512-${'A'.repeat(86)}==`;
// An npm v3 project on stripe-node 22: the card rename in TypeScript upgrades it (run.ts).
const NPM_PROJECT = {
  'package.json': `${JSON.stringify({ name: 'app', dependencies: { stripe: '^22.6.2' } }, null, 2)}\n`,
  'package-lock.json': `${JSON.stringify(
    {
      name: 'app',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'app', dependencies: { stripe: '^22.6.2' } },
        'node_modules/stripe': {
          version: '22.6.2',
          resolved: 'https://registry.npmjs.org/stripe/-/stripe-22.6.2.tgz',
          integrity: SHA512,
        },
      },
    },
    null,
    2,
  )}\n`,
};

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const body = (properties: Record<string, unknown>) => ({
  content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties } } },
});
const returns = (schema: string) => ({
  '200': {
    description: 'OK',
    content: { 'application/json': { schema: { $ref: `#/components/schemas/${schema}` } } },
  },
});

// Shaped like Stripe's dahlia and endive contracts where the dev-30 repositories stop: Checkout
// Session creation drops payment_method_types, the session drops a response field, and customer
// creation makes a request property required, which no rule migrates.
function contract(version: string) {
  const endive = version === AFTER;
  return {
    openapi: '3.0.0',
    info: { version },
    paths: {
      '/v1/checkout/sessions': {
        post: {
          operationId: 'PostCheckoutSessions',
          requestBody: body({
            mode: { type: 'string' },
            line_items: { type: 'array', items: { type: 'object' } },
            [endive ? 'allowed_payment_method_types' : 'payment_method_types']: {
              type: 'array',
              items: { type: 'string' },
            },
          }),
          responses: returns('checkout.session'),
        },
      },
      '/v1/customers': {
        post: {
          operationId: 'PostCustomers',
          requestBody: {
            content: {
              'application/x-www-form-urlencoded': {
                schema: {
                  type: 'object',
                  properties: { email: { type: 'string' }, name: { type: 'string' } },
                  ...(endive ? { required: ['email'] } : {}),
                },
              },
            },
          },
          responses: returns('customer'),
        },
      },
    },
    components: {
      schemas: {
        'checkout.session': {
          type: 'object',
          properties: {
            id: { type: 'string' },
            url: { type: 'string' },
            [endive ? 'tax_details' : 'total_details']: {
              type: 'object',
              properties: { amount_tax: { type: 'integer' } },
            },
          },
        },
        customer: { type: 'object', properties: { id: { type: 'string' } } },
      },
    },
  };
}

const ADAPTER = {
  id: 'stripe-endive',
  packageName: 'stripe',
  defaultImport: true,
  namedExport: 'Stripe',
  constructorCalls: true,
  apiVersion: { constructorArgument: 1, property: 'apiVersion', requestArguments: [1, 2] },
  operations: [
    {
      resource: 'checkout.sessions',
      method: 'create',
      schema: 'checkout.session',
      operationId: 'PostCheckoutSessions',
    },
    { resource: 'customers', method: 'create', schema: 'customer', operationId: 'PostCustomers' },
  ],
};

// A docker stand-in: every check passes unless the mounted code contains BREAKS_CHECKS.
const DOCKER = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'image') { console.log(args[3] === '{{.Id}}' ? 'sha256:${'d'.repeat(64)}' : JSON.stringify(['NODE_VERSION=22.23.3'])); process.exit(0); }
if (args[0] === 'info') { console.log(${16 * 1024 ** 3}); process.exit(0); }
if (['rm', 'create', 'ps'].includes(args[0])) process.exit(0);
if (args[0] === 'cp') { fs.writeFileSync(args[2], 'stripe-mock'); process.exit(0); }
const mount = args.find((arg) => arg.includes('dst=/input'));
const source = /src=([^,]+)/.exec(mount)[1];
const read = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
  entry.name === 'node_modules' ? [] : entry.isDirectory() ? read(path.join(directory, entry.name)) : [fs.readFileSync(path.join(directory, entry.name), 'utf8')]);
const broken = read(source).some((content) => content.includes('${BREAKS}'));
if (broken) console.error('TypeError: the migrated code breaks the checks');
process.exit(broken ? 1 : 0);
`;

interface Shape {
  // The dev-30 repository the fixture is shaped like.
  name: string;
  files: Record<string, string>;
  fullDiff?: boolean;
  // A contract and adapter other than the Checkout and Customers ones.
  contract?: (version: string) => object;
  adapter?: typeof ADAPTER;
  // The model's edit for what the rules left, in the rules' patch's text.
  fix?: { file: string; original: string; replacement: string };
}

const CARD_CHECKOUT = `export const checkout = (price) =>
  stripe.checkout.sessions.create({ mode: 'subscription', payment_method_types: ['card'], line_items: [{ price, quantity: 1 }] });
`;
const client = (key = 'process.env.STRIPE_SECRET_KEY') =>
  `import Stripe from 'stripe';\nexport const stripe = new Stripe(${key}, { apiVersion: '${BEFORE}' });\n`;

// A removed request parameter with no reviewed replacement beside reads the rules leave.
const REMOVED_PARAMETER: Shape[] = [
  {
    name: 'doganarif/build-it',
    files: {
      'lib/stripe.js': `${client()}${CARD_CHECKOUT}export const terminal = () =>
  stripe.checkout.sessions.create({ mode: 'payment', payment_method_types: ['card_present'] });
export function tax(session) {
  return session.total_details.amount_tax;
}
`,
    },
    fix: {
      file: 'lib/stripe.js',
      original: 'session.total_details.amount_tax',
      replacement: 'session.tax_details.amount_tax',
    },
  },
  {
    name: 'ggallon/type-last',
    files: {
      'app/api/users/stripe/route.ts': `${client('process.env.STRIPE_SECRET_KEY!')}export async function POST(request: Request) {
  const { price } = await request.json();
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price, quantity: 1 }],
  });
  return Response.json({ url: session.url });
}
export const terminal = () =>
  stripe.checkout.sessions.create({ mode: 'payment', payment_method_types: ['card_present'] });
export const receipt = (session: any) => ({ tax: session.total_details.amount_tax });
`,
    },
    fix: {
      file: 'app/api/users/stripe/route.ts',
      original: 'session.total_details.amount_tax',
      replacement: 'session.tax_details.amount_tax',
    },
  },
];

// Reads of a removed field Refit could not trace to a Stripe object.
const UNTRACED: Shape[] = [
  {
    name: 'alanagoyal/branded',
    files: {
      'lib/billing-state.ts': `${client('process.env.STRIPE_SECRET_KEY!')}${CARD_CHECKOUT}export function billingState(session: any) {
  return { tax: session?.total_details ? session.total_details.amount_tax : null };
}
`,
    },
    fix: {
      file: 'lib/billing-state.ts',
      original: 'session?.total_details ? session.total_details.amount_tax : null',
      replacement: 'session?.tax_details ? session.tax_details.amount_tax : null',
    },
  },
  {
    name: 'JensenMPillay/pdfai',
    files: {
      'src/lib/stripe.ts': `${client('process.env.STRIPE_SECRET_KEY ?? ""')}${CARD_CHECKOUT}export async function checkoutTax(id: string, sessions: any[]) {
  const session = sessions.find((entry) => entry.id === id);
  return session.total_details.amount_tax;
}
`,
    },
    fix: {
      file: 'src/lib/stripe.ts',
      original: 'session.total_details.amount_tax',
      replacement: 'session.tax_details.amount_tax',
    },
  },
];

// SDK calls traced to a breaking contract change no rule migrates (needs oasdiff).
const CONTRACT_CHANGES: Shape[] = [
  {
    name: 'Emmah-oo/spotify-clone',
    fullDiff: true,
    files: {
      'libs/supabaseAdmin.ts': `${client('process.env.STRIPE_SECRET_KEY!')}${CARD_CHECKOUT}export async function createOrRetrieveCustomer(uuid: string, email: string) {
  const customer = await stripe.customers.create({ metadata: { supabaseUUID: uuid } });
  return customer.id;
}
`,
    },
    fix: {
      file: 'libs/supabaseAdmin.ts',
      original: '{ metadata: { supabaseUUID: uuid } }',
      replacement: '{ email, metadata: { supabaseUUID: uuid } }',
    },
  },
  {
    name: 'adamhitzger/financehb',
    fullDiff: true,
    files: {
      'actions/checkout.js': `${client()}${CARD_CHECKOUT}export async function register(user) {
  const customer = await stripe.customers.create({ name: user.name });
  return customer.id;
}
`,
    },
    fix: {
      file: 'actions/checkout.js',
      original: '{ name: user.name }',
      replacement: '{ name: user.name, email: user.email }',
    },
  },
];

async function workspace(shape: Shape) {
  const root = await mkdtemp(join(tmpdir(), 'refit-coverage-'));
  roots.push(root);
  const repository = join(root, 'repository');
  const files = { ...NPM_PROJECT, ...shape.files };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repository, path)), { recursive: true });
    await writeFile(join(repository, path), content);
  }
  await execute('git', ['init', '-q', repository]);
  await execute('git', ['-C', repository, 'add', '.']);
  await execute('git', [
    '-C',
    repository,
    '-c',
    'user.name=Refit Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'test: seed repository',
  ]);
  const before = join(root, 'before.json');
  const after = join(root, 'after.json');
  const providerConfig = join(root, 'adapter.json');
  await writeFile(before, JSON.stringify((shape.contract ?? contract)(BEFORE)));
  await writeFile(after, JSON.stringify((shape.contract ?? contract)(AFTER)));
  await writeFile(providerConfig, JSON.stringify(shape.adapter ?? ADAPTER));
  const binary = join(root, 'bin');
  await mkdir(binary);
  await writeFile(join(binary, 'docker'), DOCKER);
  await chmod(join(binary, 'docker'), 0o755);
  vi.stubEnv('PATH', binary + delimiter + process.env.PATH);
  const inputs = {
    repository,
    before,
    after,
    providerConfig,
    apiVersion: BEFORE,
    ...(shape.fullDiff ? { fullDiff: true } : {}),
  };
  return { root, inputs };
}

interface Request {
  instructions: string;
  evidence: {
    findings: { id: string; file: string; line: number; changeId: string; expression: string }[];
    files: { path: string; content: string }[];
  };
}

// The npm registry's stripe metadata, and OpenAI's Responses API, where each request gets
// `answer(request, n)` as its edits. Without `answer` any OpenAI request fails the test.
function network(
  answer?: (request: Request, count: number) => unknown[],
  // OpenAI's HTTP status for every request, such as 401 for a rejected key.
  status = 200,
) {
  const requests: Request[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === `https://registry.npmjs.org/stripe/${SDK}`)
      return Response.json({
        name: 'stripe',
        version: SDK,
        license: 'MIT',
        dependencies: {},
        dist: {
          tarball: `https://registry.npmjs.org/stripe/-/stripe-${SDK}.tgz`,
          integrity: SHA512,
        },
      });
    if (!url.startsWith(OPENAI) || !answer) throw new Error(`Unexpected request to ${url}`);
    if (status !== 200) return new Response('{}', { status });
    const sent = JSON.parse(String(init!.body));
    if (url.endsWith('/input_tokens')) return Response.json({ input_tokens: 1000 });
    const request = {
      instructions: sent.instructions,
      evidence: JSON.parse(sent.input[0].content),
    };
    requests.push(request);
    return Response.json({
      id: `resp_coverage_${requests.length}`,
      model: MODEL,
      status: 'completed',
      usage: { input_tokens: 1000, output_tokens: 100 },
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({
                summary: 'Resolve what the rules left.',
                uncertainties: ['Review the replacement field.'],
                edits: answer(request, requests.length),
              }),
            },
          ],
        },
      ],
    });
  });
  vi.stubGlobal('fetch', fetcher);
  const openai = () => fetcher.mock.calls.filter(([url]) => url.startsWith(OPENAI));
  return { requests, openai };
}

// The fix as an edit of the file the request sends, citing a finding in that file.
const edit = (fix: NonNullable<Shape['fix']>, request: Request, replacement = fix.replacement) => {
  const file = request.evidence.files.find((entry) => entry.path === fix.file)!;
  const finding = request.evidence.findings.find((entry) => entry.file === fix.file)!;
  const start = file.content.indexOf(fix.original);
  // The model returns the whole statement around the change, as a model would.
  const lineStart = file.content.lastIndexOf('\n', start) + 1;
  const lineEnd = file.content.indexOf('\n', start);
  const original = file.content.slice(lineStart, lineEnd);
  return {
    file: fix.file,
    original,
    replacement: original.replace(fix.original, replacement),
    findingId: finding.id,
  };
};

async function run(shape: Shape, ai = false) {
  const { root, inputs } = await workspace(shape);
  const result = await runWorkflow({
    ...inputs,
    output: join(root, 'run'),
    image: 'node:22-alpine',
    command: ['npm', 'test'],
    allowUnresolved: true,
    ...(ai
      ? {
          aiPatch: {
            apiKey: 'test-key',
            model: MODEL,
            budget: { directory: join(root, 'budget'), limitUsd: 5 },
          },
          repairAttempts: 1,
        }
      : {}),
  });
  const artifact = (name: string) =>
    readFile(join(root, 'run', name), 'utf8').catch((error) => {
      throw new Error(`${name} is missing: ${JSON.stringify(result.manifest)}`, { cause: error });
    });
  const report = JSON.parse(await artifact('report.json'));
  return {
    inputs,
    manifest: result.manifest,
    report,
    body: await artifact('pull-request.md'),
    publication: Object.fromEntries(
      (report.publicationFiles as { path: string; content: string }[]).map((file) => [
        file.path,
        file.content,
      ]),
    ),
  };
}

// What the rules' patch alone writes, from a scan without AI.
async function rulesPatch(inputs: Awaited<ReturnType<typeof workspace>>['inputs']) {
  const scan = await runPipeline({ ...inputs, proposePatch: true, leaveReviewedFindings: true });
  if (!('diff' in scan.patch)) throw new Error(`No rules patch: ${JSON.stringify(scan.patch)}`);
  return scan.patch;
}

const COVERAGE = [
  ...REMOVED_PARAMETER.map((shape) => ['a removed request parameter', shape.name, shape] as const),
  ...UNTRACED.map((shape) => ['untraced reads', shape.name, shape] as const),
  ...(process.env.REFIT_OASDIFF
    ? CONTRACT_CHANGES.map((shape) => ['an unmigrated contract change', shape.name, shape] as const)
    : []),
];
const gates = (report: { waivedGates?: { gate: string }[] }) =>
  (report.waivedGates ?? []).map((entry) => entry.gate);
const NEEDS_REVIEW = 'Review artifacts are ready as a [Needs review] draft for';

it.each(COVERAGE)(
  'with AI off, %s shaped like %s keeps the rules-only draft and makes no request',
  async (_kind, _name, shape) => {
    const { openai } = network();
    const { inputs, manifest, report, body } = await run(shape);
    console.log(shape.name, 'AI off:', manifest.status, manifest.reason);
    expect(openai()).toHaveLength(0);
    expect(manifest).toMatchObject({ status: 'needs-review', stage: 'validation' });
    expect(report.patch).toMatchObject({
      generator: 'deterministic',
      diff: (await rulesPatch(inputs)).diff,
    });
    expect(report.validation).not.toHaveProperty('aiCostUsd');
    expect(report.validation).not.toHaveProperty('coverageAi');
    expect(gates(report)).not.toContain('ai-patch');
    expect(body).not.toContain('Resolved by AI');
  },
);

it.each(COVERAGE)(
  'with AI on, %s shaped like %s gets an AI patch on the rules, published [Needs review] with its lines',
  async (_kind, _name, shape) => {
    const fix = shape.fix!;
    const { requests } = network((request) => [edit(fix, request)]);
    const { inputs, manifest, report, body, publication } = await run(shape, true);
    const rules = await rulesPatch(inputs);
    console.log(shape.name, 'AI kept:', JSON.stringify(report.validation.coverageAi, null, 2));
    expect(requests).toHaveLength(1);
    // The model gets the rules' patch, frozen, and only what the rules left.
    const sent = requests[0].evidence.files.find((file) => file.path === fix.file)!;
    expect(sent.content).toContain(`apiVersion: '${AFTER}'`);
    expect(sent.content).toContain("allowed_payment_method_types: ['card']");
    expect(requests[0].instructions).toContain('resolve only these');
    expect(requests[0].evidence.findings.length).toBeGreaterThan(0);
    for (const finding of requests[0].evidence.findings)
      expect(finding.changeId).not.toMatch(/^request-parameter:/);
    expect(manifest).toMatchObject({ status: 'needs-review', stage: 'validation' });
    expect(manifest.reason).toContain(NEEDS_REVIEW);
    expect(report.validation).toMatchObject({
      status: 'passed',
      aiCostUsd: REQUEST_COST,
      coverageAi: { outcome: 'kept', costUsd: REQUEST_COST },
    });
    expect(report.patch.generator).toBe('openai');
    // The rules' lines stay; the model's edit is added.
    const migrated = publication[fix.file];
    expect(migrated).toContain(fix.replacement);
    expect(migrated).toContain(`apiVersion: '${AFTER}'`);
    expect(migrated).toContain("allowed_payment_method_types: ['card']");
    expect(rules.diff).not.toContain(fix.replacement);
    expect(gates(report)).toContain('ai-patch');
    // The AI item lists the AI-written line, and no line the rules wrote.
    const line = migrated.split('\n').findIndex((text) => text.includes(fix.replacement)) + 1;
    const item = body.split('\n- ').find((entry) => entry.startsWith('Refit asked an AI model'))!;
    expect(item.match(/`[^`\s]+:\d+(?:-\d+)?`/g)).toEqual([`\`${fix.file}:${line}\``]);
    if (!shape.fullDiff) {
      expect(body).toContain(`Resolved by AI: \`${fix.file}\``);
      expect(report.validation.coverageAi.resolved.length).toBeGreaterThan(0);
    }
    if (shape.files[fix.file].includes('card_present')) {
      // The removed parameter stays as written and listed for review.
      expect(migrated).toContain("payment_method_types: ['card_present']");
      expect(gates(report)).toContain('removed-request-parameter');
    }
  },
);

it.each(COVERAGE)(
  'with AI on, %s shaped like %s never publishes an AI patch whose checks fail after repair',
  async (_kind, _name, shape) => {
    const fix = shape.fix!;
    const { requests } = network((request, count) => [
      edit(fix, request, `${fix.replacement} /* ${BREAKS} ${count} */`),
    ]);
    const { inputs, manifest, report, body, publication } = await run(shape, true);
    console.log(shape.name, 'AI failed:', JSON.stringify(report.validation.coverageAi, null, 2));
    // The proposal and one repair.
    expect(requests).toHaveLength(2);
    expect(report.validation).toMatchObject({
      status: 'passed',
      aiCostUsd: 2 * REQUEST_COST,
      coverageAi: {
        outcome: 'checks-failed',
        costUsd: 2 * REQUEST_COST,
        repair: { requested: 1, stopReason: 'attempt-limit' },
      },
    });
    expect(
      report.validation.coverageAi.attempts.map(
        (attempt: { check: { status: string } }) => attempt.check.status,
      ),
    ).toEqual(['failed', 'failed']);
    // The rules' patch is the draft, exactly as without AI.
    expect(report.patch).toMatchObject({
      generator: 'deterministic',
      diff: (await rulesPatch(inputs)).diff,
    });
    expect(report.validation.attempts).toHaveLength(1);
    expect(Object.values(publication).join('\n')).not.toContain(BREAKS);
    expect(body).not.toContain(BREAKS);
    // The same draft and outcome as with AI off.
    const off = await run(shape);
    expect(requests).toHaveLength(2);
    expect(publication).toEqual(off.publication);
    expect(manifest).toMatchObject({ status: off.manifest.status, reason: off.manifest.reason });
    expect(gates(report)).toEqual(gates(off.report));
  },
);

it.each(REMOVED_PARAMETER.map((shape) => [shape.name, shape] as const))(
  'keeps a coverage patch its repair fixed for %s, with the removed parameter still unresolved',
  async (_name, shape) => {
    const fix = shape.fix!;
    const { requests } = network((request, count) => [
      edit(fix, request, count === 1 ? `${fix.replacement} /* ${BREAKS} */` : fix.replacement),
    ]);
    const { report, publication } = await run(shape, true);
    console.log(shape.name, 'AI repaired:', JSON.stringify(report.validation.coverageAi, null, 2));
    expect(requests).toHaveLength(2);
    expect(report.validation).toMatchObject({
      status: 'passed',
      aiCostUsd: 2 * REQUEST_COST,
      coverageAi: { outcome: 'kept', costUsd: 2 * REQUEST_COST },
      repair: { requested: 1 },
    });
    expect(publication[fix.file]).toContain(fix.replacement);
    expect(publication[fix.file]).not.toContain(BREAKS);
    expect(publication[fix.file]).toContain("payment_method_types: ['card_present']");
    expect(report.patch.unresolvedSites).toContainEqual(
      expect.objectContaining({
        file: fix.file,
        expression: expect.stringContaining('payment_method_types'),
      }),
    );
  },
);

// The draft's title, as `refit run` and publication name it.
const title = (
  report: Parameters<typeof createReviewArtifacts>[0] & {
    waivedGates?: Parameters<typeof createReviewArtifacts>[3];
  },
) => createReviewArtifacts(report, 'local', undefined, report.waivedGates).manifest.title;

it.each([
  ['a rejected key (HTTP 401)', 401, UNTRACED[0]],
  ['a rejected key (HTTP 401)', 401, REMOVED_PARAMETER[0]],
  [
    'evidence over the input limit',
    200,
    {
      ...UNTRACED[1],
      files: {
        'src/lib/stripe.ts': `${UNTRACED[1].files['src/lib/stripe.ts']}// ${'x'.repeat(70 * 1024)}\n`,
      },
    },
  ],
] as const)(
  'leaves the rules-only outcome and title unchanged when the AI request fails: %s on %s',
  async (_failure, status, shape) => {
    network(() => [], status);
    const ai = await run(shape, true);
    const off = await run(shape);
    console.log(shape.name, 'AI failed:', ai.manifest.status, ai.report.validation.coverageAi);
    expect(ai.report.validation.coverageAi).toMatchObject({ outcome: 'refused', costUsd: 0 });
    expect(ai.report.validation.coverageAi.error).toMatch(
      status === 401 ? /HTTP 401/ : /input limit/,
    );
    expect(ai.manifest).toMatchObject({
      status: off.manifest.status,
      stage: off.manifest.stage,
      reason: off.manifest.reason,
    });
    expect(gates(ai.report)).toEqual(gates(off.report));
    expect(title(ai.report)).toBe(title(off.report));
    expect(ai.publication).toEqual(off.publication);
    expect(ai.report.patch).toMatchObject({
      generator: 'deterministic',
      diff: off.report.patch.diff,
    });
  },
);

it('records what a declined coverage request cost and keeps the rules-only draft (palashb01/DocuChat)', async () => {
  // DocuChat's untraced reads are a local plan table's own field, not Stripe's.
  const shape: Shape = {
    name: 'palashb01/DocuChat',
    files: {
      'src/lib/stripe.ts': `${client('process.env.STRIPE_SECRET_KEY ?? ""')}${CARD_CHECKOUT}export const priceId = (plan: any) => plan.total_details.priceIds.test;
`,
    },
  };
  const { requests } = network(() => []);
  const { inputs, report } = await run(shape, true);
  console.log(shape.name, 'AI declined:', JSON.stringify(report.validation.coverageAi, null, 2));
  expect(requests).toHaveLength(1);
  expect(report.validation).toMatchObject({
    status: 'passed',
    aiCostUsd: REQUEST_COST,
    coverageAi: { costUsd: REQUEST_COST },
  });
  // The model's own account is what shows why it proposed nothing.
  expect(report.validation.coverageAi).toMatchObject({
    outcome: 'no-proposal',
    response: {
      id: 'resp_coverage_1',
      summary: 'Resolve what the rules left.',
      uncertainties: ['Review the replacement field.'],
    },
  });
  expect(report.patch).toMatchObject({
    generator: 'deterministic',
    diff: (await rulesPatch(inputs)).diff,
  });
});

// Shaped like basil's subscription period move: the field leaves the subscription for its items.
function periodContract(version: string) {
  const endive = version === AFTER;
  const integer = { type: 'integer' };
  const period = { current_period_start: integer, current_period_end: integer };
  return {
    openapi: '3.0.0',
    info: { version },
    paths: {
      '/v1/subscriptions/{subscription_exposed_id}': {
        get: {
          operationId: 'GetSubscriptionsSubscriptionExposedId',
          parameters: [
            {
              name: 'subscription_exposed_id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: returns('subscription'),
        },
      },
    },
    components: {
      schemas: {
        subscription: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            cancel_at_period_end: { type: 'boolean' },
            ...(endive ? {} : period),
            items: {
              type: 'object',
              properties: {
                data: { type: 'array', items: { $ref: '#/components/schemas/subscription_item' } },
              },
            },
          },
        },
        subscription_item: {
          type: 'object',
          properties: { id: { type: 'string' }, ...(endive ? period : {}) },
        },
      },
    },
  };
}

it('asks AI to finish an untraced period read through the helper the rules wrote, and keeps it (shagunmistry/FlowCraft)', async () => {
  // FlowCraft's adapter maps subscriptions.retrieve but not subscriptions.list, so the rules
  // migrate the retrieved subscription, with the item its function reads, and leave the listed
  // one's read untraced.
  const shape: Shape = {
    name: 'shagunmistry/FlowCraft',
    contract: periodContract,
    adapter: {
      ...ADAPTER,
      operations: [
        {
          resource: 'subscriptions',
          method: 'retrieve',
          schema: 'subscription',
          operationId: 'GetSubscriptionsSubscriptionExposedId',
        },
      ],
    },
    files: {
      'src/app/api/subscription/route.ts': `${client('process.env.STRIPE_SECRET_KEY!')}export async function renewal(id: string) {
  const subscription = await stripe.subscriptions.retrieve(id);
  return { item: subscription.items.data[0].id, ends: subscription.current_period_end * 1000 };
}
export async function recover(customer: string) {
  const subs = await stripe.subscriptions.list({ customer, status: 'all', limit: 10 });
  return subs.data.find((s) => s.cancel_at_period_end && s.current_period_end * 1000 > Date.now());
}
`,
    },
    fix: {
      file: 'src/app/api/subscription/route.ts',
      original: 's.current_period_end',
      replacement: 'getSubscriptionPeriodEnd(s)',
    },
  };
  const fix = shape.fix!;
  const { requests } = network((request) => [edit(fix, request)]);
  const { inputs, report, publication } = await run(shape, true);
  const rules = await rulesPatch(inputs);
  console.log(shape.name, 'AI coverage:', JSON.stringify(report.validation.coverageAi, null, 2));
  console.log(shape.name, 'rules patch:', rules.diff);
  expect(rules.diff).toContain('getSubscriptionPeriodEnd(subscription, (items) => items[0])');
  expect(rules.diff).toContain('s.current_period_end');
  expect(requests).toHaveLength(1);
  // What the model needs to finish the read: the target, the rules' helper and the guidance.
  const { evidence, instructions } = requests[0] as Request & {
    evidence: { contextFiles: { path: string; content: string }[] };
  };
  expect(evidence.findings).toEqual([
    expect.objectContaining({
      file: fix.file,
      expression: '.current_period_end',
      untraced: true,
    }),
  ]);
  // The rules write the helper into its one calling file, or a shared module when several call it.
  const helper = [...evidence.files, ...evidence.contextFiles].find((file) =>
    /function getSubscriptionPeriodEnd\(/.test(file.content),
  );
  expect(helper).toBeDefined();
  expect(instructions).toContain('through that helper, passing the object alone');
  expect(instructions).toContain('not evidence that the value is something else');
  // The helper with the object alone is no item choice, so the guards keep the edit.
  expect(report.validation.coverageAi).toMatchObject({ outcome: 'kept', costUsd: REQUEST_COST });
  expect(publication[fix.file]).toContain('getSubscriptionPeriodEnd(s) * 1000 > Date.now()');
  expect(publication[fix.file]).toContain(
    'getSubscriptionPeriodEnd(subscription, (items) => items[0])',
  );
});

// Safety stops: AI makes no request, and the rules' [Needs review] draft still ships (decision 1).
const SAFETY: Shape[] = [
  {
    // A source file Refit cannot parse: its API usage is unknown.
    name: 'a repository with an unparseable file',
    files: {
      'lib/stripe.js': `${client()}${CARD_CHECKOUT}`,
      'lib/legacy.js': 'export const = ;\n',
    },
  },
  {
    // Reads the rules leave only in test files: tests stay as written.
    name: 'UNC-GDSC/Micro-SaaS-Starter-Kit',
    files: {
      'lib/stripe.js': `${client()}${CARD_CHECKOUT}`,
      '__tests__/stripe.test.js': `import Stripe from 'stripe';
export const fixture = (session) => session.total_details.amount_tax;
void Stripe;
`,
    },
  },
];

it.each(SAFETY.map((shape) => [shape.name, shape] as const))(
  'makes no AI request for %s and ships the rules-only draft',
  async (_name, shape) => {
    const { openai } = network();
    const { inputs, manifest, report } = await run(shape, true);
    console.log(shape.name, 'safety:', manifest.status, manifest.reason, gates(report));
    expect(openai()).toHaveLength(0);
    expect(report.validation).toMatchObject({ status: 'passed', aiCostUsd: 0 });
    expect(report.validation).not.toHaveProperty('coverageAi');
    expect(report.patch).toMatchObject({
      generator: 'deterministic',
      diff: (await rulesPatch(inputs)).diff,
    });
    expect(manifest.status).toBe('needs-review');
  },
);

it('stops an application pin the code contradicts at the scan, before any AI request (Small-Web-Co/tinypivot)', async () => {
  const { openai } = network();
  const { root, inputs } = await workspace({
    name: 'Small-Web-Co/tinypivot',
    files: {
      'lib/stripe.js': `${client()}${CARD_CHECKOUT}`,
      'api/webhook.js': `import Stripe from 'stripe';\nexport const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2025-02-24.acacia' });\n`,
    },
  });
  const { manifest } = await runWorkflow({
    ...inputs,
    output: join(root, 'run'),
    image: 'node:22-alpine',
    command: ['npm', 'test'],
    allowUnresolved: true,
    aiPatch: { apiKey: 'test-key', model: MODEL },
    repairAttempts: 1,
  });
  expect(manifest).toMatchObject({ status: 'needs-review', stage: 'scan' });
  expect(openai()).toHaveLength(0);
});

const webhookRead = (): Finding => ({
  file: 'app/api/webhook/route.ts',
  line: 12,
  column: 5,
  changeId: 'subscription.current_period_end',
  expression: '.current_period_end',
  confidence: 'confirmed',
  reason: 'A webhook payload read.',
  webhook: {
    schema: 'subscription',
    eventTypes: ['customer.subscription.updated'],
    origin: { file: 'app/api/webhook/route.ts', line: 8, column: 3 },
    apiVersion: 'unverified',
    migration: {
      rule: SUBSCRIPTION_PERIOD_RULE,
      priceId: 'price_pro',
      beforeApiVersion: BEFORE,
      afterApiVersion: AFTER,
    },
  },
});
const MATCHING = {
  before: BEFORE,
  after: AFTER,
  applicability: 'matches-before',
  reason: 'The configured API version matches the code.',
  source: { kind: 'literal', value: BEFORE },
} as unknown as Parameters<typeof aiSafetyStop>[0]['apiVersion'];

it('classifies safety stops apart from the coverage stops AI may build on', () => {
  const removed: Finding = {
    file: 'lib/stripe.js',
    line: 4,
    column: 3,
    changeId: 'request-parameter:PostCheckoutSessions.payment_method_types',
    expression: 'checkout.sessions.create argument[0].payment_method_types',
    confidence: 'confirmed',
    reason: 'Removed.',
    requestParameter: {
      parameter: 'payment_method_types',
    } as NonNullable<Finding['requestParameter']>,
  };
  expect(aiSafetyStop({ findings: [removed], apiVersion: MATCHING })).toBeUndefined();
  // The webhook endpoint's payload version policy is the owner's; AI never changes it.
  expect(
    aiSafetyStop({
      findings: [webhookRead(), removed],
      apiVersion: MATCHING,
    }),
  ).toBe(WEBHOOK_REVIEW_REASON);
  expect(
    aiSafetyStop({
      findings: [removed],
      apiVersion: { ...MATCHING, applicability: 'conflicts-with-code', reason: 'Conflict.' },
    }),
  ).toBe('Conflict.');
  expect(
    aiSafetyStop({ findings: [], skippedFiles: ['lib/broken.js'], apiVersion: MATCHING }),
  ).toMatch(/Unparseable source files/);
});

it('maps a line through edits above it and drops a line an edit changed', () => {
  const before = 'a\nb\nc\nd\n';
  const after = 'a\ninserted\nb\nC\nd\n';
  expect(movedLine(before, after, 1)).toBe(1);
  expect(movedLine(before, after, 2)).toBe(3);
  expect(movedLine(before, after, 3)).toBeUndefined();
  expect(movedLine(before, after, 4)).toBe(5);
  expect(movedLine(before, 'b\nc\nd\n', 1)).toBeUndefined();
  expect(movedLine(before, 'b\nc\nd\n', 4)).toBe(3);
});
