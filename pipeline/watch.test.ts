import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { watchCarryOver, watchedApiVersions, watchOnce } from './watch.ts';
import { runWorkflow } from './workflow.ts';
import { documentationSourceId } from './documentation-sources.ts';
import { compareOpenApi } from './openapi-diff.ts';

vi.mock('./workflow.ts', () => ({ runWorkflow: vi.fn() }));
vi.mock('./openapi-diff.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./openapi-diff.ts')>()),
  compareOpenApi: vi.fn(),
}));
const execute = promisify(execFile);
const roots: string[] = [];
async function options() {
  const root = await mkdtemp(join(tmpdir(), 'refit-watch-test-'));
  roots.push(root);
  const after = join(root, 'after.json');
  await writeFile(after, await readFile('pipeline/fixtures/after.json', 'utf8'));
  return {
    stateDirectory: join(root, 'state'),
    source: { kind: 'file' as const, path: after },
    configuration: {
      repository: resolve('pipeline/fixtures/repository'),
      before: resolve('pipeline/fixtures/before.json'),
      image: 'node:22-alpine',
      command: ['node', '--version'],
      fullDiff: false,
    },
  };
}
function result(
  input: Parameters<typeof runWorkflow>[0],
  status: 'validated' | 'validation-failed' | 'up-to-date' | 'draft-created' = 'validated',
) {
  return {
    directory: input.output,
    manifest: {
      formatVersion: 1,
      kind: 'refit-workflow',
      status,
      stage: 'validation' as const,
      reason: 'Controlled worker result',
      runId: 'test',
      baselineAdvanced: false,
      reviewRequired: true,
      files: [],
      error: null,
    },
  };
}
afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('processes a change once across worker restarts and ignores documentation-only revisions', async () => {
  const input = await options();
  vi.mocked(runWorkflow).mockImplementation(async (value) => result(value));
  expect((await watchOnce(input)).status).toBe('processed');
  const again = await watchOnce({ ...input });
  expect(again.status).toBe('already-processed');
  const document = JSON.parse(await readFile(input.source.path, 'utf8'));
  document.info = { ...document.info, title: 'A documentation-only edit' };
  await writeFile(input.source.path, JSON.stringify(document));
  expect((await watchOnce(input)).status).toBe('already-processed');
  expect((await watchOnce({ ...input, retry: true })).status).toBe('already-processed');
  expect(runWorkflow).toHaveBeenCalledTimes(1);
  // A new release is a new target even when its changes are the same.
  document.info.version = '2023-08-16';
  await writeFile(input.source.path, JSON.stringify(document));
  expect((await watchOnce(input)).status).toBe('processed');
  expect(runWorkflow).toHaveBeenCalledTimes(2);
  expect(await readFile(join(input.stateDirectory, 'state.json'), 'utf8')).not.toContain('apiKey');
});

it('watches a committed root profile with an explicit local repository and deduplicates across CLI restarts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-watch-profile-'));
  roots.push(root);
  const repository = join(root, 'repository');
  await cp(resolve('pipeline/fixtures/repository'), repository, { recursive: true });
  for (const name of ['before.json', 'after.json'])
    await cp(resolve('pipeline/fixtures/before.json'), join(repository, name));
  const configuration = join(repository, '.refit.json');
  await writeFile(
    configuration,
    JSON.stringify({
      formatVersion: 1,
      before: './before.json',
      after: './after.json',
      apiVersion: '2022-08-01',
      image: 'unused-test-image',
      command: ['node', '--version'],
      fullDiff: false,
    }),
  );
  const git = (args: string[]) => execute('git', ['-C', repository, ...args]);
  await git(['init', '-b', 'main']);
  await git(['add', '.']);
  await git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'test: seed local profile',
  ]);
  const arguments_ = [
    resolve('bin/refit.mjs'),
    'watch',
    '--repository',
    repository,
    '--config',
    configuration,
    '--state',
    join(root, 'state'),
    '--once',
    '--json',
  ];
  const poll = async () => {
    try {
      await execute(process.execPath, arguments_, { cwd: root });
      throw new Error('Expected review exit for an unchanged contract');
    } catch (error) {
      expect(error).toMatchObject({ code: 2, stderr: expect.any(String) });
      return JSON.parse((error as { stdout: string }).stdout);
    }
  };
  const first = await poll();
  expect(first.status).toBe('processed');
  expect(first.result.manifest.status).toBe('needs-review');
  const repeated = await poll();
  expect(repeated.status).toBe('already-processed');
  expect(repeated.output).toBe(first.output);
  expect((await git(['status', '--porcelain'])).stdout).toBe('');
  await expect(
    execute(process.execPath, [...arguments_, '--sync-github'], { cwd: root }),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('Choose a local --repository or --sync-github'),
  });
  // Starts the CLI several times; shared CI runners can exceed the default 5s timeout.
}, 30_000);

it.each([true, false])(
  'creates a fresh worker job for an endpoint removed after deprecation (configured replacement: %s)',
  async (configuredReplacement) => {
    const input = await options();
    const root = dirname(input.source.path);
    const fixture = resolve('pipeline/fixtures/endpoint-replacement');
    const repository = join(root, 'repository');
    await cp(join(fixture, 'repository'), repository, { recursive: true });
    const git = (arguments_: string[]) => execute('git', ['-C', repository, ...arguments_]);
    await git(['init', '-b', 'main']);
    await git(['add', '.']);
    await git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'test: seed watcher catalog app',
    ]);
    const beforeDocument = JSON.parse(await readFile(join(fixture, 'before.json'), 'utf8'));
    beforeDocument.paths['/legacy/items/{id}'].get.deprecated = true;
    const before = join(root, 'before.json');
    await writeFile(before, JSON.stringify(beforeDocument));
    await writeFile(input.source.path, JSON.stringify(beforeDocument));
    const provider = JSON.parse(await readFile(join(fixture, 'provider.json'), 'utf8'));
    if (!configuredReplacement) delete provider.operationReplacements;
    const providerConfig = join(root, 'provider.json');
    await writeFile(providerConfig, JSON.stringify(provider));
    const configuration = {
      ...input.configuration,
      repository,
      before,
      providerConfig,
      apiVersion: '1',
      fullDiff: true,
    };
    vi.mocked(compareOpenApi)
      .mockReset()
      .mockResolvedValueOnce({
        engine: 'oasdiff',
        version: 'controlled',
        coverage: 'Controlled first poll.',
        changes: [],
      })
      .mockResolvedValue({
        engine: 'oasdiff',
        version: 'controlled',
        coverage: 'Controlled deprecated removal.',
        changes: [
          {
            id: 'api-path-removed-with-deprecation',
            text: 'api path removed with deprecation',
            level: 1,
            path: '/legacy/items/{id}',
            operation: 'GET',
          },
        ],
      });
    vi.mocked(runWorkflow).mockImplementation(async (value) => result(value));
    const first = await watchOnce({ ...input, configuration });
    await writeFile(input.source.path, await readFile(join(fixture, 'after.json'), 'utf8'));
    const removal = await watchOnce({ ...input, configuration });
    expect(removal.status).toBe('processed');
    expect(removal.jobKey).not.toBe(first.jobKey);
    expect((await watchOnce({ ...input, configuration })).status).toBe('already-processed');
    expect(runWorkflow).toHaveBeenCalledTimes(2);
  },
);

it('compares the next release with the target the code reached, across a carried-over state', async () => {
  const input = await options();
  const root = dirname(input.source.path);
  const repository = join(root, 'repository');
  await cp(input.configuration.repository, repository, { recursive: true });
  // billing.ts as a merged Refit draft leaves it: migrated reads and the pin moved to 2022-11-15.
  await writeFile(
    join(repository, 'billing.ts'),
    `import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2022-11-15' });
export async function chargeHistory(paymentIntentId: string) {
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
  return (await stripe.charges.list({ payment_intent: intent.id })).data;
}
`,
  );
  const git = (arguments_: string[]) => execute('git', ['-C', repository, ...arguments_]);
  await git(['init', '-b', 'main']);
  await git(['add', '.']);
  await git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'fix: merge the Refit draft',
  ]);
  const configuration = { ...input.configuration, repository, apiVersion: '2022-08-01' };
  vi.mocked(runWorkflow).mockImplementation(async (value) => result(value, 'up-to-date'));

  const reached = await watchOnce({ ...input, configuration });
  expect(reached).toMatchObject({
    status: 'processed',
    baselineAdvanced: { from: '2022-08-01', to: '2022-11-15' },
  });
  const state = JSON.parse(await readFile(join(input.stateDirectory, 'state.json'), 'utf8'));
  expect(state.baseline).toMatchObject({ hash: reached.sourceHash, apiVersion: '2022-11-15' });
  const baseline = join('snapshots', `${reached.sourceHash}.baseline.json`);
  expect(await watchCarryOver(input.stateDirectory)).toContain(baseline);
  expect(await watchedApiVersions(input.stateDirectory)).toEqual(['2022-11-15']);
  // A later commit before the next release is quiet and runs nothing.
  await writeFile(join(repository, 'README.md'), 'Billing\n');
  await git(['add', 'README.md']);
  await git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'docs: readme',
  ]);
  expect(await watchOnce({ ...input, configuration })).toMatchObject({
    status: 'already-processed',
    previousStatus: 'up-to-date',
    output: null,
  });
  expect(runWorkflow).toHaveBeenCalledTimes(1);

  // A job machine starts from the carried-over files only.
  const carried = join(root, 'carried');
  for (const file of await watchCarryOver(input.stateDirectory))
    await cp(join(input.stateDirectory, file), join(carried, file), { recursive: true });
  const release = JSON.parse(await readFile(input.source.path, 'utf8'));
  release.info.version = '2023-08-16';
  release.components.schemas.refund = {
    type: 'object',
    properties: { id: { type: 'string' } },
  };
  await writeFile(input.source.path, JSON.stringify(release));
  vi.mocked(runWorkflow).mockClear();
  vi.mocked(runWorkflow).mockImplementation(async (value) => result(value));
  const next = await watchOnce({ ...input, stateDirectory: carried, configuration });
  expect(next.status).toBe('processed');
  expect(next).not.toHaveProperty('baselineAdvanced');
  expect(await watchedApiVersions(carried)).toEqual(['2022-11-15', '2023-08-16']);
  expect(runWorkflow).toHaveBeenCalledTimes(1);
  expect(vi.mocked(runWorkflow).mock.calls[0][0]).toMatchObject({
    before: join(await realpath(carried), baseline),
    apiVersion: '2022-11-15',
  });
  // A baseline file that no longer matches the state stops the watcher.
  await writeFile(join(carried, baseline), await readFile('pipeline/fixtures/before.json'));
  await writeFile(
    input.source.path,
    JSON.stringify({
      ...release,
      info: { ...release.info, version: '2024-04-10' },
      components: { schemas: { ...release.components.schemas, dispute: { type: 'object' } } },
    }),
  );
  await expect(watchOnce({ ...input, stateDirectory: carried, configuration })).rejects.toThrow(
    'The advanced watch baseline does not match its recorded hash.',
  );
});

it('preserves failed jobs and permits one explicit retry with a fresh evidence directory', async () => {
  const input = await options();
  vi.mocked(runWorkflow).mockImplementation(async (value) => result(value, 'validation-failed'));
  const first = await watchOnce(input);
  // A reused job keeps why it ended, so the status a person reads still says it.
  expect(await watchOnce(input)).toMatchObject({
    status: 'already-processed',
    previousStatus: 'validation-failed',
    previousReason: 'Controlled worker result',
  });
  const retry = await watchOnce({ ...input, retry: true });
  expect(runWorkflow).toHaveBeenCalledTimes(2);
  expect(first.output).not.toBe(retry.output);
});

// As state from before a Refit upgrade records the job.
async function recordedEarlier(input: Awaited<ReturnType<typeof options>>, jobKey: string) {
  const path = join(input.stateDirectory, 'state.json');
  const state = JSON.parse(await readFile(path, 'utf8'));
  state.jobs[jobKey].refit = '0.0.1';
  await writeFile(path, JSON.stringify(state));
}

it('runs a draft job once more after a Refit release, then reuses it', async () => {
  const input = await options();
  vi.mocked(runWorkflow).mockImplementation(async (value) => result(value, 'draft-created'));
  const first = await watchOnce(input);
  expect(await watchOnce(input)).toMatchObject({ status: 'already-processed' });
  await recordedEarlier(input, first.jobKey);
  expect(await watchOnce(input)).toMatchObject({ status: 'processed', jobKey: first.jobKey });
  expect(await watchOnce(input)).toMatchObject({ status: 'already-processed' });
  expect(runWorkflow).toHaveBeenCalledTimes(2);
});

it('reuses a job without a draft that an earlier Refit release recorded', async () => {
  const input = await options();
  vi.mocked(runWorkflow).mockImplementation(async (value) => result(value, 'validation-failed'));
  const first = await watchOnce(input);
  await recordedEarlier(input, first.jobKey);
  expect(await watchOnce(input)).toMatchObject({
    status: 'already-processed',
    previousStatus: 'validation-failed',
  });
  expect(runWorkflow).toHaveBeenCalledTimes(1);
});

it('uses the captured input instead of forwarding a run configuration discovery flag', async () => {
  const input = await options();
  const configuration = { ...input.configuration, latestStripe: true };
  vi.mocked(runWorkflow).mockImplementation(async (value) => result(value));
  await watchOnce({ ...input, configuration });
  expect(vi.mocked(runWorkflow).mock.calls[0][0]).toMatchObject({ latestStripe: undefined });
  expect(vi.mocked(runWorkflow).mock.calls[0][0].after).toContain('/snapshots/');
});

it('marks interrupted jobs for review instead of silently regenerating or publishing after restart', async () => {
  const input = await options();
  vi.mocked(runWorkflow).mockImplementation(async (value) => result(value));
  const first = await watchOnce(input);
  const path = join(input.stateDirectory, 'state.json');
  const state = JSON.parse(await readFile(path, 'utf8'));
  state.jobs[first.jobKey].status = 'running';
  await writeFile(path, JSON.stringify(state));
  const resumed = await watchOnce(input);
  expect(resumed).toMatchObject({
    status: 'already-processed',
    previousStatus: 'interrupted',
    previousReason: expect.stringMatching(/^\w*Error: /),
  });
  expect(runWorkflow).toHaveBeenCalledTimes(1);
});

it('rejects state inside the repository and refuses to reset state when configuration changes', async () => {
  const input = await options();
  await expect(
    watchOnce({ ...input, stateDirectory: input.configuration.repository }),
  ).rejects.toThrow(/outside/);
  vi.mocked(runWorkflow).mockImplementation(async (value) => result(value));
  await watchOnce(input);
  await expect(
    watchOnce({
      ...input,
      configuration: { ...input.configuration, command: ['node', '-e', 'process.exit(1)'] },
    }),
  ).rejects.toThrow(/another configuration/);
});

it('preserves default worker identity when preparation is disabled and requires fresh state to enable it', async () => {
  const input = await options();
  vi.mocked(runWorkflow).mockImplementation(async (value) => result(value));
  await watchOnce(input);
  expect(
    (
      await watchOnce({
        ...input,
        configuration: { ...input.configuration, prepareDependencies: false },
      })
    ).status,
  ).toBe('already-processed');
  await expect(
    watchOnce({ ...input, configuration: { ...input.configuration, prepareDependencies: true } }),
  ).rejects.toThrow(/another configuration/);
  await watchOnce({
    ...input,
    stateDirectory: join(input.stateDirectory, '..', 'prepared-state'),
    configuration: { ...input.configuration, prepareDependencies: true },
  });
  expect(vi.mocked(runWorkflow).mock.calls.at(-1)?.[0].prepareDependencies).toBe(true);
});

it('records public documentation changes as unified evidence without starting another migration', async () => {
  const input = await options();
  const documentationSources = [
    { label: 'Provider changelog', url: 'https://docs.example.com/changelog' },
  ];
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(
        new Response('<main><h1>Release 1</h1><p>Old behavior.</p></main>', {
          headers: { 'content-type': 'text/html', etag: '"release-1"' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('<main><h1>Release 1</h1><p>New behavior.</p></main>', {
          headers: { 'content-type': 'text/html', etag: '"release-2"' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 })),
  );
  vi.mocked(runWorkflow).mockImplementation(async (value) => result(value));

  const initial = await watchOnce({ ...input, documentationSources });
  expect(initial.status).toBe('processed');
  if (initial.status !== 'processed') throw new Error('Expected the initial poll to finish.');
  expect(initial.documentationBaselines).toMatchObject([
    { label: 'Provider changelog', url: 'https://docs.example.com/changelog' },
  ]);
  const changed = await watchOnce({ ...input, documentationSources });
  expect(changed.status).toBe('documentation-changed');
  if (changed.status !== 'documentation-changed') throw new Error('Expected documentation notice.');
  expect(changed.documentationChanges).toHaveLength(1);
  const change = changed.documentationChanges[0];
  expect(change).toMatchObject({ label: 'Provider changelog', addedLines: 1, removedLines: 1 });
  expect(await readFile(change.patch, 'utf8')).toContain('-Old behavior.');
  expect(await readFile(change.patch, 'utf8')).toContain('+New behavior.');
  expect(JSON.parse(await readFile(change.evidence, 'utf8'))).toMatchObject({
    kind: 'refit-documentation-change',
    previousHash: change.previousHash,
    currentHash: change.currentHash,
  });
  expect(runWorkflow).toHaveBeenCalledTimes(1);
  const savedNotes = vi.mocked(runWorkflow).mock.calls[0][0].documentationSnapshots;
  expect(savedNotes).toHaveLength(1);
  expect(JSON.parse(await readFile(savedNotes![0], 'utf8')).content).toContain('Old behavior.');

  expect((await watchOnce({ ...input, documentationSources })).status).toBe('already-processed');
  expect(runWorkflow).toHaveBeenCalledTimes(1);
});

it('keeps a documentation update pending when the accompanying API workflow throws', async () => {
  const input = await options();
  const documentationSources = [
    { label: 'Provider changelog', url: 'https://docs.example.com/changelog' },
  ];
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(
        new Response('# Release one', {
          headers: { 'content-type': 'text/markdown', etag: '"release-1"' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('# Release two', {
          headers: { 'content-type': 'text/markdown', etag: '"release-2"' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('# Release two', {
          headers: { 'content-type': 'text/markdown', etag: '"release-2"' },
        }),
      ),
  );
  vi.mocked(runWorkflow)
    .mockImplementationOnce(async (value) => result(value))
    .mockRejectedValueOnce(new Error('Controlled workflow interruption'));
  await watchOnce({ ...input, documentationSources });

  const after = JSON.parse(await readFile(input.source.path, 'utf8'));
  delete after.components.schemas.payment_intent.properties.id;
  await writeFile(input.source.path, JSON.stringify(after));
  await expect(watchOnce({ ...input, documentationSources })).rejects.toThrow(
    'Controlled workflow interruption',
  );

  const statePath = join(input.stateDirectory, 'state.json');
  const stateAfterFailure = JSON.parse(await readFile(statePath, 'utf8'));
  const sourceId = documentationSourceId(documentationSources[0]);
  expect(stateAfterFailure.documentation[sourceId]).toBeTruthy();
  const retainedHash = stateAfterFailure.documentation[sourceId];
  const recovered = await watchOnce({ ...input, documentationSources });
  expect(recovered.status).toBe('documentation-changed');
  if (recovered.status !== 'documentation-changed')
    throw new Error('Expected the pending documentation change to remain visible.');
  expect(recovered.documentationChanges[0].previousHash).toBe(retainedHash);
  expect(runWorkflow).toHaveBeenCalledTimes(2);
});
