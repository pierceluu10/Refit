import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeliveryLog } from './deliveries.ts';
import { createWebhookServer } from './server.ts';
import type { WebhookServerDeps } from './server.ts';
import type { RunView } from '../shared/types.ts';
import { GitHubApiError } from './github.ts';
import type { AppJob, HumanVerdict } from './types.ts';

const SECRET = 'test-webhook-secret';
const DELIVERY = '00000000-0000-4000-8000-000000000001';
const SMALL_CAP = 64;
const INSTALLED_REPOS = [
  'refit-example-org/billing-api',
  'refit-example-org/storefront',
  'refit-example-org/ops-scripts',
];

const raw = (name: string) => readFileSync(new URL(`fixtures/${name}.json`, import.meta.url));
const sign = (body: Buffer | string, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

let server: Server | undefined;
let stateDir: string;
// Removed at the end, since a handler still saving after its 202 outlives its test.
const stateRoot = mkdtempSync(join(tmpdir(), 'refit-server-test-'));

beforeEach(() => {
  stateDir = mkdtempSync(join(stateRoot, 'test-'));
});

afterAll(() => rmSync(stateRoot, { recursive: true, force: true }));

const closeServer = () =>
  new Promise<void>((resolve, reject) =>
    server ? server.close((error) => (error ? reject(error) : resolve())) : resolve(),
  );

async function start(overrides: Partial<WebhookServerDeps> = {}) {
  const jobs: AppJob[] = [];
  const verdicts: [string, HumanVerdict][] = [];
  server = createWebhookServer({
    webhookSecret: SECRET,
    deliveries: await createDeliveryLog(join(stateDir, 'deliveries.json')),
    queue: { enqueue: async (job) => void jobs.push(job) },
    recordVerdict: async (pr, verdict) => void verdicts.push([pr, verdict]),
    tokens: { token: async () => 'ghs_test_installation_token' },
    listRepos: async () => INSTALLED_REPOS,
    compareCommits: async () => [],
    pullDiff: async () => '',
    listRunViews: async () => [],
    viewerRepos: async () => [],
    isServiceToken: () => false,
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
  await closeServer();
  server = undefined;
});

describe('duplicate deliveries', () => {
  const body = raw('push.default-branch');
  const send = (base: string) => post(base, 'push', body, sign(body));

  it('does the work of a repeated delivery once', async () => {
    const { base, jobs } = await start();
    expect((await send(base)).status).toBe(202);
    await vi.waitFor(() => expect(jobs).toHaveLength(1));
    expect((await send(base)).status).toBe(202);
    // Let the second delivery's handler run, if it was going to.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(jobs).toHaveLength(1);
  });

  it('does the work once when both copies arrive together', async () => {
    let enqueued = 0;
    const { base } = await start({
      queue: { enqueue: async () => void enqueued++ },
    });
    await Promise.all([send(base), send(base), send(base)]);
    await vi.waitFor(() => expect(enqueued).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(enqueued).toBe(1);
  });

  it('remembers a delivery across a restart', async () => {
    const first = await start();
    await send(first.base);
    await vi.waitFor(() => expect(first.jobs).toHaveLength(1));
    await vi.waitFor(() =>
      expect(readFileSync(join(stateDir, 'deliveries.json'), 'utf8')).toContain(DELIVERY),
    );
    await closeServer();

    const second = await start();
    expect((await send(second.base)).status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(second.jobs).toEqual([]);
  });

  it('runs a redelivery of a delivery that failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let attempts = 0;
    const jobs: AppJob[] = [];
    const { base } = await start({
      queue: {
        enqueue: async (job) => {
          if (++attempts === 1) throw new Error('queue unavailable');
          jobs.push(job);
        },
      },
    });
    await send(base);
    await vi.waitFor(() => expect(attempts).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await send(base);
    await vi.waitFor(() => expect(jobs).toHaveLength(1));
  });

  it('does not let an unsigned request use up a delivery id', async () => {
    const { base, jobs } = await start();
    expect((await post(base, 'push', body)).status).toBe(401);
    await send(base);
    await vi.waitFor(() => expect(jobs).toHaveLength(1));
  });

  it('forgets ids older than GitHub can redeliver', async () => {
    const file = join(stateDir, 'old.json');
    let now = 0;
    const log = await createDeliveryLog(file, () => now);
    log.claim('old');
    await log.finish('old');
    now = 8 * 24 * 60 * 60 * 1000;
    log.claim('new');
    await log.finish('new');
    const reopened = await createDeliveryLog(file, () => now);
    expect(reopened.claim('old')).toBe(true);
    expect(reopened.claim('new')).toBe(false);
  });
});

describe('webhook server', () => {
  it.each([
    ['installation', 'installation.created', 3],
    ['installation', 'installation.deleted', 1],
    ['installation_repositories', 'installation_repositories.added', 2],
    ['installation_repositories', 'installation_repositories.removed', 1],
    ['push', 'push.default-branch', 1],
    ['push', 'push.other-branch', 0],
  ])('accepts a signed %s (%s) and queues %i jobs', async (event, name, count) => {
    const { base, jobs } = await start();
    const body = raw(name);
    const response = await post(base, event, body, sign(body));
    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(jobs).toHaveLength(count));
  });

  it('records the verdict for a signed Refit PR close', async () => {
    const { base, verdicts } = await start();
    const body = raw('pull_request.closed.merged');
    expect((await post(base, 'pull_request', body, sign(body))).status).toBe(202);
    await vi.waitFor(() => expect(verdicts).toHaveLength(1));
    expect(verdicts).toEqual([
      ['https://github.com/refit-example-org/billing-api/pull/41', 'merged'],
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

  it('answers 202 before slow work finishes', async () => {
    let finish = () => {};
    const verdicts: string[] = [];
    const { base } = await start({
      recordVerdict: (pr) =>
        new Promise<void>((resolve) => {
          finish = () => {
            verdicts.push(pr);
            resolve();
          };
        }),
    });
    const body = raw('pull_request.closed.merged');
    expect((await post(base, 'pull_request', body, sign(body))).status).toBe(202);
    expect(verdicts).toEqual([]);
    finish();
    expect(verdicts).toHaveLength(1);
  });

  it('logs event, delivery and message when the handler throws after answering', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { base } = await start({
      queue: {
        enqueue: async () => {
          throw new Error('queue unavailable');
        },
      },
    });
    const body = raw('push.default-branch');
    expect((await post(base, 'push', body, sign(body))).status).toBe(202);
    await vi.waitFor(() =>
      expect(errors).toHaveBeenCalledWith(`webhook push ${DELIVERY} failed: queue unavailable`),
    );
  });

  it('returns 413 when the body is over the cap', async () => {
    const { base, jobs } = await start({ maxBodyBytes: SMALL_CAP });
    const body = raw('push.default-branch');
    expect(body.length).toBeGreaterThan(SMALL_CAP);
    expect((await post(base, 'push', body, sign(body))).status).toBe(413);
    expect(jobs).toEqual([]);
  });

  it('mounts routes in order, and 404s what none handles', async () => {
    const { base } = await start({
      routes: [
        async (request, response) => {
          if (request.url !== '/api/report') return false;
          response.writeHead(200).end('mounted');
          return true;
        },
      ],
    });
    expect(await (await fetch(`${base}/api/report`)).text()).toBe('mounted');
    expect((await fetch(`${base}/api/other`)).status).toBe(404);
  });

  it('answers 500 and logs when a mounted route throws', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { base } = await start({
      routes: [
        async () => {
          throw new Error('route broke');
        },
      ],
    });
    expect((await fetch(`${base}/api/report`)).status).toBe(500);
    expect(errors).toHaveBeenCalledWith('GET /api/report request failed: route broke');
  });

  it('answers 400 to a request target that is not a valid URL, and keeps serving', async () => {
    const { base } = await start();
    const { hostname, port } = new URL(base);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      httpRequest({ hostname, port, path: '//' }, (response) => {
        response.resume();
        resolve(response.statusCode);
      })
        .on('error', reject)
        .end();
    });
    expect(status).toBe(400);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it('serves /healthz and 404s everything else', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/webhooks`)).status).toBe(404);
  });
});

const run = (repo: string, id: string): RunView => ({
  id,
  repo,
  taskId: `task-${id}`,
  provider: 'stripe',
  changeId: 'illustrative-change',
  outcome: 'verified',
  costUsd: 1,
  summary: 'Illustrative run.',
  finishedAt: '2026-11-01T12:00:00Z',
});

describe('GET /api/runs', () => {
  const MINE = 'refit-example-org/billing-api';
  const THEIRS = 'other-org/secret-service';
  const STORED = [run(THEIRS, '4'), run(MINE, '3'), run(THEIRS, '2'), run(MINE, '1')];
  const USER_TOKEN = 'ghu_test_user_token';

  async function startRuns() {
    const filters: unknown[] = [];
    const viewers: string[] = [];
    const { base } = await start({
      listRunViews: async (filter) => {
        filters.push(filter);
        const runs = STORED.filter((item) => !filter.repo || item.repo === filter.repo);
        return runs.slice(0, filter.limit ?? runs.length);
      },
      viewerRepos: async (token) => {
        viewers.push(token);
        if (token !== USER_TOKEN) throw new GitHubApiError('GET', '/user/installations', 401);
        return [MINE];
      },
    });
    const get = (query = '', token: string | null = USER_TOKEN) =>
      fetch(`${base}/api/runs${query}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    return { get, filters, viewers };
  }

  it("returns only the viewer's repos, filtered before the limit", async () => {
    const { get, viewers } = await startRuns();
    const response = await get('?limit=2');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(((await response.json()) as RunView[]).map((item) => item.id)).toEqual(['3', '1']);
    expect(viewers).toEqual([USER_TOKEN]);
  });

  it('passes an accessible repo and limit through to memory', async () => {
    const { get, filters } = await startRuns();
    const response = await get(`?repo=${MINE}&limit=1`);
    expect(((await response.json()) as RunView[]).map((item) => item.id)).toEqual(['3']);
    expect(filters).toEqual([{ repo: MINE, limit: 1 }]);
  });

  it("returns [] for another installation's repo without reading memory", async () => {
    const { get, filters } = await startRuns();
    expect(await (await get(`?repo=${THEIRS}`)).json()).toEqual([]);
    expect(filters).toEqual([]);
  });

  describe('with the service token', () => {
    const SERVICE = 'test-service-token';
    const serviceStart = () =>
      start({
        listRunViews: async ({ repo, limit }) =>
          STORED.filter((item) => !repo || item.repo === repo).slice(0, limit),
        viewerRepos: async () => {
          throw new Error('the service token must not be sent to GitHub');
        },
        isServiceToken: (authorization) => authorization === `Bearer ${SERVICE}`,
      });
    const read = (base: string, query = '') =>
      fetch(`${base}/api/runs${query}`, { headers: { Authorization: `Bearer ${SERVICE}` } });

    it('reads every repo, never asking GitHub', async () => {
      const { base } = await serviceStart();
      const response = await read(base);
      expect(response.status).toBe(200);
      expect(((await response.json()) as RunView[]).map((item) => item.id)).toEqual([
        '4',
        '3',
        '2',
        '1',
      ]);
    });

    it('still honours repo and limit, and still rejects a bad limit', async () => {
      const { base } = await serviceStart();
      const runs = (await (await read(base, `?repo=${THEIRS}&limit=1`)).json()) as RunView[];
      expect(runs.map((item) => item.id)).toEqual(['4']);
      expect((await read(base, '?limit=0')).status).toBe(400);
    });

    it('does not widen a GitHub user token', async () => {
      const { get } = await startRuns();
      const runs = (await (await get()).json()) as RunView[];
      expect(new Set(runs.map((item) => item.repo))).toEqual(new Set([MINE]));
    });
  });

  it('returns 401 without a token or with one GitHub rejects', async () => {
    const { get, viewers } = await startRuns();
    expect((await get('', null)).status).toBe(401);
    expect(viewers).toEqual([]);
    expect((await get('', 'ghu_revoked')).status).toBe(401);
  });

  it.each(['?limit=0', '?limit=101', '?limit=2.5', '?limit=abc', '?repo=no-slash', '?repo=a/..'])(
    'returns 400 for %s',
    async (query) => {
      const { get } = await startRuns();
      const response = await get(query);
      expect(response.status).toBe(400);
      expect(await response.json()).toHaveProperty('error');
    },
  );
});
