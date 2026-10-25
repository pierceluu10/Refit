import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { preparationFailure } from './dependency-preparation.ts';
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
      dependencyFailure: preparationFailure(
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
    recordUntested: true,
    leaveReviewedFindings: true,
  });
  const body = await readFile(join(local, 'pull-request.md'), 'utf8');
  expect(body).toMatch(/^## Why this needs review\n/);
  expect(body).toContain('\n## Untested: checks did not run\n');
  expect(body).toContain('the repository has no committed lockfile');
  expect(publishDraft).not.toHaveBeenCalled();

  const send = vi.fn(async () => {});
  const published = await runWorkflow({
    ...inputs,
    output: await output(),
    publication: { repository: 'o/r', base: 'main', token: 'unused', allowUnresolved: true },
    notify: { send },
  });
  expect(published.manifest).toMatchObject({ status: 'draft-created' });
  expect(publishDraft).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledExactlyOnceWith(
    '📝 o/r: [Needs review] draft PR ready https://github.com/o/r/pull/1',
  );
});

it('sends an [URGENT] notice when publication fails partway', async () => {
  vi.mocked(validateMigration).mockResolvedValue(await untested());
  vi.mocked(publishDraft).mockRejectedValueOnce(new Error('GitHub returned HTTP 502.'));
  const send = vi.fn(async () => {});
  const result = await runWorkflow({
    ...inputs,
    output: await output(),
    publication: { repository: 'o/r', base: 'main', token: 'unused', allowUnresolved: true },
    notify: { send },
  });
  expect(result.manifest).toMatchObject({ status: 'error', stage: 'publication' });
  expect(send).toHaveBeenCalledExactlyOnceWith(
    '🚨 [URGENT] o/r: publication failed partway (GitHub returned HTTP 502.); a remote branch or draft PR may remain, reconcile before retrying.',
  );
});

it('never saves or publishes a regression, even with --publish-unresolved', async () => {
  vi.mocked(validateMigration).mockResolvedValue(await untested('regression'));
  const send = vi.fn(async () => {});
  const result = await runWorkflow({
    ...inputs,
    output: await output(),
    publication: { repository: 'o/r', base: 'main', token: 'unused', allowUnresolved: true },
    notify: { send },
  });
  expect(result.manifest).toMatchObject({ status: 'validation-failed' });
  expect(result.manifest).not.toHaveProperty('waivedGates');
  expect(publishDraft).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledExactlyOnceWith(
    "🚨 [URGENT] o/r: the patch breaks the repository's own checks (regression); not published.",
  );
});

// Owner decision 1: checks that fail on the original code say nothing about the patch, which is
// published untested; a check that ran on the patch and did not pass never publishes.
it('publishes a patch untested when the baseline fails, and never when a check failed on it', async () => {
  const baselineFailed = await untested('baseline-failed');
  delete (baselineFailed.validation as { dependencyFailure?: unknown }).dependencyFailure;
  baselineFailed.validation.baseline = { status: 'failed', exitCode: 1, stdout: '', stderr: '' };
  vi.mocked(validateMigration).mockResolvedValue(baselineFailed);
  const refused = await runWorkflow({ ...inputs, output: await output() });
  expect(refused.manifest).toMatchObject({ status: 'validation-failed' });

  const local = await output();
  const saved = await runWorkflow({ ...inputs, output: local, allowUnresolved: true });
  expect(saved.manifest).toMatchObject({
    status: 'needs-review',
    waivedGates: ['baseline-failed'],
  });
  const body = await readFile(join(local, 'pull-request.md'), 'utf8');
  expect(body).toContain(
    '- `npm test` does not pass on the original code, so the checks say nothing about this patch and Refit did not run them on it.',
  );
  const published = await runWorkflow({
    ...inputs,
    output: await output(),
    publication: { repository: 'o/r', base: 'main', token: 'unused', allowUnresolved: true },
  });
  expect(published.manifest).toMatchObject({ status: 'draft-created' });

  // A baseline stopped at the time limit did not finish, rather than failed.
  const timedOut = await untested('error');
  delete (timedOut.validation as { dependencyFailure?: unknown }).dependencyFailure;
  timedOut.validation.baseline = {
    status: 'error',
    exitCode: null,
    stdout: '',
    stderr: '',
    error: 'Check exceeded 120 seconds; the container was stopped.',
  };
  vi.mocked(validateMigration).mockResolvedValue(timedOut);
  const stopped = await output();
  expect(
    (await runWorkflow({ ...inputs, output: stopped, allowUnresolved: true })).manifest,
  ).toMatchObject({ status: 'needs-review', waivedGates: ['baseline-failed'] });
  expect(await readFile(join(stopped, 'pull-request.md'), 'utf8')).toContain(
    '- `npm test` did not finish on the original code, so the checks say nothing about this patch and Refit did not run them on it. **Check:** Make `npm test` finish and pass on the base branch',
  );

  // A generated check that fails on the original code while the patched checks ran.
  const generated = await untested('baseline-failed');
  delete (generated.validation as { dependencyFailure?: unknown }).dependencyFailure;
  const ran = { status: 'passed' as const, exitCode: 0, stdout: '', stderr: '' };
  generated.validation.baseline = ran;
  generated.validation.patched = ran;
  vi.mocked(validateMigration).mockResolvedValue(generated);
  vi.mocked(publishDraft).mockClear();
  const kept = await runWorkflow({
    ...inputs,
    output: await output(),
    publication: { repository: 'o/r', base: 'main', token: 'unused', allowUnresolved: true },
  });
  expect(kept.manifest).toMatchObject({ status: 'validation-failed' });
  expect(publishDraft).not.toHaveBeenCalled();
});

it('marks a passing AI patch for review and adds refit doctor findings to its reasons', async () => {
  const passing = await untested('passed');
  delete (passing.validation as { dependencyFailure?: unknown }).dependencyFailure;
  const ran = { status: 'passed' as const, exitCode: 0, stdout: '', stderr: '' };
  passing.validation.baseline = ran;
  passing.validation.patched = ran;
  passing.patch.generator = 'openai' as typeof passing.patch.generator;
  vi.mocked(validateMigration).mockResolvedValue(passing);
  const doctor = [
    {
      id: 'source-resolution',
      title: 'Shared client resolution',
      status: 'blocked' as const,
      detail: 'tsconfig.json extends a package Refit cannot read.',
      action: 'Check the clients shared between files.',
    },
  ];
  const send = vi.fn(async () => {});
  const local = await output();
  const result = await runWorkflow({
    ...inputs,
    output: local,
    doctor,
    publication: {
      repository: 'o/r',
      base: 'main',
      token: 'ghs_never_in_a_body',
      allowUnresolved: true,
    },
    notify: { send },
  });
  expect(result.manifest).toMatchObject({
    status: 'draft-created',
    waivedGates: ['ai-patch', 'doctor'],
  });
  expect(vi.mocked(publishDraft).mock.calls[0][2]).toBe(doctor);
  const body = await readFile(join(local, 'pull-request.md'), 'utf8');
  expect(body).toContain(
    '- refit doctor, Shared client resolution: tsconfig.json extends a package Refit cannot read. **Check:** Check the clients shared between files.',
  );
  expect(send).toHaveBeenCalledExactlyOnceWith(
    '📝 o/r: [Needs review] draft PR ready https://github.com/o/r/pull/1',
  );
  for (const file of [...result.manifest.files.map((entry) => entry.path), 'manifest.json'])
    expect(await readFile(join(local, file), 'utf8')).not.toContain('ghs_never_in_a_body');

  // Without --publish-unresolved the doctor findings change nothing.
  vi.mocked(publishDraft).mockClear();
  const plain = await runWorkflow({
    ...inputs,
    output: await output(),
    doctor,
    publication: { repository: 'o/r', base: 'main', token: 'unused' },
  });
  expect(plain.manifest).not.toHaveProperty('waivedGates');
  expect(vi.mocked(publishDraft).mock.calls[0][2]).toBe(doctor);
});
