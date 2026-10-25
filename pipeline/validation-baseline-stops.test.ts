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

// A docker stand-in whose every check prints `output` and exits 1, as a failing baseline does.
async function failingChecks(output: string) {
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
process.stdout.write(${JSON.stringify(output)});
process.exit(1);
`,
  );
  await chmod(join(binary, 'docker'), 0o755);
  vi.stubEnv('PATH', binary + delimiter + process.env.PATH);
  return validateSourcePatch({
    repository,
    propose: async () =>
      'diff --git a/index.js b/index.js\n--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-module.exports = 1;\n+module.exports = 2;\n',
    image: 'node:22-alpine',
    command: ['npm', 'test'],
  });
}

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
    `npm test || { echo '${TESTS_FAILED}'; exit 1; }; echo '${TYPE_CHECK_STARTED}'; ${TYPE_CHECK.join(' ')}`,
  ];
  const check = (stdout: string) =>
    ({ status: 'failed', exitCode: 1, stdout, stderr: '' }) as const;
  expect(
    checkFailure('baseline', command, check(`FAIL src/payments.test.ts\n${TESTS_FAILED}\n`)),
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
