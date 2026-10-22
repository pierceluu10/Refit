import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { approvedRepository } from './fixtures/approved-repository.ts';
import {
  accountRename,
  installation,
  installationRepositories,
  malformedWebhooks,
  repositoryEvent,
  repositoryRecord,
  WEBHOOK_APP_ID as APP_ID,
  WEBHOOK_INSTALLATION as INSTALLATION,
  WEBHOOK_REPOSITORY_ID as APPLICATION_ID,
} from './fixtures/webhook-payloads.ts';
import { parseWebhook } from './github-webhooks.ts';
import { runHostedService } from './hosted-service.ts';
import { hostedTargetId, openHostedStore } from './hosted-store.ts';
import { hostedTenancy } from './hosted-tenancy.ts';
import type { RepositoryApproval } from './repository-enrollment.ts';

const github = vi.hoisted(() => ({ missing: false, id: 789 }));
vi.mock('./github-app.ts', async () => {
  const { GitHubRequestError } = await import('./github.ts');
  return {
    authenticateGitHubRead: vi.fn(async (_app: unknown, repository: string) => {
      if (github.missing)
        throw new GitHubRequestError(404, 'GET', `/repos/${repository}/installation`);
      return { token: 'lifecycle-read-token', appId: 123, installationId: 456 };
    }),
  };
});
vi.mock('./github.ts', async (original) => ({
  ...(await original<typeof import('./github.ts')>()),
  requestGitHub: vi.fn(async (_token: string, _method: string, path: string) => ({
    id: github.id,
    full_name: path.slice('/repos/'.length),
    archived: false,
    disabled: false,
  })),
}));

const DATABASE = process.env.REFIT_POSTGRES_URL;
const OTHER_INSTALLATION = 457;
const WEBHOOK_SECRET = 'webhook-secret-for-lifecycle-tests-123';
const CONTROL_TOKEN = 'control-secret-for-lifecycle-tests-456';
const TARGET = hostedTargetId('example/application', 'main');
// Every account the store-level cases move repositories between; the service allows only example.
const TENANCY = hostedTenancy({ REFIT_HOSTED_ACCOUNTS: 'example,other,example-labs' });
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  github.missing = false;
  github.id = APPLICATION_ID;
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

async function approved() {
  const root = await mkdtemp(join(tmpdir(), 'refit-lifecycle-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return { root, ...(await approvedRepository(root)) };
}

// Sends the exact bytes GitHub would through the same parser the service uses.
async function deliver(
  store: Awaited<ReturnType<typeof openHostedStore>>,
  event: string,
  payload: unknown,
  delivery = randomUUID(),
) {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  return store.accept(delivery, event, body, parseWebhook(body, event, APP_ID));
}

async function approvals(pool: pg.Pool) {
  return (
    await pool.query<{ repository: string; approved_by: string; approval: RepositoryApproval }>(
      'SELECT repository, approved_by, approval FROM refit_approvals ORDER BY repository',
    )
  ).rows;
}

// An installed repository's inventory, monitoring state, deadline alerts and report are keyed by
// its name.
async function derive(pool: pg.Pool, repository: string) {
  await pool.query(
    `INSERT INTO refit_inventories (installation_id, repository, state) VALUES ($1, $2, 'idle')`,
    [INSTALLATION, repository],
  );
  await pool.query(
    `INSERT INTO refit_monitoring (installation_id, repository, rescanned_at) VALUES ($1, $2, now())`,
    [INSTALLATION, repository],
  );
  await pool.query(
    `INSERT INTO refit_deadline_alerts (installation_id, repository, deadline, stage, status, sent_at)
     VALUES ($1, $2, 'example-deadline', 1, 'opened', now())`,
    [INSTALLATION, repository],
  );
  await pool.query(
    `INSERT INTO refit_reports (installation_id, repository, digest, status, updated_at)
     VALUES ($1, $2, 'digest', 'opened', now())`,
    [INSTALLATION, repository],
  );
}

async function derived(pool: pg.Pool) {
  const { rows } = await pool.query<{ repository: string }>(
    `SELECT repository FROM refit_inventories UNION ALL SELECT repository FROM refit_monitoring
     UNION ALL SELECT repository FROM refit_deadline_alerts UNION ALL SELECT repository FROM refit_reports`,
  );
  return rows.map((row) => row.repository);
}

async function membership(pool: pg.Pool) {
  return (
    await pool.query<{ installation_id: string; repository: string; github_id: string }>(
      `SELECT installation_id, repository, github_id FROM refit_installation_repositories
       ORDER BY installation_id, repository`,
    )
  ).rows.map((row) => [Number(row.installation_id), row.repository, Number(row.github_id)]);
}

async function service(pool: pg.Pool, root: string, lifecycle = true) {
  const controller = new AbortController();
  let ready: (url: string) => void;
  const listening = new Promise<string>((resolve) => (ready = resolve));
  const progress: string[] = [];
  const running = runHostedService({
    database: pool,
    app: { appId: String(APP_ID), privateKeyFile: 'unused-test-key' },
    directory: join(root, 'hosted-state'),
    webhookSecret: WEBHOOK_SECRET,
    controlToken: CONTROL_TOKEN,
    tenancy: hostedTenancy({ REFIT_HOSTED_OWNER: 'example' }),
    host: '127.0.0.1',
    port: 0,
    intervalSeconds: 30,
    leaseSeconds: 30,
    worker: 'lifecycle-worker',
    lifecycle,
    signal: controller.signal,
    onReady: (url) => ready(url),
    onProgress: (message) => progress.push(message),
  });
  cleanups.push(async () => {
    controller.abort();
    await running.catch(() => undefined);
  });
  const url = await listening;
  const status = async () =>
    (
      await fetch(`${url}/status`, { headers: { Authorization: `Bearer ${CONTROL_TOKEN}` } })
    ).json();
  const send = async (
    event: string,
    payload: unknown,
    headers: Record<string, string> = {},
    body: string | Uint8Array<ArrayBuffer> = JSON.stringify(payload),
  ) => {
    const response = await fetch(`${url}/github/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': event,
        'X-GitHub-Delivery': randomUUID(),
        'X-Hub-Signature-256': `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`,
        ...headers,
      },
      body,
    });
    return { status: response.status, body: await response.json() };
  };
  // Waits until every claimed job has its receipt. /status reads its tables in separate queries, so
  // the final read starts only after a read that saw every receipt: everything a job changed
  // before its receipt is then visible in all three tables.
  const settled = async () => {
    const open = (job: { status: string; attempts: number; receipt: unknown }) =>
      ['queued', 'running'].includes(job.status) || (job.attempts > 0 && job.receipt === null);
    for (const deadline = Date.now() + 20_000; Date.now() < deadline;) {
      if (!(await status()).jobs.some(open)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return status();
  };
  return { url, progress, status, send, settled };
}

it.skipIf(!DATABASE)(
  'enrolls the approved repositories an installation lists when it is created and records the rest',
  async () => {
    const pool = await database();
    const store = await openHostedStore(pool, TENANCY);
    await store.approve((await approved()).approval, 'octo-reviewer');
    const created = await deliver(
      store,
      'installation',
      installation('created', [
        ['example/application', APPLICATION_ID],
        ['example/unapproved', 790],
      ]),
    );
    expect(created).toEqual({ status: 'accepted', enrolled: [TARGET], cancelled: [], running: [] });
    const registry = await store.read();
    expect(registry.installations).toMatchObject([
      {
        id: String(INSTALLATION),
        owner: 'example',
        status: 'active',
        repositories: ['example/application', 'example/unapproved'],
      },
    ]);
    expect(registry.targets).toEqual([
      expect.objectContaining({ id: TARGET, installationId: String(INSTALLATION) }),
    ]);
    expect(await membership(pool)).toEqual([
      [INSTALLATION, 'example/application', APPLICATION_ID],
      [INSTALLATION, 'example/unapproved', 790],
    ]);
  },
);

it.skipIf(!DATABASE)(
  'enrolls an approved repository added to an installation and records an unapproved one without enrolling it',
  async () => {
    const pool = await database();
    const store = await openHostedStore(pool, TENANCY);
    const sample = await approved();
    expect(await store.approve(sample.approval, 'octo-reviewer')).toEqual([]);
    expect((await deliver(store, 'installation', installation('created', []))).enrolled).toEqual(
      [],
    );
    const added = await deliver(
      store,
      'installation_repositories',
      installationRepositories('added', [
        ['example/application', APPLICATION_ID],
        ['example/unapproved', 790],
      ]),
    );
    expect(added).toMatchObject({ status: 'accepted', enrolled: [TARGET], cancelled: [] });
    const registry = await store.read();
    expect(registry.installations[0]).toMatchObject({
      status: 'active',
      repositories: ['example/application', 'example/unapproved'],
    });
    expect(registry.targets).toEqual([expect.objectContaining({ id: TARGET, status: 'enrolled' })]);
    expect(registry.jobs).toEqual([
      expect.objectContaining({ targetId: TARGET, status: 'queued' }),
    ]);
  },
);

it.skipIf(!DATABASE)(
  'cancels a removed repository’s targets and running job and forgets the repository',
  async () => {
    const pool = await database();
    const store = await openHostedStore(pool, TENANCY);
    await store.approve((await approved()).approval, 'octo-reviewer');
    await deliver(store, 'installation', installation('created', [['example/application', 789]]));
    const job = await store.claim('worker-a', 30);
    const removed = await deliver(
      store,
      'installation_repositories',
      installationRepositories('removed', [['example/application', APPLICATION_ID]]),
    );
    expect(removed).toMatchObject({ cancelled: [TARGET], running: [job!.job], enrolled: [] });
    expect(await membership(pool)).toEqual([]);
    const registry = await store.read();
    expect(registry.targets[0]).toMatchObject({
      status: 'cancelled',
      message: 'Repository removed from the installation.',
    });
    expect(registry.jobs[0].status).toBe('cancelled');
  },
);

it.skipIf(!DATABASE)(
  'cancels every target on suspend, records repositories added while suspended without enrolling them, and resumes every approved repository on unsuspend',
  async () => {
    const pool = await database();
    const store = await openHostedStore(pool, TENANCY);
    await store.approve((await approved()).approval, 'octo-reviewer');
    await deliver(
      store,
      'installation',
      installation('created', [['example/application', APPLICATION_ID]], {
        updatedAt: '2026-10-22T08:00:00Z',
      }),
    );
    const suspended = await deliver(
      store,
      'installation',
      installation('suspend', [], { updatedAt: '2026-10-22T09:00:00Z' }),
    );
    expect(suspended).toMatchObject({ cancelled: [TARGET], enrolled: [] });
    expect((await store.read()).targets[0]).toMatchObject({
      status: 'cancelled',
      message: 'Installation suspend.',
    });

    const whileSuspended = await deliver(
      store,
      'installation_repositories',
      installationRepositories('added', [['example/unapproved', 790]]),
    );
    expect(whileSuspended.enrolled).toEqual([]);
    expect((await store.read()).installations[0]).toMatchObject({
      status: 'suspended',
      repositories: ['example/application', 'example/unapproved'],
    });
    expect(await store.enqueueDue(0)).toBe(0);
    expect(await store.claim('worker-a', 30)).toBeNull();

    const resumed = await deliver(
      store,
      'installation',
      installation('unsuspend', [], { updatedAt: '2026-10-22T10:00:00Z' }),
    );
    expect(resumed).toMatchObject({ status: 'accepted', enrolled: [TARGET] });
    const registry = await store.read();
    expect(registry.installations[0].status).toBe('active');
    expect(registry.targets[0]).toMatchObject({ status: 'enrolled', message: null });
    expect(await store.claim('worker-a', 30)).toMatchObject({ target: { id: TARGET } });
  },
);

it.skipIf(!DATABASE)(
  'keeps a suspension in place when new permissions are accepted, and enrolls the listed repositories once active',
  async () => {
    const pool = await database();
    const store = await openHostedStore(pool, TENANCY);
    await store.approve((await approved()).approval, 'octo-reviewer');
    await deliver(store, 'installation', installation('created', []));
    await deliver(store, 'installation', installation('suspend', []));
    const accepted = await deliver(
      store,
      'installation',
      installation('new_permissions_accepted', [['example/application', APPLICATION_ID]]),
    );
    expect(accepted).toMatchObject({ status: 'accepted', enrolled: [] });
    expect((await store.read()).installations[0]).toMatchObject({
      status: 'suspended',
      repositories: ['example/application'],
    });
    await deliver(store, 'installation', installation('unsuspend', []));
    const active = await deliver(
      store,
      'installation',
      installation('new_permissions_accepted', [['example/application', APPLICATION_ID]]),
    );
    expect(active.enrolled).toEqual([TARGET]);
    expect((await store.read()).installations[0].status).toBe('active');
  },
);

it.skipIf(!DATABASE)(
  'follows a renamed repository by its ID: the old target stops and the approval stays with the old name',
  async () => {
    const pool = await database();
    const store = await openHostedStore(pool, TENANCY);
    const sample = await approved();
    await store.approve(sample.approval, 'octo-reviewer');
    await deliver(
      store,
      'installation',
      installation('created', [['example/application', APPLICATION_ID]]),
    );
    await derive(pool, 'example/application');
    const job = await store.claim('worker-a', 30);
    const renamedTarget = hostedTargetId('example/billing', 'main');

    const renamed = await deliver(
      store,
      'repository',
      repositoryEvent('renamed', 'example/Billing', {
        repository: { name: { from: 'Application' } },
      }),
    );
    // Owner decision (2026-10-22): approvals never follow a rename, so nothing enrolls.
    expect(renamed).toMatchObject({
      status: 'accepted',
      cancelled: [TARGET],
      running: [job!.job],
      enrolled: [],
    });
    expect(await membership(pool)).toEqual([[INSTALLATION, 'example/billing', APPLICATION_ID]]);
    expect(await derived(pool)).toEqual(Array(4).fill('example/billing'));
    expect(await approvals(pool)).toEqual([
      {
        repository: 'example/application',
        approved_by: 'octo-reviewer',
        approval: sample.approval,
      },
    ]);
    const { targets } = await store.read();
    expect(targets).toEqual([
      expect.objectContaining({
        id: TARGET,
        status: 'cancelled',
        message: 'Repository renamed to example/billing; approve it under its new name to resume.',
      }),
    ]);
    expect(targets.find((target) => target.id === renamedTarget)).toBeUndefined();
    expect(await store.claim('worker-b', 30)).toBeFalsy();

    // The same rename sent again with a new GUID finds the repository already moved.
    expect(
      await deliver(
        store,
        'repository',
        repositoryEvent('renamed', 'example/billing', {
          repository: { name: { from: 'application' } },
        }),
      ),
    ).toMatchObject({ status: 'accepted', enrolled: [], cancelled: [] });
    // A rename that does not start from the stored name is refused, so it can be redelivered.
    await expect(
      deliver(
        store,
        'repository',
        repositoryEvent('renamed', 'example/payments', {
          repository: { name: { from: 'invoices' } },
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await membership(pool)).toEqual([[INSTALLATION, 'example/billing', APPLICATION_ID]]);
    // A repository the installation never listed moves nothing.
    expect(
      await deliver(
        store,
        'repository',
        repositoryEvent(
          'renamed',
          'example/other',
          { repository: { name: { from: 'old' } } },
          {
            id: 999,
          },
        ),
      ),
    ).toMatchObject({ status: 'accepted', enrolled: [], cancelled: [] });
  },
);

it.skipIf(!DATABASE)(
  'stops a repository transferred to another account and enrolls one transferred in only under an approval for its new name',
  async () => {
    const pool = await database();
    const store = await openHostedStore(pool, TENANCY);
    const sample = await approved();
    await store.approve(sample.approval, 'octo-reviewer');
    await deliver(
      store,
      'installation',
      installation('created', [['example/application', APPLICATION_ID]]),
    );
    await deliver(
      store,
      'installation',
      installation('created', [], { login: 'other', id: OTHER_INSTALLATION }),
    );

    const away = await deliver(
      store,
      'repository',
      repositoryEvent(
        'transferred',
        'other/application',
        { owner: { from: { user: { login: 'example', id: 1001 } } } },
        { installation: OTHER_INSTALLATION },
      ),
    );
    expect(away).toMatchObject({ status: 'accepted', cancelled: [TARGET], enrolled: [] });
    expect(await membership(pool)).toEqual([
      [OTHER_INSTALLATION, 'other/application', APPLICATION_ID],
    ]);
    expect((await store.read()).targets[0]).toMatchObject({
      status: 'cancelled',
      message:
        'Repository transferred to other/application; approve it under its new name to resume.',
    });
    // The approval stays with the account that reviewed it.
    expect((await approvals(pool)).map((row) => row.repository)).toEqual(['example/application']);

    const back = await deliver(
      store,
      'repository',
      repositoryEvent('transferred', 'example/application', {
        owner: { from: { organization: { login: 'other', id: 1002 } } },
      }),
    );
    expect(back).toMatchObject({ status: 'accepted', enrolled: [TARGET], cancelled: [] });
    expect(await membership(pool)).toEqual([[INSTALLATION, 'example/application', APPLICATION_ID]]);
    expect((await store.read()).targets[0]).toMatchObject({ status: 'enrolled', message: null });

    // A transfer into an installation this service never accepted records nothing there.
    await deliver(
      store,
      'repository',
      repositoryEvent(
        'transferred',
        'stranger/application',
        { owner: { from: { user: { login: 'example', id: 1001 } } } },
        { installation: 999 },
      ),
    );
    expect(await membership(pool)).toEqual([]);
  },
);

it.skipIf(!DATABASE)(
  'stops an archived repository’s targets and resumes them when it is unarchived',
  async () => {
    const pool = await database();
    const store = await openHostedStore(pool, TENANCY);
    await store.approve((await approved()).approval, 'octo-reviewer');
    await deliver(
      store,
      'installation',
      installation('created', [['example/application', APPLICATION_ID]]),
    );
    expect(
      await deliver(
        store,
        'repository',
        repositoryEvent('archived', 'example/application', undefined),
      ),
    ).toMatchObject({ cancelled: [TARGET], enrolled: [] });
    expect((await store.read()).targets[0]).toMatchObject({
      status: 'cancelled',
      message: 'Repository archived; unarchive it to resume.',
    });
    expect(await membership(pool)).toEqual([[INSTALLATION, 'example/application', APPLICATION_ID]]);
    expect(
      await deliver(
        store,
        'repository',
        repositoryEvent('unarchived', 'example/application', undefined),
      ),
    ).toMatchObject({ cancelled: [], enrolled: [TARGET] });
    expect((await store.read()).targets[0].status).toBe('enrolled');
  },
);

it.skipIf(!DATABASE)(
  'retires a target before its job when GitHub answers 404 for its repository',
  async () => {
    const pool = await database();
    const sample = await approved();
    await (await openHostedStore(pool, TENANCY)).approve(sample.approval, 'octo-reviewer');
    const hosted = await service(pool, sample.root);
    // GitHub Apps never receive repository.deleted; the next access check answers 404.
    github.missing = true;
    const installed = await hosted.send(
      'installation',
      installation('created', [['example/application', APPLICATION_ID]]),
    );
    expect(installed).toMatchObject({ status: 202, body: { enrolled: [TARGET] } });
    const registry = await hosted.settled();
    expect(registry.targets[0]).toMatchObject({
      status: 'cancelled',
      message:
        'GitHub no longer serves example/application to this installation: it was deleted or removed from the installation.',
    });
    expect(registry.jobs).toEqual([
      expect.objectContaining({
        status: 'cancelled',
        attempts: 1,
        receipt: expect.objectContaining({ status: 'error' }),
      }),
    ]);
    expect(registry.jobs[0].receipt.message).toContain('HTTP 404');
    // The repository stays recorded and approved, so access granted again re-enrolls it.
    expect(await membership(pool)).toEqual([[INSTALLATION, 'example/application', APPLICATION_ID]]);
    expect((await approvals(pool)).map((row) => row.repository)).toEqual(['example/application']);
  },
  30_000,
);

it.skipIf(!DATABASE)(
  'retires a target whose name now belongs to a different repository and requires a new approval',
  async () => {
    const pool = await database();
    const sample = await approved();
    const store = await openHostedStore(pool, TENANCY);
    await store.approve(sample.approval, 'octo-reviewer');
    const hosted = await service(pool, sample.root);
    // The installed repository was deleted and a new one created under the same name.
    github.id = 4242;
    await hosted.send(
      'installation',
      installation('created', [['example/application', APPLICATION_ID]]),
    );
    const registry = await hosted.settled();
    expect(registry.targets[0]).toMatchObject({
      status: 'cancelled',
      message:
        'example/application now names a different GitHub repository than the one approved; approve it again.',
    });
    expect(registry.jobs).toEqual([expect.objectContaining({ status: 'cancelled', attempts: 1 })]);
    expect(registry.jobs[0].receipt.message).toBe(
      'PipelineInputError: Repository name now belongs to a different GitHub repository; approve it again.',
    );
    expect(await approvals(pool)).toEqual([]);
    expect(await membership(pool)).toEqual([[INSTALLATION, 'example/application', 4242]]);
    expect(hosted.progress.join('\n')).not.toContain('lifecycle-read-token');
    // A fresh approval enrolls the new repository, and its ID now matches.
    expect(await store.approve(sample.approval, 'octo-reviewer')).toEqual([TARGET]);
    expect(await store.retire(TARGET, 4242)).toBe(false);
  },
  30_000,
);

it.skipIf(!DATABASE)(
  'follows an account rename: the login and repository names move, approvals stay and targets stop',
  async () => {
    const pool = await database();
    const store = await openHostedStore(pool, TENANCY);
    const sample = await approved();
    await store.approve(sample.approval, 'octo-reviewer');
    await deliver(
      store,
      'installation',
      installation('created', [['example/application', APPLICATION_ID]]),
    );
    await derive(pool, 'example/application');
    const renamed = await deliver(
      store,
      'installation_target',
      accountRename('example', 'Example-Labs'),
    );
    expect(renamed).toMatchObject({ status: 'accepted', cancelled: [TARGET], enrolled: [] });
    const registry = await store.read();
    expect(registry.installations).toEqual([
      expect.objectContaining({
        owner: 'example-labs',
        repositories: ['example-labs/application'],
      }),
    ]);
    expect((await approvals(pool)).map((row) => row.repository)).toEqual(['example/application']);
    expect(await derived(pool)).toEqual(Array(4).fill('example-labs/application'));
    // Later installation events carry the new login and are no longer refused as a changed owner.
    expect(
      (
        await deliver(
          store,
          'installation_repositories',
          installationRepositories('added', [['example-labs/tools', 791]], {
            login: 'example-labs',
          }),
        )
      ).status,
    ).toBe('accepted');
    expect(
      await deliver(store, 'installation_target', accountRename('example', 'example-labs')),
    ).toMatchObject({ status: 'accepted', enrolled: [], cancelled: [] });
    await expect(
      deliver(store, 'installation_target', accountRename('someone', 'example-tools')),
    ).rejects.toMatchObject({ status: 409 });
    expect((await store.read()).installations[0].owner).toBe('example-labs');

    // A rename to a login the allowlist does not name stops every target and enrolls nothing.
    expect(
      await deliver(store, 'installation_target', accountRename('example-labs', 'example-gone')),
    ).toMatchObject({ status: 'not-allowed', enrolled: [] });
    expect((await store.read()).installations[0]).toMatchObject({
      owner: 'example-gone',
      allowed: false,
    });
  },
);

it.skipIf(!DATABASE)(
  'refuses a renamed account whose new login is not allowed over HTTP and tells the operator to list it',
  async () => {
    const pool = await database();
    const sample = await approved();
    const hosted = await service(pool, sample.root);
    await hosted.send('installation', installation('created', []));
    const renamed = await hosted.send(
      'installation_target',
      accountRename('example', 'example-labs'),
    );
    expect(renamed).toMatchObject({ status: 202, body: { status: 'not-allowed' } });
    expect(hosted.progress).toContain(
      'Account example is now example-labs, which REFIT_HOSTED_ACCOUNTS does not list; its targets stopped. Add example-labs to allow it again.',
    );
    // The allowlist matches logins, so the new login stays refused until the operator lists it.
    expect(
      await hosted.send(
        'installation_repositories',
        installationRepositories('added', [['example-labs/application', 789]], {
          login: 'example-labs',
        }),
      ),
    ).toMatchObject({ status: 202, body: { status: 'not-allowed' } });
    expect((await hosted.status()).installations).toEqual([
      expect.objectContaining({
        owner: 'example-labs',
        allowed: false,
        repositories: ['example-labs/application'],
      }),
    ]);
  },
  30_000,
);

it.skipIf(!DATABASE)(
  'ignores repository and account events unless lifecycle handling is on, and still accepts pushes',
  async () => {
    const pool = await database();
    const sample = await approved();
    const store = await openHostedStore(pool, TENANCY);
    await store.approve(sample.approval, 'octo-reviewer');
    const hosted = await service(pool, sample.root, false);
    await hosted.send(
      'installation',
      installation('created', [['example/application', APPLICATION_ID]]),
    );
    const events: [string, unknown][] = [
      [
        'repository',
        repositoryEvent('renamed', 'example/billing', {
          repository: { name: { from: 'application' } },
        }),
      ],
      ['repository', repositoryEvent('archived', 'example/application', undefined)],
      ['installation_target', accountRename('example', 'example-labs')],
    ];
    for (const [event, payload] of events)
      expect(await hosted.send(event, payload), event).toMatchObject({
        status: 202,
        body: { status: 'ignored', enrolled: [], cancelled: [] },
      });
    expect(await membership(pool)).toEqual([[INSTALLATION, 'example/application', APPLICATION_ID]]);
    expect((await approvals(pool)).map((row) => row.repository)).toEqual(['example/application']);
    expect((await hosted.status()).installations).toMatchObject([{ owner: 'example' }]);
    // A default-branch push is accepted ahead of the ignored events, so monitoring can use it.
    expect(
      await hosted.send('push', {
        ref: 'refs/heads/main',
        after: 'c'.repeat(40),
        installation: { id: INSTALLATION },
        repository: {
          ...repositoryRecord('example/application', APPLICATION_ID),
          default_branch: 'main',
        },
      }),
    ).toMatchObject({ status: 202, body: { status: 'accepted' } });
  },
  30_000,
);

it.skipIf(!DATABASE)(
  'treats a deleted installation as final when its created delivery arrives late',
  async () => {
    const pool = await database();
    const store = await openHostedStore(pool, TENANCY);
    await store.approve((await approved()).approval, 'octo-reviewer');
    const deleted = await deliver(
      store,
      'installation',
      installation('deleted', [['example/application', APPLICATION_ID]], {
        updatedAt: '2026-10-22T09:00:00Z',
      }),
    );
    expect(deleted).toMatchObject({ status: 'accepted', enrolled: [] });
    const created = await deliver(
      store,
      'installation',
      installation('created', [['example/application', APPLICATION_ID]], {
        updatedAt: '2026-10-22T08:00:00Z',
      }),
    );
    expect(created).toMatchObject({ status: 'stale', enrolled: [], cancelled: [] });
    for (const late of [
      ['installation', installation('unsuspend', [], { updatedAt: '2026-10-22T10:00:00Z' })],
      [
        'installation_repositories',
        installationRepositories('added', [['example/unapproved', 790]]),
      ],
    ] as const)
      expect((await deliver(store, late[0], late[1])).status).toBe('stale');
    const registry = await store.read();
    expect(registry.installations).toEqual([
      expect.objectContaining({ status: 'deleted', repositories: ['example/application'] }),
    ]);
    expect(registry.targets).toEqual([]);
    expect(registry.jobs).toEqual([]);
  },
);

it.skipIf(!DATABASE)(
  'skips an installation event older than the newest one applied, so a late suspend cannot stop a resumed installation',
  async () => {
    const pool = await database();
    const store = await openHostedStore(pool, TENANCY);
    await store.approve((await approved()).approval, 'octo-reviewer');
    await deliver(
      store,
      'installation',
      installation('created', [['example/application', APPLICATION_ID]], {
        // GitHub may send Unix seconds instead of an ISO timestamp.
        updatedAt: Date.parse('2026-10-22T08:00:00Z') / 1000,
      }),
    );
    // The suspend delivery failed; the unsuspend that followed it arrived first.
    await deliver(
      store,
      'installation',
      installation('unsuspend', [], { updatedAt: '2026-10-22T10:00:00Z' }),
    );
    const late = await deliver(
      store,
      'installation',
      installation('suspend', [], { updatedAt: '2026-10-22T09:00:00Z' }),
    );
    expect(late).toMatchObject({ status: 'stale', cancelled: [] });
    const registry = await store.read();
    expect(registry.installations[0].status).toBe('active');
    expect(registry.targets[0].status).toBe('enrolled');
    // An event at the same time as the newest one still applies.
    expect(
      (
        await deliver(
          store,
          'installation',
          installation('suspend', [], { updatedAt: '2026-10-22T10:00:00Z' }),
        )
      ).cancelled,
    ).toEqual([TARGET]);
  },
);

it.skipIf(!DATABASE)(
  'treats a redelivery hours or months later as a duplicate and never prunes delivery IDs',
  async () => {
    const pool = await database();
    const store = await openHostedStore(pool, TENANCY);
    await store.approve((await approved()).approval, 'octo-reviewer');
    const payload = installation('created', [['example/application', APPLICATION_ID]]);
    const delivery = randomUUID();
    expect((await deliver(store, 'installation', payload, delivery)).enrolled).toEqual([TARGET]);
    await store.finish((await store.claim('worker-a', 30))!.job, 'worker-a', 'finished', {
      status: 'validated',
      output: null,
      message: null,
    });
    await pool.query(
      `UPDATE refit_deliveries SET received_at = now() - interval '6 hours' WHERE id = $1`,
      [delivery],
    );
    expect(await deliver(store, 'installation', payload, delivery)).toMatchObject({
      status: 'duplicate',
      enrolled: [],
    });
    expect((await store.read()).jobs).toHaveLength(1);

    // Owner decision (2026-10-22): replay hashes are kept forever.
    await pool.query(
      `UPDATE refit_deliveries SET received_at = now() - interval '400 days' WHERE id = $1`,
      [delivery],
    );
    const next = randomUUID();
    await deliver(store, 'ping', { zen: 'Design for failure.' }, next);
    expect(await deliver(store, 'installation', payload, delivery)).toMatchObject({
      status: 'duplicate',
      enrolled: [],
    });
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM refit_deliveries');
    expect(rows.map((row) => row.id).sort()).toEqual([delivery, next].sort());
  },
);

it.skipIf(!DATABASE)(
  'acknowledges unknown events and actions with 202 and changes nothing',
  async () => {
    const pool = await database();
    const sample = await approved();
    const hosted = await service(pool, sample.root);
    const unknown: [string, unknown][] = [
      ['issues', { action: 'opened', issue: { number: 1 } }],
      [
        'pull_request',
        {
          action: 'opened',
          number: 7,
          installation: { id: INSTALLATION },
          repository: repositoryRecord('example/application', APPLICATION_ID),
          pull_request: {
            number: 7,
            base: { sha: 'a'.repeat(40) },
            head: { sha: 'b'.repeat(40) },
          },
        },
      ],
      [
        'push',
        {
          ref: 'refs/heads/feature',
          installation: { id: INSTALLATION },
          repository: { ...repositoryRecord('example/application', 789), default_branch: 'main' },
        },
      ],
      ['github_app_authorization', { action: 'revoked', sender: { login: 'octocat' } }],
      ['installation', { ...installation('created', []), action: 'reauthorized' }],
      ['installation_repositories', { ...installationRepositories('added', []), action: 'moved' }],
      ['installation_target', { ...accountRename('example', 'x'), action: 'deleted' }],
      [
        'installation_target',
        { ...accountRename('example', 'x'), changes: { slug: { from: 'old-slug' } } },
      ],
      ['repository', repositoryEvent('publicized', 'example/application', undefined)],
      ['repository', repositoryEvent('created', 'example/application', undefined)],
      ['repository', repositoryEvent('deleted', 'example/application', undefined)],
      ['security_advisory', { action: 'published' }],
    ];
    for (const [event, payload] of unknown)
      expect(await hosted.send(event, payload), event).toMatchObject({
        status: 202,
        body: { status: 'ignored', enrolled: [], cancelled: [] },
      });
    expect(await hosted.status()).toMatchObject({ installations: [], targets: [], jobs: [] });
    const { rows } = await pool.query('SELECT event FROM refit_deliveries');
    expect(rows).toHaveLength(unknown.length);
  },
  30_000,
);

it.skipIf(!DATABASE)(
  'refuses malformed and oversized webhooks with a 4xx and changes nothing',
  async () => {
    const pool = await database();
    const sample = await approved();
    const hosted = await service(pool, sample.root);
    // An installed repository and a stored delivery give a malformed delivery state to disturb.
    await hosted.send(
      'installation',
      installation('created', [['example/application', APPLICATION_ID]]),
    );
    // The install inventory runs in the background; the snapshot waits until it has finished.
    for (const deadline = Date.now() + 20_000; Date.now() < deadline;) {
      const { inventories } = await hosted.status();
      if (inventories.every((entry: { checkedAt: string | null }) => entry.checkedAt)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const snapshot = async () => ({
      registry: await hosted.status(),
      membership: await membership(pool),
      deliveries: (await pool.query('SELECT id, hash, event FROM refit_deliveries ORDER BY id'))
        .rows,
    });
    const before = await snapshot();

    const valid = JSON.stringify(
      installation('deleted', [['example/application', APPLICATION_ID]]),
    );
    const raw: {
      name: string;
      event: string;
      body: string | Uint8Array<ArrayBuffer>;
      headers?: Record<string, string>;
    }[] = [
      {
        name: 'wrong signature',
        event: 'installation',
        body: valid,
        headers: { 'X-Hub-Signature-256': `sha256=${'0'.repeat(64)}` },
      },
      {
        name: 'missing signature',
        event: 'installation',
        body: valid,
        headers: { 'X-Hub-Signature-256': '' },
      },
      {
        name: 'SHA-1 signature',
        event: 'installation',
        body: valid,
        headers: { 'X-Hub-Signature-256': `sha1=${'0'.repeat(40)}` },
      },
      {
        name: 'invalid delivery GUID',
        event: 'installation',
        body: valid,
        headers: { 'X-GitHub-Delivery': 'not-a-guid' },
      },
      { name: 'invalid event name', event: 'Installation', body: valid },
      { name: 'empty event name', event: '', body: valid },
      {
        name: 'text body',
        event: 'installation',
        body: valid,
        headers: { 'Content-Type': 'text/plain' },
      },
      {
        name: 'compressed body',
        event: 'installation',
        body: valid,
        headers: { 'Content-Encoding': 'gzip' },
      },
      { name: 'JSON array', event: 'installation', body: '[]' },
      { name: 'JSON string', event: 'installation', body: '"installation"' },
      { name: 'empty body', event: 'installation', body: '' },
      {
        name: 'invalid UTF-8',
        event: 'installation',
        body: Buffer.concat([
          Buffer.from(valid.slice(0, -1)),
          Buffer.from([0xff, 0xfe]),
          Buffer.from('}'),
        ]),
      },
      {
        name: 'deeply nested',
        event: 'installation',
        body: `{"action":"deleted","nested":${'['.repeat(100_000)}${']'.repeat(100_000)}}`,
      },
      {
        name: 'over 1 MiB',
        event: 'installation',
        body: JSON.stringify({ ...JSON.parse(valid), padding: 'x'.repeat(1024 * 1024) }),
      },
      ...[1, 10, 100, valid.length / 2, valid.length - 1].map((length) => ({
        name: `truncated to ${Math.floor(length)} bytes`,
        event: 'installation',
        body: valid.slice(0, Math.floor(length)),
      })),
    ];
    const malformed = malformedWebhooks();
    const outcomes: string[] = [];
    for (const item of [
      ...raw,
      ...malformed.map((item) => ({ ...item, body: JSON.stringify(item.payload), headers: {} })),
    ]) {
      const { status } = await hosted.send(item.event, undefined, item.headers, item.body);
      if (status < 400 || status >= 500) outcomes.push(`${item.name}: HTTP ${status}`);
    }
    console.log(`${raw.length + malformed.length} malformed deliveries refused`);
    expect(outcomes).toEqual([]);
    expect(await snapshot()).toEqual(before);
  },
  60_000,
);
