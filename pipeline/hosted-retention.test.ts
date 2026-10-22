import { randomBytes, randomUUID } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, expect, it } from 'vitest';
import { purgeUninstalled, UNINSTALL_GRACE_DAYS } from './hosted-retention.ts';
import { runHostedService } from './hosted-service.ts';
import { hostedTargetId, openHostedStore } from './hosted-store.ts';
import { hostedTenancy } from './hosted-tenancy.ts';
import type { RepositoryApproval } from './repository-enrollment.ts';

const DATABASE = process.env.REFIT_POSTGRES_URL;
const OWNER = 'example';
const TENANCY = hostedTenancy({ REFIT_HOSTED_OWNER: OWNER });
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
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

async function stateDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'refit-hosted-retention-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
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

// Approves and installs each repository, finishes its first job and writes its evidence.
async function installed(pool: pg.Pool, state: string, installations: Record<number, string>) {
  const store = await openHostedStore(pool, TENANCY);
  for (const [id, repository] of Object.entries(installations)) {
    await store.approve(approval(repository), 'octo-reviewer');
    await install(store, Number(id), repository);
    const claimed = await store.claim('test-worker', 60);
    await store.finish(claimed!.job, 'test-worker', 'finished', {
      status: 'unchanged',
      output: null,
      message: 'No contract change.',
    });
    const evidence = join(state, 'targets', hostedTargetId(repository, 'main'), 'evidence');
    await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, 'receipt.json'), '{}');
  }
  return store;
}

async function install(
  store: Awaited<ReturnType<typeof openHostedStore>>,
  installationId: number,
  repository: string,
  action = 'created',
) {
  await store.accept(randomUUID(), 'installation', new TextEncoder().encode(randomUUID()), {
    kind: 'installation',
    installationId,
    owner: OWNER,
    action,
    added: action === 'created' ? [{ id: installationId * 10, name: repository }] : [],
    removed: [],
  });
}

async function uninstalledDaysAgo(pool: pg.Pool, installationId: number, days: number) {
  await pool.query(
    'UPDATE refit_installations SET updated_at = now() - make_interval(days => $2) WHERE id = $1',
    [installationId, days],
  );
}

async function counts(pool: pg.Pool) {
  const { rows } = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM refit_installations) AS installations,
       (SELECT count(*)::int FROM refit_installation_repositories) AS repositories,
       (SELECT count(*)::int FROM refit_approvals) AS approvals,
       (SELECT count(*)::int FROM refit_targets) AS targets,
       (SELECT count(*)::int FROM refit_jobs) AS jobs`,
  );
  return rows[0];
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

it.skipIf(!DATABASE)(
  'deletes an uninstalled installation’s targets, jobs and evidence only after the grace period',
  async () => {
    const pool = await database();
    const state = await stateDirectory();
    const store = await installed(pool, state, {
      456: 'example/application',
      900: 'example/billing',
    });
    const removed = join(state, 'targets', hostedTargetId('example/billing', 'main'));
    const kept = join(state, 'targets', hostedTargetId('example/application', 'main'));
    await install(store, 900, 'example/billing', 'deleted');
    const before = await counts(pool);
    console.log('Before purge:', before);
    expect(before).toEqual({
      installations: 2,
      repositories: 2,
      approvals: 2,
      targets: 2,
      jobs: 2,
    });

    // One day short of the grace period nothing is deleted.
    await uninstalledDaysAgo(pool, 900, UNINSTALL_GRACE_DAYS - 1);
    expect(await purgeUninstalled(pool, state)).toEqual({
      installations: [],
      targets: [],
      jobs: 0,
      kept: [],
    });
    expect(await counts(pool)).toEqual(before);
    expect(await exists(removed)).toBe(true);

    await uninstalledDaysAgo(pool, 900, UNINSTALL_GRACE_DAYS + 1);
    const purged = await purgeUninstalled(pool, state);
    console.log('Purged:', purged);
    expect(purged).toEqual({
      installations: [900],
      targets: [hostedTargetId('example/billing', 'main')],
      jobs: 1,
      kept: [],
    });
    // The installation row records the uninstall; approvals belong to repositories and stay.
    expect(await counts(pool)).toEqual({
      installations: 2,
      repositories: 1,
      approvals: 2,
      targets: 1,
      jobs: 1,
    });
    expect(await exists(removed)).toBe(false);
    expect(await exists(join(kept, 'evidence', 'receipt.json'))).toBe(true);
    const { rows } = await pool.query(
      'SELECT id::int, status FROM refit_installations ORDER BY id',
    );
    expect(rows).toEqual([
      { id: 456, status: 'active' },
      { id: 900, status: 'deleted' },
    ]);
    // A later pass finds nothing left to delete.
    expect((await purgeUninstalled(pool, state)).installations).toEqual([]);
  },
);

it.skipIf(!DATABASE)(
  'keeps the history and evidence of a repository reinstalled within the grace period',
  async () => {
    const pool = await database();
    const state = await stateDirectory();
    const store = await installed(pool, state, { 456: 'example/application' });
    const target = hostedTargetId('example/application', 'main');
    await install(store, 456, 'example/application', 'deleted');
    // GitHub gives a reinstalled App a new installation id.
    await install(store, 457, 'example/application');
    await uninstalledDaysAgo(pool, 456, UNINSTALL_GRACE_DAYS + 1);

    const purged = await purgeUninstalled(pool, state);
    console.log('Purged after reinstall:', purged);
    expect(purged).toEqual({ installations: [456], targets: [], jobs: 0, kept: [] });
    const { rows } = await pool.query(
      `SELECT t.installation_id::int AS installation, t.status, count(j.id)::int AS jobs
       FROM refit_targets t JOIN refit_jobs j ON j.target_id = t.id
       WHERE t.id = $1 GROUP BY 1, 2`,
      [target],
    );
    // The first job's history and the new installation's queued job both stay.
    expect(rows).toEqual([{ installation: 457, status: 'enrolled', jobs: 2 }]);
    expect(await exists(join(state, 'targets', target, 'evidence', 'receipt.json'))).toBe(true);
    expect(
      (await pool.query('SELECT installation_id::int FROM refit_installation_repositories')).rows,
    ).toEqual([{ installation_id: 457 }]);
  },
);

it.skipIf(!DATABASE || process.getuid?.() === 0)(
  'keeps the rows of a target whose evidence cannot be removed until a later pass',
  async () => {
    const pool = await database();
    const state = await stateDirectory();
    const store = await installed(pool, state, { 900: 'example/billing' });
    const target = hostedTargetId('example/billing', 'main');
    await install(store, 900, 'example/billing', 'deleted');
    await uninstalledDaysAgo(pool, 900, UNINSTALL_GRACE_DAYS + 1);
    const targets = join(state, 'targets');
    await chmod(targets, 0o500);
    cleanups.push(() => chmod(targets, 0o700));

    const purged = await purgeUninstalled(pool, state);
    console.log('Purge with a read-only state directory:', purged);
    expect(purged).toEqual({
      installations: [900],
      targets: [],
      jobs: 0,
      kept: [{ target, reason: expect.stringContaining('EACCES') }],
    });
    expect(await counts(pool)).toMatchObject({ repositories: 0, targets: 1, jobs: 1 });

    await chmod(targets, 0o700);
    expect(await purgeUninstalled(pool, state)).toEqual({
      installations: [900],
      targets: [target],
      jobs: 1,
      kept: [],
    });
    expect(await exists(join(targets, target))).toBe(false);
  },
);

// The loop purges between enqueueing due targets and claiming jobs, so once the due job is claimed
// the pass has reached the purge.
async function servePass(pool: pg.Pool, state: string, purge: boolean | undefined) {
  await pool.query(
    `UPDATE refit_jobs SET created_at = now() - interval '1 day'
     WHERE target_id = $1`,
    [hostedTargetId('example/application', 'main')],
  );
  const controller = new AbortController();
  const service = runHostedService({
    database: pool,
    app: { appId: '123', privateKeyFile: join(state, 'missing-test-key') },
    directory: state,
    webhookSecret: 'webhook-secret-for-hosted-retention-tests-123',
    controlToken: 'control-secret-for-hosted-retention-tests-456',
    tenancy: TENANCY,
    host: '127.0.0.1',
    port: 0,
    intervalSeconds: 30,
    leaseSeconds: 30,
    worker: 'retention-worker',
    signal: controller.signal,
    ...(purge !== undefined && { purgeUninstalled: purge }),
  });
  try {
    for (let attempt = 0; attempt < 300; attempt++) {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS claimed FROM refit_jobs
         WHERE target_id = $1 AND attempts > 0 AND created_at > now() - interval '1 hour'`,
        [hostedTargetId('example/application', 'main')],
      );
      if (rows[0].claimed) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('The worker never claimed the due job.');
  } finally {
    controller.abort();
    await service.catch(() => undefined);
  }
}

it.skipIf(!DATABASE)('deletes nothing unless the worker runs with purgeUninstalled', async () => {
  const pool = await database();
  const state = await stateDirectory();
  const store = await installed(pool, state, {
    456: 'example/application',
    900: 'example/billing',
  });
  await install(store, 900, 'example/billing', 'deleted');
  await uninstalledDaysAgo(pool, 900, UNINSTALL_GRACE_DAYS + 1);
  const removed = join(state, 'targets', hostedTargetId('example/billing', 'main'));

  await servePass(pool, state, undefined);
  const after = await counts(pool);
  console.log('After a default pass:', after);
  expect(after.targets).toBe(2);
  expect(await exists(removed)).toBe(true);

  await servePass(pool, state, true);
  const purged = await counts(pool);
  console.log('After a purging pass:', purged);
  expect(purged.targets).toBe(1);
  expect(await exists(removed)).toBe(false);
});
