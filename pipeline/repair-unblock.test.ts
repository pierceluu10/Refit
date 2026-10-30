import { expect, it } from 'vitest';
import { rewrittenRuleLines } from './ai-patch-policies.ts';
import { repeatedProposalReason, typeCheckedFindings } from './repair-context.ts';
import type { Repository } from './types.ts';

// Founder decisions (Otabek, 2026-10-28): what lets AI repair a patch that breaks the build.

const STRIPE_TYPES = [
  {
    path: 'types/Discounts.d.ts',
    content:
      'declare module "stripe" {\n  namespace Stripe {\n    interface Discount {\n      id: string;\n      source: Discount.Source;\n    }\n  }\n}\n',
  },
  {
    path: 'types/lib.d.ts',
    content:
      "declare module 'stripe' {\n  namespace Stripe {\n    type LatestApiVersion = '2023-10-16';\n  }\n}\n",
  },
];

const error = (file: string, line: number, code: string, message: string) => ({
  file,
  line,
  column: 1,
  code,
  message,
});

it('treats a declared-type read as Stripe usage where an introduced error names a stripe-node type', () => {
  // zainulabedeen123/Best-Saas-Kit--V2: stripe 23 moved Discount.coupon under source.
  const route = 'src/app/api/stripe/webhook/route.ts';
  const read = { file: route, line: 110, confidence: 'review', declaredType: {} };
  const unrelated = { file: route, line: 40, confidence: 'review', declaredType: {} };
  const traced = { file: route, line: 110, confidence: 'confirmed', declaredType: {} };
  const errors = [
    error(route, 112, 'TS2339', "Property 'coupon' does not exist on type 'Discount'."),
    error(route, 40, 'TS2339', "Property 'coupon' does not exist on type 'LocalDiscount'."),
  ];
  // Rules added two lines above the read, so line 110 is 112 in the checked candidate.
  const moved = (finding: { line: number }) => finding.line + 2;
  expect(typeCheckedFindings([read, unrelated, traced], errors, STRIPE_TYPES, moved)).toEqual([
    read,
  ]);
  // Without stripe-node's types nothing is evidence, and a read the patch deleted has no line.
  expect(typeCheckedFindings([read], errors, [], moved)).toEqual([]);
  expect(typeCheckedFindings([read], errors, STRIPE_TYPES, () => undefined)).toEqual([]);
});

const repository = (path: string, content: string): Repository => ({
  root: '/repository',
  files: [{ path, content }],
  dependencies: [],
  lockfiles: [],
  warnings: [],
});

it('lets the AI adjust a rule line while what the rule introduced stays', () => {
  // LouisMbc/twitter-like: the helper call the rule wrote does not type-check with `as unknown`.
  const path = 'src/app/api/stripe/webhook/route.ts';
  const original =
    "const end = (sub as unknown).current_period_end;\nconst version = '2024-06-20';\n";
  const rules =
    "const end = getSubscriptionPeriodEnd(sub as unknown);\nconst version = '2026-09-30.endive';\n";
  const files = (after: string) =>
    [
      repository(path, original),
      repository(path, rules),
      repository(path, after),
      new Set([path]),
    ] as const;
  const fixed = rules.replace('sub as unknown', 'sub');
  expect(rewrittenRuleLines(...files(fixed))).toEqual([]);
  // Putting the removed read back, or the old version, drops what the rule introduced.
  const reverted = rules.replace(
    'getSubscriptionPeriodEnd(sub as unknown)',
    'sub.current_period_end',
  );
  expect(rewrittenRuleLines(...files(reverted))).toEqual([{ file: path, line: 1 }]);
  const unpinned = rules.replace("'2026-09-30.endive'", "'2024-06-20'");
  expect(rewrittenRuleLines(...files(unpinned))).toEqual([{ file: path, line: 2 }]);
});

it('names the likely reason a repair returned the same patch', () => {
  const stripeFiles = new Set(['src/lib/stripe.ts']);
  const base = { stripeFiles, stripeTypes: STRIPE_TYPES };
  // Panda2Chan/ai-asmr: the pin moved but the stripe-node upgrade was skipped.
  const pin = error(
    'src/lib/stripe.ts',
    6,
    'TS2322',
    `Type '"2026-09-30.endive"' is not assignable to type '"2023-10-16"'.`,
  );
  expect(repeatedProposalReason({ ...base, errors: [pin], sdkUpgraded: false })).toMatchObject({
    kind: 'sdk-not-upgraded',
    text: expect.stringContaining('src/lib/stripe.ts:6 TS2322'),
  });
  const outside = error('src/ui/Chart.tsx', 3, 'TS2304', "Cannot find name 'Foo'.");
  expect(repeatedProposalReason({ ...base, errors: [outside], sdkUpgraded: true }).kind).toBe(
    'outside-stripe-code',
  );
  const discount = error(
    'src/lib/stripe.ts',
    9,
    'TS2339',
    "Property 'coupon' does not exist on type 'Discount'.",
  );
  expect(
    repeatedProposalReason({ ...base, errors: [discount], sdkUpgraded: true, stripeTypes: [] })
      .kind,
  ).toBe('missing-types');
  expect(repeatedProposalReason({ ...base, errors: [discount], sdkUpgraded: true }).kind).toBe(
    'unknown',
  );
});
