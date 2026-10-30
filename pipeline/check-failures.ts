import { failingPart, TESTS_FAILED, TYPE_CHECK_STARTED } from './check-selection.ts';
import type { CheckResult } from './validation.ts';

// compareTypeCheck (validation.ts) lists the type errors a patch introduced above tsc's output.
export const INTRODUCED_TYPE_ERRORS = 'Type errors this patch introduced:\n';

const ANSI = /\u001b\[[0-9;]*m/g;
// The first line test runners and tsc print for a failure: a failing file or test, a type error,
// an uncaught error or npm's own.
const FAILURE_LINE =
  /^\s*(?:FAIL\s+\S|[×✗✕]\s|not ok\b|\S.*\(\d+,\d+\): error TS\d+|\w*Error:|npm (?:ERR!|error) )/;
const PASSED_LINE = /^\s*(?:[✓√]|PASS|ok\b)\s+\S/;
const FAILED_LINE = /^\s*(?:FAIL|[×✗✕]|not ok\b)\s+\S/;

// Which check failed or did not finish (in a tests-then-type-check chain, which part), the first
// failure it printed and, for a check stopped at the time limit, how far it got, so a slow or
// failing suite is reported instead of a bare status.
export function checkFailure(side: 'baseline' | 'patched', command: string[], check: CheckResult) {
  if (check.status === 'passed' || check.status === 'not-run') return undefined;
  const stdout = check.stdout.replace(ANSI, '');
  const stderr = check.stderr.replace(ANSI, '');
  const part = failingPart(command, `${stdout}\n${stderr}`);
  // A chain part's own output: the tests' before their line, the type check's after its own, where
  // tsc writes (the introduced errors validation lists above it come first).
  const own =
    part?.part === 'tests'
      ? `${stdout.includes(TESTS_FAILED) ? stdout.slice(0, stdout.indexOf(TESTS_FAILED)) : stdout}\n${stderr}`
      : part?.part === 'type check' && !stdout.startsWith(INTRODUCED_TYPE_ERRORS)
        ? `${stdout.slice(stdout.lastIndexOf(TYPE_CHECK_STARTED))}\n${stderr}`
        : `${stdout}\n${stderr}`;
  const lines = own.split('\n');
  const firstFailure = lines
    .find((line) => FAILURE_LINE.test(line))
    ?.trim()
    .slice(0, 300);
  const passed = lines.filter((line) => PASSED_LINE.test(line)).length;
  const failed = lines.filter((line) => FAILED_LINE.test(line)).length;
  return {
    side,
    command: part?.command ?? command.join(' '),
    ...(part ? { part: part.part } : {}),
    status: check.status,
    // A failed check's error is the Docker command line; only an error is a reason of its own.
    ...(check.status === 'error' && check.error ? { error: check.error } : {}),
    ...(firstFailure ? { firstFailure } : {}),
    // Test counts describe the tests, not a type check that failed after them.
    ...((passed || failed) && part?.part !== 'type check' ? { reported: { passed, failed } } : {}),
  };
}

// A test runner's failing lines without their timing (`× test 7ms`, `✕ test (5 ms)`).
const failingTests = (check: CheckResult) =>
  testOutput(check)
    .split('\n')
    .filter((line) => FAILED_LINE.test(line))
    .map((line) => line.trim().replace(/\s*\(?\d+(?:\.\d+)?\s*m?s\)?$/, ''));
const testOutput = (check: CheckResult) => {
  const stdout = check.stdout.replace(ANSI, '');
  return `${stdout.includes(TESTS_FAILED) ? stdout.slice(0, stdout.indexOf(TESTS_FAILED)) : stdout}\n${check.stderr.replace(ANSI, '')}`;
};
// Jest's `FAIL src/a.test.ts` names a file, not a test: with several files Jest prints only these.
const FILE_LINE = /^FAIL\s+\S+$/;
// An error a suite threw, as runners print it: `Error: ENOENT …`, `TypeError: Cannot read …`.
const ERROR_LINE = /^\s*\w*Error:/;
// The runner's own totals: Jest's `Tests: 1 failed, 5 passed, 6 total`, Vitest's
// `Tests  1 failed | 5 passed (6)`.
const SUMMARY = /^\s*Tests:?\s+(.*)$/m;
const summaryCount = (check: CheckResult, kind: 'failed' | 'passed') => {
  const line = SUMMARY.exec(testOutput(check))?.[1];
  return line ? Number(new RegExp(`(\\d+) ${kind}`).exec(line)?.[1] ?? 0) : undefined;
};

// Founder decision (Otabek, 2026-10-28): tests that already fail on the original code still show
// whether a patch adds a failure. It adds none when the tests on it report no fewer passing and
// no more failing tests (the runner's totals where it prints them, else the lines counted), and
// every failing test it names also failed on the original code. The failures it adds, empty for
// none, or undefined where the output does not name failing tests (a runner Refit cannot read,
// only failing files, or a check that did not finish), which proves nothing.
export function newTestFailures(baseline: CheckResult, patched: CheckResult) {
  if (![baseline, patched].every((check) => ['passed', 'failed'].includes(check.status)))
    return undefined;
  const counts = (check: CheckResult) => {
    const failed = failingTests(check);
    return {
      passed:
        summaryCount(check, 'passed') ??
        testOutput(check)
          .split('\n')
          .filter((line) => PASSED_LINE.test(line)).length,
      failing: summaryCount(check, 'failed') ?? failed.length,
      failed,
    };
  };
  const before = counts(baseline);
  const after = counts(patched);
  // No test ran on either side: every suite failed before its tests, while loading or in a setup
  // hook. The patch adds a failure unless each failing suite and error it printed was printed the
  // same on the original code.
  if (!before.passed && !before.failing && !after.passed && !after.failing) {
    const failures = (check: CheckResult) =>
      new Set(
        testOutput(check)
          .split('\n')
          .filter((line) => FAILED_LINE.test(line) || ERROR_LINE.test(line))
          .map((line) => line.trim()),
      );
    const known = failures(baseline);
    const found = failures(patched);
    // Output that names no failure on one side says nothing about the other.
    return known.size && found.size ? [...found].filter((line) => !known.has(line)) : undefined;
  }
  // Failing files alone do not say which test failed, so they prove nothing; a file that failed
  // only on the patch is a new failure all the same.
  if (!before.failed.some((line) => !FILE_LINE.test(line))) return undefined;
  if (!(after.passed + after.failing)) return undefined;
  const known = new Set(before.failed);
  return [
    ...(after.passed < before.passed || after.failing > before.failing
      ? [
          `${after.passed} passing and ${after.failing} failing on the patch, against ${before.passed} and ${before.failing} on the original code`,
        ]
      : []),
    ...after.failed.filter((line) => !known.has(line)),
  ];
}

// The stop message's sentences naming each check that failed or did not finish.
export function checkFailureText(validation: {
  checkFailures?: NonNullable<ReturnType<typeof checkFailure>>[];
}) {
  return (validation.checkFailures ?? [])
    .map((failure) => {
      const what = failure.error
        ? `did not finish (${failure.error.replace(/\.$/, '')})`
        : failure.side === 'baseline'
          ? 'fails on the original code, before any change'
          : 'fails on the migrated code';
      const first = failure.firstFailure ? `; the first failure: ${failure.firstFailure}` : '';
      const reported = failure.reported
        ? ` ${failure.error ? 'Before it stopped, it' : 'It'} reported ${failure.reported.passed} passing and ${failure.reported.failed} failing.`
        : '';
      return ` The ${failure.side} check ${failure.command} ${what}${first}.${reported}`;
    })
    .join('');
}

// Every check of a validation that failed or did not finish, including each generated function
// that completed on the original code and threw on the patched code, and each behaviour test that
// passed on the original code and failed on the patched code (the only such results that count).
export function checkFailures(
  baselineCommand: string[],
  command: string[],
  baseline: CheckResult,
  patched: CheckResult,
  generated?: { regressions: { id: string; error: string }[] },
  behaviour?: { regressions: { id: string; error: string }[] },
  signedEvents?: { regressions: { id: string; error: string }[] },
) {
  const counted = (
    evidence: { regressions: { id: string; error: string }[] } | undefined,
    what: string,
  ) =>
    (evidence?.regressions ?? []).map((regression) => ({
      side: 'patched' as const,
      command: `${regression.id} (${what})`,
      status: 'failed' as const,
      firstFailure: regression.error.slice(0, 300),
    }));
  const failures = [
    checkFailure('baseline', baselineCommand, baseline),
    checkFailure('patched', command, patched),
    ...counted(generated, 'generated stripe-mock check, which completed on the original code'),
    ...counted(behaviour, 'behaviour test, which passed on the original code'),
    ...counted(
      signedEvents,
      'signed webhook event, which the original code handled the same way in both API versions',
    ),
  ].filter((failure) => failure !== undefined);
  return failures.length ? { checkFailures: failures } : {};
}
