import { execFile } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareDependencies } from './dependency-preparation.ts';
import { PipelineInputError } from './types.ts';
import { validateMigration } from './validation.ts';

vi.mock('./docker-sandbox.ts', async (original) => ({
  ...(await original<typeof import('./docker-sandbox.ts')>()),
  resolveDockerImage: vi.fn(async () => `sha256:${'e'.repeat(64)}`),
}));
vi.mock('./dependency-preparation.ts', async (original) => ({
  ...(await original<typeof import('./dependency-preparation.ts')>()),
  prepareDependencies: vi.fn(),
}));

const execute = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function options() {
  const root = await mkdtemp(join(tmpdir(), 'refit-untested-'));
  roots.push(root);
  await cp(resolve('pipeline/fixtures/repository'), root, { recursive: true });
  await execute('git', ['init', '-q', root]);
  await execute('git', ['-C', root, 'add', '.']);
  await execute('git', [
    '-C',
    root,
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
  return {
    repository: root,
    before: resolve('pipeline/fixtures/before.json'),
    after: resolve('pipeline/fixtures/after.json'),
    apiVersion: '2022-08-01',
    image: 'node:22-alpine',
    command: ['npm', 'test'],
    prepareDependencies: true,
  };
}

it('returns the patch untested on a repository-side preparation failure only when asked', async () => {
  const input = await options();
  const outOfSync = new PipelineInputError(
    'package.json dependencies differ from the committed package-lock.json: stripe is "11.0.0" in package.json but missing in the lockfile. Run npm install and commit the updated package-lock.json.',
  );
  vi.mocked(prepareDependencies).mockRejectedValue(outOfSync);
  await expect(validateMigration(input)).rejects.toBe(outOfSync);

  const report = await validateMigration({ ...input, recordDependencyFailures: true });
  expect(report.validation).toMatchObject({
    status: 'untested',
    baseline: { status: 'not-run' },
    patched: { status: 'not-run' },
    dependencyFailure: { reason: 'lockfile-out-of-sync' },
    repair: { stopReason: 'dependencies-unavailable' },
  });
  expect(report.patch.validation).toBe('untested');
  expect(report.publicationFiles.map((file) => file.path)).toEqual(['billing.ts']);

  // Docker, network and other failures still stop validation.
  const sandbox = new PipelineInputError('Dependency preparation exceeded 300 seconds.');
  vi.mocked(prepareDependencies).mockRejectedValue(sandbox);
  await expect(validateMigration({ ...input, recordDependencyFailures: true })).rejects.toBe(
    sandbox,
  );
});
