import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { runHostedService } from './hosted-service.ts';
import { DEFAULT_TENANCY_LIMITS } from './hosted-tenancy.ts';
import type { ServicePoll } from './service-worker.ts';

const TARGET = { id: 'target-a', repository: 'example/application', base: 'main' };
const WAIT_MS = 10_000;
const POLL_MS = 20;

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
  pollServiceTarget: vi.fn(async () => ({
    status: 'already-processed',
    previousStatus: 'needs-review',
    output: null,
    checkout: { revision: 'a'.repeat(40) },
  })) as unknown as () => Promise<ServicePoll>,
}));
// Each job reads /proc/stat once before and once after; any job length is measured here.
vi.mock('./hosted-cpu.ts', async (original) => ({
  ...(await original<typeof import('./hosted-cpu.ts')>()),
  MIN_THROTTLE_SECONDS: 0,
  readCpuTimes: vi.fn(async () => fake.samples.shift() ?? null),
}));

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function job(id: number) {
  return {
    job: id,
    retry: false,
    target: { ...TARGET, integration: null, installationId: 456, approval: {} },
  };
}

it('logs a throttled job at error level and stores each job’s CPU steal in its receipt', async () => {
  fake.claims = [job(1), job(2)];
  // Job 1: 1294 of 2589 ticks stolen, as on refit-hosted during job 254. Job 2: 10 of 1000.
  fake.samples = [
    { steal: 468098, total: 2387153 },
    { steal: 469392, total: 2389742 },
    { steal: 100, total: 5000 },
    { steal: 110, total: 6000 },
  ];
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
      return true;
    }),
    read: vi.fn(async () => ({ installations: [], targets: [], jobs: [] })),
  };
  const lines: { message: string; level?: string; job?: number }[] = [];
  const directory = await mkdtemp(join(tmpdir(), 'refit-hosted-throttle-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  const service = runHostedService({
    database: { query: vi.fn(async () => ({ rows: [] })) } as unknown as Pool,
    app: { appId: '123', privateKeyFile: 'unused-test-key' },
    directory,
    webhookSecret: 'webhook-secret-for-hosted-throttle-tests',
    controlToken: 'control-secret-for-hosted-throttle-tests',
    tenancy: { accounts: ['example'], limits: DEFAULT_TENANCY_LIMITS },
    host: '127.0.0.1',
    port: 0,
    intervalSeconds: 30,
    leaseSeconds: 30,
    worker: 'test-worker',
    signal: controller.signal,
    onProgress: (message, fields) => lines.push({ message, ...fields }),
  });
  cleanups.push(async () => {
    controller.abort();
    await service;
  });
  for (const deadline = Date.now() + WAIT_MS; finished.length < 2;) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for both jobs.');
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  console.log(JSON.stringify(lines, null, 2));
  expect(finished.map(([id, , status, receipt]) => [id, status, receipt])).toEqual([
    [1, 'finished', expect.objectContaining({ status: 'needs-review', cpuSteal: 0.5 })],
    [2, 'finished', expect.objectContaining({ status: 'needs-review', cpuSteal: 0.01 })],
  ]);
  const throttled = lines.filter((line) => line.message.startsWith('CPU throttled:'));
  expect(throttled).toEqual([
    expect.objectContaining({
      job: 1,
      level: 'error',
      message:
        "CPU throttled: the host took 50% of this machine's CPU time during the job, so installs and checks ran slower and may have hit their time limits.",
    }),
  ]);
});
