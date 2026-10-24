import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { runHostedService } from './hosted-service.ts';
import { hostedTargetId, openHostedStore } from './hosted-store.ts';
import { DEFAULT_TENANCY_LIMITS } from './hosted-tenancy.ts';
import type { RepositoryApproval } from './repository-enrollment.ts';
import { digest } from './specifications.ts';

vi.mock('./service-worker.ts', () => ({
  confirmRepositoryAccess: vi.fn(async (_app: unknown, repository: string) => ({
    installationId: repository.startsWith('first/') ? 1 : 2,
    id: 789,
  })),
  pollServiceTarget: vi.fn(),
  summarizePoll: vi.fn(() => ({ status: 'unchanged', output: null, message: 'No change.' })),
}));
const worker = await import('./service-worker.ts');

const DATABASE = process.env.REFIT_POSTGRES_URL;
const TENANCY = { accounts: ['first', 'second'], limits: DEFAULT_TENANCY_LIMITS };
const WAIT_MS = 30_000;
const POLL_MS = 50;
// Well under the 5-second first outage retry, so a worker that retries again is caught.
const BOOT_STOP_MS = 2_000;
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  vi.mocked(worker.pollServiceTarget).mockReset();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function database() {
  const schema = `refit_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: DATABASE });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: DATABASE, options: `-c search_path=${schema}` });
  cleanups.push(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  return pool;
}

async function until(condition: () => boolean | Promise<boolean>, what: string) {
  for (const deadline = Date.now() + WAIT_MS; !(await condition());) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

// The store only matches approvals by repository, base and fingerprint.
function approval(repository: string): RepositoryApproval {
  return {
    formatVersion: 2,
    kind: 'refit-repository-approval',
    repository,
    base: 'main',
    fingerprint: digest(repository),
    files: [],
    reviewedRevision: 'a'.repeat(40),
    approvedAt: '2026-10-24T00:00:00.000Z',
  };
}

// Two installations with one approved repository each, so two jobs are queued.
async function enrolled(pool: pg.Pool) {
  const store = await openHostedStore(pool, TENANCY);
  for (const [installationId, owner] of [
    [1, 'first'],
    [2, 'second'],
  ] as const) {
    await store.approve(approval(`${owner}/a`), 'octo-reviewer');
    await store.accept(randomUUID(), 'installation', new TextEncoder().encode(randomUUID()), {
      kind: 'installation',
      installationId,
      owner,
      action: 'created',
      added: [{ id: installationId * 100, name: `${owner}/a` }],
      removed: [],
    });
  }
  return store;
}

// Each poll waits until the test releases it or the worker aborts it.
function heldPolls() {
  const polls: { release: () => void; aborted?: boolean }[] = [];
  vi.mocked(worker.pollServiceTarget).mockImplementation(async ({ signal }) => {
    const poll = { release: () => undefined } as (typeof polls)[number];
    polls.push(poll);
    try {
      await new Promise<void>((resolve, reject) => {
        poll.release = resolve;
        signal.addEventListener('abort', () => reject(new Error('Poll aborted.')), { once: true });
      });
      return {} as Awaited<ReturnType<typeof worker.pollServiceTarget>>;
    } finally {
      poll.aborted = signal.aborted;
    }
  });
  return polls;
}

function serve(pool: pg.Pool, directory: string, progress: string[]) {
  const controller = new AbortController();
  const drain = new AbortController();
  const service = runHostedService({
    database: pool,
    app: { appId: '123', privateKeyFile: 'unused-test-key' },
    directory,
    webhookSecret: 'webhook-secret-for-hosted-drain-tests-123',
    controlToken: 'control-secret-for-hosted-drain-tests-456',
    tenancy: TENANCY,
    host: '127.0.0.1',
    port: 0,
    intervalSeconds: 30,
    leaseSeconds: 30,
    worker: 'drain-worker',
    signal: controller.signal,
    drain: drain.signal,
    onProgress: (message) => progress.push(message),
  });
  cleanups.push(async () => {
    controller.abort();
    await service.catch(() => undefined);
  });
  return { service, controller, drain };
}

it('stops retrying PostgreSQL at boot on the first signal', async () => {
  // Nothing listens on port 1, so every connection is refused.
  const pool = new pg.Pool({ connectionString: 'postgres://refit:unused@127.0.0.1:1/refit' });
  cleanups.push(() => pool.end());
  const directory = await mkdtemp(join(tmpdir(), 'refit-hosted-drain-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const progress: string[] = [];
  const retries = () => progress.filter((line) => line.startsWith('PostgreSQL is unavailable'));
  const { service, drain } = serve(pool, directory, progress);
  await until(() => retries().length > 0, 'a retry');
  drain.abort();
  let timer: NodeJS.Timeout | undefined;
  const stopped = Promise.race([
    service,
    new Promise((resolve) => (timer = setTimeout(() => resolve('still retrying'), BOOT_STOP_MS))),
  ]).finally(() => clearTimeout(timer));
  await expect(stopped).rejects.toMatchObject({ name: 'AbortError' });
  expect(retries()).toHaveLength(1);
});

it.skipIf(!DATABASE)(
  'claims no job while paused, keeps the first pause time and claims again after resume',
  async () => {
    const store = await enrolled(await database());
    expect(await store.paused()).toBeNull();
    const since = await store.pause();
    expect(await store.pause()).toEqual(since);
    expect(await store.paused()).toEqual(since);
    expect(await store.claim('worker', 30)).toBeNull();
    expect((await store.read()).jobs.map((job) => job.status)).toEqual(['queued', 'queued']);
    expect(await store.resume()).toBe(true);
    expect(await store.resume()).toBe(false);
    expect(await store.claim('worker', 30)).toMatchObject({
      target: { id: hostedTargetId('first/a', 'main') },
    });
  },
  30_000,
);

it.skipIf(!DATABASE)(
  'returns a dead worker’s expired lease to the queue while paused, and fails one that expired too often',
  async () => {
    const pool = await database();
    const store = await enrolled(pool);
    const first = await store.claim('dead-worker', 30);
    const second = await store.claim('dead-worker', 30);
    await pool.query(`UPDATE refit_jobs SET attempts = 3 WHERE id = $1`, [second!.job]);
    await store.pause();
    await pool.query(`UPDATE refit_jobs SET lease_expires_at = now() - interval '1 second'`);
    expect(await store.claim('worker', 30)).toBeNull();
    const jobs = async () =>
      (await store.read()).jobs.map((job) => [job.id, job.status, job.attempts]);
    expect(await jobs()).toEqual([
      [String(first!.job), 'queued', 1],
      [String(second!.job), 'failed', 3],
    ]);
    // Resuming continues the job as the same attempt series, without a new daily reservation.
    await store.resume();
    expect(await store.claim('worker', 30)).toMatchObject({ job: first!.job });
    expect(await jobs()).toEqual([
      [String(first!.job), 'running', 2],
      [String(second!.job), 'failed', 3],
    ]);
    expect((await store.read()).installations.map((entry) => entry.jobsToday)).toEqual([1, 1]);
  },
  30_000,
);

it.skipIf(!DATABASE)(
  'starts nothing while paused, lets the running job finish on drain and stops it on a second signal',
  async () => {
    const pool = await database();
    const store = await enrolled(pool);
    const directory = await mkdtemp(join(tmpdir(), 'refit-hosted-drain-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const polls = heldPolls();
    const progress: string[] = [];
    const jobs = async () =>
      (await store.read()).jobs.map((job) => [job.status, job.receipt?.status]);

    // A paused worker logs the pause and claims nothing.
    await store.pause();
    const paused = serve(pool, directory, progress);
    await until(() => progress.some((line) => line.startsWith('Paused since ')), 'the pause line');
    paused.drain.abort();
    await paused.service;
    expect(polls).toHaveLength(0);
    expect(await jobs()).toEqual([
      ['queued', undefined],
      ['queued', undefined],
    ]);
    await store.resume();

    // Draining lets the running job finish, then the service returns without starting the next.
    // The paused worker logged its own drain line, so only this worker's lines count.
    progress.splice(0);
    const first = serve(pool, directory, progress);
    await until(() => polls.length === 1, 'the first job to start');
    first.drain.abort();
    expect(progress).toContain('Stopping after the running job; no new job starts.');
    polls[0].release();
    await first.service;
    expect(polls).toHaveLength(1);
    expect(polls[0].aborted).toBe(false);
    expect(await jobs()).toEqual([
      ['finished', 'unchanged'],
      ['queued', undefined],
    ]);

    // A second signal while draining stops the running job.
    const second = serve(pool, directory, progress);
    await until(() => polls.length === 2, 'the second job to start');
    second.drain.abort();
    second.controller.abort();
    await second.service;
    expect(polls[1].aborted).toBe(true);
    expect(await jobs()).toEqual([
      ['finished', 'unchanged'],
      ['failed', 'interrupted'],
    ]);
  },
  60_000,
);
