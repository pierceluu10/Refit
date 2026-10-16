import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { repositoryDependencyFailure } from './dependency-preparation.ts';
import { publishDraft } from './publication.ts';
import { runPipeline } from './run.ts';
import { digest } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import { validateMigration } from './validation.ts';
import { runWorkflow } from './workflow.ts';

vi.mock('./validation.ts', () => ({ validateMigration: vi.fn() }));
vi.mock('./publication.ts', async (original) => ({
  ...(await original<typeof import('./publication.ts')>()),
  publishDraft: vi.fn(async () => ({ status: 'created', url: 'https://github.com/o/r/pull/1' })),
}));

const roots: string[] = [];
const inputs = {
  repository: resolve('pipeline/fixtures/repository'),
  before: resolve('pipeline/fixtures/before.json'),
  after: resolve('pipeline/fixtures/after.json'),
  apiVersion: '2022-08-01',
  image: 'node:22-alpine',
  command: ['npm', 'test'],
};

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function output() {
  const root = await mkdtemp(join(tmpdir(), 'refit-workflow-waiver-'));
  roots.push(root);
  return join(root, 'run');
}

async function untested(status = 'untested') {
  const scan = await runPipeline({ ...inputs, proposePatch: true });
  if (!('diff' in scan.patch)) throw new Error('Expected fixture patch');
  const notRun = { status: 'not-run', exitCode: null, stdout: '', stderr: '' };
  return {
    ...scan,
    patch: { ...scan.patch, validation: status },
    publicationFiles: [{ path: 'billing.ts', mode: '100644', content: 'patched' }],
    validation: {
      status,
      revision: 'a'.repeat(40),
      command: inputs.command,
      baselineCommand: inputs.command,
      patchHash: digest(scan.patch.diff),
      baseline: notRun,
      patched: notRun,
      dependencyFailure: repositoryDependencyFailure(
        new PipelineInputError(
          'The repository commits package.json without a lockfile, so the dependency versions to verify are unknown. Run npm install, pnpm install or yarn install and commit the package-lock.json, pnpm-lock.yaml or yarn.lock it writes.',
        ),
      ),
    },
  } as unknown as Awaited<ReturnType<typeof validateMigration>>;
}

it('saves an untested patch as a [Needs review] draft only with --publish-unresolved', async () => {
  vi.mocked(validateMigration).mockResolvedValue(await untested());
  const refused = await runWorkflow({ ...inputs, output: await output() });
  expect(refused.manifest).toMatchObject({ status: 'validation-failed' });
  expect(refused.manifest).not.toHaveProperty('waivedGates');

  const local = await output();
  const saved = await runWorkflow({ ...inputs, output: local, allowUnresolved: true });
  expect(saved.manifest).toMatchObject({
    status: 'needs-review',
    waivedGates: ['dependency-preparation'],
  });
  expect(vi.mocked(validateMigration).mock.calls[1][0]).toMatchObject({
    recordDependencyFailures: true,
    leaveRequestParameters: true,
  });
  const body = await readFile(join(local, 'pull-request.md'), 'utf8');
  expect(body).toMatch(/^## Untested: checks did not run/);
  expect(body).toContain('the repository has no committed lockfile');
  expect(publishDraft).not.toHaveBeenCalled();

  const published = await runWorkflow({
    ...inputs,
    output: await output(),
    publication: { repository: 'o/r', base: 'main', token: 'unused', allowUnresolved: true },
  });
  expect(published.manifest).toMatchObject({ status: 'draft-created' });
  expect(publishDraft).toHaveBeenCalledOnce();
});

it('never saves or publishes a regression, even with --publish-unresolved', async () => {
  vi.mocked(validateMigration).mockResolvedValue(await untested('regression'));
  const result = await runWorkflow({
    ...inputs,
    output: await output(),
    publication: { repository: 'o/r', base: 'main', token: 'unused', allowUnresolved: true },
  });
  expect(result.manifest).toMatchObject({ status: 'validation-failed' });
  expect(result.manifest).not.toHaveProperty('waivedGates');
  expect(publishDraft).not.toHaveBeenCalled();
});
