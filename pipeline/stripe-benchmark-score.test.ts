import { expect, it } from 'vitest';
import { repositoryOutcome } from './stripe-benchmark-score.ts';

const read = {
  file: 'webhook.ts',
  line: 3,
  property: 'current_period_end',
  label: 'breaking' as const,
};
const request = {
  file: 'checkout.ts',
  line: 9,
  property: 'payment_method_types',
  label: 'breaking' as const,
};
const broken = {
  repo: 'a/b',
  verdict: 'broken' as const,
  reason: '',
  reads: [read],
  requests: [request],
};
const diff = (checkout: string) => `diff --git "a/webhook.ts" "b/webhook.ts"
--- "a/webhook.ts"
+++ "b/webhook.ts"
-  end: subscription.current_period_end,
+  end: periodEnd(subscription),
diff --git "a/checkout.ts" "b/checkout.ts"
--- "a/checkout.ts"
+++ "b/checkout.ts"
-    payment_method_types: ['card'],
+${checkout}
`;
const validated = { status: 'validated', patch: 'proposed' };

it('counts a validated fix as correct only when it changes every breaking line', () => {
  expect(
    repositoryOutcome(broken, [], validated, diff("    allowed_payment_method_types: ['card'],")),
  ).toEqual({ outcome: 'correct', reason: 'validated fix' });
  // Re-adding the same line is a context change, not a fix.
  expect(
    repositoryOutcome(broken, [], validated, diff("    payment_method_types: ['card'],")),
  ).toEqual({
    outcome: 'incorrect',
    reason: 'validated fix leaves checkout.ts:9 payment_method_types unchanged',
  });
});

it('counts a stop as a correct review only when its findings name every break', () => {
  const stop = { status: 'needs-review', patch: 'proposed' };
  const finding = (value: { file: string; line: number; property: string }) => ({
    ...value,
    confidence: 'review' as const,
  });
  expect(repositoryOutcome(broken, [finding(read), finding(request)], stop)).toEqual({
    outcome: 'correct-review',
    reason: '[Needs review] patch naming every break',
  });
  expect(repositoryOutcome(broken, [finding(read)], undefined).outcome).toBe('incorrect');
  expect(
    repositoryOutcome(broken, [finding(read), finding(request)], {
      status: 'error',
      error: 'sandbox',
    }),
  ).toEqual({ outcome: 'incorrect', reason: 'workflow error: sandbox' });
});

it('counts no change on an unaffected repository as correct', () => {
  const unaffected = { ...broken, verdict: 'unaffected' as const, reads: [], requests: [] };
  expect(repositoryOutcome(unaffected, [], undefined).outcome).toBe('correct');
  expect(repositoryOutcome(unaffected, [], validated).outcome).toBe('incorrect');
});
