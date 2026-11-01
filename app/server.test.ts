import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebhookServer } from './server.ts';
import type { WebhookServerDeps } from './server.ts';
import type { AppJob, HumanVerdict } from './types.ts';

const SECRET = 'test-webhook-secret';
const DELIVERY = '00000000-0000-4000-8000-000000000001';
const SMALL_CAP = 64;
const INSTALLED_REPOS = [
  'aptitude-example-org/billing-api',
  'aptitude-example-org/storefront',
  'aptitude-example-org/ops-scripts',
];

const raw = (name: string) => readFileSync(new URL(`fixtures/${name}.json`, import.meta.url));
const sign = (body: Buffer | string, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

let server: Server | undefined;

async function start(overrides: Partial<WebhookServerDeps> = {}) {
  const jobs: AppJob[] = [];
  const verdicts: [string, HumanVerdict][] = [];
  server = createWebhookServer({
    webhookSecret: SECRET,
    queue: { enqueue: async (job) => void jobs.push(job) },
    recordVerdict: async (pr, verdict) => void verdicts.push([pr, verdict]),
    tokens: { token: async () => 'ghs_test_installation_token' },
    listRepos: async () => INSTALLED_REPOS,
    ...overrides,
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { jobs, verdicts, base: `http://127.0.0.1:${port}` };
}

function post(base: string, event: string, body: Buffer<ArrayBuffer> | string, signature?: string) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-GitHub-Event': event,
    'X-GitHub-Delivery': DELIVERY,
  };
  if (signature) headers['X-Hub-Signature-256'] = signature;
  return fetch(`${base}/webhooks`, { method: 'POST', headers, body });
}

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server ? server.close((error) => (error ? reject(error) : resolve())) : resolve(),
  );
  server = undefined;
});

describe('webhook server', () => {
  it.each([
    ['installation', 'installation.created', 3],
    ['installation', 'installation.deleted', 3],
    ['installation_repositories', 'installation_repositories.added', 2],
    ['installation_repositories', 'installation_repositories.removed', 1],
    ['push', 'push.default-branch', 1],
    ['push', 'push.other-branch', 0],
  ])('accepts a signed %s (%s) and queues %i jobs', async (event, name, count) => {
    const { base, jobs } = await start();
    const body = raw(name);
    const response = await post(base, event, body, sign(body));
    expect(response.status).toBe(202);
    expect(jobs).toHaveLength(count);
  });

  it('records the verdict for a signed Aptitude PR close', async () => {
    const { base, verdicts } = await start();
    const body = raw('pull_request.closed.merged');
    expect((await post(base, 'pull_request', body, sign(body))).status).toBe(202);
    expect(verdicts).toEqual([
      ['https://github.com/aptitude-example-org/billing-api/pull/41', 'merged'],
    ]);
  });

  it('rejects unsigned and wrongly signed deliveries without handling them', async () => {
    const { base, jobs } = await start();
    const body = raw('push.default-branch');
    expect((await post(base, 'push', body)).status).toBe(401);
    expect((await post(base, 'push', body, sign(body, 'other-secret'))).status).toBe(401);
    expect(jobs).toEqual([]);
  });

  it('returns 400 for correctly signed invalid JSON', async () => {
    const { base } = await start();
    const body = '{"action": ';
    expect((await post(base, 'push', body, sign(body))).status).toBe(400);
  });

  it('returns 500 and logs event, delivery and message when the handler throws', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { base } = await start({
      queue: {
        enqueue: async () => {
          throw new Error('queue unavailable');
        },
      },
    });
    const body = raw('push.default-branch');
    expect((await post(base, 'push', body, sign(body))).status).toBe(500);
    expect(errors).toHaveBeenCalledWith(`webhook push ${DELIVERY} failed: queue unavailable`);
  });

  it('returns 413 when the body is over the cap', async () => {
    const { base, jobs } = await start({ maxBodyBytes: SMALL_CAP });
    const body = raw('push.default-branch');
    expect(body.length).toBeGreaterThan(SMALL_CAP);
    expect((await post(base, 'push', body, sign(body))).status).toBe(413);
    expect(jobs).toEqual([]);
  });

  it('serves /healthz and 404s everything else', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/webhooks`)).status).toBe(404);
  });
});
