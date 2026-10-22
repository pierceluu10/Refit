import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import {
  CONNECTION_TIMEOUT_MS,
  isDatabaseUnavailable,
  openHostedPool,
  STATEMENT_TIMEOUT_MS,
} from './hosted-database.ts';
import { runHostedService } from './hosted-service.ts';
import { hostedTargetId, openHostedStore } from './hosted-store.ts';
import { hostedTenancy } from './hosted-tenancy.ts';
import type { RepositoryApproval } from './repository-enrollment.ts';

vi.mock('./service-worker.ts', () => ({
  confirmRepositoryAccess: vi.fn(async () => ({ installationId: 456, id: 789 })),
  pollServiceTarget: vi.fn(),
  summarizePoll: vi.fn(() => ({ status: 'unchanged', output: null, message: 'No change.' })),
}));
const worker = await import('./service-worker.ts');

const DATABASE = process.env.REFIT_POSTGRES_URL;
// A Postgres image for a throwaway container this test stops and starts, never a shared one.
const OUTAGE_IMAGE = process.env.REFIT_POSTGRES_OUTAGE_IMAGE;
const LEASE_SECONDS = 15;
const READY_TIMEOUT_MS = 60_000;
const POLL_MS = 100;
const execute = promisify(execFile);
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until(condition: () => boolean | Promise<boolean>, what: string) {
  for (const deadline = Date.now() + READY_TIMEOUT_MS; !(await condition());) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

it('tells unreachable PostgreSQL apart from failed queries', () => {
  const failure = (message: string, code?: string) =>
    Object.assign(new Error(message), code ? { code } : {});
  for (const error of [
    failure('connect ECONNREFUSED 127.0.0.1:5432', 'ECONNREFUSED'),
    failure('read ECONNRESET', 'ECONNRESET'),
    failure('terminating connection due to administrator command', '57P01'),
    failure('the database system is starting up', '57P03'),
    failure('canceling statement due to statement timeout', '57014'),
    failure('connection failure', '08006'),
    failure('Connection terminated unexpectedly'),
    failure('timeout exceeded when trying to connect'),
    failure('Query read timeout'),
  ])
    expect(isDatabaseUnavailable(error), error.message).toBe(true);
  for (const error of [
    failure('relation "refit_jobs" does not exist', '42P01'),
    failure('duplicate key value violates unique constraint', '23505'),
    failure('permission denied for table refit_jobs', '42501'),
    new Error('Something else'),
    'ECONNREFUSED',
  ])
    expect(isDatabaseUnavailable(error), String(error)).toBe(false);
});

it(
  'gives up on a server that accepts the connection but never answers',
  async () => {
    const sockets = new Set<Socket>();
    const silent = createServer((socket) => sockets.add(socket));
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => silent.close(resolve));
    });
    const errors: Error[] = [];
    const pool = openHostedPool(
      `postgres://refit:unused@127.0.0.1:${(silent.address() as AddressInfo).port}/refit`,
      (error) => errors.push(error),
    );
    cleanups.push(() => pool.end());
    const started = Date.now();
    const failure = await pool.query('SELECT 1').catch((error: unknown) => error);
    const elapsed = Date.now() - started;
    console.log(`Connection attempt failed after ${elapsed} ms:`, failure);
    expect(isDatabaseUnavailable(failure)).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(CONNECTION_TIMEOUT_MS - POLL_MS);
  },
  CONNECTION_TIMEOUT_MS * 2,
);

it.skipIf(!DATABASE)('sets the statement timeout on every pooled connection', async () => {
  const errors: Error[] = [];
  const pool = openHostedPool(DATABASE!, (error) => errors.push(error));
  cleanups.push(() => pool.end());
  const clients = await Promise.all([pool.connect(), pool.connect()]);
  for (const client of clients) {
    const { rows } = await client.query('SHOW statement_timeout');
    expect(rows[0].statement_timeout).toBe(`${STATEMENT_TIMEOUT_MS / 1000}s`);
    client.release();
  }
  expect(errors).toEqual([]);
});

// A Postgres container of this test's own, reachable on a fixed local port across restarts.
async function throwawayPostgres() {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((resolve) => probe.close(resolve));
  const name = `refit-pp7-outage-${randomBytes(4).toString('hex')}`;
  const password = randomBytes(12).toString('hex');
  await execute('docker', [
    'run',
    '--detach',
    '--name',
    name,
    '--env',
    'POSTGRES_USER=refit',
    '--env',
    `POSTGRES_PASSWORD=${password}`,
    '--env',
    'POSTGRES_DB=refit',
    '--publish',
    `127.0.0.1:${port}:5432`,
    OUTAGE_IMAGE!,
  ]);
  cleanups.push(() => execute('docker', ['rm', '--force', name]));
  const url = `postgres://refit:${password}@127.0.0.1:${port}/refit`;
  const ready = () =>
    until(async () => {
      const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1_000 });
      client.on('error', () => undefined);
      try {
        await client.connect();
        await client.query('SELECT 1');
        return true;
      } catch {
        return false;
      } finally {
        await client.end().catch(() => undefined);
      }
    }, 'PostgreSQL to accept connections');
  await ready();
  return {
    url,
    stop: async () => {
      await execute('docker', ['stop', name]);
      console.log(`Stopped ${name} at ${new Date().toISOString()}`);
    },
    start: async () => {
      await execute('docker', ['start', name]);
      await ready();
      console.log(`Started ${name} at ${new Date().toISOString()}`);
    },
  };
}

function approval(repository: string): RepositoryApproval {
  return {
    formatVersion: 1,
    kind: 'refit-repository-approval',
    repository,
    base: 'main',
    fingerprint: randomBytes(32).toString('hex'),
    files: [],
    reviewedRevision: 'a'.repeat(40),
    approvedAt: '2026-10-22T00:00:00.000Z',
  };
}

it.skipIf(!OUTAGE_IMAGE)(
  'keeps leases through a short PostgreSQL outage and stops a job before a long one can expire its lease',
  async () => {
    const postgres = await throwawayPostgres();
    const errors: Error[] = [];
    const observer = openHostedPool(postgres.url, (error) => errors.push(error));
    cleanups.push(() => observer.end());
    const tenancy = hostedTenancy({ REFIT_HOSTED_OWNER: 'example' });
    const seed = await openHostedStore(observer, tenancy);
    const target = hostedTargetId('example/application', 'main');
    await seed.approve(approval('example/application'), 'octo-reviewer');
    await seed.accept(randomUUID(), 'installation', new TextEncoder().encode('created'), {
      kind: 'installation',
      installationId: 456,
      owner: 'example',
      action: 'created',
      added: [{ id: 789, name: 'example/application' }],
      removed: [],
    });
    const job = async (id: number) =>
      (
        await observer.query<{ status: string; attempts: number; expires: Date | null }>(
          'SELECT status, attempts, lease_expires_at AS expires FROM refit_jobs WHERE id = $1',
          [id],
        )
      ).rows[0];
    const renewedAfter = async (id: number, previous: Date) =>
      until(
        async () => ((await job(id)).expires?.getTime() ?? 0) > previous.getTime(),
        `job ${id}'s lease to be renewed`,
      );

    // Each poll records when it ran and waits until the test releases it or the worker aborts it.
    const runs: { started: number; ended?: number; aborted?: boolean; release: () => void }[] = [];
    let running = 0;
    let overlapping = 0;
    vi.mocked(worker.pollServiceTarget).mockImplementation(async ({ signal }) => {
      running += 1;
      overlapping = Math.max(overlapping, running);
      const run = { started: Date.now(), release: () => undefined } as (typeof runs)[number];
      runs.push(run);
      try {
        await new Promise<void>((resolve, reject) => {
          run.release = resolve;
          signal?.addEventListener('abort', () => reject(new Error('Poll aborted.')), {
            once: true,
          });
        });
        return {} as Awaited<ReturnType<typeof worker.pollServiceTarget>>;
      } finally {
        run.aborted = signal?.aborted;
        run.ended = Date.now();
        running -= 1;
      }
    });

    const logs: string[] = [];
    const controller = new AbortController();
    const directory = await mkdtemp(join(tmpdir(), 'refit-hosted-outage-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const services: Promise<unknown>[] = [];
    cleanups.push(async () => {
      controller.abort();
      await Promise.allSettled(services);
    });
    const serve = (name: string) => {
      let ready = false;
      const database = openHostedPool(postgres.url, (error) => errors.push(error));
      cleanups.push(() => database.end());
      const service = runHostedService({
        database,
        app: { appId: '123', privateKeyFile: 'unused-test-key' },
        directory: join(directory, name),
        webhookSecret: 'webhook-secret-for-hosted-outage-tests-123',
        controlToken: 'control-secret-for-hosted-outage-tests-456',
        tenancy,
        host: '127.0.0.1',
        port: 0,
        intervalSeconds: 30,
        leaseSeconds: LEASE_SECONDS,
        worker: name,
        signal: controller.signal,
        onReady: () => (ready = true),
        onProgress: (message) => {
          logs.push(`${new Date().toISOString()} ${name} ${message}`);
          console.log(logs.at(-1));
        },
      });
      services.push(service);
      return { service, ready: () => ready };
    };

    // The worker starts while PostgreSQL is down and waits for it.
    await postgres.stop();
    const first = serve('worker-a');
    await until(() => logs.some((line) => line.includes('PostgreSQL is unavailable')), 'a retry');
    expect(first.ready()).toBe(false);
    await postgres.start();
    await until(() => runs.length === 1, 'job 1 to start');
    expect(first.ready()).toBe(true);

    // Short outage: one renewal fails, the lease still holds, and the next renewal succeeds.
    const claimed = (await job(1)).expires!;
    await renewedAfter(1, claimed);
    await postgres.stop();
    await until(() => logs.some((line) => line.endsWith('; retrying.')), 'a failed renewal');
    await postgres.start();
    const resumed = (await job(1)).expires!;
    await renewedAfter(1, resumed);
    runs[0].release();
    await until(async () => (await job(1)).status === 'finished', 'job 1 to finish');
    expect(await job(1)).toMatchObject({ status: 'finished', attempts: 1 });
    expect(logs.some((line) => line.includes('; stopping.'))).toBe(false);

    // Long outage: a second worker claims job 2, PostgreSQL stays down until the worker stops the
    // job, and neither worker claims it again until its lease has expired.
    expect(await seed.retry(target)).toBe(2);
    serve('worker-b');
    await until(() => runs.length === 2, 'job 2 to start');
    await renewedAfter(2, (await job(2)).expires!);
    await postgres.stop();
    await until(() => runs[1].ended !== undefined, 'job 2 to stop');
    await until(
      () => logs.filter((line) => line.includes('PostgreSQL is unavailable')).length > 1,
      'the worker to wait for PostgreSQL',
    );
    await postgres.start();
    const { expires } = await job(2);
    console.log(
      `Job 2 stopped at ${new Date(runs[1].ended!).toISOString()}; its lease expired at ${expires!.toISOString()}.`,
    );
    expect(runs[1]).toMatchObject({ aborted: true });
    expect(runs[1].ended!).toBeLessThan(expires!.getTime());
    expect(await job(2)).toMatchObject({ status: 'running', attempts: 1 });
    await until(() => runs.length === 3, 'job 2 to be claimed again');
    console.log(`Job 2 claimed again at ${new Date(runs[2].started).toISOString()}.`);
    runs[2].release();
    await until(async () => (await job(2)).status === 'finished', 'job 2 to finish');
    expect(await job(2)).toMatchObject({ status: 'finished', attempts: 2 });
    expect(runs[2].started).toBeGreaterThan(runs[1].ended!);
    expect(overlapping).toBe(1);
    expect(
      logs.some((line) => line.includes('Lease renewal failed') && line.endsWith('; stopping.')),
    ).toBe(true);

    controller.abort();
    // Both workers survived the outages and stop cleanly.
    expect((await Promise.allSettled(services)).map((result) => result.status)).toEqual([
      'fulfilled',
      'fulfilled',
    ]);
    console.log(`Pool errors handled: ${errors.map((error) => error.message).join(' | ')}`);
  },
  240_000,
);
