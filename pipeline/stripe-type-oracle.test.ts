import { expect, it, vi } from 'vitest';
import { TYPE_CHECK, TYPE_CHECK_STARTED, TESTS_FAILED } from './check-selection.ts';
import type { BreakingOperationImpact } from './provider-operations.ts';
import { typeOraclePasses, typeOracleReach } from './stripe-type-evidence.ts';
import { typeErrors } from './type-errors.ts';
import { runTypeOracle } from './validation.ts';

// Diagnostics as `tsc --noEmit --pretty false` prints them against stripe-node 23 types.
const SESSION_ERROR =
  "app/checkout.ts(5,3): error TS2353: Object literal may only specify known properties, and 'payment_method_types' does not exist in type 'SessionCreateParams'.";
const PERIOD_ERROR =
  "lib/billing.ts(4,23): error TS2339: Property 'current_period_end' does not exist on type 'Subscription'.";
const VERSION_ERROR =
  'app/checkout.ts(2,50): error TS2322: Type \'"2024-06-20"\' is not assignable to type \'"2026-09-30.endive"\'.';

const CHECKOUT = `import Stripe from 'stripe';
const stripe = new Stripe('sk_test_placeholder', { apiVersion: '2024-06-20' });
export const go = () => stripe.checkout.sessions.create({
  mode: 'payment',
  payment_method_types: ['card'],
});
export const other = { payment_method_types: ['card'] };
`;
const BILLING = `import Stripe from 'stripe';
const stripe = new Stripe('sk_test_placeholder');
export async function ends(subscription: Stripe.Subscription) {
  return new Date(subscription.current_period_end * 1000);
}
`;
const FILES = [
  { path: 'app/checkout.ts', content: CHECKOUT },
  { path: 'lib/billing.ts', content: BILLING },
];
const BEFORE = {
  paths: {
    '/v1/subscriptions/{subscription_exposed_id}': {
      get: {
        responses: {
          200: {
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/subscription' } },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      subscription: { type: 'object', properties: { current_period_end: { type: 'integer' } } },
    },
  },
};

const requestChange = (reach = 'unknown') => ({
  id: 'request-property-removed',
  level: 3,
  text: 'removed the request property `payment_method_types`',
  operation: 'POST',
  path: '/v1/checkout/sessions',
  reach,
  reachReason: 'The untraced call `x.checkout.sessions.create` may request it.',
});
const responseChange = () => ({
  id: 'response-required-property-removed',
  level: 3,
  text: 'removed the required property `current_period_end` from the response with the `200` status',
  operation: 'GET',
  path: '/v1/subscriptions/{subscription_exposed_id}',
  reach: 'unknown',
  reachReason: 'lib/billing.ts:4 reads `current_period_end` on an object Refit cannot trace.',
});
const impacts = (change: {
  id: string;
  text: string;
  level: number;
}): BreakingOperationImpact[] => [
  {
    operationId: 'PostCheckoutSessions',
    path: '/v1/checkout/sessions',
    httpMethod: 'POST',
    text: change.text,
    changes: [{ id: change.id, level: change.level, text: change.text }],
    usages: [{ file: 'app/checkout.ts', line: 3, column: 25, method: 'checkout.sessions.create' }],
  },
];
const parsed = (...lines: string[]) =>
  typeErrors({ stdout: lines.join('\n'), stderr: '' }).map(({ key, ...error }) => error);
const context = (change: { id: string; text: string; level: number }) => ({
  files: FILES,
  impacts: impacts(change),
  before: BEFORE,
  sdk: '23.0.0',
});

it('moves an unknown request change to reached where the target SDK rejects its property in a traced call', () => {
  const change = requestChange();
  const shared = context(change);
  const reached = typeOracleReach([change], parsed(SESSION_ERROR, VERSION_ERROR), shared);
  expect(reached).toEqual([
    {
      changeId: 'request-property-removed',
      operation: 'POST',
      path: '/v1/checkout/sessions',
      file: 'app/checkout.ts',
      line: 5,
      code: 'TS2353',
    },
  ]);
  expect(change.reach).toBe('reached');
  expect(change.reachReason).toBe(
    "With stripe-node 23.0.0 installed, tsc reports TS2353 at app/checkout.ts:5 on the unpatched code: Object literal may only specify known properties, and 'payment_method_types' does not exist in type 'SessionCreateParams'.",
  );
  expect(shared.impacts[0].changes[0].reachReason).toBe(change.reachReason);
});

it('leaves a request change alone when the error is outside every traced call or names another property', () => {
  // The same property in an object no traced call receives (line 7).
  const outside = requestChange();
  expect(
    typeOracleReach([outside], parsed(SESSION_ERROR.replace('(5,3)', '(7,24)')), context(outside)),
  ).toEqual([]);
  expect(outside.reach).toBe('unknown');
  // Inside the traced call, but on `mode`, with a message that does not quote the property.
  const other = requestChange();
  expect(
    typeOracleReach(
      [other],
      parsed(
        "app/checkout.ts(4,3): error TS2322: Type '\"payment\"' is not assignable to type 'Mode'.",
      ),
      context(other),
    ),
  ).toEqual([]);
  expect(other.reach).toBe('unknown');
  // The constructor's apiVersion error is not inside a traced call of the operation.
  const version = requestChange();
  expect(typeOracleReach([version], parsed(VERSION_ERROR), context(version))).toEqual([]);
});

it('never moves a reach tracing decided, and never toward a passing reach', () => {
  for (const reach of ['unused', 'compatible', 'handled', 'reached']) {
    const change = requestChange(reach);
    const reason = change.reachReason;
    expect(typeOracleReach([change], parsed(SESSION_ERROR), context(change))).toEqual([]);
    expect(change).toMatchObject({ reach, reachReason: reason });
  }
  // Zero introduced errors is no evidence of absence: unknown stays unknown.
  const change = requestChange();
  expect(typeOracleReach([change], [], context(change))).toEqual([]);
  expect(change.reach).toBe('unknown');
});

it('moves an unknown response change to reached where the target SDK drops the property from its Stripe type', () => {
  const change = responseChange();
  expect(typeOracleReach([change], parsed(PERIOD_ERROR), context(change))).toMatchObject([
    { changeId: 'response-required-property-removed', file: 'lib/billing.ts', line: 4 },
  ]);
  expect(change.reach).toBe('reached');
  // The same property missing on a type that is not the change's Stripe object.
  const local = responseChange();
  expect(
    typeOracleReach(
      [local],
      parsed(PERIOD_ERROR.replace("type 'Subscription'", "type 'Plan'")),
      context(local),
    ),
  ).toEqual([]);
  expect(local.reach).toBe('unknown');
  // Errors in test files are not production reads.
  const test = responseChange();
  expect(
    typeOracleReach(
      [test],
      parsed(PERIOD_ERROR.replace('lib/billing.ts', 'lib/billing.test.ts')),
      context(test),
    ),
  ).toEqual([]);
});

const run = (stdout: string, exitCode = stdout.includes('error TS') ? 2 : 0) => ({
  status: exitCode === 0 ? ('passed' as const) : ('failed' as const),
  exitCode,
  stdout,
  stderr: '',
});
const BASELINE_ERROR =
  "lib/legacy.ts(1,7): error TS2322: Type 'number' is not assignable to type 'string'.";
const oracleInput = (overrides: Partial<Parameters<typeof runTypeOracle>[0]> = {}) => {
  const change = requestChange();
  return {
    change,
    input: {
      compareTypeErrors: true,
      command: TYPE_CHECK,
      upgrade: { from: '16.12.0', to: '23.0.0' },
      packages: 'diff --git a/package.json b/package.json\n',
      dependencies: '/tmp/candidate-dependencies.tar',
      baseline: run(BASELINE_ERROR),
      patched: run(BASELINE_ERROR),
      report: {
        specificationDiff: { engine: 'oasdiff', changes: [change] },
        operationImpacts: impacts(change),
      } as unknown as Parameters<typeof runTypeOracle>[0]['report'],
      before: BEFORE,
      files: FILES,
      check: vi.fn(async () => run(`${BASELINE_ERROR}\n${SESSION_ERROR}\n${VERSION_ERROR}`)),
      ...overrides,
    },
  };
};

it('type-checks the original code with only the patch package files and the target SDK', async () => {
  const { change, input } = oracleInput();
  const oracle = await runTypeOracle(input);
  expect(input.check).toHaveBeenCalledWith(input.packages, TYPE_CHECK, input.dependencies);
  expect(oracle).toMatchObject({
    sdk: { from: '16.12.0', to: '23.0.0' },
    unpatched: {
      status: 'compared',
      introduced: [
        { file: 'app/checkout.ts', line: 5, code: 'TS2353' },
        { file: 'app/checkout.ts', line: 2, code: 'TS2322' },
      ],
    },
    patched: { status: 'compared', introduced: [] },
    reached: [{ changeId: 'request-property-removed', line: 5 }],
  });
  expect(change.reach).toBe('reached');
  expect(typeOraclePasses(oracle)).toBe(true);
});

it('fails the D2 type gate on any error the patched code adds, once per position', async () => {
  const { input } = oracleInput({
    // compareTypeCheck prefixes a failed check with the errors it introduced.
    patched: run(
      `Type errors this patch introduced:\n${SESSION_ERROR}\n\n${BASELINE_ERROR}\n${SESSION_ERROR}`,
    ),
  });
  const oracle = await runTypeOracle(input);
  expect(oracle?.patched).toEqual({
    status: 'compared',
    introduced: [
      {
        file: 'app/checkout.ts',
        line: 5,
        column: 3,
        code: 'TS2353',
        message:
          "Object literal may only specify known properties, and 'payment_method_types' does not exist in type 'SessionCreateParams'.",
      },
    ],
  });
  expect(typeOraclePasses(oracle)).toBe(false);
  expect(typeOraclePasses(undefined)).toBe(false);
});

it('runs only the type check part of a tests-then-type-check chain and prefixes a nested package', async () => {
  const chain = [
    'sh',
    '-c',
    `npm test || { echo '${TESTS_FAILED}'; false; }; echo '${TYPE_CHECK_STARTED}'; npx --no-install tsc --noEmit --pretty false -p .`,
  ];
  const { input } = oracleInput({
    command: chain,
    packageDirectory: 'web',
    baseline: run(`tests ok\n${TYPE_CHECK_STARTED}\n`),
    patched: run(`tests ok\n${TYPE_CHECK_STARTED}\n`),
    check: vi.fn(async () => run(PERIOD_ERROR)),
  });
  const oracle = await runTypeOracle(input);
  expect(input.check).toHaveBeenCalledWith(
    input.packages,
    ['sh', '-c', 'npx --no-install tsc --noEmit --pretty false -p .', 'refit-check'],
    input.dependencies,
  );
  expect(oracle?.unpatched).toMatchObject({
    status: 'compared',
    introduced: [{ file: 'web/lib/billing.ts', line: 4 }],
  });
});

it('records why the oracle could not compare, and is absent without a target SDK of its own', async () => {
  expect(await runTypeOracle(oracleInput({ upgrade: undefined }).input)).toBeUndefined();
  expect(await runTypeOracle(oracleInput({ dependencies: undefined }).input)).toBeUndefined();
  expect(await runTypeOracle(oracleInput({ compareTypeErrors: false }).input)).toBeUndefined();

  const testsOnly = oracleInput({ command: ['npm', 'test'] });
  expect(await runTypeOracle(testsOnly.input)).toMatchObject({
    unpatched: { status: 'unavailable', reason: 'the check has no type check of its own' },
  });
  expect(testsOnly.input.check).not.toHaveBeenCalled();

  const crashed = oracleInput({ check: vi.fn(async () => run('Killed', 137)) });
  expect(await runTypeOracle(crashed.input)).toMatchObject({
    unpatched: {
      status: 'unavailable',
      reason: 'the type check did not finish on the original code with the target stripe-node',
    },
    reached: [],
  });
  expect(crashed.change.reach).toBe('unknown');

  const unapplied = oracleInput({
    check: vi.fn(async () => {
      throw new Error('git apply --check failed');
    }),
  });
  expect(await runTypeOracle(unapplied.input)).toMatchObject({
    unpatched: {
      status: 'unavailable',
      reason:
        'the type check did not finish on the original code with the target stripe-node: git apply --check failed',
    },
    patched: { status: 'compared' },
  });

  const unavailable = oracleInput({
    typeCheckUnavailable: "error TS5083: Cannot read file 'base.json'.",
  });
  const oracle = await runTypeOracle(unavailable.input);
  expect(oracle?.patched).toEqual({
    status: 'unavailable',
    reason: "the type check is unavailable: error TS5083: Cannot read file 'base.json'.",
  });
  expect(unavailable.input.check).not.toHaveBeenCalled();
  expect(typeOraclePasses(oracle)).toBe(false);
});
