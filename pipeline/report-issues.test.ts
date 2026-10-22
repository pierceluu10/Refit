import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { loadDeadlineRegistry } from './deadline-registry.ts';
import { authenticateGitHubIssues } from './github-app.ts';
import { runHostedService } from './hosted-service.ts';
import { openHostedStore } from './hosted-store.ts';
import { DEFAULT_TENANCY_LIMITS } from './hosted-tenancy.ts';
import { openInventoryStore } from './inventory-store.ts';
import { registryDigest, type Inventory } from './inventory.ts';
import { hostedReports, syncReportIssues } from './report-issues.ts';
import { openReportStore } from './report-store.ts';
import { REPORT_MARKER } from './report.ts';

const github = vi.hoisted(() => ({
  writes: [] as { method: string; path: string; body: unknown }[],
  // What GET /repos/{repository}/issues answers.
  issues: [] as unknown[],
  // Fails the next PATCH, as a GitHub outage would.
  failNext: false,
  nextIssue: 1,
}));
vi.mock('./github-app.ts', async (original) => ({
  ...(await original<typeof import('./github-app.ts')>()),
  authenticateGitHubIssues: vi.fn(async () => ({
    token: 'private-issues-test-token',
    login: 'refit-test[bot]',
  })),
}));
vi.mock('./github.ts', async (original) => ({
  ...(await original<typeof import('./github.ts')>()),
  requestGitHub: vi.fn(async (_token: string, method: string, path: string, body?: unknown) => {
    github.writes.push({ method, path, body });
    if (method === 'GET') return github.issues;
    if (method === 'PATCH' && github.failNext) {
      github.failNext = false;
      throw new Error('GitHub answered HTTP 502.');
    }
    return path.endsWith('/issues') ? { number: github.nextIssue++ } : {};
  }),
}));

const DATABASE = process.env.REFIT_POSTGRES_URL;
const APP = { appId: '123', privateKeyFile: 'unused-test-key' };
const NOW = new Date('2026-10-22T12:00:00Z');
// The registry the recorded reports were built with, so registry edits do not change these tests.
const REGISTRY = new URL('./fixtures/report/registry.json', import.meta.url);
const DAY = 24 * 60 * 60 * 1000;
const WEBHOOK_SECRET = 'webhook-secret-for-report-service-tests-1';
const CONTROL_TOKEN = 'control-secret-for-report-service-tests-2';
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  github.writes = [];
  github.issues = [];
  github.failNext = false;
  github.nextIssue = 1;
  vi.mocked(authenticateGitHubIssues).mockClear();
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

// The anthropic-app fixture: yayasoumah/pocket-server at its frozen commit.
async function anthropicApp() {
  const { inventory } = JSON.parse(
    await readFile(new URL('./fixtures/report/anthropic-app.json', import.meta.url), 'utf8'),
  ) as { inventory: Inventory };
  return inventory;
}

const installation = (action: string, repositories: string[]) => ({
  kind: 'installation' as const,
  installationId: 456,
  owner: 'example',
  action,
  added: repositories.map((name, index) => ({ id: 789 + index, name })),
  removed: [],
});

// Installs example/app for an allowed account and stores `inventory` as its complete inventory.
async function installed(pool: pg.Pool, inventory: Inventory) {
  const hosted = await openHostedStore(pool, {
    accounts: ['example'],
    limits: DEFAULT_TENANCY_LIMITS,
  });
  const inventories = await openInventoryStore(pool);
  const reports = openReportStore(pool);
  const registry = await loadDeadlineRegistry(REGISTRY, NOW);
  await hosted.accept(
    randomUUID(),
    'installation',
    new TextEncoder().encode(randomUUID()),
    installation('created', ['example/app']),
  );
  // Report issues go only to approved repositories; this stores one as `refit hosted approve`
  // would, without enrolling a target.
  const approve = () =>
    pool.query(
      `INSERT INTO refit_approvals (repository, base, fingerprint, approval, approved_by)
       VALUES ('example/app', 'main', 'fingerprint', '{}', 'octo-reviewer')`,
    );
  const store = async (changed: Inventory, revision = 'a'.repeat(40)) => {
    await inventories.requestRepository('example/app');
    const claimed = (await inventories.claim('scanner', 60))!;
    expect(
      await inventories.finish(claimed, 'scanner', {
        result: { outcome: 'complete', base: 'main', revision, inventory: changed },
        registry: registryDigest(registry),
        durationMs: 1,
      }),
    ).toBe(true);
  };
  await store(inventory);
  const pass = (now: Date) =>
    syncReportIssues({
      app: APP,
      reports,
      registry,
      now,
      signal: new AbortController().signal,
      onProgress: (message) => console.log(message),
    });
  return { hosted, reports, store, pass, approve };
}

const writes = () => github.writes.map((write) => `${write.method} ${write.path}`);

it('reads REFIT_HOSTED_REPORTS as off unless it is 1', () => {
  expect(hostedReports({})).toBe(false);
  expect(hostedReports({ REFIT_HOSTED_REPORTS: '0' })).toBe(false);
  expect(hostedReports({ REFIT_HOSTED_REPORTS: '1' })).toBe(true);
  expect(() => hostedReports({ REFIT_HOSTED_REPORTS: 'true' })).toThrow(
    'REFIT_HOSTED_REPORTS must be 1, 0 or unset.',
  );
});

it.skipIf(!DATABASE)(
  'opens the report issue once, updates it only when the report changes and writes each change once',
  async () => {
    const pool = await database();
    const inventory = await anthropicApp();
    const { reports, store, pass, approve } = await installed(pool, inventory);

    // Nothing is written for an inventoried repository without an approval.
    expect(await pass(NOW)).toBe(0);
    expect(writes()).toEqual([]);
    await approve();
    expect(await pass(NOW)).toBe(1);
    expect(writes()).toEqual([
      'GET /repos/example/app/issues?state=all&creator=refit-test%5Bbot%5D&per_page=100',
      'POST /repos/example/app/issues',
    ]);
    const opened = github.writes[1].body as { title: string; body: string };
    expect(opened.title).toBe('Refit report: what this repository depends on');
    expect(opened.body.startsWith(`${REPORT_MARKER}\n# What \`example/app\` depends on`)).toBe(
      true,
    );
    expect(opened.body).toContain('- **2026-11-30** (39 days left)');

    // The same content, the same day or three days later in the same stage: no request at all.
    github.writes = [];
    expect(await pass(NOW)).toBe(0);
    expect(await pass(new Date(NOW.getTime() + 3 * DAY))).toBe(0);
    expect(writes()).toEqual([]);
    expect(authenticateGitHubIssues).toHaveBeenCalledTimes(1);

    // A push that only moves code (a new commit, other line numbers) writes nothing.
    await store(
      { ...inventory, models: inventory.models.map((call) => ({ ...call, line: call.line + 1 })) },
      'b'.repeat(40),
    );
    expect(await pass(NOW)).toBe(0);
    expect(writes()).toEqual([]);

    // A new model call changes the report: one update with a comment, on the same issue.
    await store({
      ...inventory,
      models: [...inventory.models, { ...inventory.models[0], file: 'src/agent/core/added.ts' }],
    });
    expect(await pass(NOW)).toBe(1);
    expect(writes()).toEqual([
      'PATCH /repos/example/app/issues/1',
      'POST /repos/example/app/issues/1/comments',
    ]);
    expect((github.writes[0].body as { body: string }).body).toContain('`src/agent/core/added.ts:');
    expect(github.writes[1].body).toEqual({
      body: 'Refit updated this report for commit `aaaaaaaaaaaa`.',
    });

    // claude-sonnet-4-5 crosses 30 days on 2026-10-31. Two workers both read the old report
    // before either takes the write; one writes.
    github.writes = [];
    const crossed = new Date('2026-11-01T12:00:00Z');
    let arrived = 0;
    let release!: () => void;
    const together = new Promise<void>((resolve) => (release = resolve));
    const barrier = async () => {
      if (++arrived === 2) release();
      await together;
      return { token: 'private-issues-test-token', login: 'refit-test[bot]' };
    };
    vi.mocked(authenticateGitHubIssues)
      .mockImplementationOnce(barrier)
      .mockImplementationOnce(barrier);
    expect((await Promise.all([pass(crossed), pass(crossed)])).sort()).toEqual([0, 1]);
    expect(writes()).toEqual([
      'PATCH /repos/example/app/issues/1',
      'POST /repos/example/app/issues/1/comments',
    ]);
    expect((github.writes[0].body as { body: string }).body).toContain('(29 days left)');
    expect(await reports.read()).toEqual([
      {
        installationId: 456,
        repository: 'example/app',
        issue: 1,
        status: 'updated',
        message: null,
        updatedAt: crossed.toISOString(),
      },
    ]);
  },
  30_000,
);

it.skipIf(!DATABASE)(
  'finds the issue it opened before by its marker and retries a failed write after a day',
  async () => {
    const pool = await database();
    github.issues = [
      { number: 7, body: 'A customer issue.' },
      { number: 9, body: `${REPORT_MARKER}\nA pull request.`, pull_request: {} },
      { number: 12, body: `${REPORT_MARKER}\n# An earlier report` },
    ];
    github.failNext = true;
    const { reports, pass, approve } = await installed(pool, await anthropicApp());
    await approve();

    expect(await pass(NOW)).toBe(0);
    expect(writes()).toEqual([
      'GET /repos/example/app/issues?state=all&creator=refit-test%5Bbot%5D&per_page=100',
      'PATCH /repos/example/app/issues/12',
    ]);
    expect(await reports.read()).toMatchObject([
      { issue: null, status: 'failed', message: 'Error: GitHub answered HTTP 502.' },
    ]);

    // Not retried within a day, not even a token request; retried after it, on the found issue.
    github.writes = [];
    expect(await pass(new Date(NOW.getTime() + 23 * 60 * 60 * 1000))).toBe(0);
    expect(authenticateGitHubIssues).toHaveBeenCalledTimes(1);
    expect(await pass(new Date(NOW.getTime() + DAY))).toBe(1);
    expect(writes()).toEqual([
      'GET /repos/example/app/issues?state=all&creator=refit-test%5Bbot%5D&per_page=100',
      'PATCH /repos/example/app/issues/12',
      'POST /repos/example/app/issues/12/comments',
    ]);
    expect(await reports.read()).toMatchObject([{ issue: 12, status: 'updated', message: null }]);
  },
  30_000,
);

it.skipIf(!DATABASE)(
  'keeps the report issue from the hosted worker when enabled, and stops writing on uninstall',
  async () => {
    const pool = await database();
    await (await installed(pool, await anthropicApp())).approve();
    const root = await mkdtemp(join(tmpdir(), 'refit-report-service-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const controller = new AbortController();
    let ready: (url: string) => void;
    const listening = new Promise<string>((resolve) => (ready = resolve));
    const service = runHostedService({
      database: pool,
      app: APP,
      directory: join(root, 'state'),
      webhookSecret: WEBHOOK_SECRET,
      controlToken: CONTROL_TOKEN,
      tenancy: { accounts: ['example'], limits: DEFAULT_TENANCY_LIMITS },
      reports: true,
      now: () => NOW,
      host: '127.0.0.1',
      port: 0,
      intervalSeconds: 30,
      worker: 'test-worker',
      signal: controller.signal,
      onReady: (url) => ready(url),
    });
    cleanups.push(async () => {
      controller.abort();
      await service.catch(() => undefined);
    });
    const url = await listening;
    const status = async () =>
      (
        await fetch(`${url}/status`, { headers: { Authorization: `Bearer ${CONTROL_TOKEN}` } })
      ).json();
    const reported = await until(status, (value) => value.reports.issues.length === 1);
    expect(reported.reports).toEqual({
      enabled: true,
      issues: [
        {
          installationId: 456,
          repository: 'example/app',
          issue: 1,
          status: 'opened',
          message: null,
          updatedAt: NOW.toISOString(),
        },
      ],
    });
    expect(writes()).toContain('POST /repos/example/app/issues');

    const body = JSON.stringify({
      action: 'deleted',
      installation: { id: 456, app_id: 123, account: { login: 'example' } },
    });
    const response = await fetch(`${url}/github/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'installation',
        'X-GitHub-Delivery': randomUUID(),
        'X-Hub-Signature-256': `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`,
      },
      body,
    });
    expect(response.status).toBe(202);
    // The report row stays for the uninstall grace period (until purge); the inventory goes now,
    // so nothing is written for the repository again.
    const removed = await until(status, (value) => value.inventories.length === 0);
    expect(removed.reports.issues).toHaveLength(1);
    expect(
      writes().filter(
        (write) =>
          write !==
          'GET /repos/example/app/issues?state=all&creator=refit-test%5Bbot%5D&per_page=100',
      ),
    ).toEqual(['POST /repos/example/app/issues']);
  },
  60_000,
);

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean) {
  for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Condition was not reached.');
}
