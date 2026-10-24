import { afterEach, expect, it, vi } from 'vitest';
import { runHostedTarget } from './hosted-runner.ts';
import type { HostedTarget } from './hosted-store.ts';
import type { ServicePoll } from './service-worker.ts';

// What the hosted job stores for each poll result; the poll itself is simulated.
vi.mock('./service-worker.ts', async (original) => ({
  ...(await original<typeof import('./service-worker.ts')>()),
  pollServiceTarget: vi.fn(),
}));
const worker = await import('./service-worker.ts');

const REVISION = 'a'.repeat(40);
const OUTPUT = '/data/state/targets/target-a/runs/job-1';
const REASON =
  'Workflow failed during validation. Completed artifacts are retained. Publication errors can leave a remote branch or PR; reconcile before retrying.';
const TIMEOUT = {
  name: 'DependencyPreparationError',
  message:
    'Dependency preparation exceeded 300 seconds. Set REFIT_DEPENDENCY_TIMEOUT_SECONDS (up to 1800) for a larger dependency tree.',
};
const TARGET: HostedTarget = {
  id: 'target-a',
  repository: 'example/application',
  base: 'main',
  integration: null,
  installationId: 456,
  approval: {
    formatVersion: 2,
    kind: 'refit-repository-approval',
    repository: 'example/application',
    base: 'main',
    fingerprint: 'f'.repeat(64),
    files: [],
    reviewedRevision: REVISION,
    approvedAt: '2026-10-24T00:00:00.000Z',
  },
};

afterEach(() => vi.mocked(worker.pollServiceTarget).mockReset());

// Only the fields summarizePoll and the runner read.
function processed(status: string, error: { name: string; message: string } | null) {
  return {
    status: 'processed',
    output: OUTPUT,
    result: {
      manifest: { status, reason: status === 'error' ? REASON : 'Draft PR opened.', error },
    },
    checkout: { revision: REVISION },
    readiness: { status: 'ready-for-validation' },
  } as unknown as ServicePoll;
}

function run(controller = new AbortController()) {
  return runHostedTarget({
    target: TARGET,
    app: { appId: '123', privateKeyFile: 'unused-test-key' },
    directory: '/data/state',
    retry: false,
    signal: controller.signal,
    repairAttempts: 0,
  });
}

it('fails the job on a workflow error and keeps the error in the receipt', async () => {
  vi.mocked(worker.pollServiceTarget).mockResolvedValue(processed('error', TIMEOUT));
  expect(await run()).toEqual({
    status: 'failed',
    receipt: {
      status: 'error',
      output: OUTPUT,
      message: `${REASON} ${TIMEOUT.name}: ${TIMEOUT.message}`,
      revision: REVISION,
      readiness: 'ready-for-validation',
    },
  });
});

it('stores a stop during the workflow as interrupted, as before the workflow starts', async () => {
  const controller = new AbortController();
  vi.mocked(worker.pollServiceTarget).mockImplementation(async () => {
    controller.abort();
    return processed('error', { name: 'AbortError', message: 'This operation was aborted' });
  });
  expect(await run(controller)).toMatchObject({
    status: 'failed',
    receipt: {
      status: 'interrupted',
      message: `${REASON} AbortError: This operation was aborted`,
    },
  });
  vi.mocked(worker.pollServiceTarget).mockRejectedValue(
    new DOMException('This operation was aborted', 'AbortError'),
  );
  expect(await run(controller)).toMatchObject({
    status: 'failed',
    receipt: { status: 'interrupted', message: 'AbortError: This operation was aborted' },
  });
});

it('finishes the job for a completed workflow and for a reused error, so one error alerts once', async () => {
  vi.mocked(worker.pollServiceTarget).mockResolvedValue(processed('draft-created', null));
  expect(await run()).toMatchObject({
    status: 'finished',
    receipt: { status: 'draft-created', message: 'Draft PR opened.' },
  });
  vi.mocked(worker.pollServiceTarget).mockResolvedValue({
    status: 'already-processed',
    previousStatus: 'error',
    output: OUTPUT,
    checkout: { revision: REVISION },
  } as unknown as ServicePoll);
  expect(await run()).toMatchObject({
    status: 'finished',
    receipt: { status: 'error', message: 'Saved worker result reused; checks were not rerun.' },
  });
});
