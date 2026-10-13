import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { watchOnce } from './watch.ts';
import { runWorkflow } from './workflow.ts';
import { documentationSourceId } from './documentation-sources.ts';

vi.mock('./workflow.ts', () => ({ runWorkflow: vi.fn() }));
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
  status: 'validated' | 'validation-failed' = 'validated',
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
  document.info = { title: 'A documentation-only edit' };
  await writeFile(input.source.path, JSON.stringify(document));
  expect((await watchOnce(input)).status).toBe('already-processed');
  expect((await watchOnce({ ...input, retry: true })).status).toBe('already-processed');
  expect(runWorkflow).toHaveBeenCalledTimes(1);
  expect(await readFile(join(input.stateDirectory, 'state.json'), 'utf8')).not.toContain('apiKey');
});

it('preserves failed jobs and permits one explicit retry with a fresh evidence directory', async () => {
  const input = await options();
  vi.mocked(runWorkflow).mockImplementation(async (value) => result(value, 'validation-failed'));
  const first = await watchOnce(input);
  await watchOnce(input);
  const retry = await watchOnce({ ...input, retry: true });
  expect(runWorkflow).toHaveBeenCalledTimes(2);
  expect(first.output).not.toBe(retry.output);
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
  expect(resumed).toMatchObject({ status: 'already-processed', previousStatus: 'interrupted' });
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
