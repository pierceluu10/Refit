import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { hostedLogging } from './hosted-ops.ts';
import { runHostedService } from './hosted-service.ts';
import { DEFAULT_TENANCY_LIMITS } from './hosted-tenancy.ts';

const SECRETS = {
  GITHUB_APP_PRIVATE_KEY:
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAloggingtestkeymaterial012345\n-----END RSA PRIVATE KEY-----',
  REFIT_WEBHOOK_SECRET: 'webhook-secret-for-hosted-logging-tests-0123',
  REFIT_SERVICE_TOKEN: 'control-secret-for-hosted-logging-tests-4567',
  REFIT_DATABASE_URL:
    'postgresql://refit_hosted.project:db-password-logging-test@db.example.invalid:5432/postgres',
  OPENAI_API_KEY: 'sk-proj-loggingtestkey0123456789abcdefghij',
  REFIT_SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T0000/B0000/loggingpathsecret',
};
const TOKEN = 'ghs_loggingtestinstallationtoken0123456789';
const TARGET = { id: 'target-a', repository: 'example/application', base: 'main' };

const fake = vi.hoisted(() => ({
  claims: [] as unknown[],
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
vi.mock('./service-worker.ts', () => ({
  confirmRepositoryAccess: vi.fn(),
  pollServiceTarget: vi.fn(),
  summarizePoll: vi.fn(),
}));
const worker = await import('./service-worker.ts');
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function job(id: number) {
  return {
    job: id,
    retry: false,
    target: { ...TARGET, integration: null, installationId: 456, approval: {} },
  };
}

it('keeps every hosted log path and the failed-job notice JSON and free of secrets', async () => {
  fake.claims = [job(1), job(2)];
  const finished: unknown[] = [];
  fake.store = {
    allow: vi.fn(async () => ({ enrolled: [], cancelled: [] })),
    enqueueDue: vi.fn(async () => 0),
    claim: vi.fn(async () => fake.claims.shift() ?? null),
    // The repository keeps its GitHub ID, so nothing is retired.
    retire: vi.fn(async () => false),
    // Lease renewal fails while job 2 runs, which must abort it.
    renew: vi.fn(async () => {
      throw new Error(`connection to ${SECRETS.REFIT_DATABASE_URL} terminated`);
    }),
    finish: vi.fn(async (...args: unknown[]) => {
      finished.push(args);
      return true;
    }),
    accept: vi.fn(async () => {
      throw new Error(`insert failed for key ${SECRETS.OPENAI_API_KEY}`);
    }),
    read: vi.fn(async () => ({
      installations: [{ id: '456' }, { id: '900' }],
      targets: [
        { id: TARGET.id, installationId: '456', repository: TARGET.repository },
        { id: 'target-b', installationId: '900', repository: 'example/other' },
      ],
      jobs: [{ targetId: TARGET.id }, { targetId: 'target-b' }],
    })),
  };
  vi.mocked(worker.confirmRepositoryAccess)
    .mockRejectedValueOnce(new Error(`GitHub rejected token ${TOKEN}`))
    .mockResolvedValueOnce({
      installationId: 456,
      id: 789,
      token: 'test-token',
      defaultBranch: 'main',
      size: 1,
    });
  vi.mocked(worker.pollServiceTarget).mockImplementationOnce(async (options) => {
    options.onProgress?.(`Fetching with x-access-token:${TOKEN}@github.com`);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      options.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    throw new Error(`Stopped while holding ${SECRETS.GITHUB_APP_PRIVATE_KEY}`);
  });
  // The failed-job query returns a receipt message that carries a secret.
  const failures = [
    {
      id: '1',
      targetId: TARGET.id,
      repository: TARGET.repository,
      finishedAt: '2026-10-22 03:00:00.000001+00',
      outcome: 'error',
      message: `Error: GitHub rejected token ${TOKEN} and ${SECRETS.REFIT_SERVICE_TOKEN}`,
    },
  ];
  const database = {
    query: vi.fn(async (sql: string) =>
      sql.startsWith('SELECT now()')
        ? { rows: [{ now: '2026-10-22 02:59:00+00' }] }
        : { rows: failures.splice(0) },
    ),
  } as unknown as Pool;
  const slack: string[] = [];
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input) !== SECRETS.REFIT_SLACK_WEBHOOK_URL) return realFetch(input, init);
    slack.push(JSON.parse(String(init?.body)).text);
    return new Response('ok');
  });

  const lines: string[] = [];
  const { log, notify, redact } = hostedLogging(SECRETS, (line) => lines.push(line));
  const directory = await mkdtemp(join(tmpdir(), 'refit-hosted-logging-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  let ready: (url: string) => void;
  const listening = new Promise<string>((resolve) => (ready = resolve));
  const service = runHostedService({
    database,
    app: { appId: '123', privateKeyFile: 'unused-test-key' },
    directory,
    webhookSecret: SECRETS.REFIT_WEBHOOK_SECRET,
    controlToken: SECRETS.REFIT_SERVICE_TOKEN,
    tenancy: { accounts: ['example'], limits: DEFAULT_TENANCY_LIMITS },
    notify,
    redact,
    host: '127.0.0.1',
    port: 0,
    intervalSeconds: 30,
    leaseSeconds: 3,
    worker: 'test-worker',
    signal: controller.signal,
    onReady: (url) => {
      log(`Listening at ${url}`);
      ready(url);
    },
    onProgress: log,
  });
  cleanups.push(async () => {
    controller.abort();
    await service;
  });
  const url = await listening;
  // Both jobs finish (job 2 once its failed lease renewal aborts it) and job 1's notice is sent.
  for (
    const deadline = Date.now() + 10_000;
    (!slack.length || finished.length < 2) && Date.now() < deadline;
  )
    await new Promise((resolve) => setTimeout(resolve, 50));

  const body = JSON.stringify({
    action: 'created',
    installation: { id: 456, app_id: 123, account: { login: 'example' } },
    repositories: [{ id: 789, full_name: 'example/application' }],
  });
  const delivery = randomUUID();
  const webhook = await fetch(`${url}/github/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'installation',
      'X-GitHub-Delivery': delivery,
      'X-Hub-Signature-256': `sha256=${createHmac('sha256', SECRETS.REFIT_WEBHOOK_SECRET).update(body).digest('hex')}`,
    },
    body,
  });
  expect(webhook.status).toBe(500);
  const status = (query: string, token = SECRETS.REFIT_SERVICE_TOKEN) =>
    fetch(`${url}/status${query}`, { headers: { Authorization: `Bearer ${token}` } });
  expect(await (await status(`?target=${TARGET.id}`)).json()).toEqual({
    installations: [{ id: '456' }],
    targets: [{ id: TARGET.id, installationId: '456', repository: TARGET.repository }],
    jobs: [{ targetId: TARGET.id }],
    inventories: [],
  });
  expect((await status('')).status).toBe(200);
  expect((await status('?target=missing')).status).toBe(404);
  expect((await status('?since=today')).status).toBe(400);
  expect((await status(`?target=${TARGET.id}`, 'wrong-token')).status).toBe(401);
  controller.abort();
  await service;

  const output = [...lines, ...slack].join('\n');
  console.log(output);
  for (const secret of [...Object.values(SECRETS), TOKEN, 'db-password-logging-test'])
    expect(output).not.toContain(secret);
  const entries = lines.map((line) => JSON.parse(line));
  const ids = { job: 1, target: TARGET.id, installation: 456 };
  expect(entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ level: 'info', message: expect.stringMatching(/^Listening at/) }),
      {
        time: expect.any(String),
        level: 'error',
        message: 'Error: GitHub rejected token [redacted]',
        ...ids,
      },
      expect.objectContaining({
        ...ids,
        job: 2,
        level: 'info',
        message: 'Fetching with x-access-token:[redacted]@github.com',
      }),
      expect.objectContaining({
        ...ids,
        job: 2,
        level: 'error',
        message: 'Lease renewal failed: connection to [redacted] terminated; stopping.',
      }),
      expect.objectContaining({
        ...ids,
        job: 2,
        level: 'info',
        // The runner turns the aborted job's error into an interrupted receipt.
        message: 'interrupted: Error: Stopped while holding [redacted]',
      }),
      expect.objectContaining({
        level: 'error',
        delivery,
        installation: 456,
        message: 'Webhook processing failed: insert failed for key [redacted]',
      }),
    ]),
  );
  expect(finished).toEqual([
    [1, 'test-worker', 'failed', expect.objectContaining({ status: 'error' })],
    [2, 'test-worker', 'failed', expect.objectContaining({ status: 'interrupted' })],
  ]);
  expect(slack).toEqual([
    '🚨 [URGENT] example/application: hosted job 1 failed (error: Error: GitHub rejected token [redacted] and [redacted]); see refit hosted receipt 1.',
  ]);
}, 30_000);
