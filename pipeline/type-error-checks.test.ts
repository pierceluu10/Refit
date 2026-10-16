import { expect, it } from 'vitest';
import { compareTypeCheck, reviewTypeError, typeErrors, type CheckResult } from './validation.ts';

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
