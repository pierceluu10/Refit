import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { TESTS_FAILED } from './check-selection.ts';
import { compareBaselineTests, testOutcomes } from './test-outcomes.ts';

// Real output of each runner (Vitest 3.2.4, Jest 29.7.0, Mocha 10.8.2, Node 22's runner) on a
// test file with one passing and one failing test (Vitest and Jest also have a file that fails to
// load); `regressed` is the same run after the passing test was broken too.
const output = (name: string) => ({
  stdout: readFileSync(join(import.meta.dirname, 'fixtures/test-outcomes', `${name}.txt`), 'utf8'),
  stderr: '',
});

it('reads the failing tests and the passed count of each runner', () => {
  expect(testOutcomes(output('v-before'))).toEqual({
    runner: 'vitest',
    failed: new Set(['v/a.test.js > math > breaks', 'file v/b.test.js']),
    passed: 1,
  });
  expect(testOutcomes(output('j-before'))).toEqual({
    runner: 'jest',
    failed: new Set(['j/a.test.js › math › breaks', 'file j/b.test.js']),
    passed: 1,
  });
  expect(testOutcomes(output('m-before'))).toEqual({
    runner: 'mocha',
    failed: new Set(['math breaks']),
    passed: 1,
  });
  expect(testOutcomes(output('n-before'))).toEqual({
    runner: 'node',
    failed: new Set(['breaks']),
    passed: 1,
  });
});

it('keeps a patch that fails only what already failed, and lists those tests', () => {
  for (const runner of ['v', 'j', 'm', 'n'])
    expect(
      compareBaselineTests(output(`${runner}-before`), output(`${runner}-before`)),
    ).toMatchObject({ status: 'kept', passed: 1 });
  expect(compareBaselineTests(output('m-before'), output('m-before'))).toEqual({
    status: 'kept',
    runner: 'mocha',
    alreadyFailing: ['math breaks'],
    passed: 1,
  });
});

it('refuses a patch that fails a test that passed on the original code', () => {
  for (const runner of ['v', 'j', 'm', 'n'])
    expect(
      compareBaselineTests(output(`${runner}-before`), output(`${runner}-regressed`)),
    ).toMatchObject({
      status: 'regressed',
      reason: expect.stringContaining('that passed on the original code'),
    });
});

it('reads only the test part of a check chain, and nothing it cannot read', () => {
  const chain = {
    stdout: `${output('m-before').stdout}\n${TESTS_FAILED}\nRefit: type check.\n  3 passing (1ms)\n`,
    stderr: '',
  };
  expect(testOutcomes(chain)?.passed).toBe(1);
  // Fewer passing tests with the same failures: some tests no longer ran.
  const fewer = { stdout: output('m-before').stdout.replace('1 passing', '0 passing'), stderr: '' };
  expect(compareBaselineTests(output('m-before'), fewer)).toMatchObject({ status: 'regressed' });
  for (const [before, after] of [
    [{ stdout: 'npm ERR! build failed', stderr: '' }, output('m-before')],
    [output('m-before'), output('j-before')],
    // A baseline with no failing test is not a failing-tests baseline.
    [output('m-before'), output('m-before')].map((run) => ({
      ...run,
      stdout: run.stdout.replace('1 failing', '0 failing').replace(/ {2}1\) math[\s\S]*/, ''),
    })),
  ])
    expect(compareBaselineTests(before, after)).toMatchObject({ status: 'unreadable' });
});
