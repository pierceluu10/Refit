import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { readCpuTimes } from './hosted-cpu.ts';
import { runHostedService } from './hosted-service.ts';
import { DEFAULT_TENANCY_LIMITS } from './hosted-tenancy.ts';
import type { ServicePoll } from './service-worker.ts';

// What the worker records about an in-VM job's limits: CPU throttling, the job timeout and a
// receipt the store refuses. The store and the poll are simulated.
const TARGET = { id: 'target-a', repository: 'example/application', base: 'main' };
const WAIT_MS = 10_000;
const POLL_MS = 20;
const CACHED = {
  status: 'already-processed',
  previousStatus: 'needs-review',
  output: null,
  checkout: { revision: 'a'.repeat(40) },
} as unknown as ServicePoll;

const fake = vi.hoisted(() => ({
  claims: [] as unknown[],
  samples: [] as { steal: number; total: number }[],
  store: {} as Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock('./hosted-store.ts', () => ({ openHostedStore: vi.fn(async () => fake.store) }));
vi.mock('./inventory-store.ts', () => ({
  openInventoryStore: vi.fn(() => ({
    request: vi.fn(async () => 0),
    requestMissing: vi.fn(async () => 0),
    claim: vi.fn(async () => null),
    read: vi.fn(async () => []),
  })),
}));
vi.mock('./service-worker.ts', async (original) => ({
  ...(await original<typeof import('./service-worker.ts')>()),
  confirmRepositoryAccess: vi.fn(async () => ({ installationId: 456, id: 789 })),
  pollServiceTarget: vi.fn(),
}));
// Each job reads /proc/stat once before and once after; any job length is measured here.
vi.mock('./hosted-cpu.ts', async (original) => ({
  ...(await original<typeof import('./hosted-cpu.ts')>()),
  MIN_THROTTLE_SECONDS: 0,
  readCpuTimes: vi.fn(async () => fake.samples.shift() ?? null),
}));
const worker = await import('./service-worker.ts');

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.mocked(worker.pollServiceTarget).mockReset();
  fake.samples = [];
});

function job(id: number) {
  return {
    job: id,
    retry: false,
    target: { ...TARGET, integration: null, installationId: 456, approval: {} },
  };
}

// Serves until `count` jobs reach the store; returns what it stored and the error-level lines.
async function serve(
  count: number,
  options: { stored?: (job: number) => boolean; jobTimeoutSeconds?: number } = {},
) {
  fake.claims = Array.from({ length: count }, (_, index) => job(index + 1));
  const finished: unknown[][] = [];
  fake.store = {
    allow: vi.fn(async () => ({ enrolled: [], cancelled: [] })),
    enqueueDue: vi.fn(async () => 0),
    paused: vi.fn(async () => null),
    claim: vi.fn(async () => fake.claims.shift() ?? null),
    retire: vi.fn(async () => false),
    renew: vi.fn(async () => true),
    finish: vi.fn(async (...args: unknown[]) => {
      finished.push(args);
      return options.stored?.(args[0] as number) ?? true;
    }),
    read: vi.fn(async () => ({ installations: [], targets: [], jobs: [] })),
  };
  const lines: { message: string; level?: string; job?: number }[] = [];
  const directory = await mkdtemp(join(tmpdir(), 'refit-hosted-limits-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  const service = runHostedService({
    database: { query: vi.fn(async () => ({ rows: [] })) } as unknown as Pool,
    app: { appId: '123', privateKeyFile: 'unused-test-key' },
    directory,
    webhookSecret: 'webhook-secret-for-hosted-limit-tests',
    controlToken: 'control-secret-for-hosted-limit-tests',
    tenancy: { accounts: ['example'], limits: DEFAULT_TENANCY_LIMITS },
    host: '127.0.0.1',
    port: 0,
    intervalSeconds: 30,
    leaseSeconds: 30,
    jobTimeoutSeconds: options.jobTimeoutSeconds,
    worker: 'test-worker',
    signal: controller.signal,
    onProgress: (message, fields) => lines.push({ message, ...fields }),
  });
  cleanups.push(async () => {
    controller.abort();
    await service;
  });
  for (const deadline = Date.now() + WAIT_MS; finished.length < count;) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${count} jobs.`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  console.log(JSON.stringify(lines, null, 2));
  return {
    finished: finished.map(([id, , status, receipt]) => [id, status, receipt]),
    errors: lines.filter((line) => line.level === 'error'),
  };
}

it('logs a throttled job at error level and stores each job’s CPU steal in its receipt', async () => {
  vi.mocked(worker.pollServiceTarget).mockResolvedValue(CACHED);
  // Job 1: 1294 of 2589 ticks stolen, as on refit-hosted during job 254. Job 2: 10 of 1000.
  fake.samples = [
    { steal: 468098, total: 2387153 },
    { steal: 469392, total: 2389742 },
    { steal: 100, total: 5000 },
    { steal: 110, total: 6000 },
  ];
  const { finished, errors } = await serve(2);
  expect(finished).toEqual([
    [1, 'finished', expect.objectContaining({ status: 'needs-review', cpuSteal: 0.5 })],
    [2, 'finished', expect.objectContaining({ status: 'needs-review', cpuSteal: 0.01 })],
  ]);
  expect(errors).toEqual([
    expect.objectContaining({
      job: 1,
      message:
        "CPU throttled: the host took 50% of this machine's CPU time during the job, so installs and checks ran slower and may have hit their time limits.",
    }),
  ]);
});

it('stores the receipt without CPU steal when /proc/stat cannot be read', async () => {
  vi.mocked(worker.pollServiceTarget).mockResolvedValue(CACHED);
  // Job 1 cannot read /proc/stat at the start, job 2 only at the end.
  const denied = Object.assign(new Error("EACCES: permission denied, open '/proc/stat'"), {
    code: 'EACCES',
  });
  vi.mocked(readCpuTimes)
    .mockRejectedValueOnce(denied)
    .mockResolvedValueOnce({ steal: 100, total: 5000 })
    .mockRejectedValueOnce(denied);
  const { finished, errors } = await serve(2);
  expect(finished).toEqual([
    [1, 'finished', expect.not.objectContaining({ cpuSteal: expect.anything() })],
    [2, 'finished', expect.not.objectContaining({ cpuSteal: expect.anything() })],
  ]);
  expect(errors.filter((line) => line.message.startsWith('CPU steal not measured:'))).toEqual([
    expect.objectContaining({ job: 1 }),
    expect.objectContaining({ job: 2 }),
  ]);
});

it('stops an in-VM job at the job timeout and frees the worker for the next job', async () => {
  // The first poll runs until its signal fires, then stops as the pipeline does.
  vi.mocked(worker.pollServiceTarget)
    .mockImplementationOnce(async ({ signal }) => {
      await new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }));
      signal?.throwIfAborted();
      throw new Error('The poll ended without its signal firing.');
    })
    .mockResolvedValueOnce(CACHED);
  const { finished, errors } = await serve(2, { jobTimeoutSeconds: 1 });
  const message = 'PipelineInputError: Job exceeded the 1-second job timeout and was stopped.';
  expect(finished).toEqual([
    [1, 'failed', expect.objectContaining({ status: 'interrupted', message })],
    [2, 'finished', expect.objectContaining({ status: 'needs-review' })],
  ]);
  expect(errors).toEqual([expect.objectContaining({ job: 1, message: `interrupted: ${message}` })]);
});

it('logs a receipt the store refuses because this worker no longer holds the job', async () => {
  vi.mocked(worker.pollServiceTarget).mockResolvedValue(CACHED);
  const { errors } = await serve(2, { stored: (id) => id !== 1 });
  expect(errors).toEqual([
    expect.objectContaining({
      job: 1,
      message:
        'Receipt not stored: this worker no longer holds job 1; another worker reclaimed its lease, or it failed after repeated lease expiry. needs-review: Saved worker result reused; checks were not rerun.',
    }),
  ]);
});
