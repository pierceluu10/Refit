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
  vi.unstubAllGlobals();
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

it.skipIf(!process.env.REFIT_DOCKER_IMAGE)(
  'records why the changed modules cannot run on stripe alone when preparation is refused, with no model request',
  async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    vi.mocked(prepareDependencies).mockRejectedValue(
      new PipelineInputError(
        'package.json dependencies differ from the committed package-lock.json: stripe is "11.0.0" in package.json but missing in the lockfile. Run npm install and commit the updated package-lock.json.',
      ),
    );
    const input = await options();
    const behaviourTestWriter = { apiKey: 'test-key', model: 'gpt-6.1-sol' };
    // billing.ts imports only stripe, but there is no package-lock.json to take stripe's closure from.
    const report = await validateMigration({ ...input, behaviourTestWriter });
    expect(report.validation).toMatchObject({
      status: 'untested',
      dependencyFailure: { reason: 'lockfile-out-of-sync' },
      stripeOnly: {
        status: 'not-preparable',
        reasons: ['Only an npm package-lock.json records the stripe closure Refit installs.'],
      },
    });
    // No request is built; the writer's record says why.
    expect(report.validation).toMatchObject({
      behaviourTestWriter: {
        status: 'skipped',
        reason:
          'Dependencies could not be prepared, and the changed Stripe code cannot run on stripe alone: Only an npm package-lock.json records the stripe closure Refit installs.',
      },
    });
    expect(fetcher).not.toHaveBeenCalled();
  },
);
