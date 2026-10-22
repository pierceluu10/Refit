import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_LEAD_DAYS } from './deadline-alerts.ts';
import type { DeadlineRegistry } from './deadline-registry.ts';
import { gitEnvironment } from './git-environment.ts';
import { runHostedService } from './hosted-service.ts';
import { openHostedStore } from './hosted-store.ts';
import { DEFAULT_TENANCY_LIMITS } from './hosted-tenancy.ts';
import { openInventoryStore } from './inventory-store.ts';
import { registryDigest, scanInventory } from './inventory.ts';
import {
  hostedAlerts,
  requestRescans,
  sendDeadlineAlerts,
  upcomingDeadlines,
} from './monitoring.ts';
import { openMonitoringStore } from './monitoring-store.ts';

const github = vi.hoisted(() => ({
  // Issue writes as `METHOD path`, in order.
  writes: [] as { method: string; path: string; body: unknown }[],
  // Holds the next issue creation for one repository until released, to stop a pass mid-write.
  hold: undefined as
    undefined | { repository: string; reached: () => void; release: Promise<void> },
  nextIssue: 1,
  remotes: new Map<string, { source: string; head: string }>(),
  fetches: [] as string[],
  native: undefined as
    undefined | ((args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>),
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execute = promisify(actual.execFile);
  github.native = (args, cwd) => execute('git', args, { cwd, env: gitEnvironment() });
  const execFile = vi.fn();
  Object.defineProperty(execFile, promisify.custom, {
    value: async (binary: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      if (binary !== 'git' || !args.includes('fetch')) return execute(binary, args, options);
      const directory = args[args.indexOf('-C') + 1];
      const url = (
        await execute('git', ['-C', directory, 'remote', 'get-url', 'origin'], options)
      ).stdout.trim();
      github.fetches.push(url);
      const local = [...args];
      local[local.indexOf('origin')] = github.remotes.get(url)!.source;
      return execute(binary, ['-c', 'protocol.file.allow=always', ...local], options);
    },
  });
  return { ...actual, execFile };
});
vi.mock('./github-app.ts', async (original) => ({
  ...(await original<typeof import('./github-app.ts')>()),
  authenticateGitHubRead: vi.fn(async () => ({
    token: 'private-read-test-token',
    appId: 123,
    installationId: 456,
  })),
  authenticateGitHubIssues: vi.fn(async () => ({ token: 'private-issues-test-token' })),
}));
vi.mock('./github.ts', async (original) => ({
  ...(await original<typeof import('./github.ts')>()),
  requestGitHub: vi.fn(async (_token: string, method: string, path: string, body?: unknown) => {
    const [, , owner, name, ...rest] = path.split('/');
    if (method === 'GET') {
      const remote = github.remotes.get(`https://github.com/${owner}/${name}.git`)!;
      if (!rest.length)
        return {
          id: 789,
          full_name: `${owner}/${name}`,
          archived: false,
          disabled: false,
          default_branch: 'main',
          size: 12,
        };
      expect(rest.join('/')).toBe('git/ref/heads/main');
      return { object: { type: 'commit', sha: remote.head } };
    }
    github.writes.push({ method, path, body });
    const hold = github.hold;
    if (
      method === 'POST' &&
      rest.join('/') === 'issues' &&
      hold?.repository === `${owner}/${name}`
    ) {
      github.hold = undefined;
      hold.reached();
      await hold.release;
    }
    return rest.join('/') === 'issues' ? { number: github.nextIssue++ } : {};
  }),
}));

const DATABASE = process.env.REFIT_POSTGRES_URL;
const APP = { appId: '123', privateKeyFile: 'unused-test-key' };
const DEADLINE = '2027-01-20';
const REGISTRY: DeadlineRegistry = {
  formatVersion: 1,
  deadlines: [
    {
      id: 'openai-test-gpt-4',
      provider: 'openai',
      kind: 'model',
      versions: ['gpt-4'],
      date: DEADLINE,
      summary: 'GPT-4 is shut down.',
      replacement: 'gpt-5.6-sol',
      source: 'https://platform.openai.com/docs/deprecations',
      checkedAt: '2026-10-01',
    },
  ],
};
const MODEL_CALL = [
  "import OpenAI from 'openai';",
  'const openai = new OpenAI();',
  "export const reply = () => openai.chat.completions.create({ model: 'gpt-4', messages: [] });",
].join('\n');
const PACKAGE = JSON.stringify({ dependencies: { openai: '^4.20.0' } });
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  github.writes = [];
  github.hold = undefined;
  github.nextIssue = 1;
  github.remotes.clear();
  github.fetches = [];
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// Midday UTC `days` before the test deadline.
const before = (days: number) =>
  new Date(Date.parse(`${DEADLINE}T12:00:00Z`) - days * 24 * 60 * 60 * 1000);

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

async function directory(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-monitoring-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

const installation = (id: number, action: string, repositories: string[]) => ({
  kind: 'installation' as const,
  installationId: id,
  owner: 'example',
  action,
  added: repositories.map((name, index) => ({ id: id * 100 + index, name })),
  removed: [],
});

// The worker's stores, opened as a (re)started worker opens them.
async function stores(pool: pg.Pool) {
  const hosted = await openHostedStore(pool, {
    accounts: ['example'],
    limits: DEFAULT_TENANCY_LIMITS,
  });
  const inventories = await openInventoryStore(pool);
  return { hosted, inventories, monitoring: await openMonitoringStore(pool) };
}

// Installs `repositories` and stores an inventory of each, scanned from its files.
async function inventoried(pool: pg.Pool, repositories: Record<string, Record<string, string>>) {
  const { hosted, inventories, monitoring } = await stores(pool);
  await hosted.accept(
    randomUUID(),
    'installation',
    new TextEncoder().encode(randomUUID()),
    installation(1, 'created', Object.keys(repositories)),
  );
  await inventories.requestMissing();
  for (let claimed; (claimed = await inventories.claim('scanner', 60));) {
    const inventory = await scanInventory(
      await directory(repositories[claimed.repository]),
      REGISTRY,
      before(120),
    );
    expect(
      await inventories.finish(claimed, 'scanner', {
        result: { outcome: 'complete', base: 'main', revision: 'a'.repeat(40), inventory },
        registry: registryDigest(REGISTRY),
        durationMs: 1,
      }),
    ).toBe(true);
  }
  return { hosted, inventories, monitoring };
}

function pass(monitoring: Awaited<ReturnType<typeof openMonitoringStore>>, now: Date) {
  return sendDeadlineAlerts({
    app: APP,
    monitoring,
    registry: REGISTRY,
    now,
    leadDays: DEFAULT_LEAD_DAYS,
    signal: new AbortController().signal,
    onProgress: (message) => console.log(message),
  });
}

const issueWrites = () =>
  github.writes.filter(
    (write) =>
      write.method === 'PATCH' || (write.method === 'POST' && write.path.endsWith('/issues')),
  );

it('reads REFIT_HOSTED_ALERTS as off unless it is 1', () => {
  expect(hostedAlerts({})).toBeNull();
  expect(hostedAlerts({ REFIT_HOSTED_ALERTS: '0' })).toBeNull();
  expect(hostedAlerts({ REFIT_HOSTED_ALERTS: '1' })).toEqual({ leadDays: [90, 30, 7] });
  expect(() => hostedAlerts({ REFIT_HOSTED_ALERTS: 'yes' })).toThrow(
    'REFIT_HOSTED_ALERTS must be 1, 0 or unset.',
  );
});

it.skipIf(!DATABASE)(
  'writes the issue exactly three times from 91 to 7 days left, recomputing days from the stored inventory',
  async () => {
    const pool = await database();
    const { monitoring } = await inventoried(pool, {
      'example/app': { 'package.json': PACKAGE, 'src/chat.ts': MODEL_CALL },
    });
    const days = [91, 90, 89, 60, 31, 30, 29, 8, 7, 6];
    const sent = [];
    for (const day of days) sent.push(await pass(monitoring, before(day)));
    console.log(github.writes.map((write) => `${write.method} ${write.path}`).join('\n'));
    expect(sent).toEqual([0, 1, 0, 0, 0, 1, 0, 0, 1, 0]);
    expect(issueWrites().map((write) => `${write.method} ${write.path}`)).toEqual([
      'POST /repos/example/app/issues',
      'PATCH /repos/example/app/issues/1',
      'PATCH /repos/example/app/issues/1',
    ]);
    // Each update also comments so watchers are notified.
    expect(github.writes.filter((write) => write.path.endsWith('/comments'))).toHaveLength(2);
    expect(github.writes[0].body).toMatchObject({
      title: `OpenAI model gpt-4 reaches its sunset on ${DEADLINE}`,
      body: expect.stringContaining('90 days left'),
    });
    expect(github.writes.at(-1)?.body).toMatchObject({
      body: '7 days left until 2027-01-20. Refit refreshed the evidence above.',
    });
    const [listed] = await upcomingDeadlines(monitoring, before(6));
    expect(listed).toMatchObject({
      installationId: 1,
      owner: 'example',
      deadlines: [
        {
          repository: 'example/app',
          deadline: 'openai-test-gpt-4',
          date: DEADLINE,
          days: 6,
          ignored: false,
          alert: { stage: 7, issue: 1, status: 'updated' },
        },
      ],
      more: 0,
    });
  },
);

it.skipIf(!DATABASE)(
  'sends nothing twice when a worker restarts in the middle of a pass',
  async () => {
    const pool = await database();
    const first = await inventoried(pool, {
      'example/first': { 'package.json': PACKAGE, 'src/chat.ts': MODEL_CALL },
      'example/second': { 'package.json': PACKAGE, 'src/chat.ts': MODEL_CALL },
    });
    let reached!: () => void;
    let release!: () => void;
    const stopped = new Promise<void>((resolve) => (reached = resolve));
    github.hold = {
      repository: 'example/first',
      reached,
      release: new Promise<void>((resolve) => (release = resolve)),
    };
    // The first worker's write to GitHub goes out and then the worker stops responding.
    const interrupted = pass(first.monitoring, before(60));
    await stopped;
    // A restarted worker skips the stage already taken and alerts the other repository.
    const restarted = await stores(pool);
    expect(await pass(restarted.monitoring, before(60))).toBe(1);
    // The first worker resumes; the second repository's stage is no longer its to send.
    release();
    expect(await interrupted).toBe(1);
    expect(await pass(restarted.monitoring, before(59))).toBe(0);
    expect(
      issueWrites()
        .map((write) => write.path)
        .sort(),
    ).toEqual(['/repos/example/first/issues', '/repos/example/second/issues']);
  },
);

it.skipIf(!DATABASE)(
  'honours a committed ignore and sends nothing for an uninstalled repository',
  async () => {
    const pool = await database();
    const { hosted, monitoring } = await inventoried(pool, {
      'example/accepted': {
        'package.json': PACKAGE,
        'src/chat.ts': MODEL_CALL,
        '.refit-deadlines-ignore.json': JSON.stringify({
          formatVersion: 1,
          ignore: [
            {
              deadline: 'openai-test-gpt-4',
              reason: 'Replaced before launch.',
              until: '2027-02-01',
            },
          ],
        }),
      },
      'example/broken-ignore': {
        'package.json': PACKAGE,
        'src/chat.ts': MODEL_CALL,
        '.refit-deadlines-ignore.json': '{"formatVersion": 1, "ignore": "everything"}',
      },
      'example/removed': { 'package.json': PACKAGE, 'src/chat.ts': MODEL_CALL },
    });
    await hosted.accept(
      randomUUID(),
      'installation_repositories',
      new TextEncoder().encode(randomUUID()),
      {
        ...installation(1, 'removed', []),
        kind: 'repositories',
        removed: [{ id: 102, name: 'example/removed' }],
      },
    );
    expect(await pass(monitoring, before(30))).toBe(1);
    // Only the repository whose ignore file is invalid, which accepts nothing, is alerted.
    expect(issueWrites().map((write) => write.path)).toEqual([
      '/repos/example/broken-ignore/issues',
    ]);
    const [listed] = await upcomingDeadlines(monitoring, before(30));
    expect(listed.deadlines.map((item) => [item.repository, item.ignored])).toEqual([
      ['example/accepted', true],
      ['example/broken-ignore', false],
    ]);

    // Uninstalling deletes the alert state with the repositories, and nothing is sent afterwards.
    await hosted.accept(
      randomUUID(),
      'installation',
      new TextEncoder().encode(randomUUID()),
      installation(1, 'deleted', []),
    );
    expect(await pass(monitoring, before(7))).toBe(0);
    expect(issueWrites()).toHaveLength(1);
    expect(
      (await pool.query('SELECT count(*)::int AS rows FROM refit_deadline_alerts')).rows,
    ).toEqual([{ rows: 0 }]);
    expect(await upcomingDeadlines(monitoring, before(7))).toEqual([]);
  },
);

it.skipIf(!DATABASE)(
  'asks for a new inventory after a push, a registry change or a day, at most once per 10 minutes',
  async () => {
    const pool = await database();
    const { inventories, monitoring } = await inventoried(pool, {
      'example/app': { 'package.json': PACKAGE },
    });
    const start = before(60);
    const at = (minutes: number) => new Date(start.getTime() + minutes * 60 * 1000);
    const rescans = (now: Date, registry = REGISTRY) =>
      requestRescans({ monitoring, inventories, registry, now });
    const state = async () => (await inventories.read('example/app'))[0].state;
    // First sight starts the clock; nothing is due yet.
    expect(await rescans(at(0))).toEqual([]);
    expect(await monitoring.pushed(1, 'example/app', at(1))).toBe(true);
    expect(await monitoring.pushed(1, 'example/other', at(1))).toBe(false);
    expect(await rescans(at(5))).toEqual([]);
    expect(await rescans(at(10))).toEqual([
      { installationId: 1, repository: 'example/app', reason: 'push' },
    ]);
    expect(await state()).toBe('queued');
    const finish = async () =>
      inventories.finish((await inventories.claim('scanner', 60))!, 'scanner', {
        result: { outcome: 'unchanged', base: 'main', revision: 'a'.repeat(40) },
        registry: registryDigest(REGISTRY),
        durationMs: 1,
      });
    // A queued inventory is not requested again. A push that arrives meanwhile asks once more
    // when it is idle, since the queued one may have read the head before the push.
    expect(await monitoring.pushed(1, 'example/app', at(11))).toBe(true);
    expect(await rescans(at(30))).toEqual([]);
    await finish();
    expect(await rescans(at(31))).toEqual([
      { installationId: 1, repository: 'example/app', reason: 'push' },
    ]);
    await finish();
    expect(await rescans(at(35))).toEqual([]);
    // A changed registry, then age.
    const changed = { ...REGISTRY, deadlines: [{ ...REGISTRY.deadlines[0], date: '2027-02-01' }] };
    expect(await rescans(at(40), changed)).toEqual([]);
    expect(await rescans(at(41), changed)).toEqual([
      { installationId: 1, repository: 'example/app', reason: 'registry' },
    ]);
    await finish();
    expect(await rescans(at(41 + 23 * 60))).toEqual([]);
    expect(await rescans(at(41 + 24 * 60))).toEqual([
      { installationId: 1, repository: 'example/app', reason: 'age' },
    ]);
  },
);

const WEBHOOK_SECRET = 'webhook-secret-for-monitoring-service-tests-1';
const CONTROL_TOKEN = 'control-secret-for-monitoring-service-tests-2';

async function commit(source: string, repository: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(source, name)), { recursive: true });
    await writeFile(join(source, name), content);
  }
  await github.native!(['add', '.'], source);
  await github.native!(
    [
      '-c',
      'user.name=Refit Tests',
      '-c',
      'user.email=tests@refit.local',
      'commit',
      '--quiet',
      '-m',
      'test: change',
    ],
    source,
  );
  const head = (await github.native!(['rev-parse', 'HEAD'], source)).stdout.trim();
  github.remotes.set(`https://github.com/${repository}.git`, { source, head });
  return head;
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
  expect(response.status).toBe(202);
  return response.json();
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean) {
  for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Condition was not reached.');
}

it.skipIf(!DATABASE)(
  'takes a new inventory after a default-branch push and alerts on the model it added',
  async () => {
    const pool = await database();
    const root = await directory({ 'registry.json': JSON.stringify(REGISTRY) });
    const source = join(root, 'example/app');
    await mkdir(source, { recursive: true });
    await github.native!(['init', '--quiet', '--initial-branch=main'], source);
    const first = await commit(source, 'example/app', {
      'package.json': PACKAGE,
      'src/chat.ts': MODEL_CALL.replace("'gpt-4'", "'gpt-5'"),
    });
    const clock = { now: before(60) };
    const controller = new AbortController();
    let ready: (url: string) => void;
    const listening = new Promise<string>((resolve) => (ready = resolve));
    const progress: string[] = [];
    const service = runHostedService({
      database: pool,
      app: APP,
      directory: join(root, 'state'),
      webhookSecret: WEBHOOK_SECRET,
      controlToken: CONTROL_TOKEN,
      tenancy: { accounts: ['example'], limits: DEFAULT_TENANCY_LIMITS },
      alerts: { leadDays: DEFAULT_LEAD_DAYS },
      registry: join(root, 'registry.json'),
      now: () => clock.now,
      host: '127.0.0.1',
      port: 0,
      intervalSeconds: 30,
      worker: 'test-worker',
      signal: controller.signal,
      onReady: (url) => ready(url),
      onProgress: (message) => progress.push(message),
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

    await deliver(url, 'installation', {
      action: 'created',
      installation: { id: 456, app_id: 123, account: { login: 'example' } },
      repositories: [{ id: 789, full_name: 'example/app' }],
    });
    let registry = await until(status, (value) =>
      value.inventories.some((row: { revision: string }) => row.revision === first),
    );
    expect(registry.inventories[0].summary).toMatchObject({ models: ['gpt-5'], deadlines: [] });
    expect(registry.monitoring).toEqual({
      alerts: true,
      installations: [{ installationId: 456, owner: 'example', deadlines: [], more: 0 }],
    });

    const second = await commit(source, 'example/app', { 'src/legacy.ts': MODEL_CALL });
    clock.now = new Date(clock.now.getTime() + 11 * 60 * 1000);
    const push = (ref: string) =>
      deliver(url, 'push', {
        ref,
        after: second,
        deleted: false,
        installation: { id: 456 },
        repository: { full_name: 'example/app', default_branch: 'main' },
      });
    expect(await push('refs/heads/feature')).toMatchObject({ status: 'accepted' });
    expect(await push('refs/heads/main')).toMatchObject({ status: 'accepted' });
    await until(
      async () => issueWrites(),
      (writes) => writes.length === 1,
    );
    registry = await status();
    console.log(progress.join('\n'));
    expect(github.fetches).toHaveLength(2);
    expect(registry.inventories[0]).toMatchObject({
      revision: second,
      summary: { models: ['gpt-5', 'gpt-4'], deadlines: [{ id: 'openai-test-gpt-4', live: 1 }] },
    });
    expect(issueWrites()[0]).toMatchObject({
      path: '/repos/example/app/issues',
      body: { title: `OpenAI model gpt-4 reaches its sunset on ${DEADLINE}` },
    });
    expect(registry.monitoring.installations[0].deadlines).toEqual([
      {
        repository: 'example/app',
        deadline: 'openai-test-gpt-4',
        date: DEADLINE,
        days: 60,
        ignored: false,
        alert: { stage: 90, issue: 1, status: 'opened' },
      },
    ]);
    expect(progress).toContain('[monitoring example/app] Inventory requested (push).');
  },
  60_000,
);
