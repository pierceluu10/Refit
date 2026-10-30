import { expect, it } from 'vitest';
import { newTestFailures } from './check-failures.ts';
import { validatedReport } from './fixtures/publication-report.ts';
import { aiPatchProven, proofLevel, publicationWaiver } from './publication.ts';
import { NO_OP_CHECK } from './review.ts';
import type { CheckResult, validateMigration } from './validation.ts';

// Founder decision (Otabek, 2026-10-28; docs/PROOF-BASED-VALIDATION.md): [Needs review] means no proof
// or a real Stripe problem Refit could not fix. Grades A to C are proof.

type Report = Awaited<ReturnType<typeof validateMigration>>;
const REVISION = 'e'.repeat(40);

const graded = (report: Report, letter: 'A' | 'B' | 'C' | 'D') =>
  Object.assign(report.validation, {
    grade: {
      letter,
      level: { A: 'behaviour-tests', B: 'tests', C: 'type-check', D: 'none' }[letter],
      reason: 'test',
    },
  });
const gates = (report: Report) => publicationWaiver(report, true)?.map(({ gate }) => gate);

it('validates an AI patch with A to C proof and holds one without', async () => {
  for (const letter of ['A', 'B', 'C'] as const) {
    const report = await validatedReport(REVISION);
    report.patch.generator = 'openai' as typeof report.patch.generator;
    graded(report, letter);
    expect(proofLevel(report)).toBe(letter);
    expect(aiPatchProven(report)).toBe(true);
    expect(gates(report)).not.toContain('ai-patch');
  }
  const unproven = await validatedReport(REVISION);
  unproven.patch.generator = 'openai' as typeof unproven.patch.generator;
  graded(unproven, 'D');
  expect(aiPatchProven(unproven)).toBe(false);
  expect(gates(unproven)).toContain('ai-patch');
  // Proof needs the checks to have passed on the patch.
  const ungraded = await validatedReport(REVISION);
  ungraded.patch.generator = 'openai' as typeof ungraded.patch.generator;
  expect(gates(ungraded)).toContain('ai-patch');
});

it('lets a grade-A behaviour test prove a patch no check covers', async () => {
  const report = await validatedReport(REVISION);
  report.validation.command = NO_OP_CHECK.split(' ');
  graded(report, 'D');
  expect(gates(report)).toContain('no-checks');
  graded(report, 'A');
  expect(gates(report)).not.toContain('no-checks');
  // A type check is no proof where no check ran: only behaviour tests are.
  graded(report, 'C');
  expect(gates(report)).toContain('no-checks');
});

async function brokenBaseline(newFailures: string[] | null, letter: 'C' | 'D') {
  const report = await validatedReport(REVISION);
  const notRun = { status: 'not-run' as const, exitCode: null, stdout: '', stderr: '' };
  report.validation = {
    ...report.validation,
    status: 'baseline-failed',
    baseline: { status: 'failed', exitCode: 1, stdout: '', stderr: '' },
    patched: notRun,
    brokenTestsTypeCheck: {
      command: ['tsc'],
      patched: { status: 'passed', exitCode: 0, stdout: '', stderr: '' },
      tests: { status: 'failed', newFailures },
    },
  } as Report['validation'];
  report.patch.validation = 'baseline-failed';
  graded(report, letter);
  return report;
}

it('validates a patch to code whose tests already failed only when it adds no failure', async () => {
  expect(gates(await brokenBaseline([], 'C'))).not.toContain('baseline-failed');
  expect(gates(await brokenBaseline(['× charges the card'], 'C'))).toContain('baseline-failed');
  // Unreadable test output, or no proof reaching the changed lines, proves nothing.
  expect(gates(await brokenBaseline(null, 'C'))).toContain('baseline-failed');
  expect(gates(await brokenBaseline([], 'D'))).toContain('baseline-failed');
});

const run = (status: CheckResult['status'], stdout: string): CheckResult => ({
  status,
  exitCode: status === 'passed' ? 0 : 1,
  stdout,
  stderr: '',
});

it('finds the test failures a patch adds to tests that already failed', () => {
  const before = run(
    'failed',
    ' ✓ creates a session 3ms\n × refunds a charge 7ms\n ✓ lists prices 1ms\n',
  );
  // The same failure, with another timing.
  expect(
    newTestFailures(
      before,
      run('failed', ' ✓ creates a session 4ms\n × refunds a charge 9ms\n ✓ lists prices 1ms\n'),
    ),
  ).toEqual([]);
  // Fewer failures is no new one.
  expect(
    newTestFailures(
      before,
      run('passed', ' ✓ creates a session\n ✓ refunds a charge\n ✓ lists prices\n'),
    ),
  ).toEqual([]);
  // A new failing test, even with the counts unchanged.
  expect(
    newTestFailures(
      before,
      run('failed', ' × creates a session 4ms\n ✓ refunds a charge 9ms\n ✓ lists prices 1ms\n'),
    ),
  ).toEqual(['× creates a session']);
  // A suite that no longer loads reports fewer passing tests, whatever lines it repeats.
  expect(newTestFailures(before, run('failed', ' × refunds a charge\n'))?.[0]).toMatch(
    /^0 passing and 1 failing on the patch, against 2 and 1/,
  );
  // Output that counts no tests, or a check that did not finish, proves nothing.
  expect(newTestFailures(before, run('failed', 'Error: cannot find module'))).toBeUndefined();
  expect(newTestFailures(run('failed', 'npm ERR! missing script'), before)).toBeUndefined();
  expect(newTestFailures(before, run('error', ' × refunds a charge\n'))).toBeUndefined();
});

it('compares suites that failed before any test ran by the suites and errors they print', () => {
  // Vitest, a setup hook that needs a database binary the offline sandbox cannot download.
  const suites = (error: string, extra = '') => ({
    status: 'failed' as const,
    exitCode: 1,
    stdout: ` ❯ tests/checkout.test.ts (6 tests | 6 skipped) 69ms\n Test Files  2 failed (2)\n      Tests  11 skipped (11)\n`,
    stderr: ` FAIL  tests/checkout.test.ts [ tests/checkout.test.ts ]\n FAIL  tests/webhook.test.ts [ tests/webhook.test.ts ]\n${error}\n ❯ tests/setup.ts:22:12\n${extra}`,
  });
  const before = suites("Error: ENOENT: no such file or directory, mkdir '/.cache'");
  expect(
    newTestFailures(before, suites("Error: ENOENT: no such file or directory, mkdir '/.cache'")),
  ).toEqual([]);
  // A suite that now fails to load on the patch is a new failure.
  expect(
    newTestFailures(
      before,
      suites(
        "Error: ENOENT: no such file or directory, mkdir '/.cache'",
        'FAIL  tests/refund.test.ts [ tests/refund.test.ts ]\nSyntaxError: Unexpected token\n',
      ),
    ),
  ).toEqual([
    'FAIL  tests/refund.test.ts [ tests/refund.test.ts ]',
    'SyntaxError: Unexpected token',
  ]);
  // So is another error in the same suites.
  expect(
    newTestFailures(
      before,
      suites("TypeError: Cannot read properties of undefined (reading 'id')"),
    ),
  ).toEqual(["TypeError: Cannot read properties of undefined (reading 'id')"]);
  // A side that names no failure says nothing.
  expect(
    newTestFailures(before, { ...before, stdout: '', stderr: 'Segmentation fault' }),
  ).toBeUndefined();
});

it('reads Jest totals where it names only failing files', () => {
  const jest = (failed: number, passed: number) =>
    run(
      'failed',
      `FAIL src/billing.test.ts\nPASS src/other.test.ts\nTests:       ${failed} failed, ${passed} passed, ${failed + passed} total\n`,
    );
  // Failing files alone do not say which test failed.
  expect(newTestFailures(jest(1, 5), jest(2, 4))).toBeUndefined();
  expect(newTestFailures(jest(1, 5), jest(1, 5))).toBeUndefined();
  // With test names, the totals still count: a second failure in the same file is new.
  const named = (failed: number, passed: number, names: string) =>
    run(
      'failed',
      `FAIL src/billing.test.ts\n  ✕ refunds a charge (5 ms)${names}\nTests:       ${failed} failed, ${passed} passed, ${failed + passed} total\n`,
    );
  expect(newTestFailures(named(1, 5, ''), named(1, 5, ''))).toEqual([]);
  expect(newTestFailures(named(1, 5, ''), named(2, 4, '\n  ✕ creates a session (3 ms)'))).toEqual([
    '4 passing and 2 failing on the patch, against 5 and 1 on the original code',
    '✕ creates a session',
  ]);
  // A file that fails only on the patch is a new failure.
  expect(
    newTestFailures(
      named(1, 5, ''),
      run(
        'failed',
        'FAIL src/billing.test.ts\n  ✕ refunds a charge (5 ms)\nFAIL src/new.test.ts\nTests:       1 failed, 5 passed, 6 total\n',
      ),
    ),
  ).toEqual(['FAIL src/new.test.ts']);
});
