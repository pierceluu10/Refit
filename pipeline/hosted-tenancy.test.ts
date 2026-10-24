import { execFile } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { reserveAiBudget } from './ai-budget.ts';
import { authenticateGitHubRead } from './github-app.ts';
import { runHostedService } from './hosted-service.ts';
import { hostedTargetId, openHostedStore } from './hosted-store.ts';
import {
  DEFAULT_TENANCY_LIMITS,
  hostedTenancy,
  TENANCY_REFUSALS,
  type TenancyLimits,
} from './hosted-tenancy.ts';
import type { RepositoryApproval } from './repository-enrollment.ts';
import { digest } from './specifications.ts';
import { writeState } from './state-files.ts';

// Any checkout starts by authenticating, so a call here means Refit tried to clone.
vi.mock('./github-app.ts', async (original) => ({
  ...(await original<typeof import('./github-app.ts')>()),
  authenticateGitHubRead: vi.fn(async () => {
    throw new Error('GitHub access is simulated as unavailable.');
  }),
}));

const DATABASE = process.env.REFIT_POSTGRES_URL;
const MODEL = 'gpt-5.4-mini';
const WEBHOOK_SECRET = 'webhook-secret-for-hosted-tenancy-tests-123';
const CONTROL_TOKEN = 'control-secret-for-hosted-tenancy-tests-456';
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// Each test gets its own schema so runs never share rows.
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

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'refit-tenancy-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
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
    approvedAt: '2026-10-22T00:00:00.000Z',
  };
}

function tenancy(accounts: string[], limits: Partial<TenancyLimits> = {}) {
  return { accounts, limits: { ...DEFAULT_TENANCY_LIMITS, ...limits } };
}

type Store = Awaited<ReturnType<typeof openHostedStore>>;

function install(store: Store, installationId: number, owner: string, repositories: string[]) {
  return store.accept(randomUUID(), 'installation', new TextEncoder().encode(randomUUID()), {
    kind: 'installation',
    installationId,
    owner,
    action: 'created',
    added: repositories.map((name, index) => ({ id: installationId * 100 + index, name })),
    removed: [],
  });
}

async function serve(pool: pg.Pool, directory: string, accounts: string[]) {
  const controller = new AbortController();
  let ready: (url: string) => void;
  const listening = new Promise<string>((resolve) => (ready = resolve));
  const service = runHostedService({
    database: pool,
    app: { appId: '123', privateKeyFile: 'unused-test-key' },
    directory,
    webhookSecret: WEBHOOK_SECRET,
    controlToken: CONTROL_TOKEN,
    tenancy: tenancy(accounts),
    host: '127.0.0.1',
    port: 0,
    intervalSeconds: 30,
    leaseSeconds: 30,
    worker: 'tenancy-worker',
    signal: controller.signal,
    onReady: (url) => ready(url),
  });
  const url = await listening;
  const stop = async () => {
    controller.abort();
    await service;
  };
  cleanups.push(() => stop().catch(() => undefined));
  const status = async () =>
    (
      await fetch(`${url}/status`, { headers: { Authorization: `Bearer ${CONTROL_TOKEN}` } })
    ).json();
  return { url, stop, status };
}

async function deliver(url: string, event: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const response = await fetch(`${url}/github/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': event,
      'X-GitHub-Delivery': randomUUID(),
      'X-Hub-Signature-256': `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`,
    },
    body,
  });
  return { status: response.status, body: await response.json() };
}

async function finish(store: Store, job: number, worker: string) {
  expect(
    await store.finish(job, worker, 'finished', {
      status: 'validated',
      output: null,
      message: null,
    }),
  ).toBe(true);
}

it('reads allowed accounts from REFIT_HOSTED_ACCOUNTS, defaulting to REFIT_HOSTED_OWNER alone', () => {
  expect(hostedTenancy({ REFIT_HOSTED_OWNER: 'Example' })).toEqual({
    accounts: ['example'],
    limits: DEFAULT_TENANCY_LIMITS,
  });
  expect(
    hostedTenancy({
      REFIT_HOSTED_OWNER: 'example',
      REFIT_HOSTED_ACCOUNTS: 'Example, first-customer,example\nsecond',
      REFIT_HOSTED_DAILY_JOBS: '20',
      REFIT_HOSTED_DAILY_INVENTORIES: '3',
    }),
  ).toEqual({
    accounts: ['example', 'first-customer', 'second'],
    limits: { dailyJobs: 20, dailyInventories: 3 },
  });
  for (const environment of [
    {},
    { REFIT_HOSTED_OWNER: 'example', REFIT_HOSTED_ACCOUNTS: '' },
    { REFIT_HOSTED_ACCOUNTS: 'example,not/an-account' },
    { REFIT_HOSTED_ACCOUNTS: '-leading-dash' },
  ])
    expect(() => hostedTenancy(environment)).toThrow('REFIT_HOSTED_ACCOUNTS');
  for (const value of ['0', '-1', '1.5', 'ten', '100001', ''])
    expect(() =>
      hostedTenancy({ REFIT_HOSTED_OWNER: 'example', REFIT_HOSTED_DAILY_JOBS: value }),
    ).toThrow('REFIT_HOSTED_DAILY_JOBS must be a whole number from 1 to 100000.');
});

it.skipIf(!DATABASE)(
  'records other accounts as not allowed, backfills them once allowed and cancels them when removed',
  async () => {
    const pool = await database();
    const owner = await openHostedStore(pool, tenancy(['example']));
    const ours = hostedTargetId('example/application', 'main');
    const theirs = hostedTargetId('customer/shop', 'main');
    await owner.approve(approval('example/application'), 'octo-reviewer');
    expect(await owner.approve(approval('customer/shop'), 'octo-reviewer')).toEqual([]);

    expect(await install(owner, 1, 'example', ['example/application'])).toMatchObject({
      status: 'accepted',
      enrolled: [ours],
    });
    expect(await install(owner, 2, 'customer', ['customer/shop', 'customer/site'])).toEqual({
      status: 'not-allowed',
      enrolled: [],
      cancelled: [],
      running: [],
    });
    // A stored approval for a not-allowed installation enrolls nothing either.
    expect(await owner.approve(approval('customer/shop'), 'octo-reviewer')).toEqual([]);
    let registry = await owner.read();
    expect(registry.installations).toEqual([
      expect.objectContaining({ id: '1', owner: 'example', allowed: true, refusals: [] }),
      {
        id: '2',
        owner: 'customer',
        status: 'active',
        allowed: false,
        repositories: ['customer/shop', 'customer/site'],
        jobsToday: 0,
        inventoriesToday: 0,
        refusals: [TENANCY_REFUSALS.notAllowed],
      },
    ]);
    expect(registry.targets.map((target) => target.id)).toEqual([ours]);
    expect(await owner.reserveInventory(2)).toBe(TENANCY_REFUSALS.notAllowed);
    expect(await owner.reserveInventory(3)).toBe(TENANCY_REFUSALS.notAllowed);
    const first = await owner.claim('worker', 30);
    expect(first?.target.id).toBe(ours);
    await finish(owner, first!.job, 'worker');
    expect(await owner.claim('worker', 30)).toBeNull();

    // Restarting with the customer allowed backfills its recorded, approved repository.
    const widened = await openHostedStore(pool, tenancy(['example', 'customer']));
    expect(await widened.allow()).toEqual({ enrolled: [theirs], cancelled: [], running: [] });
    expect(await widened.allow()).toEqual({ enrolled: [], cancelled: [], running: [] });
    const backfilled = await widened.claim('worker', 30);
    expect(backfilled?.target).toMatchObject({ id: theirs, installationId: 2 });
    expect(await widened.reserveInventory(2)).toBeNull();

    // Narrowing the list again cancels the customer's targets and its running job.
    const narrowed = await openHostedStore(pool, tenancy(['example']));
    expect(await narrowed.allow()).toEqual({
      enrolled: [],
      cancelled: [theirs],
      running: [backfilled!.job],
    });
    registry = await narrowed.read();
    expect(registry.targets).toEqual([
      expect.objectContaining({ id: ours, status: 'enrolled' }),
      expect.objectContaining({
        id: theirs,
        status: 'cancelled',
        message: 'Account is no longer allowed.',
      }),
    ]);
    expect(registry.installations[1]).toMatchObject({ allowed: false, inventoriesToday: 1 });
    expect(await narrowed.renew(backfilled!.job, 'worker', 30)).toBe(false);
    expect(
      await install(narrowed, 2, 'customer', ['customer/shop']).then((receipt) => receipt.status),
    ).toBe('not-allowed');
    const uninstalled = await narrowed.accept(
      randomUUID(),
      'installation',
      new TextEncoder().encode(randomUUID()),
      {
        kind: 'installation',
        installationId: 2,
        owner: 'customer',
        action: 'deleted',
        added: [],
        removed: [],
      },
    );
    expect(uninstalled).toEqual({
      status: 'not-allowed',
      enrolled: [],
      cancelled: [],
      running: [],
    });
    expect(await narrowed.enqueueDue(0)).toBe(1);
    expect((await narrowed.claim('worker', 30))?.target.id).toBe(ours);
  },
  30_000,
);

it.skipIf(!DATABASE)(
  'clones nothing for a signed install from an account that is not allowed until a restart allows it',
  async () => {
    const pool = await database();
    const directory = await temporaryDirectory();
    await (await openHostedStore(pool)).approve(approval('customer/shop'), 'octo-reviewer');
    const first = await serve(pool, directory, ['example']);
    const installed = await deliver(first.url, 'installation', {
      action: 'created',
      installation: { id: 77, app_id: 123, account: { login: 'Customer' } },
      repositories: [{ id: 7701, full_name: 'Customer/shop' }],
    });
    expect(installed).toEqual({
      status: 202,
      body: { delivery: expect.any(String), status: 'not-allowed', enrolled: [], cancelled: [] },
    });
    let registry = await first.status();
    expect(registry.installations).toEqual([
      expect.objectContaining({
        id: '77',
        owner: 'customer',
        allowed: false,
        repositories: ['customer/shop'],
        refusals: [TENANCY_REFUSALS.notAllowed],
      }),
    ]);
    expect(registry.targets).toEqual([]);
    expect(registry.jobs).toEqual([]);
    await first.stop();
    expect(authenticateGitHubRead).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);

    // Restarting with the account listed enrolls the recorded repository and runs its job.
    const second = await serve(pool, directory, ['example', 'customer']);
    for (
      const deadline = Date.now() + 10_000;
      registry.jobs[0]?.status !== 'failed' && Date.now() < deadline;
      registry = await second.status()
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(registry.targets).toEqual([
      expect.objectContaining({ id: hostedTargetId('customer/shop', 'main'), status: 'enrolled' }),
    ]);
    expect(registry.jobs).toEqual([
      expect.objectContaining({
        status: 'failed',
        receipt: expect.objectContaining({
          message: 'Error: GitHub access is simulated as unavailable.',
        }),
      }),
    ]);
    // One read for the job and one for the inventory backfilled once the account is allowed.
    expect(authenticateGitHubRead).toHaveBeenCalledTimes(2);
  },
  30_000,
);

it.skipIf(!DATABASE)(
  'runs one job per installation at a time and takes turns, so a noisy installation cannot starve another',
  async () => {
    const pool = await database();
    const store = await openHostedStore(pool, tenancy(['noisy', 'quiet']));
    const noisy = ['noisy/a', 'noisy/b', 'noisy/c', 'noisy/d'];
    for (const repository of [...noisy, 'quiet/a'])
      await store.approve(approval(repository), 'octo-reviewer');
    expect((await install(store, 10, 'noisy', noisy)).enrolled).toHaveLength(4);
    // The quiet installation's only job is queued after all of the noisy one's.
    expect((await install(store, 20, 'quiet', ['quiet/a'])).enrolled).toHaveLength(1);

    const running = await store.claim('worker-a', 30);
    expect(running?.target.installationId).toBe(10);
    const quiet = await store.claim('worker-b', 30);
    expect(quiet?.target).toMatchObject({ installationId: 20, repository: 'quiet/a' });
    // Both installations now have a running job; three noisy jobs wait.
    expect(await store.claim('worker-c', 30)).toBeNull();
    let registry = await store.read();
    expect(registry.installations.map((installation) => installation.refusals)).toEqual([
      [TENANCY_REFUSALS.jobRunning],
      [TENANCY_REFUSALS.jobRunning],
    ]);
    expect(registry.jobs.map((job) => [job.status, job.waiting])).toEqual([
      ['running', null],
      ['queued', TENANCY_REFUSALS.jobRunning],
      ['queued', TENANCY_REFUSALS.jobRunning],
      ['queued', TENANCY_REFUSALS.jobRunning],
      ['running', null],
    ]);
    await finish(store, running!.job, 'worker-a');
    await finish(store, quiet!.job, 'worker-b');

    // With jobs finishing one at a time, claims alternate while both installations have work.
    await store.approve(approval('quiet/b'), 'octo-reviewer');
    await store.accept(
      randomUUID(),
      'installation_repositories',
      new TextEncoder().encode(randomUUID()),
      {
        kind: 'repositories',
        installationId: 20,
        owner: 'quiet',
        action: 'added',
        added: [{ id: 2001, name: 'quiet/b' }],
        removed: [],
      },
    );
    const order: number[] = [];
    const repositories = [running!.target.repository];
    for (let claimed = await store.claim('worker', 30); claimed;) {
      order.push(claimed.target.installationId);
      repositories.push(claimed.target.repository);
      await finish(store, claimed.job, 'worker');
      claimed = await store.claim('worker', 30);
    }
    // Claiming in job order would have run all three noisy jobs before quiet/b.
    expect(order).toEqual([10, 20, 10, 10]);
    expect(repositories.filter((name) => name.startsWith('noisy/')).sort()).toEqual(noisy);
    registry = await store.read();
    expect(registry.installations.map((installation) => installation.jobsToday)).toEqual([4, 2]);
    expect(registry.jobs.every((job) => job.waiting === null)).toBe(true);
  },
  30_000,
);

it.skipIf(!DATABASE)(
  'caps jobs and inventories per installation per UTC day with named refusals in status',
  async () => {
    const pool = await database();
    const store = await openHostedStore(
      pool,
      tenancy(['capped', 'other'], { dailyJobs: 2, dailyInventories: 1 }),
    );
    for (const repository of ['capped/a', 'capped/b', 'capped/c', 'other/a'])
      await store.approve(approval(repository), 'octo-reviewer');
    await install(store, 30, 'capped', ['capped/a', 'capped/b', 'capped/c']);

    // Reclaiming an expired lease continues the same job and does not count again.
    const expiring = await store.claim('worker-a', 1);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const reclaimed = await store.claim('worker-b', 30);
    expect(reclaimed).toMatchObject({ job: expiring!.job });
    await finish(store, reclaimed!.job, 'worker-b');
    const second = await store.claim('worker-b', 30);
    expect(second?.job).not.toBe(expiring!.job);
    await finish(store, second!.job, 'worker-b');
    expect(await store.claim('worker-b', 30)).toBeNull();

    expect(await store.reserveInventory(30)).toBeNull();
    expect(await store.reserveInventory(30)).toBe(TENANCY_REFUSALS.dailyInventories);
    let registry = await store.read();
    expect(registry.installations).toEqual([
      expect.objectContaining({
        id: '30',
        jobsToday: 2,
        inventoriesToday: 1,
        refusals: [TENANCY_REFUSALS.dailyJobs, TENANCY_REFUSALS.dailyInventories],
      }),
    ]);
    expect(registry.jobs.map((job) => job.waiting)).toEqual([
      null,
      null,
      TENANCY_REFUSALS.dailyJobs,
    ]);

    // Caps are per installation: another account's work still runs.
    await install(store, 40, 'other', ['other/a']);
    expect(await store.reserveInventory(40)).toBeNull();
    const other = await store.claim('worker-b', 30);
    expect(other?.target.installationId).toBe(40);
    await finish(store, other!.job, 'worker-b');

    // The next UTC day starts with fresh allowances.
    await pool.query('UPDATE refit_installation_usage SET day = day - 1');
    expect((await store.claim('worker-b', 30))?.target.installationId).toBe(30);
    expect(await store.reserveInventory(30)).toBeNull();
    registry = await store.read();
    expect(registry.installations[0]).toMatchObject({
      jobsToday: 1,
      inventoriesToday: 1,
      refusals: [TENANCY_REFUSALS.jobRunning, TENANCY_REFUSALS.dailyInventories],
    });
  },
  30_000,
);

it.skipIf(!DATABASE)(
  'keeps one PostgreSQL AI ledger per installation, so one customer cannot spend another’s budget',
  async () => {
    const pool = await database();
    const store = await openHostedStore(pool, tenancy(['first', 'second', 'third']));
    for (const [id, owner] of [
      [1, 'first'],
      [2, 'second'],
      [3, 'third'],
    ] as const)
      await install(store, id, owner, []);
    const directory = await temporaryDirectory();
    // Each maximum reservation costs $0.019182, so two fit within $0.05.
    const budget = (installationId: number, legacyFile?: string) => ({
      directory,
      limitUsd: 0.05,
      ledger: store.aiLedger(installationId, legacyFile),
    });
    const reserve = (installationId: number, legacyFile?: string) =>
      reserveAiBudget(budget(installationId, legacyFile), MODEL, 1000, 4096);

    const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => reserve(1)));
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(2);
    for (const attempt of attempts)
      if (attempt.status === 'rejected')
        expect(attempt.reason.message).toMatch(/^AI budget exhausted/);
    const settle = attempts.find((attempt) => attempt.status === 'fulfilled')!;
    expect(
      await settle.value(
        {
          inputTokens: 1000,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 100,
          reasoningTokens: 0,
        },
        MODEL,
      ),
    ).toEqual({ costUsd: 0.0012, spentUsd: 0.0012, limitUsd: 0.05 });

    // The second installation's allowance is untouched by the first one's reservations.
    await reserve(2);
    await reserve(2);
    await expect(reserve(2)).rejects.toThrow('AI budget exhausted');
    const { rows } = await pool.query(
      'SELECT installation_id::int AS id, state FROM refit_ai_ledgers ORDER BY installation_id',
    );
    expect(
      rows.map((row) => [row.id, row.state.spentNano, Object.keys(row.state.reservations).length]),
    ).toEqual([
      [1, 1_200_000, 1],
      [2, 0, 2],
    ]);
    // Nothing was written to the file ledger under the budget directory.
    expect(await readdir(directory)).toEqual([]);

    // A file ledger written by an earlier worker is imported, so its spend is not forgotten.
    await mkdir(join(directory, 'installation-3'));
    const legacy = join(directory, 'installation-3', 'budget.json');
    await writeState(legacy, {
      formatVersion: 1,
      limitNano: 50_000_000,
      spentNano: 20_000_000,
      reservations: {},
    });
    await reserve(3, legacy);
    await expect(reserve(3, legacy)).rejects.toThrow('AI budget exhausted');
    const imported = await pool.query(
      'SELECT state FROM refit_ai_ledgers WHERE installation_id = 3',
    );
    expect(imported.rows[0].state).toMatchObject({ spentNano: 20_000_000 });
    expect(Object.keys(imported.rows[0].state.reservations)).toHaveLength(1);
  },
  30_000,
);

it.skipIf(!DATABASE)(
  'moves every AI ledger to a new limit without forgetting spend, and refuses while a job runs',
  async () => {
    const pool = await database();
    const store = await openHostedStore(pool, tenancy(['first', 'second']));
    await store.approve(approval('first/a'), 'octo-reviewer');
    await install(store, 1, 'first', ['first/a']);
    await install(store, 2, 'second', []);
    const directory = await temporaryDirectory();
    const reserve = (limitUsd: number, totalUsd: number) =>
      reserveAiBudget(
        {
          directory,
          limitUsd,
          ledger: store.aiLedger(1),
          parent: { directory, limitUsd: totalUsd, ledger: store.aiTotalLedger() },
        },
        MODEL,
        1000,
        4096,
      );
    const settle = await reserve(0.05, 0.06);
    await settle(
      {
        inputTokens: 1000,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 100,
        reasoningTokens: 0,
      },
      MODEL,
    );
    // A request whose job failed before settling keeps its $0.019182 reservation.
    await reserve(0.05, 0.06);
    // The second installation's spend is still in an earlier worker's file ledger.
    await mkdir(join(directory, 'installation-2'));
    await writeState(join(directory, 'installation-2', 'budget.json'), {
      formatVersion: 1,
      limitNano: 50_000_000,
      spentNano: 20_000_000,
      reservations: {},
    });

    const job = await store.claim('worker', 30);
    expect(job).not.toBeNull();
    await expect(
      store.changeAiLimits({ installationUsd: 0.1, totalUsd: 0.2 }, directory),
    ).rejects.toThrow('A job is running; change AI limits once no job runs.');
    await store.finish(job!.job, 'worker', 'finished', {
      status: 'needs-review',
      output: null,
      message: null,
    });

    const open = { reservedUsd: 0.019182, reservations: 1 };
    const none = { reservedUsd: 0, reservations: 0 };
    expect(await store.changeAiLimits({ installationUsd: 0.1, totalUsd: 0.2 }, directory)).toEqual({
      installations: [
        { installationId: 1, summary: { limitUsd: 0.1, spentUsd: 0.0012, ...open } },
        { installationId: 2, summary: { limitUsd: 0.1, spentUsd: 0.02, ...none } },
      ],
      total: { limitUsd: 0.2, spentUsd: 0.0012, ...open },
    });
    // A worker still configured with the old limits is refused rather than given a fresh budget.
    await expect(reserve(0.05, 0.06)).rejects.toThrow('its configured limit changed');
    await reserve(0.1, 0.2);
    const ledgers = await store.aiLedgerStates();
    expect(
      ledgers.installations.map(({ installationId, state }) => [installationId, state]),
    ).toEqual([
      [1, expect.objectContaining({ limitNano: 100_000_000, spentNano: 1_200_000 })],
      [2, expect.objectContaining({ limitNano: 100_000_000, spentNano: 20_000_000 })],
    ]);
    expect(ledgers.total).toMatchObject({ limitNano: 200_000_000, spentNano: 1_200_000 });
    expect(Object.keys(ledgers.total!.reservations as object)).toHaveLength(2);

    // Only the shared ledger moves when only its limit is given.
    expect(await store.changeAiLimits({ totalUsd: 0.3 })).toMatchObject({
      installations: [],
      total: { limitUsd: 0.3 },
    });
  },
  30_000,
);

it.skipIf(!DATABASE)(
  'caps AI spend across all installations with one total ledger',
  async () => {
    const pool = await database();
    const store = await openHostedStore(pool, tenancy(['first', 'second']));
    await install(store, 1, 'first', []);
    await install(store, 2, 'second', []);
    const directory = await temporaryDirectory();
    // Each installation could hold two $0.019182 reservations; the total holds three.
    const reserve = (installationId: number) =>
      reserveAiBudget(
        {
          directory,
          limitUsd: 0.05,
          ledger: store.aiLedger(installationId),
          parent: { directory, limitUsd: 0.06, ledger: store.aiTotalLedger() },
        },
        MODEL,
        1000,
        4096,
      );
    const settle = await reserve(1);
    await reserve(1);
    await reserve(2);
    await expect(reserve(2)).rejects.toThrow('AI budget exhausted');
    const ledgers = async () =>
      (
        await pool.query(
          'SELECT installation_id::int AS id, state FROM refit_ai_ledgers ORDER BY installation_id',
        )
      ).rows.map((row) => [
        row.id,
        row.state.spentNano,
        Object.keys(row.state.reservations).length,
      ]);
    // The refused request left no reservation in the second installation's own ledger.
    expect(await ledgers()).toEqual([
      [1, 0, 2],
      [2, 0, 1],
    ]);
    await settle(
      {
        inputTokens: 1000,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 100,
        reasoningTokens: 0,
      },
      MODEL,
    );
    const total = await pool.query('SELECT state FROM refit_ai_total_ledger');
    expect(total.rows).toHaveLength(1);
    expect(total.rows[0].state).toMatchObject({ limitNano: 60_000_000, spentNano: 1_200_000 });
    expect(Object.keys(total.rows[0].state.reservations)).toHaveLength(2);
    expect((await ledgers())[0]).toEqual([1, 1_200_000, 1]);
    // Settling freed room in the total, so the second installation can reserve again.
    await reserve(2);
  },
  30_000,
);

it.skipIf(!DATABASE)(
  'lists installations, their allow state and today’s usage with refit hosted accounts',
  async () => {
    const pool = await database();
    const store = await openHostedStore(
      pool,
      tenancy(['example'], { dailyJobs: 5, dailyInventories: 2 }),
    );
    await store.approve(approval('example/application'), 'octo-reviewer');
    await install(store, 1, 'example', ['example/application', 'example/site']);
    await install(store, 2, 'customer', ['customer/shop']);
    await store.claim('worker', 30);
    await store.reserveInventory(1);
    const { schema } = (await pool.query('SELECT current_schema() AS schema')).rows[0];
    const url = new URL(DATABASE!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [resolve('bin/refit.mjs'), 'hosted', 'accounts'],
      {
        env: {
          PATH: process.env.PATH,
          REFIT_DATABASE_URL: url.toString(),
          REFIT_HOSTED_ACCOUNTS: 'example',
          REFIT_HOSTED_DAILY_JOBS: '5',
          REFIT_HOSTED_DAILY_INVENTORIES: '2',
        },
      },
    );
    console.log(stdout);
    expect(stdout.trimEnd().split('\n')).toEqual([
      'Allowed accounts: example. Daily caps per installation (UTC): 5 jobs, 2 inventories.',
      'Installation 1 (example): active, allowed; 2 repositories; today 1/5 jobs, 1/2 inventories; refusals: installation-job-running.',
      'Installation 2 (customer): active, not allowed; 1 repository; today 0/5 jobs, 0/2 inventories; refusals: account-not-allowed.',
    ]);
  },
  30_000,
);

it.skipIf(!DATABASE)(
  'claims and uninstalls racing each other never deadlock',
  async () => {
    const pool = await database();
    const accounts = Array.from({ length: 12 }, (_, index) => `account${index}`);
    const store = await openHostedStore(pool, tenancy(accounts));
    for (const [index, account] of accounts.entries()) {
      await store.approve(approval(`${account}/app`), 'octo-reviewer');
      await install(store, 500 + index, account, [`${account}/app`]);
    }
    const uninstall = (index: number) =>
      store.accept(randomUUID(), 'installation', new TextEncoder().encode(randomUUID()), {
        kind: 'installation',
        installationId: 500 + index,
        owner: accounts[index],
        action: 'deleted',
        added: [],
        removed: [],
      });
    const results = await Promise.allSettled([
      ...accounts.map((_, index) => store.claim(`worker-${index}`, 30)),
      ...accounts.map((_, index) => uninstall(index)),
      store.allow(),
    ]);
    const failures = results.filter((result) => result.status === 'rejected');
    console.log('Rejected:', failures);
    expect(failures).toEqual([]);
    expect((await store.read()).targets.every((target) => target.status === 'cancelled')).toBe(
      true,
    );
  },
  30_000,
);
