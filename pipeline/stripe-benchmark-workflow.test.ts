import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { REMOVED_REQUEST_PARAMETER_REVIEW_REASON } from './migration-review.ts';
import { runPipeline } from './run.ts';
import { workflowExitReason, workflowScanStop } from './stripe-benchmark.ts';
import { validateMigration } from './validation.ts';
import { runWorkflow } from './workflow.ts';

vi.mock('./validation.ts', () => ({ validateMigration: vi.fn() }));
const execute = promisify(execFile);
const LIMIT_MS = 20 * 60 * 1000;
const directories: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

// Shaped like Stripe's dahlia and endive Checkout Session create bodies.
function contract(version: string, fields: string[]) {
  return {
    openapi: '3.0.0',
    info: { version },
    paths: {
      '/v1/checkout/sessions': {
        post: {
          operationId: 'PostCheckoutSessions',
          requestBody: {
            content: {
              'application/x-www-form-urlencoded': {
                schema: {
                  type: 'object',
                  properties: Object.fromEntries(fields.map((name) => [name, {}])),
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: { 'checkout.session': { type: 'object', properties: { id: { type: 'string' } } } },
    },
  };
}

// A benchmark-shaped repository, contract pair and adapter, as the harness writes them.
async function benchmarkInputs(
  parameters: string,
  sameContract = false,
  pin = '2026-08-26.dahlia',
  // A second Checkout Session call's parameters.
  second?: string,
) {
  const root = await mkdtemp(join(tmpdir(), 'refit-benchmark-workflow-'));
  directories.push(root);
  const repository = join(root, 'repository');
  await mkdir(repository);
  await writeFile(
    join(repository, 'package.json'),
    JSON.stringify({ dependencies: { stripe: '22.6.2' } }),
  );
  await writeFile(
    join(repository, 'checkout.js'),
    `import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_KEY, { apiVersion: '${pin}' });
export const checkout = () => stripe.checkout.sessions.create({ mode: 'subscription'${parameters ? `, ${parameters}` : ''} });
${second ? `export const linked = () => stripe.checkout.sessions.create({ mode: 'payment', ${second} });\n` : ''}`,
  );
  const before = join(root, 'before.json');
  const after = join(root, 'after.json');
  const providerConfig = join(root, 'adapter.json');
  await writeFile(
    before,
    JSON.stringify(contract('2026-08-26.dahlia', ['mode', 'payment_method_types'])),
  );
  await writeFile(
    after,
    JSON.stringify(
      sameContract
        ? contract('2026-08-26.dahlia', ['mode', 'payment_method_types'])
        : contract('2026-09-30.endive', ['mode', 'allowed_payment_method_types']),
    ),
  );
  await writeFile(
    providerConfig,
    JSON.stringify({
      id: 'stripe-checkout',
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
      ],
    }),
  );
  return { root, repository, before, after, providerConfig, apiVersion: '2026-08-26.dahlia' };
}

it.each([
  ['a removed parameter with card and link', "payment_method_types: ['card', 'link']", {}, 'scan'],
  ['the reviewed card-only rename', "payment_method_types: ['card']", {}, 'validation'],
  [
    'a listed opt-in for card and link',
    "payment_method_types: ['card', 'link']",
    { keepListed: true },
    'validation',
  ],
  [
    '--publish-unresolved on a removed parameter',
    "payment_method_types: ['card', 'link']",
    { leave: true },
    'scan',
  ],
  [
    '--publish-unresolved on a card-only rename beside a removed parameter',
    "payment_method_types: ['card']",
    { leave: true, second: "payment_method_types: ['card', 'link']" },
    'validation',
  ],
  [
    '--publish-unresolved with AI on a removed parameter',
    "payment_method_types: ['card', 'link']",
    { leave: true, ai: true },
    'scan',
  ],
  [
    '--publish-unresolved on an application pin the code contradicts',
    "payment_method_types: ['card']",
    { leave: true, apiVersion: '2026-07-30.basil' },
    'scan',
  ],
  ['AI on a removed parameter', "payment_method_types: ['card', 'link']", { ai: true }, 'scan'],
  ['an application pin the code contradicts', '', { apiVersion: '2026-07-30.basil' }, 'scan'],
  ['an unchanged contract', "payment_method_types: ['card']", { sameContract: true }, 'scan'],
] as const)(
  'decides %s exactly as the workflow does, before it starts refit run',
  async (label, parameters, variant: Record<string, unknown>, stage) => {
    const fetcher = vi.fn(() => Promise.reject(new Error('No network in this test.')));
    vi.stubGlobal('fetch', fetcher);
    const { root, ...inputs } = await benchmarkInputs(
      parameters,
      Boolean(variant.sameContract),
      undefined,
      variant.second as string | undefined,
    );
    const ai = Boolean(variant.ai);
    const leave = Boolean(variant.leave);
    const scanInputs = {
      ...inputs,
      apiVersion: (variant.apiVersion as string | undefined) ?? inputs.apiVersion,
      ...(variant.keepListed ? { keepListedPaymentMethods: true } : {}),
    };
    const stop = await workflowScanStop(scanInputs, ai, leave);
    const { manifest } = await runWorkflow({
      ...scanInputs,
      output: join(root, 'run'),
      image: 'node:22-alpine',
      command: ['npm', 'test'],
      ...(variant.leave ? { allowUnresolved: true } : {}),
      ...(ai ? { aiPatch: { apiKey: 'unused', model: 'unused' } } : {}),
    });
    console.log(`${label}: harness stop ${JSON.stringify(stop)}; workflow`, {
      status: manifest.status,
      stage: manifest.stage,
      reason: manifest.reason,
    });
    expect(manifest.stage).toBe(stage);
    if (stage === 'scan') {
      expect(manifest).toMatchObject({ status: 'needs-review', reason: stop });
      expect(validateMigration).not.toHaveBeenCalled();
    } else {
      expect(stop).toBeUndefined();
      expect(validateMigration).toHaveBeenCalledOnce();
    }
    expect(fetcher).not.toHaveBeenCalled();
  },
);

it("writes the rules' patch around a call it leaves for review, without editing it (owner decision 1)", async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('No network in this test.'))),
  );
  const inputs = await benchmarkInputs(
    "payment_method_types: ['card']",
    false,
    undefined,
    "payment_method_types: ['card', 'link']",
  );
  expect((await runPipeline({ ...inputs, proposePatch: true })).patch).toMatchObject({
    status: 'not-generated',
    reason: REMOVED_REQUEST_PARAMETER_REVIEW_REASON,
  });
  const scan = await runPipeline({ ...inputs, proposePatch: true, leaveReviewedFindings: true });
  if (!('diff' in scan.patch)) throw new Error(`Expected a patch: ${JSON.stringify(scan.patch)}`);
  expect(scan.patch).toMatchObject({
    status: 'proposed',
    unresolvedFindings: 1,
    unresolvedSites: [{ file: 'checkout.js', line: 4 }],
  });
  expect(scan.patch.diff).toContain("allowed_payment_method_types: ['card'] }");
  // The patch renders whole files; the reviewed call's line comes out as it went in.
  expect(scan.patch.diff).toContain(
    "\n+export const linked = () => stripe.checkout.sessions.create({ mode: 'payment', payment_method_types: ['card', 'link'] });\n",
  );
  expect(scan.warnings).toContain(REMOVED_REQUEST_PARAMETER_REVIEW_REASON);
});

it('leaves code already on the target to refit run, which reports it up to date', async () => {
  const { root, ...inputs } = await benchmarkInputs('', false, '2026-09-30.endive');
  expect(await workflowScanStop(inputs, false, false)).toBeUndefined();
  const { manifest } = await runWorkflow({
    ...inputs,
    output: join(root, 'run'),
    image: 'node:22-alpine',
    command: ['npm', 'test'],
  });
  expect(manifest).toMatchObject({ status: 'up-to-date', stage: 'scan' });
  expect(validateMigration).not.toHaveBeenCalled();
});

it('leaves a scan that fails to refit run', async () => {
  const { root, ...inputs } = await benchmarkInputs("payment_method_types: ['card']");
  expect(
    await workflowScanStop({ ...inputs, before: join(root, 'missing.json') }, false, false),
  ).toBeUndefined();
});

async function failure(script: string, options: { timeout?: number; maxBuffer?: number } = {}) {
  return execute(process.execPath, ['-e', script], options).then(
    () => {
      throw new Error('Expected the child to fail.');
    },
    (error: unknown) => error,
  );
}

it.each([
  [
    'the harness time limit',
    'setInterval(() => {}, 1000)',
    { timeout: 200 },
    'refit run was stopped with SIGTERM at the 20-minute limit.',
  ],
  [
    'a signal such as the kernel OOM killer',
    "process.kill(process.pid, 'SIGKILL')",
    {},
    'refit run was killed by SIGKILL.',
  ],
  [
    'a V8 heap crash',
    "console.error('<--- Last few GCs --->'); console.error('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'); process.exit(134)",
    {},
    'refit run exited with code 134: FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
  ],
  ['an exit without output', 'process.exit(3)', {}, 'refit run exited with code 3.'],
  [
    'output past the buffer',
    "process.stdout.write('x'.repeat(100))",
    { maxBuffer: 10 },
    'refit run failed: stdout maxBuffer length exceeded',
  ],
] as const)('says the manifest is missing because of %s', async (label, script, options, text) => {
  const error = (await failure(script, options)) as { code?: unknown; signal?: unknown };
  console.log(`${label}: code ${String(error.code)}, signal ${String(error.signal)}`);
  expect(workflowExitReason(error, LIMIT_MS)).toBe(text);
});
