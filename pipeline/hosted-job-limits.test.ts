import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import type { FlyMachines } from './fly-machines.ts';
import { readCpuTimes } from './hosted-cpu.ts';
import { runHostedService } from './hosted-service.ts';
import { DEFAULT_TENANCY_LIMITS } from './hosted-tenancy.ts';
import type { ServicePoll } from './service-worker.ts';

// What the worker records about an in-VM job's limits: CPU throttling, the job timeout and a
// receipt the store refuses, and how it runs several jobs in job processes. The store and the
// poll are simulated.
const TARGET = { id: 'target-a', repository: 'example/application', base: 'main' };
const WAIT_MS = 10_000;
const POLL_MS = 20;
// Long enough for a loop that wrongly claims or returns to do so.
const SETTLE_MS = 200;
const JOB_PROCESS = new URL('./fixtures/job-process.mjs', import.meta.url);
const BUSY_MS = 3_000;
// Fly's health check times out after 5 s; a free event loop answers in milliseconds.
const HEALTH_LIMIT_MS = 1_000;
const VALIDATED = {
  status: 'finished',
  receipt: { status: 'validated', output: null, message: 'Simulated job process.' },
} as const;
const CACHED = {
  status: 'already-processed',
  previousStatus: 'needs-review',
  output: null,
  checkout: { revision: 'a'.repeat(40) },
} as unknown as ServicePoll;
// A poll a later job on the same commit, approval and build may reuse.
const READY = {
  ...CACHED,
  previousStatus: 'validated',
  readiness: { status: 'ready-for-validation' },
  liveContract: false,
} as unknown as ServicePoll;

const fake = vi.hoisted(() => ({
  claims: [] as unknown[],
  samples: [] as { steal: number; total: number }[],
  store: {} as Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock('./hosted-store.ts', async (original) => ({
  ...(await original<typeof import('./hosted-store.ts')>()),
  openHostedStore: vi.fn(async () => fake.store),
}));
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
vi.mock('./inventory.ts', async (original) => ({
  ...(await original<typeof import('./inventory.ts')>()),
  defaultRevision: vi.fn(async () => 'a'.repeat(40)),
}));
vi.mock('./hosted-runner.ts', async (original) => ({
  ...(await original<typeof import('./hosted-runner.ts')>()),
  runJobProcess: vi.fn(),
}));
const worker = await import('./service-worker.ts');
const runner = await import('./hosted-runner.ts');

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.mocked(worker.pollServiceTarget).mockReset();
  vi.mocked(runner.runJobProcess).mockReset();
  vi.unstubAllEnvs();
  fake.samples = [];
});

async function until(condition: () => boolean, what: string) {
  for (const deadline = Date.now() + WAIT_MS; !condition();) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await delay(POLL_MS);
  }
}

function job(id: number) {
  return {
    job: id,
    retry: false,
    target: { ...TARGET, integration: null, installationId: 456, approval: {} },
  };
}

// Starts a worker with `count` jobs to claim. `finished` collects what reaches the store.
async function start(
  count: number,
  options: {
    stored?: (job: number) => boolean;
    jobTimeoutSeconds?: number;
    build?: string;
    jobProcesses?: number;
  } = {},
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
    lastEnded: vi.fn(async () => {
      const [job, , status, receipt] = finished.at(-1) ?? [];
      return job === undefined ? null : { job, status, receipt };
    }),
    reuse: vi.fn(async (job: number, worker: string, _installation: number, receipt: unknown) => {
      finished.push([job, worker, 'finished', receipt]);
      return options.stored?.(job) ?? true;
    }),
    read: vi.fn(async () => ({ installations: [], targets: [], jobs: [] })),
  };
  const lines: { message: string; level?: string; job?: number }[] = [];
  const directory = await mkdtemp(join(tmpdir(), 'refit-hosted-limits-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  const drain = new AbortController();
  let ready!: (url: string) => void;
  const listening = new Promise<string>((resolve) => (ready = resolve));
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
    build: options.build,
    jobProcesses: options.jobProcesses,
    worker: 'test-worker',
    signal: controller.signal,
    drain: drain.signal,
    onReady: ready,
    onProgress: (message, fields) => lines.push({ message, ...fields }),
  });
  cleanups.push(async () => {
    controller.abort();
    await service;
  });
  return { service, drain, directory, finished, lines, url: await listening };
}

// Serves until `count` jobs reach the store; returns what it stored and the error-level lines.
async function serve(count: number, options: Parameters<typeof start>[1] = {}) {
  const { finished, lines } = await start(count, options);
  await until(() => finished.length >= count, `${count} jobs`);
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

it('logs a reused receipt the store refuses because this worker no longer holds the job', async () => {
  vi.mocked(worker.pollServiceTarget).mockResolvedValue(READY);
  const { finished, errors } = await serve(2, {
    build: 'registry.fly.io/refit-hosted:test',
    stored: (id) => id !== 2,
  });
  expect(worker.pollServiceTarget).toHaveBeenCalledTimes(1);
  expect(finished[1]).toEqual([2, 'finished', expect.objectContaining({ unchangedSince: 1 })]);
  expect(errors).toEqual([
    expect.objectContaining({
      job: 2,
      message:
        'Receipt not stored: this worker no longer holds job 2; another worker reclaimed its lease, or it failed after repeated lease expiry. validated: Reused the receipt of job 1: same commit, approval and worker build, so nothing ran. Saved worker result reused; checks were not rerun.',
    }),
  ]);
});

it('runs up to --job-processes jobs at once, refills a slot when a job ends and drains only after every job', async () => {
  const jobs: (() => void)[] = [];
  vi.mocked(runner.runJobProcess).mockImplementation(
    () => new Promise((resolve) => jobs.push(() => resolve(VALIDATED))),
  );
  const { service, drain, directory, finished } = await start(3, { jobProcesses: 2 });
  await until(() => jobs.length === 2, 'two jobs to start');
  // Both slots are busy, so the worker claims nothing more.
  await delay(SETTLE_MS);
  expect(jobs).toHaveLength(2);
  expect(fake.store.claim).toHaveBeenCalledTimes(2);
  expect(vi.mocked(runner.runJobProcess).mock.calls[0][0].inputs).toEqual({
    target: job(1).target,
    directory: expect.stringContaining(directory.split('/').at(-1)!),
    retry: false,
    repairAttempts: 0,
    publishDraft: false,
    aiPatch: false,
  });
  jobs[0]();
  await until(() => jobs.length === 3, 'the freed slot to take the third job');

  // Draining waits for both running jobs and starts nothing new.
  drain.abort();
  jobs[1]();
  let returned = false;
  void service.then(() => (returned = true));
  await until(() => finished.length === 2, 'the second job to be stored');
  await delay(SETTLE_MS);
  expect(returned).toBe(false);
  jobs[2]();
  await service;
  expect(finished.map(([id, , status, receipt]) => [id, status, receipt])).toEqual([
    [1, 'finished', expect.objectContaining({ status: 'validated' })],
    [2, 'finished', expect.objectContaining({ status: 'validated' })],
    [3, 'finished', expect.objectContaining({ status: 'validated' })],
  ]);
  expect(fake.store.claim).toHaveBeenCalledTimes(3);
});

it('answers /health within a second while a job process holds its CPU', async () => {
  vi.stubEnv('REFIT_TEST_JOB_PROCESS', 'busy');
  vi.stubEnv('REFIT_TEST_JOB_BUSY_MS', String(BUSY_MS));
  const actual = await vi.importActual<typeof import('./hosted-runner.ts')>('./hosted-runner.ts');
  vi.mocked(runner.runJobProcess).mockImplementation((options) =>
    actual.runJobProcess({ ...options, entry: JOB_PROCESS }),
  );
  const { url, finished, lines } = await start(1, { jobProcesses: 1 });
  await until(() => vi.mocked(runner.runJobProcess).mock.calls.length === 1, 'the job to start');
  const started = Date.now();
  const latencies: number[] = [];
  while (!finished.length) {
    const sent = Date.now();
    const response = await fetch(`${url}/health`);
    latencies.push(Date.now() - sent);
    expect(await response.json()).toEqual({ status: 'listening' });
    await delay(POLL_MS);
  }
  console.log(JSON.stringify({ latencies, lines }, null, 2));
  // The checks span the whole job, so they cover its busy loop.
  expect(Date.now() - started).toBeGreaterThanOrEqual(BUSY_MS);
  expect(Math.max(...latencies)).toBeLessThan(HEALTH_LIMIT_MS);
  expect(lines.map((line) => line.message)).toContain('Running example/application.');
  expect(finished[0]).toEqual([
    1,
    'test-worker',
    'finished',
    expect.objectContaining({ status: 'validated' }),
  ]);
});

it('refuses --job-processes outside 1–32 or with --job-machines', async () => {
  const base = {
    database: {} as Pool,
    app: { appId: '123', privateKeyFile: 'unused-test-key' },
    directory: '/unused',
    webhookSecret: 'webhook-secret-for-hosted-limit-tests',
    controlToken: 'control-secret-for-hosted-limit-tests',
    tenancy: { accounts: ['example'], limits: DEFAULT_TENANCY_LIMITS },
    signal: new AbortController().signal,
  };
  for (const jobProcesses of [0, 33, 1.5, Number.NaN])
    await expect(runHostedService({ ...base, jobProcesses })).rejects.toThrow(
      '--job-processes must be a whole number from 1 to 32.',
    );
  await expect(
    runHostedService({
      ...base,
      jobProcesses: 2,
      jobMachines: { machines: {} as FlyMachines, image: 'image', region: 'iad', images: [] },
    }),
  ).rejects.toThrow('--job-processes cannot be combined with --job-machines.');
});
