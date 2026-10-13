import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runLocalService } from './local-service.ts';
import { watchOnce } from './watch.ts';
import type { ServiceTarget } from './service-configuration.ts';

const remote = vi.hoisted(() => ({ blocked: new Set<string>() }));
vi.mock('./github-app.ts', () => ({
  authenticateGitHubRead: vi.fn(async (_app: unknown, repository: string) => {
    if (remote.blocked.has(repository)) throw new Error('Installation access is blocked');
    return { token: 'private-read-test-token', appId: 123, installationId: 456 };
  }),
}));
vi.mock('./github.ts', async (original) => ({
  ...(await original<typeof import('./github.ts')>()),
  requestGitHub: vi.fn(async (_token: string, method: string, path: string) => {
    expect(method).toBe('GET');
    return { id: 789, full_name: path.slice('/repos/'.length), archived: false, disabled: false };
  }),
}));
vi.mock('./watch.ts', () => ({ watchOnce: vi.fn() }));

const WEBHOOK_SECRET = 'webhook-secret-for-http-tests-only-123';
const CONTROL_TOKEN = 'control-token-for-http-tests-only-456';
const APP = { appId: '123', privateKeyFile: 'unused-test-key' };
const STATUS_TIMEOUT_MS = 5000;
const roots: string[] = [];
const services: { controller: AbortController; completion: ReturnType<typeof runLocalService> }[] =
  [];
function target(id = 'demo', repository = 'example/application'): ServiceTarget {
  return {
    id,
    repository,
    base: 'main',
    workflow: {
      repository: undefined,
      before: resolve('pipeline/fixtures/before.json'),
      after: resolve('pipeline/fixtures/after.json'),
      latestStripe: undefined,
      image: 'checks:local',
      command: ['npm', 'test'],
      baselineCommand: undefined,
      providerConfig: undefined,
      fullDiff: false,
    },
    source: { kind: 'file', path: resolve('pipeline/fixtures/after.json') },
  };
}
beforeEach(() => {
  vi.mocked(watchOnce).mockResolvedValue({
    status: 'already-processed',
    provider: 'stripe',
    jobKey: 'test-job',
    sourceHash: 'test-source',
    previousStatus: 'existing-pr',
    output: '/tmp/retained-test-evidence',
  });
});
afterEach(async () => {
  for (const service of services.splice(0)) {
    service.controller.abort();
    await service.completion;
  }
  remote.blocked.clear();
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function start(targets = [target()]) {
  const root = await mkdtemp(join(tmpdir(), 'refit-http-service-'));
  roots.push(root);
  const controller = new AbortController();
  let ready!: (url: string) => void;
  const address = new Promise<string>((resolve) => {
    ready = resolve;
  });
  const completion = runLocalService({
    targets,
    app: APP,
    directory: root,
    port: 0,
    intervalSeconds: 30,
    webhookSecret: WEBHOOK_SECRET,
    controlToken: CONTROL_TOKEN,
    signal: controller.signal,
    onReady: ready,
  });
  services.push({ controller, completion });
  const url = await Promise.race([
    address,
    completion.then(() => {
      throw new Error('Service stopped before listening');
    }),
  ]);
  return { root, controller, completion, url };
}
async function status(url: string) {
  const response = await fetch(`${url}/status`, {
    headers: { Authorization: `Bearer ${CONTROL_TOKEN}` },
  });
  expect(response.status).toBe(200);
  return response.json();
}
async function deliver(
  url: string,
  payload: unknown,
  event = 'installation',
  delivery = randomUUID(),
  secret = WEBHOOK_SECRET,
) {
  const body = JSON.stringify(payload);
  return fetch(`${url}/github/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': event,
      'X-GitHub-Delivery': delivery,
      'X-Hub-Signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
    },
    body,
  });
}
const installation = { id: 456, app_id: 123, account: { login: 'example' } };

it('runs configured installed targets, protects status and acknowledges concurrent duplicate webhook deliveries', async () => {
  const service = await start();
  expect((await fetch(`${service.url}/health`)).status).toBe(200);
  expect((await fetch(`${service.url}/status`)).status).toBe(401);
  await expect
    .poll(async () => (await status(service.url)).targets.demo.status, {
      timeout: STATUS_TIMEOUT_MS,
    })
    .toBe('existing-pr');
  const payload = {
    action: 'created',
    installation,
    repositories: [{ id: 789, full_name: 'example/application' }],
  };
  const id = randomUUID();
  const responses = await Promise.all([
    deliver(service.url, payload, 'installation', id),
    deliver(service.url, payload, 'installation', id),
  ]);
  expect(responses.every((response) => response.status === 202)).toBe(true);
  expect(
    (await Promise.all(responses.map((response) => response.json())))
      .map((response) => response.status)
      .sort(),
  ).toEqual(['accepted', 'duplicate']);
  await expect
    .poll(() => vi.mocked(watchOnce).mock.calls.length, { timeout: STATUS_TIMEOUT_MS })
    .toBe(2);
  expect((await status(service.url)).accessVersion).toBe(1);
  expect(vi.mocked(watchOnce).mock.calls[0][0].configuration.publication).toBeUndefined();
  expect(await readFile(join(service.root, 'registry.json'), 'utf8')).not.toContain(
    'private-read-test-token',
  );
});

it('rejects unauthenticated, conflicting, foreign-App and oversized requests without worker side effects', async () => {
  const service = await start();
  await expect.poll(() => vi.mocked(watchOnce).mock.calls.length).toBe(1);
  const ping = { zen: 'test' };
  expect((await deliver(service.url, ping, 'ping', randomUUID(), 'wrong-secret')).status).toBe(401);
  const id = randomUUID();
  expect((await deliver(service.url, ping, 'ping', id)).status).toBe(202);
  expect((await deliver(service.url, { zen: 'changed' }, 'ping', id)).status).toBe(409);
  expect(
    (
      await deliver(service.url, {
        action: 'created',
        installation: { ...installation, app_id: 999 },
        repositories: [],
      })
    ).status,
  ).toBe(422);
  const large = 'x'.repeat(1024 * 1024 + 1);
  expect(
    (
      await fetch(`${service.url}/github/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: large,
      })
    ).status,
  ).toBe(413);
  expect(vi.mocked(watchOnce).mock.calls).toHaveLength(1);
});

it('cancels an in-flight worker when installed access is removed and checks the API before restarting', async () => {
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  let signal: AbortSignal | undefined;
  vi.mocked(watchOnce).mockImplementationOnce(async (input) => {
    signal = input.configuration.signal;
    began();
    await new Promise<void>((resolve) =>
      signal!.addEventListener('abort', () => resolve(), { once: true }),
    );
    return {
      status: 'already-processed',
      provider: 'stripe',
      jobKey: 'test',
      sourceHash: 'test',
      previousStatus: 'validated',
      output: '/tmp/test-evidence',
    };
  });
  const service = await start();
  await started;
  remote.blocked.add('example/application');
  expect(
    (await deliver(service.url, { action: 'deleted', installation, repositories: [] })).status,
  ).toBe(202);
  expect(signal?.aborted).toBe(true);
  await expect
    .poll(async () => (await status(service.url)).targets.demo.access, {
      timeout: STATUS_TIMEOUT_MS,
    })
    .toBe('blocked');
  expect(vi.mocked(watchOnce).mock.calls).toHaveLength(1);
});

it('continues other configured targets when one installation is inaccessible and releases its process lock on shutdown', async () => {
  remote.blocked.add('example/blocked');
  const service = await start([
    target('blocked', 'example/blocked'),
    target('active', 'example/active'),
  ]);
  await expect
    .poll(async () => (await status(service.url)).targets.active.status, {
      timeout: STATUS_TIMEOUT_MS,
    })
    .toBe('existing-pr');
  expect((await status(service.url)).targets.blocked.access).toBe('blocked');
  service.controller.abort();
  await service.completion;
  await expect(readFile(join(service.root, 'service.lock'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(fetch(`${service.url}/health`)).rejects.toThrow();
});

it('keeps confirmed installation access separate from a failed migration job', async () => {
  vi.mocked(watchOnce).mockRejectedValueOnce(new Error('Check image is missing'));
  const service = await start();
  await expect.poll(async () => (await status(service.url)).targets.demo.status).toBe('error');
  expect((await status(service.url)).targets.demo).toMatchObject({
    access: 'active',
    message: 'Error: Check image is missing',
  });
});
