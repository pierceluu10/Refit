import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { watchOnce } from './watch.ts';
import { runWorkflow } from './workflow.ts';

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
