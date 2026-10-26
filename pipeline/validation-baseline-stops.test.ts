import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { checkFailure, checkFailureText, INTRODUCED_TYPE_ERRORS } from './check-failures.ts';
import { TESTS_FAILED, TYPE_CHECK, TYPE_CHECK_STARTED } from './check-selection.ts';
import { validateSourcePatch } from './validation.ts';

const TYPE_CHECK_COMMAND = ['npx', '--no-install', 'tsc', '--noEmit'];

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// A committed repository and a docker stand-in that runs `check` (a script body with `args`) for
// every check.
async function validated(check: string, options: { command: string[]; compareTypeErrors?: true }) {
  const root = await mkdtemp(join(tmpdir(), 'refit-baseline-stops-'));
  roots.push(root);
  const repository = join(root, 'repository');
  const binary = join(root, 'bin');
  await mkdir(repository);
  await mkdir(binary);
  await writeFile(join(repository, 'package.json'), '{"name":"app","scripts":{"test":"jest"}}');
  await writeFile(join(repository, 'index.js'), 'module.exports = 1;\n');
  await execute('git', ['init', '-q', repository]);
  await execute('git', ['-C', repository, 'add', '.']);
  await execute('git', [
    '-C',
    repository,
    '-c',
    'user.name=Refit Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'test: seed',
  ]);
  await writeFile(
    join(binary, 'docker'),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'image') { console.log(args[3] === '{{.Id}}' ? 'sha256:${'a'.repeat(64)}' : JSON.stringify(['NODE_VERSION=22.23.3'])); process.exit(0); }
if (args[0] === 'rm' || args[0] === 'ps') process.exit(0);
${check}
`,
  );
  await chmod(join(binary, 'docker'), 0o755);
  vi.stubEnv('PATH', binary + delimiter + process.env.PATH);
  return validateSourcePatch({
    repository,
    propose: async () =>
      'diff --git a/index.js b/index.js\n--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-module.exports = 1;\n+module.exports = 2;\n',
    image: 'node:22-alpine',
    ...options,
  });
}

// Every check prints `output` and exits 1, as a failing baseline does.
const failingChecks = (output: string) =>
  validated(`process.stdout.write(${JSON.stringify(output)});\nprocess.exit(1);`, {
    command: ['npm', 'test'],
  });

const CHAIN = [
  'sh',
  '-c',
  `npm test || echo '${TESTS_FAILED}'; echo '${TYPE_CHECK_STARTED}'; ${TYPE_CHECK.join(' ')}`,
  'refit-check',
];
type Side = { tests: string; stderr?: string; typeCheck: string; exitCode: number };
// A tests-then-type-check chain whose tests print `tests` and fail, then whose type check prints
// `typeCheck` and exits with `exitCode`, on the original code and on the patch (mounted from
// candidate/).
const chainChecks = (baseline: Side, patched: Side) =>
  validated(
    `const side = args.some((arg) => arg.includes('/candidate,dst=/input')) ? ${JSON.stringify(patched)} : ${JSON.stringify(baseline)};
process.stdout.write(side.tests + ${JSON.stringify(`${TESTS_FAILED}\n${TYPE_CHECK_STARTED}\n`)} + side.typeCheck);
process.stderr.write(side.stderr ?? '');
process.exit(side.exitCode);`,
    { command: CHAIN, compareTypeErrors: true },
  );

it('records the named stop for a baseline that fails for a setup reason', async () => {
  // JensenMPillay/pdfai's baseline (docs/PREPARATION-FAILURES.md).
  const result = await failingChecks(
    '> jest\n\nNo tests found, exiting with code 1\nRun with `--passWithNoTests` to exit with code 0\n',
  );
  expect(result).toMatchObject({
    status: 'baseline-failed',
    baselineStop: {
      reason: 'no-tests-found',
      action: expect.stringContaining('In .refit.json, set "command" and "baselineCommand"'),
    },
  });
});

// What the tests of a chain printed in refit-bench run 40236299492.
const NO_JEST_TESTS =
  '> jest\n\nNo tests found, exiting with code 1\nRun with `--passWithNoTests` to exit with code 0\n';

it('runs only the type check of a chain whose test script finds no test files', async () => {
  // JensenMPillay/pdfai at 76eee198ded23bf4fafba0e2d431cf01d2f60290: `jest` has no test file to
  // run, and tsc passes on both sides.
  const pdfai = await chainChecks(
    { tests: NO_JEST_TESTS, typeCheck: '', exitCode: 0 },
    { tests: NO_JEST_TESTS, typeCheck: '', exitCode: 0 },
  );
  expect(pdfai).toMatchObject({
    status: 'passed',
    baseline: { status: 'passed' },
    patched: { status: 'passed' },
  });
  expect(pdfai).not.toHaveProperty('baselineStop');
  // The runner's own result stays in the evidence.
  expect('baseline' in pdfai && pdfai.baseline.stdout).toContain(
    'No tests found, exiting with code 1',
  );
  // JiantaoFu/insightly at e752d3c311780e3e11ec9738b16a4f6a549cb321: `mocha` finds no ./test, and
  // the type errors the original code already has are its baseline.
  const before = "server/index.js(12,7): error TS2339: Property 'x' does not exist on type '{}'.\n";
  const mocha = {
    tests: '\n> insightly@0.0.0 test\n> mocha\n\n',
    stderr: '\u001b[31mError: No test files found: "test"\u001b[39m\n',
    typeCheck: before,
    exitCode: 2,
  };
  expect((await chainChecks(mocha, mocha)).status).toBe('passed');
  // Panda2Chan/ai-asmr at cbaf6a28512730839a9a0d72a852416e97f0f0dc: the patch introduces a type
  // error, so it is a regression.
  const introduced = `src/lib/stripe.ts(6,3): error TS2322: Type '"2026-09-30.endive"' is not assignable to type '"2023-10-16"'.`;
  const asmr = await chainChecks(
    { tests: NO_JEST_TESTS, typeCheck: '', exitCode: 0 },
    { tests: NO_JEST_TESTS, typeCheck: `${introduced}\n`, exitCode: 2 },
  );
  expect(asmr).toMatchObject({
    status: 'regression',
    checkFailures: [{ side: 'patched', part: 'type check', firstFailure: introduced }],
  });
});

it('keeps tests that fail any other way as failing', async () => {
  const failing = 'FAIL src/payments.test.ts\n  expected 2 to be 3\n';
  expect(
    (
      await chainChecks(
        { tests: failing, typeCheck: '', exitCode: 0 },
        { tests: failing, typeCheck: '', exitCode: 0 },
      )
    ).status,
  ).toBe('baseline-failed');
  // Tests that fail on the patch for another reason fail it, even where the original found none.
  expect(
    (
      await chainChecks(
        { tests: NO_JEST_TESTS, typeCheck: '', exitCode: 0 },
        { tests: "Error: Cannot find module 'next/jest'\n", typeCheck: '', exitCode: 0 },
      )
    ).status,
  ).toBe('regression');
});

it('records no stop when the baseline fails in the code itself', async () => {
  const result = await failingChecks('FAIL src/payments.test.ts\n  expected 2 to be 3\n');
  expect(result.status).toBe('baseline-failed');
  expect(result).not.toHaveProperty('baselineStop');
});

it('names the failing baseline check and its first failure when no setup stop matches', async () => {
  const result = await failingChecks('FAIL src/payments.test.ts\n  expected 2 to be 3\n');
  expect(result).toMatchObject({
    checkFailures: [
      {
        side: 'baseline',
        command: 'npm test',
        status: 'failed',
        firstFailure: 'FAIL src/payments.test.ts',
        reported: { passed: 0, failed: 1 },
      },
    ],
  });
  expect('checkFailures' in result && checkFailureText(result)).toBe(
    ' The baseline check npm test fails on the original code, before any change; the first failure: FAIL src/payments.test.ts. It reported 0 passing and 1 failing.',
  );
});

it('reports how far a suite got before the time limit stopped it', () => {
  // beindigital-products/wedillybird's baseline in run 40077373087: `vitest run` passed 95 test
  // files, then stopped at 120 seconds (excerpt, colours as the sandbox printed them).
  const stdout = [
    '> wedillybird@0.1.0 test /workspace',
    '> vitest run',
    '',
    ' \u001b[32m✓\u001b[39m tests/integration/affiliate-attribution.test.ts \u001b[2m(\u001b[22m\u001b[2m28 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[32m 522\u001b[2mms\u001b[22m\u001b[39m',
    ' \u001b[32m✓\u001b[39m tests/unit/api/cron-entitlement-audit.test.ts \u001b[2m(\u001b[22m\u001b[2m4 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[32m 58\u001b[2mms\u001b[22m\u001b[39m',
  ].join('\n');
  const failure = checkFailure('baseline', ['pnpm', 'test'], {
    status: 'error',
    exitCode: null,
    stdout,
    stderr:
      "Another connection wants to delete database 'wedillybird-checkin-queue'. Closing db now to resume the delete request.\n",
    error: 'Check exceeded 120 seconds; the container was stopped.',
  });
  expect(failure).toEqual({
    side: 'baseline',
    command: 'pnpm test',
    status: 'error',
    error: 'Check exceeded 120 seconds; the container was stopped.',
    reported: { passed: 2, failed: 0 },
  });
  expect(checkFailureText({ checkFailures: [failure!] })).toBe(
    ' The baseline check pnpm test did not finish (Check exceeded 120 seconds; the container was stopped). Before it stopped, it reported 2 passing and 0 failing.',
  );
  expect(
    checkFailure('patched', TYPE_CHECK_COMMAND, {
      status: 'passed',
      exitCode: 0,
      stdout: '',
      stderr: '',
    }),
  ).toBeUndefined();
});

it('names the part of a tests-then-type-check chain that failed, with its own first failure', () => {
  const command = [
    'sh',
    '-c',
    `npm test || echo '${TESTS_FAILED}'; echo '${TYPE_CHECK_STARTED}'; ${TYPE_CHECK.join(' ')}`,
    'refit-check',
  ];
  const check = (stdout: string) =>
    ({ status: 'failed', exitCode: 1, stdout, stderr: '' }) as const;
  // The type check after failing tests prints a baseline error; the tests' failure is named.
  expect(
    checkFailure(
      'baseline',
      command,
      check(
        `FAIL src/payments.test.ts\n${TESTS_FAILED}\n${TYPE_CHECK_STARTED}\nsrc/a.ts(3,7): error TS2322: x\n`,
      ),
    ),
  ).toEqual({
    side: 'baseline',
    command: 'npm test',
    part: 'tests',
    status: 'failed',
    firstFailure: 'FAIL src/payments.test.ts',
    reported: { passed: 0, failed: 1 },
  });
  // A passing suite may log errors; the type check's failure is the first line after its start.
  expect(
    checkFailure(
      'baseline',
      command,
      check(
        `✓ src/payments.test.ts\nTypeError: logged by a passing test\n${TYPE_CHECK_STARTED}\nnpm error could not determine executable to run\n`,
      ),
    ),
  ).toEqual({
    side: 'baseline',
    command: TYPE_CHECK.join(' '),
    part: 'type check',
    status: 'failed',
    firstFailure: 'npm error could not determine executable to run',
  });
  const introduced =
    "src/billing.ts(4,9): error TS2339: Property 'plan' does not exist on type 'Subscription'.";
  expect(
    checkFailure(
      'patched',
      command,
      check(
        `${INTRODUCED_TYPE_ERRORS}${introduced}\n\n✓ src/payments.test.ts\n${TYPE_CHECK_STARTED}\n${introduced}\n`,
      ),
    ),
  ).toEqual({
    side: 'patched',
    command: TYPE_CHECK.join(' '),
    part: 'type check',
    status: 'failed',
    firstFailure: introduced,
  });
});
