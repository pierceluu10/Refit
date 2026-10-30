import { afterEach, expect, it } from 'vitest';
import { compareBehaviourRuns } from './behaviour-tests.ts';
import type { SandboxRequest } from './provider-sandbox.ts';
import { STRIPE_TEST_MODE, stripeTestMode } from './stripe-test-mode.ts';

const saved = process.env.STRIPE_TEST_KEY;
afterEach(() => {
  if (saved === undefined) delete process.env.STRIPE_TEST_KEY;
  else process.env.STRIPE_TEST_KEY = saved;
});

it('accepts only restricted or secret test keys from STRIPE_TEST_KEY', () => {
  process.env.STRIPE_TEST_KEY = 'rk_test_abcdefgh12345678';
  expect(stripeTestMode(true, true)?.keys).toEqual(['rk_test_abcdefgh12345678']);
  expect(stripeTestMode(false, true)).toBeUndefined();
  expect(() => stripeTestMode(true, false)).toThrow('needs --write-behaviour-tests');
  for (const value of [
    'sk_live_abcdefgh12345678',
    'rk_live_abcdefgh12345678',
    'pk_test_abcdefgh12345678',
  ]) {
    process.env.STRIPE_TEST_KEY = value;
    expect(() => stripeTestMode(true, true)).toThrow('a live or malformed key is refused');
  }
  delete process.env.STRIPE_TEST_KEY;
  expect(() => stripeTestMode(true, true)).toThrow('needs STRIPE_TEST_KEY');
});

it('tags only create operations whose form body takes metadata', () => {
  const form = (properties: object) => ({
    post: {
      requestBody: { content: { 'application/x-www-form-urlencoded': { schema: { properties } } } },
    },
  });
  expect(
    STRIPE_TEST_MODE.taggable({
      paths: {
        '/v1/customers': form({ metadata: {}, email: {} }),
        '/v1/customers/{customer}': form({ metadata: {} }),
        '/v1/billing_portal/sessions': form({ customer: {} }),
        '/v1/checkout/sessions': form({ metadata: {} }),
      },
    }),
  ).toEqual(['^POST \\/v1\\/customers$', '^POST \\/v1\\/checkout\\/sessions$']);
});

it("finds the account's own objects the code names, and Stripe's test objects pass", () => {
  expect(
    STRIPE_TEST_MODE.standIns([
      {
        path: 'lib/billing.ts',
        content:
          "price: 'price_1NabcDEF', customer: \"cus_QwErTy12\", pm: 'pm_card_visa', sub: 'sub_1AbCdEfG', acct: `acct_1XyZaBcD`, t: 'tok_visa'",
      },
    ]),
  ).toEqual({
    wanted: [
      { id: 'price_1NabcDEF', kind: 'price' },
      { id: 'cus_QwErTy12', kind: 'cus' },
    ],
    unreproducible: ['sub_1AbCdEfG (lib/billing.ts)', 'acct_1XyZaBcD (lib/billing.ts)'],
  });
});

it('creates a recurring stand-in price where the code subscribes, tagged, with its product', async () => {
  const calls: unknown[] = [];
  const created = await STRIPE_TEST_MODE.createStandIn(
    { id: 'price_1NabcDEF', kind: 'price' },
    async (call) => {
      calls.push(call);
      return { id: call.path === '/v1/products' ? 'prod_new' : 'price_new', object: 'x' };
    },
    [{ content: "mode: 'subscription'" }],
  );
  expect(created).toEqual({ id: 'price_new', assumption: 'a monthly USD 10.00 recurring price' });
  expect(calls).toEqual([
    {
      method: 'POST',
      path: '/v1/products',
      form: { name: 'Refit stand-in for price_1NabcDEF' },
      tag: true,
    },
    {
      method: 'POST',
      path: '/v1/prices',
      form: {
        currency: 'usd',
        unit_amount: '1000',
        product: 'prod_new',
        'recurring[interval]': 'month',
      },
      tag: true,
    },
  ]);
});

it('removes, expires or deactivates what a run creates, and names operations without IDs', () => {
  expect(STRIPE_TEST_MODE.cleanup({ id: 'cus_1', object: 'customer' })).toEqual({
    method: 'DELETE',
    path: '/v1/customers/cus_1',
  });
  expect(STRIPE_TEST_MODE.cleanup({ id: 'price_1', object: 'price' })).toEqual({
    method: 'POST',
    path: '/v1/prices/price_1',
    form: { active: 'false' },
  });
  expect(STRIPE_TEST_MODE.cleanup({ id: 'cs_test_1', object: 'checkout.session' })).toEqual({
    method: 'POST',
    path: '/v1/checkout/sessions/cs_test_1/expire',
  });
  expect(STRIPE_TEST_MODE.cleanup({ id: 'x', object: 'file' })).toBeUndefined();
  expect(STRIPE_TEST_MODE.operation('POST', '/v1/subscriptions/sub_1AbC2/items')).toBe(
    'POST /v1/subscriptions/{id}/items',
  );
  expect(STRIPE_TEST_MODE.operation('POST', '/v1/checkout/sessions')).toBe(
    'POST /v1/checkout/sessions',
  );
});

// One test that passed on both sides, with every changed line run, and the given Stripe records.
function compared(requests: { original: SandboxRequest[]; patched: SandboxRequest[] }) {
  const output = [
    `REFIT_BEHAVIOUR_TEST=${JSON.stringify({ file: 'refit-behaviour/a.test.mjs', id: 'a', ok: true })}`,
    'REFIT_BEHAVIOUR_EXIT=0',
    `REFIT_BEHAVIOUR_COVERAGE=${JSON.stringify({ 'refit-behaviour/a.test.mjs': { 'a.js': [[[0, 8, 1]]] } })}`,
    'REFIT_BEHAVIOUR_DONE',
  ].join('\n');
  const file = { path: 'a.js', content: 'run(1);\n' };
  return compareBehaviourRuns({
    tests: [{ path: 'refit-behaviour/a.test.mjs', content: '' }],
    changed: { original: { 'a.js': [1] }, patched: { 'a.js': [1] } },
    sources: {
      original: { root: '/r', files: [file] },
      patched: { root: '/r', files: [file] },
    } as never,
    original: { status: 'passed', exitCode: 0, stdout: output, stderr: '' },
    patched: { status: 'passed', exitCode: 0, stdout: output, stderr: '' },
    target: 'test-environment',
    sandbox: {
      adapter: STRIPE_TEST_MODE,
      runId: 'refit-run',
      versions: { original: '2025-03-31.basil', patched: '2026-09-30.endive' },
      requests,
      standIns: [],
      unreproducible: [],
    },
  });
}
const sent = (
  status: number,
  version: string,
  extra: Partial<SandboxRequest> = {},
): SandboxRequest => ({
  method: 'POST',
  path: '/v1/checkout/sessions',
  host: 'api.stripe.com',
  status,
  version,
  ...extra,
});

it('gives grade A only when Stripe returned no new error on the patched side', () => {
  expect(
    compared({
      original: [sent(200, '2025-03-31.basil')],
      patched: [sent(200, '2026-09-30.endive')],
    }),
  ).toMatchObject({ status: 'passed', grade: 'A', missing: [] });
  const failed = compared({
    original: [sent(200, '2025-03-31.basil')],
    patched: [sent(400, '2026-09-30.endive')],
  });
  expect(failed).toMatchObject({ status: 'passed', grade: null });
  expect(failed.missing).toEqual([
    'Stripe returned POST /v1/checkout/sessions 400 on the patched side only.',
  ]);
  // The wrong version on a side keeps it below A too.
  expect(
    compared({
      original: [sent(200, '2025-03-31.basil')],
      patched: [sent(200, '2025-03-31.basil')],
    }).missing,
  ).toEqual(['The patched side sent 2025-03-31.basil instead of 2026-09-30.endive.']);
});

it('reports a rate-limited side as unavailable, never as a regression', () => {
  expect(
    compared({
      original: [sent(200, '2025-03-31.basil')],
      patched: [sent(429, '2026-09-30.endive', { rateLimited: true })],
    }),
  ).toMatchObject({
    status: 'unavailable',
    grade: null,
    regressions: [],
    reason:
      'Stripe was unavailable on the patched code against Stripe test mode at the after version: 1 request(s) stayed rate-limited after every retry.',
  });
});
