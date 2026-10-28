import { expect, it } from 'vitest';
import { ceiling, changeRule, classifyRow } from '../scripts/validation-ceiling.mjs';

const affected = { fullAdapter: { confirmed: 1 } };
const needsReview = { production: { status: 'needs-review' } };
const passed = (letter: string) => ({
  status: 'needs-review',
  validation: 'passed',
  grade: { letter },
});
const preparation = (message: string) => ({
  ...affected,
  ...needsReview,
  checks: 'typecheck',
  workflow: { status: 'error', stage: 'validation', error: message },
});

// Messages and changes as rows of Actions run 40552354557 (l2-push-249, main 93e73d7c, AI) record them.
const change = (id: string, reach: string, operation: string, path: string, text: string) => ({
  id,
  reach,
  operation,
  path,
  text,
});
const CHANGES = [
  change(
    'response-property-became-optional',
    'reached',
    'POST',
    '/v1/checkout/sessions',
    'the response property `error/payment_intent/amount` became optional for the status `default`',
  ),
  change(
    'request-property-enum-value-removed',
    'reached',
    'POST',
    '/v1/checkout/sessions',
    'removed the enum value `embedded` of the request property `ui_mode`',
  ),
  change(
    'response-property-enum-value-added',
    'reached',
    'GET',
    '/v1/subscriptions',
    'added `paused` to the `subscription.status` enum',
  ),
  change(
    'request-property-removed',
    'reached',
    'POST',
    '/v1/checkout/sessions',
    'removed the request property `payment_method_types`',
  ),
];
const gateRow = {
  ...affected,
  ...needsReview,
  repo: 'odota/core',
  checks: 'typecheck',
  workflow: { ...passed('C'), waivedGates: ['contract-changes'] },
};
const gateReport = {
  findings: [],
  specificationDiff: { changes: CHANGES },
  waivedGates: [
    {
      gate: 'contract-changes',
      changes: [
        'POST /v1/checkout/sessions the response property `error/payment_intent/amount` became optional for the status `default`: app/checkout.ts:20 reads `amount`.',
        'POST /v1/checkout/sessions removed the enum value `embedded` of the request property `ui_mode`: The `checkout.sessions.create` call in app/checkout.ts sends `ui_mode`.',
        'GET /v1/subscriptions added `paused` to the `subscription.status` enum: svc/apiadmin.ts:25 compares with string literals: The code switches over, exhaustively checks or compares this enum field.',
        'POST /v1/checkout/sessions removed the request property `payment_method_types`: The `checkout.sessions.create` call in app/checkout.ts sends `payment_method_types`.',
      ],
    },
  ],
};

it('splits a contract-change stop by change, matching the gate lines to the report', () => {
  const row = classifyRow(gateRow, gateReport);
  expect(row.verdict).toBe('fixable');
  expect(row.blockers.map((b) => [b.lane, b.cause])).toEqual([
    ['heldout-2', undefined],
    ['ceiling-3', undefined],
    ['none', 'reached response-property-enum-value-added'],
    ['deps-C', undefined],
  ]);
  expect(row.lanes).toEqual(['heldout-2', 'ceiling-3', 'none', 'deps-C']);
});

it('sends unread parameters and removed paths to the planned lanes', () => {
  const rule = (id: string, reach: string, text: string) => changeRule({ id, reach, text }).lane;
  expect(
    rule(
      'request-parameter-max-length-set',
      'reached',
      'GET /v1/payment_methods for the `query` request parameter `ending_before`, the maxLength was set to `5000`: Refit cannot read the request property in "…".',
    ),
  ).toBe('heldout-2');
  expect(
    rule(
      'api-path-removed-without-deprecation',
      'unknown',
      'GET /v1/invoices/upcoming api path removed',
    ),
  ).toBe('ceiling-3');
  expect(rule('response-optional-property-removed', 'not-recorded', 'x')).toBe('none');
});

it('keeps public non-registry sources a Refit gap and calls private ones not validatable', () => {
  const github = classifyRow(
    preparation(
      'Automatic preparation supports public npm registry dependencies only; package.json declares @nanostores/react as "github:ai/react". Local, Git and URL dependencies require a custom image.',
    ),
  );
  expect(github.blockers[0]).toMatchObject({
    lane: 'none',
    cause: 'public Git, URL or local-path dependency',
  });
  // Constructed: no recorded row depends on a private registry yet.
  const evidence =
    'Automatic preparation supports public npm registry dependencies only; package.json declares @acme/ui as "git+ssh://git@github.com/acme/ui.git".';
  const privateRow = classifyRow(preparation(evidence));
  expect(privateRow).toMatchObject({
    verdict: 'not-validatable',
    reasons: ['customer-secrets-or-services'],
  });
  expect(privateRow.blockers[0].evidence).toContain('git+ssh://');
});

it('follows a stripe-node upgrade refusal to the lane of its cause', () => {
  const upgrade = (skipped: string) =>
    classifyRow({
      ...affected,
      ...needsReview,
      checks: 'typecheck',
      workflow: { ...passed('C'), sdkUpgrade: { skipped } },
    }).blockers[0];
  expect(
    upgrade(
      'package-lock.json locks stripe 15.1.0 and pnpm-lock.yaml locks 15.2.0; the lockfiles disagree, so the installed release is not known.',
    ).lane,
  ).toBe('heldout-3');
  expect(upgrade('Only single-project pnpm lockfile version 6 files are upgraded.')).toMatchObject({
    lane: 'none',
    cause: 'stripe-node upgrade refused for this lockfile shape',
  });
  expect(
    upgrade(
      'stripe 23.0.0 needs @types/node >=20, which the lockfile does not provide; upgrade it first.',
    ).lane,
  ).toBe('deps-A');
});

it('separates runtime stand-ins from a repository test that fails on its own', () => {
  const baseline = (stdout: string) =>
    classifyRow(
      {
        ...affected,
        ...needsReview,
        checks: 'tests',
        workflow: { status: 'needs-review', validation: 'baseline-failed' },
      },
      { validation: { baseline: { stdout, stderr: '' } } },
    ).blockers[0];
  expect(baseline('Error: connect ECONNREFUSED 127.0.0.1:5432').lane).toBe('ceiling-2');
  const own = baseline(
    '× Stripe Webhook Handler > should handle checkout.session.completed\n → expected 400 to be 200',
  );
  expect(own).toMatchObject({
    lane: 'none',
    cause: "repository's own check fails on the original code",
  });
  expect(own.evidence).toContain('expected 400 to be 200');
  expect(
    baseline('native-build-required Error: Could not locate the bindings file. Tried:').cause,
  ).toBe('native module not built');
});

it('reads upgrade fallout from a failing patched type check', () => {
  const row = classifyRow({
    ...affected,
    ...needsReview,
    checks: 'typecheck',
    workflow: {
      status: 'validation-failed',
      validation: 'regression',
      checkFailures: [
        {
          side: 'patched',
          firstFailure:
            "libs/playlistPayments.ts(44,26): error TS2551: Property 'dispute' does not exist on type 'Charge'. Did you mean 'disputed'?",
        },
      ],
    },
  });
  expect(row.blockers.map((b) => b.lane)).toEqual(['ceiling-4']);
});

it('names a grade-D pass and an unexplained stop instead of dropping them', () => {
  expect(
    classifyRow({ ...affected, ...needsReview, workflow: passed('D') }).blockers[0],
  ).toMatchObject({
    blocker: 'grade-d',
    lane: 'test-mode-T',
  });
  expect(
    classifyRow({ ...affected, ...needsReview, workflow: passed('C') }).blockers[0],
  ).toMatchObject({
    blocker: 'unexplained',
    lane: 'none',
  });
});

it('counts the ceiling: validated, validatable, lanes and uncovered causes', () => {
  const validatedRow = {
    ...affected,
    repo: 'a/validated',
    production: { status: 'validated' },
    workflow: { status: 'validated', validation: 'passed', grade: { letter: 'C' } },
  };
  // Before #359 a grade-D pass ended `validated`; it never counts.
  const gradeD = {
    ...validatedRow,
    repo: 'b/grade-d',
    workflow: { ...validatedRow.workflow, grade: { letter: 'D' } },
  };
  const scanStop = {
    ...affected,
    ...needsReview,
    repo: 'c/scan-stop',
    checks: 'none',
    packageManager: 'npm',
    workflow: {
      status: 'needs-review',
      stage: 'scan',
      reason: 'A traced SDK request sends a parameter the target API version removed.',
    },
    productionMode: {
      reviewReasons: {
        'The target API version no longer accepts this request parameter, and no reviewed replacement exists; removing or replacing it changes request behavior.': 1,
      },
      findings: [{ property: 'checkout.sessions.create argument[0].payment_method_types' }],
    },
  };
  const privateSource = {
    ...preparation('package.json declares @acme/ui as "git+ssh://git@github.com/acme/ui.git".'),
    repo: 'd/private',
  };
  const result = ceiling([
    { repo: 'e/unaffected', fullAdapter: { confirmed: 0 } },
    validatedRow,
    gradeD,
    scanStop,
    privateSource,
  ]);
  expect(result).toMatchObject({
    rows: 5,
    affected: 4,
    validated: 1,
    validatable: 3,
    notValidatable: { 'customer-secrets-or-services': 1 },
  });
  expect(result.lanes['test-mode-T']).toEqual({ rows: 1, only: 1 });
  expect(
    result.repositories.find((row) => row.repo === 'c/scan-stop')?.blockers.map((b) => b.lane),
  ).toEqual(['deps-C', 'follows']);
  expect(result.repositories.find((row) => row.repo === 'c/scan-stop')?.lanes).toEqual(['deps-C']);
});
