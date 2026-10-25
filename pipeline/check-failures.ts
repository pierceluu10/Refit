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
  ].filter((failure) => failure !== undefined);
  return failures.length ? { checkFailures: failures } : {};
}
