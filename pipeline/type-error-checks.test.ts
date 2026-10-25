import { expect, it } from 'vitest';
import { TESTS_FAILED, TYPE_CHECK_STARTED } from './check-selection.ts';
import {
  compareTypeCheck,
  rejectedProperties,
  reviewTypeError,
  subscriptionPeriodRead,
  typeErrors,
  type CheckResult,
} from './validation.ts';

const run = (exitCode: number, stdout: string): CheckResult => ({
  status: exitCode === 0 ? 'passed' : 'failed',
  exitCode,
  stdout,
  stderr: '',
});
const existing = "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.";
const added =
  "src/b.ts(10,5): error TS2353: Object literal may only specify known properties, and 'trial_from_plan' does not exist in type 'SubscriptionData'.";

it('parses TypeScript diagnostics with their position', () => {
  expect(typeErrors(run(2, `${existing}\n`))).toEqual([
    {
      file: 'src/a.ts',
      line: 3,
      column: 7,
      code: 'TS2322',
      message: "Type 'string' is not assignable to type 'number'.",
      key: "src/a.ts TS2322 Type 'string' is not assignable to type 'number'.",
    },
  ]);
});

it('treats a baseline that already has type errors as a completed check', () => {
  expect(compareTypeCheck(run(2, existing)).status).toBe('passed');
  expect(compareTypeCheck(run(1, 'Cannot find module typescript')).status).toBe('failed');
});

it('fails the patched check only on errors the patch introduced, listing them first', () => {
  const baseline = run(2, existing);
  expect(compareTypeCheck(baseline, run(2, existing.replace('(3,7)', '(4,7)'))).status).toBe(
    'passed',
  );
  const patched = compareTypeCheck(baseline, run(2, `${existing}\n${added}`));
  expect(patched.status).toBe('failed');
  expect(patched.stdout.split('\n').slice(0, 2)).toEqual([
    'Type errors this patch introduced:',
    added,
  ]);
  expect(compareTypeCheck(baseline, run(0, '')).status).toBe('passed');
});

it('compares only the type check of a tests-then-type-check chain, and fails failing tests', () => {
  // ts-node prints compile errors in tsc's format; they belong to the tests, not the type check.
  const testOutput = `src/test-helper.ts(1,1): error TS2307: Cannot find module 'vitest'.\n`;
  const baseline = run(2, `${testOutput}${TYPE_CHECK_STARTED}\n${existing}\n`);
  expect(typeErrors(baseline).map((error) => error.file)).toEqual(['src/a.ts']);
  expect(compareTypeCheck(baseline).status).toBe('passed');
  expect(compareTypeCheck(baseline, run(2, `${TYPE_CHECK_STARTED}\n${existing}`)).status).toBe(
    'passed',
  );
  const patched = compareTypeCheck(
    baseline,
    run(2, `${TYPE_CHECK_STARTED}\n${existing}\n${added}`),
  );
  expect(patched.status).toBe('failed');
  expect(patched.stdout.split('\n')[1]).toBe(added);
  // Tests that fail never pass as a type check, whatever type errors they printed.
  expect(compareTypeCheck(run(1, `${testOutput}${TESTS_FAILED}\n`)).status).toBe('failed');
});

it('leaves rejected literal comparisons and their never narrowing for review, not repair', () => {
  const errors = typeErrors(
    run(
      2,
      [
        `app/webhooks.ts(54,14): error TS2678: Type '"customer.subscription-created"' is not comparable to type '"product.created" | "customer.subscription.created"'.`,
        `app/webhooks.ts(57,38): error TS2339: Property 'data' does not exist on type 'never'.`,
        `app/webhooks.ts(60,9): error TS2367: This comparison appears to be unintentional because the types '"customer.subscription-created"' and '"product.created"' have no overlap.`,
        added,
      ].join('\n'),
    ),
  );
  expect(errors.map(reviewTypeError)).toEqual([true, true, true, false]);
});

it('names object-literal properties the upgraded types reject, from either tsc line', () => {
  const nested = [
    "app/route.ts(37,9): error TS2322: Type '{ trial_from_plan: true; metadata: any; }' is not assignable to type 'SubscriptionData'.",
    "  Object literal may only specify known properties, and 'trial_from_plan' does not exist in type 'SubscriptionData'.",
  ].join('\n');
  const baseline = run(2, existing);
  expect(rejectedProperties(baseline, compareTypeCheck(baseline, run(2, nested)))).toEqual([
    'trial_from_plan',
  ]);
  expect(rejectedProperties(baseline, compareTypeCheck(baseline, run(2, added)))).toEqual([
    'trial_from_plan',
  ]);
  // tsc says "but" when it suggests a near name, as for a renamed property.
  const renamed =
    "  Object literal may only specify known properties, but 'trial_end_at' does not exist in type 'SubscriptionData'. Did you mean to write 'trial_end'?";
  expect(rejectedProperties(baseline, run(2, renamed))).toEqual(['trial_end_at']);
  // A rejection the original code already had is not the upgrade's, and other errors name none.
  const typo =
    "  Object literal may only specify known properties, but 'forignTable' does not exist in type '{ foreignTable?: string; }'. Did you mean to write 'foreignTable'?";
  expect(rejectedProperties(run(2, typo), run(2, `${typo}\n${existing}`))).toEqual([]);
});

it('recognizes billing-period reads the upgraded Subscription type no longer has', () => {
  const errors = typeErrors(
    run(
      2,
      [
        // iggy-tech/product-hunt-clone-final, reading `subscriptions.list().data[0]`.
        "lib/stripe.ts(113,51): error TS2339: Property 'current_period_end' does not exist on type 'Subscription'.",
        "lib/billing.ts(20,30): error TS2339: Property 'current_period_start' does not exist on type 'Response<Subscription>'.",
        "lib/billing.ts(21,30): error TS2339: Property 'current_period_end' does not exist on type 'Stripe.Subscription | null'.",
        "lib/items.ts(8,12): error TS2339: Property 'current_period_end' does not exist on type 'SubscriptionSchedule'.",
        "lib/items.ts(9,12): error TS2339: Property 'cancel_at' does not exist on type 'Subscription'.",
        existing,
      ].join('\n'),
    ),
  );
  expect(errors.map(subscriptionPeriodRead)).toEqual([true, true, true, false, false, false]);
});
