import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { validateSourcePatch } from './validation.ts';

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
if (args[0] === 'image') { console.log('sha256:${'a'.repeat(64)}'); process.exit(0); }
if (args[0] === 'rm') process.exit(0);
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
