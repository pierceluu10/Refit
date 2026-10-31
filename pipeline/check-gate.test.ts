import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkGate, gateNote, separateChecks } from './check-gate.ts';

const run = (status: 'passed' | 'failed' | 'error', stdout = '') => ({
  status,
  exitCode: status === 'passed' ? 0 : 1,
  stdout,
  stderr: '',
});
const passed = run('passed');
const failed = run('failed', 'npm ERR! build failed');
// Mocha's own output: `math breaks` fails, one test passes; `regressed` breaks the passing one too.
const mocha = (name: string) =>
  run(
    'failed',
    readFileSync(join(import.meta.dirname, 'fixtures/test-outcomes', `m-${name}.txt`), 'utf8'),
  );
const tsc = (...errors: string[]) =>
  run(
    errors.length ? 'failed' : 'passed',
    errors.map((error) => `src/a.ts(1,1): error ${error}`).join('\n'),
  );

it('requires every check that passed before to pass after', () => {
  expect(
    checkGate([
      { name: 'tests', baseline: passed, patched: passed },
      { name: 'build', baseline: passed, patched: passed },
      { name: 'typecheck', baseline: passed, patched: passed },
    ]),
  ).toMatchObject({ status: 'passed' });
  expect(
    checkGate([
      { name: 'tests', baseline: passed, patched: passed },
      { name: 'build', baseline: passed, patched: failed },
    ]),
  ).toMatchObject({
    status: 'regression',
    reason: 'The build passed on the original code and failed on the patch.',
  });
});

it('reports a check that already failed without counting it', () => {
  const gate = checkGate([
    { name: 'tests', baseline: passed, patched: passed },
    { name: 'build', baseline: failed, patched: failed },
  ]);
  expect(gate).toMatchObject({
    status: 'passed',
    checks: [
      { name: 'tests', outcome: 'passed', counted: true },
      { name: 'build', outcome: 'already-failing', counted: false },
    ],
  });
  expect(gateNote(gate)[1]).toContain('build: already-failing (not counted)');
});

it('compares failing tests test by test and type errors error by error', () => {
  const kept = checkGate([{ name: 'tests', baseline: mocha('before'), patched: mocha('before') }]);
  expect(kept).toMatchObject({
    status: 'passed',
    checks: [{ outcome: 'kept', tests: { alreadyFailing: ['math breaks'] } }],
  });
  expect(gateNote(kept)[0]).toContain('Already failing: `math breaks`.');
  expect(
    checkGate([{ name: 'tests', baseline: mocha('before'), patched: mocha('regressed') }]),
  ).toMatchObject({ status: 'regression' });
  const old = 'TS2322: Type string is not assignable to type number.';
  expect(checkGate([{ name: 'typecheck', baseline: tsc(old), patched: tsc(old) }])).toMatchObject({
    status: 'passed',
    checks: [{ outcome: 'kept', counted: true }],
  });
  expect(
    checkGate([
      {
        name: 'typecheck',
        baseline: tsc(old),
        patched: tsc(old, 'TS2339: Property x does not exist.'),
      },
    ]),
  ).toMatchObject({
    status: 'regression',
    checks: [{ introducedTypeErrors: ['src/a.ts TS2339 Property x does not exist.'] }],
  });
});

it('needs the tests or the type check to count, and never passes a check that did not run', () => {
  expect(
    checkGate([
      { name: 'tests', baseline: failed, patched: failed },
      { name: 'build', baseline: passed, patched: passed },
    ]),
  ).toMatchObject({ status: 'baseline-failed' });
  expect(checkGate([])).toMatchObject({
    status: 'baseline-failed',
    reason: 'No tests or type check ran.',
  });
  expect(
    checkGate([
      { name: 'tests', baseline: passed, patched: run('error') },
      { name: 'typecheck', baseline: passed, patched: passed },
    ]),
  ).toMatchObject({ status: 'error' });
  // Unreadable failing tests do not count; a passing type check still does.
  expect(
    checkGate([
      { name: 'tests', baseline: failed, patched: failed },
      { name: 'typecheck', baseline: passed, patched: passed },
    ]),
  ).toMatchObject({ status: 'passed', checks: [{ counted: false }, { counted: true }] });
});

it("chooses the repository's own test, build and type check", () => {
  expect(
    separateChecks(
      { scripts: { test: 'vitest run', build: 'next build' } },
      { tsconfig: true, typescript: true },
    ).map((check) => check.name),
  ).toEqual(['tests', 'build', 'typecheck']);
  expect(
    separateChecks(
      { scripts: { test: 'echo "Error: no test specified" && exit 1' } },
      { tsconfig: true, typescript: false },
    ),
  ).toEqual([]);
});

// A runner that printed its full summary and then did not exit (an open handle) is stopped at the
// time limit. The gate compares such tests only under all four conditions below.
describe('tests stopped at the time limit', () => {
  const STOP = 'Check exceeded 120 seconds; the container was stopped.';
  const stopped = (name: string) => ({
    ...mocha(name),
    status: 'error' as const,
    exitCode: null,
    error: STOP,
  });
  type Run = Parameters<typeof checkGate>[0][number]['baseline'];
  const gate = (baseline: Run, patched: Run) => checkGate([{ name: 'tests', baseline, patched }]);

  it('(1) compares them only when both sides were stopped at the limit', () => {
    expect(gate(stopped('before'), stopped('before'))).toMatchObject({
      status: 'passed',
      checks: [{ outcome: 'kept', counted: true }],
    });
    // Any other error on either side is not a time limit, and stays an error.
    expect(
      gate({ ...stopped('before'), error: 'docker: daemon unavailable' }, stopped('before')),
    ).toMatchObject({ status: 'error' });
    expect(gate(stopped('before'), { ...stopped('before'), error: 'exit 127' })).toMatchObject({
      status: 'error',
    });
  });

  it('(2) needs a complete runner summary on both sides', () => {
    const cut = {
      ...stopped('before'),
      stdout: mocha('before').stdout.replace(/ {2}1 passing[\s\S]*/, ''),
    };
    expect(gate(cut, stopped('before'))).toMatchObject({ status: 'error' });
    expect(gate(stopped('before'), cut)).toMatchObject({ status: 'error' });
    // Failures the summary counts but does not name are not a complete summary either.
    const unnamed = {
      ...stopped('before'),
      stdout: mocha('before').stdout.replace(/ {2}1\) math[\s\S]*/, ''),
    };
    expect(gate(unnamed, unnamed)).toMatchObject({ status: 'error' });
  });

  it('(3) needs every test that passed before to pass after, with none missing', () => {
    expect(gate(stopped('before'), stopped('regressed'))).toMatchObject({
      status: 'regression',
      reason: expect.stringContaining('that passed on the original code'),
    });
    const missing = {
      ...stopped('before'),
      stdout: mocha('before').stdout.replace('1 passing', '0 passing'),
    };
    expect(gate(stopped('before'), missing)).toMatchObject({
      status: 'regression',
      reason: '1 tests passed on the original code and 0 on the patch.',
    });
  });

  it('(4) fails a check stopped at the limit on the patch only', () => {
    for (const baseline of [mocha('before'), passed])
      expect(gate(baseline, stopped('before'))).toMatchObject({
        status: 'regression',
        checks: [{ outcome: 'regressed', counted: true }],
      });
  });
});
