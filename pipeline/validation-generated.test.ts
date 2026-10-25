import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { checkFailureText } from './check-failures.ts';
import { validateMigration } from './validation.ts';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const ENTRY = 'billing.ts#chargeHistory';
const result = (value: object) => `REFIT_GENERATED_RESULT=${JSON.stringify(value)}`;
// What each side of the generated check prints and exits with; the repository checks always pass.
const SCENARIOS = {
  // No local stripe/stripe-mock image: Refit never pulls it.
  'no-image': undefined,
  // The after-version container failed to start.
  'container-error': {
    before: { stdout: `${result({ id: ENTRY, ok: true })}\nREFIT_GENERATED_DONE`, exit: 0 },
    after: {
      stdout: '',
      stderr: 'docker: Error response from daemon: OCI runtime error',
      exit: 125,
    },
  },
  regression: {
    before: { stdout: `${result({ id: ENTRY, ok: true })}\nREFIT_GENERATED_DONE`, exit: 0 },
    after: {
      stdout: `${result({ id: ENTRY, ok: false, phase: 'call', error: "TypeError: Cannot read properties of undefined (reading 'data')" })}\nREFIT_GENERATED_DONE`,
      exit: 0,
    },
  },
} as const;

const TEST_ID = 'refit-behaviour/billing.test.mjs > lists the charges of a payment';
const behaviourOutput = (test: object) =>
  [
    `REFIT_BEHAVIOUR_TEST=${JSON.stringify({ file: 'refit-behaviour/billing.test.mjs', id: TEST_ID, ...test })}`,
    'REFIT_BEHAVIOUR_EXIT=0',
    'REFIT_BEHAVIOUR_COVERAGE={}',
    'REFIT_BEHAVIOUR_DONE',
  ].join('\n');
// What each side's behaviour-test sandbox prints: the test passes on the original code and fails an
// assertion on the patched code.
const BEHAVIOUR = {
  before: behaviourOutput({ ok: true }),
  after: behaviourOutput({
    ok: false,
    phase: 'test',
    error: 'AssertionError: Expected values to be strictly equal: 2 !== 0',
  }),
};
const BEHAVIOUR_TESTS = [
  {
    path: 'refit-behaviour/billing.test.mjs',
    content: "import test from 'node:test';\ntest('lists the charges of a payment', () => {});\n",
  },
];

async function validate(scenario: keyof typeof SCENARIOS, behaviour = false) {
  const root = await mkdtemp(join(tmpdir(), 'refit-generated-validation-'));
  roots.push(root);
  const repository = join(root, 'repository');
  const binary = join(root, 'bin');
  await cp(resolve('pipeline/fixtures/repository'), repository, { recursive: true });
  await mkdir(binary);
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
    '-qm',
    'test: seed repository',
  ]);
  await writeFile(
    join(binary, 'docker'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const sides = ${JSON.stringify(SCENARIOS[scenario] ?? null)};
if (args[0] === 'image') {
  if (args.includes('stripe/stripe-mock:latest') && !sides) {
    console.error('Error response from daemon: No such image: stripe/stripe-mock:latest');
    process.exit(1);
  }
  console.log(args[3] === '{{.Id}}' ? 'sha256:${'d'.repeat(64)}' : JSON.stringify(['NODE_VERSION=22.23.3']));
  process.exit(0);
}
if (args[0] === 'info') { console.log(${16 * 1024 ** 3}); process.exit(0); }
if (args[0] === 'rm' || args[0] === 'create' || args[0] === 'ps') process.exit(0);
if (args[0] === 'cp') { fs.writeFileSync(args[2], 'stripe-mock'); process.exit(0); }
const contract = args.find((arg) => arg.includes('dst=/refit/spec.json'));
if (!contract) process.exit(0);
if (args.some((arg) => arg.includes('behaviour.mjs'))) {
  process.stdout.write(${JSON.stringify(BEHAVIOUR)}[contract.includes('before-spec.json') ? 'before' : 'after']);
  process.exit(0);
}
const side = sides[contract.includes('before-spec.json') ? 'before' : 'after'];
process.stdout.write(side.stdout);
if (side.stderr) process.stderr.write(side.stderr);
process.exit(side.exit);
`,
  );
  await chmod(join(binary, 'docker'), 0o755);
  vi.stubEnv('PATH', binary + delimiter + process.env.PATH);
  return validateMigration({
    repository,
    before: resolve('pipeline/fixtures/before.json'),
    after: resolve('pipeline/fixtures/after.json'),
    apiVersion: '2022-08-01',
    image: 'node:22-alpine',
    command: ['npm', 'test'],
    ...(behaviour ? { behaviourTests: BEHAVIOUR_TESTS } : {}),
    ...(SCENARIOS[scenario] || !behaviour
      ? {
          generatedChecks: {
            stripeMockImage: 'stripe/stripe-mock:latest',
            beforeFixtures: resolve('pipeline/fixtures/before.json'),
            afterFixtures: resolve('pipeline/fixtures/after.json'),
          },
        }
      : {}),
  });
}

it('keeps a passing validation when the generated check cannot be set up or its container fails', async () => {
  const missing = await validate('no-image');
  expect(missing.validation).toMatchObject({
    status: 'passed',
    generated: { status: 'unavailable', regressions: [] },
  });
  expect(missing.validation.generated?.reason).toBe(
    'Generated checks could not be set up: Error response from daemon: No such image: stripe/stripe-mock:latest',
  );
  expect(missing.validation.checkFailures).toBeUndefined();
  const failed = await validate('container-error');
  expect(failed.validation).toMatchObject({
    status: 'passed',
    generated: { status: 'unavailable', regressions: [] },
  });
  expect(failed.validation.generated?.reason).toMatch(/^The after-version run did not finish: /);
});

it('fails validation on a generated function that completed before and threw after, and names it', async () => {
  const report = await validate('regression');
  expect(report.validation).toMatchObject({
    status: 'regression',
    patched: { status: 'passed' },
    generated: {
      status: 'regression',
      regressions: [
        {
          id: ENTRY,
          phase: 'call',
          error: "TypeError: Cannot read properties of undefined (reading 'data')",
        },
      ],
    },
  });
  expect(checkFailureText(report.validation)).toBe(
    " The patched check billing.ts#chargeHistory (generated stripe-mock check, which completed on the original code) fails on the migrated code; the first failure: TypeError: Cannot read properties of undefined (reading 'data').",
  );
});

it('fails validation on a behaviour test that passed before and fails after, and keeps passing when behaviour tests cannot run', async () => {
  const regressed = await validate('container-error', true);
  expect(regressed.validation).toMatchObject({
    status: 'regression',
    generated: { status: 'unavailable' },
    behaviour: {
      status: 'regression',
      grade: null,
      regressions: [
        { id: TEST_ID, error: 'AssertionError: Expected values to be strictly equal: 2 !== 0' },
      ],
      tests: [
        {
          path: 'refit-behaviour/billing.test.mjs',
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ],
    },
  });
  expect(checkFailureText(regressed.validation)).toBe(
    ` The patched check ${TEST_ID} (behaviour test, which passed on the original code) fails on the migrated code; the first failure: AssertionError: Expected values to be strictly equal: 2 !== 0.`,
  );
  // Without generatedChecks there is no stripe-mock image or fixtures to run them against.
  const unconfigured = await validate('no-image', true);
  expect(unconfigured.validation).toMatchObject({
    status: 'passed',
    behaviour: {
      status: 'unavailable',
      reason:
        "Behaviour tests could not run: Behaviour tests need generatedChecks settings: a local stripe-mock image and both versions' fixtures.",
      grade: null,
    },
  });
  expect(unconfigured.validation.grade?.reason).toContain(
    'Behaviour tests did not give grade A: Behaviour tests could not run:',
  );
});
