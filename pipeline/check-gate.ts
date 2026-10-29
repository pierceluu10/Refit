import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { compareBaselineTests, type BaselineTests } from './test-outcomes.ts';
import { typeErrorKeys, typeErrors } from './type-errors.ts';

// The checks gate for a patch, shared by the rule lane and the AI fallback: the repository's tests,
// build and type check run as separate checks on the original code and on the patch.
//
// - A check that passed on the original code must pass on the patch.
// - A check that already failed is reported and does not count, with two refinements that keep
//   its evidence: failing tests are compared test by test when the runner's output is readable
//   (test-outcomes.ts: every test that passed before must pass after), and a type check that
//   reported errors fails only on errors the patch introduced.
// - At least the tests or the type check must count; a build alone proves nothing ran.
//
// Nothing else is loosened: a check that errors (the sandbox, a timeout) is an error, not a pass.

export type CheckName = 'tests' | 'build' | 'typecheck';
export interface NamedCheck {
  name: CheckName;
  command: string[];
}

// The repository's own checks, separately: its test script (not npm's placeholder), its build
// script and, with a root tsconfig.json and TypeScript installed, the type check.
export function separateChecks(
  manifest: unknown,
  files: { tsconfig: boolean; typescript: boolean },
) {
  const scripts =
    typeof manifest === 'object' && manifest !== null && 'scripts' in manifest
      ? ((manifest as { scripts?: Record<string, unknown> }).scripts ?? {})
      : {};
  const checks: NamedCheck[] = [];
  if (typeof scripts.test === 'string' && !/no test specified/.test(scripts.test))
    checks.push({ name: 'tests', command: ['npm', 'test'] });
  if (typeof scripts.build === 'string')
    checks.push({ name: 'build', command: ['npm', 'run', 'build'] });
  if (files.tsconfig && files.typescript)
    checks.push({
      name: 'typecheck',
      command: [
        'npx',
        '--no-install',
        'tsc',
        '--noEmit',
        '--pretty',
        'false',
        '-p',
        'tsconfig.json',
      ],
    });
  return checks;
}

interface Run {
  status: 'passed' | 'failed' | 'error' | 'not-run';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

// A check stopped at its time limit (validation.ts containerCheck).
const STOPPED = /^Check exceeded \d+ seconds; the container was stopped\.$/;

export interface GatedCheck {
  name: CheckName;
  // `passed`: passed before and after. `kept`: failed before, and the comparison above shows the
  // patch kept everything that worked. `already-failing`: failed before, not counted.
  // `regressed`: passed before (or kept tests or types) and the patch broke it. `error`: did not run.
  outcome: 'passed' | 'kept' | 'already-failing' | 'regressed' | 'error';
  counted: boolean;
  reason: string;
  tests?: BaselineTests;
  introducedTypeErrors?: string[];
}

export interface CheckGate {
  status: 'passed' | 'regression' | 'baseline-failed' | 'error';
  checks: GatedCheck[];
  reason: string;
}

function gateOne(name: CheckName, baseline: Run, patched: Run): GatedCheck {
  // A test runner that printed its full summary and then kept the process alive (an open handle)
  // is stopped at the time limit on both sides; its tests still ran, so they are compared.
  if (
    name === 'tests' &&
    [baseline, patched].every((run) => run.status === 'error' && STOPPED.test(run.error ?? ''))
  ) {
    const tests = compareBaselineTests(baseline, patched, true);
    if (tests.status !== 'unreadable')
      return tests.status === 'kept'
        ? {
            name,
            outcome: 'kept',
            counted: true,
            reason: `The tests did not exit after their summary and were stopped on both sides; ${tests.alreadyFailing.length ? `${tests.alreadyFailing.length} already failed on the original code, and ` : ''}every test that passed there passes on the patch.`,
            tests,
          }
        : { name, outcome: 'regressed', counted: true, reason: tests.reason, tests };
  }
  if (baseline.status === 'error' || patched.status === 'error' || patched.status === 'not-run')
    return {
      name,
      outcome: 'error',
      counted: false,
      reason: `The ${name} check did not run to completion${baseline.status === 'error' ? ' on the original code' : ' on the patch'}.`,
    };
  if (name === 'typecheck' && (baseline.status === 'failed' || patched.status === 'failed')) {
    const before = typeErrorKeys(baseline);
    // A type check that failed without reporting a type error did not check types.
    if (baseline.status === 'failed' && !before.size)
      return {
        name,
        outcome: 'already-failing',
        counted: false,
        reason: 'The type check failed on the original code without reporting a type error.',
      };
    const reported = typeErrors(patched);
    if (patched.status === 'failed' && !reported.length)
      return {
        name,
        outcome: 'regressed',
        counted: true,
        reason: 'The type check failed on the patch without reporting a type error.',
      };
    const introduced = reported.filter((error) => !before.has(error.key));
    return introduced.length
      ? {
          name,
          outcome: 'regressed',
          counted: true,
          reason: `The patch introduces ${introduced.length} type error${introduced.length === 1 ? '' : 's'}, first ${introduced[0].file}: ${introduced[0].message}`,
          introducedTypeErrors: introduced.map(
            (error) => `${error.file} ${error.code} ${error.message}`,
          ),
        }
      : {
          name,
          outcome: baseline.status === 'passed' ? 'passed' : 'kept',
          counted: true,
          reason:
            baseline.status === 'passed'
              ? 'The type check passed before and after.'
              : `The type check reported ${before.size} error${before.size === 1 ? '' : 's'} on the original code and none new on the patch.`,
        };
  }
  if (baseline.status === 'passed')
    return patched.status === 'passed'
      ? { name, outcome: 'passed', counted: true, reason: `The ${name} passed before and after.` }
      : {
          name,
          outcome: 'regressed',
          counted: true,
          reason: `The ${name} passed on the original code and failed on the patch.`,
        };
  if (name === 'tests') {
    const tests = compareBaselineTests(baseline, patched);
    if (tests.status === 'kept')
      return {
        name,
        outcome: 'kept',
        counted: true,
        reason: `${tests.alreadyFailing.length} test${tests.alreadyFailing.length === 1 ? '' : 's'} already failed on the original code; every test that passed there passes on the patch.`,
        tests,
      };
    if (tests.status === 'regressed')
      return { name, outcome: 'regressed', counted: true, reason: tests.reason, tests };
  }
  return {
    name,
    outcome: 'already-failing',
    counted: false,
    reason: `The ${name} already failed on the original code, so ${name === 'build' ? 'it' : 'they'} prove${name === 'build' ? 's' : ''} nothing about the patch; reported, not counted.`,
  };
}

export function checkGate(runs: { name: CheckName; baseline: Run; patched: Run }[]): CheckGate {
  const checks = runs.map((run) => gateOne(run.name, run.baseline, run.patched));
  const failed = checks.find((check) => check.outcome === 'regressed');
  if (failed) return { status: 'regression', checks, reason: failed.reason };
  const broken = checks.find((check) => check.outcome === 'error');
  if (broken) return { status: 'error', checks, reason: broken.reason };
  if (
    !checks.some((check) => check.counted && (check.name === 'tests' || check.name === 'typecheck'))
  )
    return {
      status: 'baseline-failed',
      checks,
      reason: checks.length
        ? 'Neither the tests nor the type check passed on the original code, so no check shows the patch works.'
        : 'No tests or type check ran.',
    };
  return {
    status: 'passed',
    checks,
    reason: checks.map((check) => `${check.name}: ${check.outcome}`).join('; '),
  };
}

// separateChecks for a checkout: TypeScript counts as installed when package.json declares it,
// since preparation installs every declared package before the checks run.
export function repositoryChecks(root: string, manifest: unknown) {
  const declared = (name: string) =>
    ['dependencies', 'devDependencies'].some((section) => {
      const value = (manifest as Record<string, unknown> | null)?.[section];
      return typeof value === 'object' && value !== null && name in value;
    });
  return separateChecks(manifest, {
    tsconfig: existsSync(join(root, 'tsconfig.json')),
    typescript: declared('typescript'),
  });
}

// What a draft says about the gate: each check's outcome, and the tests that already failed.
export function gateNote(gate?: CheckGate) {
  if (!gate) return [];
  return gate.checks.map((check) => {
    const failing = check.tests?.status === 'kept' ? check.tests.alreadyFailing : [];
    const listed = failing.slice(0, 5).map((title) => `\`${title.replaceAll('`', "'")}\``);
    return `- ${check.name}: ${check.outcome}${check.counted ? '' : ' (not counted)'}. ${check.reason}${
      listed.length
        ? ` Already failing: ${listed.join(', ')}${failing.length > 5 ? ` and ${failing.length - 5} more` : ''}.`
        : ''
    }`;
  });
}
