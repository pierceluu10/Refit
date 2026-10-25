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

async function validate(scenario: keyof typeof SCENARIOS) {
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
    generatedChecks: {
      stripeMockImage: 'stripe/stripe-mock:latest',
      beforeFixtures: resolve('pipeline/fixtures/before.json'),
      afterFixtures: resolve('pipeline/fixtures/after.json'),
    },
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
