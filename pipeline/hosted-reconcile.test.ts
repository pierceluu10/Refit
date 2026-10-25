import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { approvedRepository } from './fixtures/approved-repository.ts';
import {
  installation,
  repositoryRecord,
  WEBHOOK_APP_ID as APP_ID,
  WEBHOOK_INSTALLATION as INSTALLATION,
  WEBHOOK_REPOSITORY_ID as APPLICATION_ID,
} from './fixtures/webhook-payloads.ts';
import type { GitHubAppConfiguration } from './github-app.ts';
import type { WebhookRepository } from './github-webhooks.ts';
import { parseWebhook } from './github-webhooks.ts';
import type { HostedLogContext } from './hosted-ops.ts';
import { reconcileInstallations, runHostedService } from './hosted-service.ts';
import { hostedTargetId, openHostedStore } from './hosted-store.ts';
import { hostedTenancy } from './hosted-tenancy.ts';

const DATABASE = process.env.REFIT_POSTGRES_URL;
const API_ROOT = 'https://api.github.com';
const OTHER_INSTALLATION = 457;
const THIRD_INSTALLATION = 458;
const RECORDED_ID = 801;
const TARGET = hostedTargetId('example/application', 'main');
const realFetch = globalThis.fetch;
const cleanups: (() => Promise<unknown>)[] = [];
let app: GitHubAppConfiguration;

type HostedStore = Awaited<ReturnType<typeof openHostedStore>>;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-reconcile-key-'));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyFile = join(root, 'app.pem');
  await writeFile(privateKeyFile, privateKey.export({ type: 'pkcs1', format: 'pem' }), {
    mode: 0o600,
  });
  app = { appId: String(APP_ID), privateKeyFile };
  return () => rm(root, { recursive: true, force: true });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// A GitHub that issues one token per installation and serves that installation's repositories in
// pages; a number instead of a list answers its token request with that HTTP status.
function fakeGitHub(lists: Record<number, [string, number][] | number>) {
  const requests: { method: string; path: string; body?: unknown }[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    );
    if (url.origin !== API_ROOT) return realFetch(input, init);
    requests.push({
      method: init?.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
    });
    const access = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
    if (access) {
      const list = lists[Number(access[1])];
      if (typeof list === 'number')
        return Response.json({ message: 'Server Error' }, { status: list });
      return Response.json(
        {
          token: `ghs_installation_${access[1]}`,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          permissions: { metadata: 'read' },
          repository_selection: 'all',
        },
        { status: 201 },
      );
    }
    const token = /^Bearer ghs_installation_(\d+)$/.exec(
      new Headers(init?.headers).get('authorization') ?? '',
    );
    const list = token && lists[Number(token[1])];
    if (url.pathname !== '/installation/repositories' || !Array.isArray(list))
      return Response.json({ message: 'Not Found' }, { status: 404 });
    const size = Number(url.searchParams.get('per_page'));
    const page = Number(url.searchParams.get('page'));
    return Response.json({
      total_count: list.length,
      repository_selection: 'all',
      repositories: list
        .slice((page - 1) * size, page * size)
        .map(([name, id]) => repositoryRecord(name, id)),
    });
  });
  return requests;
}

const forks = (owner: string, count: number, firstId: number) =>
  Array.from({ length: count }, (_, index): [string, number] => [
    `${owner}/fork-${index}`,
    firstId + index,
  ]);

const listing = (installationId: number, pages: number) => [
  {
    method: 'POST',
    path: `/app/installations/${installationId}/access_tokens`,
    body: { permissions: { metadata: 'read' } },
  },
  ...Array.from({ length: pages }, (_, index) => ({
    method: 'GET',
    path: `/installation/repositories?per_page=100&page=${index + 1}`,
  })),
];

it('lists every installation’s repositories page by page with its own token and reports one installation’s failure without stopping the rest', async () => {
  const requests = fakeGitHub({
    [INSTALLATION]: forks('Example', 250, 2000),
    [OTHER_INSTALLATION]: 500,
    [THIRD_INSTALLATION]: [['someone-else/application', 3000]],
  });
  const recorded: [number, string, WebhookRepository[]][] = [];
  // Only the GitHub side is under test here; the PostgreSQL cases below use the real store.
  const store = {
    activeInstallations: async () => [
      { id: INSTALLATION, owner: 'example' },
      { id: OTHER_INSTALLATION, owner: 'other' },
      { id: THIRD_INSTALLATION, owner: 'third' },
    ],
    reconcile: async (id: number, owner: string, repositories: WebhookRepository[]) => {
      recorded.push([id, owner, repositories]);
      return { added: repositories.map((repository) => repository.name), enrolled: [] };
    },
  } as unknown as HostedStore;
  const results = await reconcileInstallations(app, store);
  console.log(JSON.stringify(requests.map(({ method, path }) => `${method} ${path}`)));
  expect(results).toEqual([
    {
      installationId: INSTALLATION,
      added: forks('example', 250, 2000).map(([name]) => name),
      enrolled: [],
    },
    {
      installationId: OTHER_INSTALLATION,
      error: expect.stringMatching(/access_tokens failed with HTTP 500/),
    },
    {
      installationId: THIRD_INSTALLATION,
      error: 'Webhook repository owner does not match its installation.',
    },
  ]);
  expect(recorded).toEqual([
    [INSTALLATION, 'example', forks('example', 250, 2000).map(([name, id]) => ({ name, id }))],
  ]);
  expect(requests).toEqual([
    ...listing(INSTALLATION, 3),
    ...listing(OTHER_INSTALLATION, 0),
    ...listing(THIRD_INSTALLATION, 1),
  ]);
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

// Sends the exact bytes GitHub would through the same parser the service uses.
async function deliver(store: HostedStore, event: string, payload: unknown) {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  return store.accept(randomUUID(), event, body, parseWebhook(body, event, APP_ID));
}

async function membership(pool: pg.Pool) {
  return (
    await pool.query<{ installation_id: string; repository: string; github_id: string }>(
      `SELECT installation_id, repository, github_id FROM refit_installation_repositories
       ORDER BY installation_id, repository`,
    )
  ).rows.map((row) => [Number(row.installation_id), row.repository, Number(row.github_id)]);
}

it.skipIf(!DATABASE)(
  'records the repositories no webhook delivered, enrolls approved ones once, keeps omitted ones and leaves other accounts alone',
  async () => {
    const pool = await database();
    const store = await openHostedStore(pool, hostedTenancy({ REFIT_HOSTED_ACCOUNTS: 'example' }));
    const root = await mkdtemp(join(tmpdir(), 'refit-reconcile-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await store.approve((await approvedRepository(root)).approval, 'octo-reviewer');
    // The installation event listed one repository; GitHub serves 102 more over two pages.
    await deliver(store, 'installation', installation('created', [['example/recorded', 801]]));
    await deliver(
      store,
      'installation',
      installation('created', [['other/application', 901]], { login: 'other', id: 457 }),
    );
    const before = await membership(pool);
    const requests = fakeGitHub({
      [INSTALLATION]: [
        ['example/application', APPLICATION_ID],
        // The recorded repository under a name no rename event delivered: known by its ID.
        ['example/renamed', RECORDED_ID],
        ...forks('example', 100, 2000),
      ],
      [OTHER_INSTALLATION]: [['other/missing', 902]],
    });
    const added = ['example/application', ...forks('example', 100, 2000).map(([name]) => name)];
    expect(await reconcileInstallations(app, store)).toEqual([
      { installationId: INSTALLATION, added: added.sort(), enrolled: [TARGET] },
    ]);
    expect(requests).toEqual(listing(INSTALLATION, 2));
    const after = await membership(pool);
    console.log(`${before.length} recorded before, ${after.length} after`);
    expect(after).toEqual(
      expect.arrayContaining([
        [INSTALLATION, 'example/application', APPLICATION_ID],
        [INSTALLATION, 'example/recorded', RECORDED_ID],
        [OTHER_INSTALLATION, 'other/application', 901],
      ]),
    );
    expect(after).toHaveLength(before.length + added.length);
    expect(after.some(([, repository]) => repository === 'example/renamed')).toBe(false);
    const registry = await store.read();
    expect(registry.targets).toEqual([
      expect.objectContaining({ id: TARGET, installationId: String(INSTALLATION) }),
    ]);
    expect(registry.jobs).toEqual([
      expect.objectContaining({ targetId: TARGET, status: 'queued' }),
    ]);

    // Rerunning finds nothing new and queues no second job.
    expect(await reconcileInstallations(app, store)).toEqual([
      { installationId: INSTALLATION, added: [], enrolled: [] },
    ]);
    expect(await membership(pool)).toEqual(after);
    expect((await store.read()).jobs).toHaveLength(1);
    // A not-allowed installation stays untouched even when asked directly.
    expect(
      await store.reconcile(OTHER_INSTALLATION, 'other', [{ name: 'other/missing', id: 902 }]),
    ).toEqual({ added: [], enrolled: [] });
    expect(await membership(pool)).toEqual(after);
  },
  60_000,
);

it.skipIf(!DATABASE)(
  'keeps serving when GitHub refuses one installation’s list, and reconciles the others on start',
  async () => {
    const pool = await database();
    const tenancy = hostedTenancy({ REFIT_HOSTED_ACCOUNTS: 'example,other' });
    const store = await openHostedStore(pool, tenancy);
    await deliver(store, 'installation', installation('created', []));
    await deliver(store, 'installation', installation('created', [], { login: 'other', id: 457 }));
    fakeGitHub({ [INSTALLATION]: 500, [OTHER_INSTALLATION]: [['other/application', 901]] });
    const root = await mkdtemp(join(tmpdir(), 'refit-reconcile-serve-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const controller = new AbortController();
    let ready: (url: string) => void;
    const listening = new Promise<string>((resolve) => (ready = resolve));
    const progress: [string, HostedLogContext | undefined][] = [];
    let ended = false;
    const running = runHostedService({
      database: pool,
      app,
      directory: join(root, 'hosted-state'),
      webhookSecret: 'webhook-secret-for-reconcile-tests-123',
      controlToken: 'control-secret-for-reconcile-tests-456',
      tenancy,
      host: '127.0.0.1',
      port: 0,
      intervalSeconds: 3600,
      leaseSeconds: 30,
      worker: 'reconcile-worker',
      signal: controller.signal,
      onReady: (url) => ready(url),
      onProgress: (message, context) => progress.push([message, context]),
    }).finally(() => (ended = true));
    cleanups.push(async () => {
      controller.abort();
      await running;
    });
    const url = await listening;
    for (const deadline = Date.now() + 20_000; Date.now() < deadline;) {
      const reconciled = progress.filter(([message]) =>
        /^Re(pository reconcile|conciled)/.test(message),
      );
      if (reconciled.length >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    console.log(JSON.stringify(progress));
    expect(progress).toEqual(
      expect.arrayContaining([
        [
          expect.stringMatching(
            /^Repository reconcile failed: GitHub POST \/app\/installations\/456\/access_tokens failed with HTTP 500\..* Retrying in 3600 s\.$/,
          ),
          { installation: INSTALLATION, level: 'error' },
        ],
        [
          'Reconciled repositories with GitHub: added 1, enrolled 0 targets.',
          { installation: OTHER_INSTALLATION },
        ],
      ]),
    );
    expect(await membership(pool)).toEqual([[OTHER_INSTALLATION, 'other/application', 901]]);
    expect(await (await realFetch(`${url}/health`)).json()).toEqual({ status: 'listening' });
    expect(ended).toBe(false);
  },
  60_000,
);
