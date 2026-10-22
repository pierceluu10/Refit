import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { gitEnvironment } from './git-environment.ts';
import { runHostedService } from './hosted-service.ts';

const transport = vi.hoisted(() => ({
  // Remote URL → local source repository and its head commit.
  remotes: new Map<string, { source: string; head: string }>(),
  fetches: [] as string[],
  native: undefined as
    undefined | ((args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>),
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execute = promisify(actual.execFile);
  transport.native = (args, cwd) => execute('git', args, { cwd, env: gitEnvironment() });
  const execFile = vi.fn();
  Object.defineProperty(execFile, promisify.custom, {
    value: async (binary: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      if (binary !== 'git' || !args.includes('fetch')) return execute(binary, args, options);
      const directory = args[args.indexOf('-C') + 1];
      const url = (
        await execute('git', ['-C', directory, 'remote', 'get-url', 'origin'], options)
      ).stdout.trim();
      transport.fetches.push(url);
      const local = [...args];
      local[local.indexOf('origin')] = transport.remotes.get(url)!.source;
      return execute(binary, ['-c', 'protocol.file.allow=always', ...local], options);
    },
  });
  return { ...actual, execFile };
});
vi.mock('./github-app.ts', () => ({
  authenticateGitHubRead: vi.fn(async () => ({
    token: 'private-read-test-token',
    appId: 123,
    installationId: 456,
  })),
}));
vi.mock('./github.ts', async (original) => ({
  ...(await original<typeof import('./github.ts')>()),
  requestGitHub: vi.fn(async (_token: string, method: string, path: string) => {
    expect(method).toBe('GET');
    const [, , owner, name, ...rest] = path.split('/');
    const remote = transport.remotes.get(`https://github.com/${owner}/${name}.git`)!;
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
  }),
}));

const DATABASE = process.env.REFIT_POSTGRES_URL;
const INSTALLATION = 456;
const APP = { appId: '123', privateKeyFile: 'unused-test-key' };
const WEBHOOK_SECRET = 'webhook-secret-for-inventory-service-tests-123';
const CONTROL_TOKEN = 'control-secret-for-inventory-service-tests-456';
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  transport.remotes.clear();
  transport.fetches = [];
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
  const url = new URL(DATABASE!);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return { pool, url: url.toString() };
}

async function remote(root: string, repository: string, files: Record<string, string>) {
  const source = join(root, repository);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(source, name)), { recursive: true });
    await writeFile(join(source, name), content);
  }
  await transport.native!(['init', '--quiet', '--initial-branch=main'], source);
  await transport.native!(['add', '.'], source);
  await transport.native!(
    [
      '-c',
      'user.name=Refit Tests',
      '-c',
      'user.email=tests@refit.local',
      'commit',
      '--quiet',
      '-m',
      'test: inventory',
    ],
    source,
  );
  const head = (await transport.native!(['rev-parse', 'HEAD'], source)).stdout.trim();
  transport.remotes.set(`https://github.com/${repository}.git`, { source, head });
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

async function status(url: string) {
  const response = await fetch(`${url}/status`, {
    headers: { Authorization: `Bearer ${CONTROL_TOKEN}` },
  });
  expect(response.status).toBe(200);
  return response.json();
}

// Polls /status until every inventory row is idle and checked, `repository` after `since`.
async function settled(url: string, count: number, since?: { repository: string; after: Date }) {
  for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
    const registry = await status(url);
    const rows: { repository: string; state: string; checkedAt: string | null }[] =
      registry.inventories;
    if (
      rows.length === count &&
      rows.every((row) => row.state === 'idle' && row.checkedAt) &&
      rows.every(
        (row) => row.repository !== since?.repository || new Date(row.checkedAt!) > since.after,
      )
    )
      return registry;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Inventories did not settle.');
}

const installation = (action: string, repositories: string[]) => ({
  action,
  installation: { id: INSTALLATION, app_id: 123, account: { login: 'example' } },
  repositories: repositories.map((full_name, index) => ({ id: 789 + index, full_name })),
});

it.skipIf(!DATABASE)(
  'inventories every installed repository on install, skips an unchanged revision and deletes rows on removal and uninstall',
  async () => {
    const { pool, url: databaseUrl } = await database();
    const root = await mkdtemp(join(tmpdir(), 'refit-inventory-service-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const application = await remote(root, 'example/application', {
      'package.json': JSON.stringify({ dependencies: { stripe: '^16.0.0', openai: '^4.20.0' } }),
      'src/chat.ts': [
        "import OpenAI from 'openai';",
        'const openai = new OpenAI();',
        "export const reply = () => openai.chat.completions.create({ model: 'gpt-4', messages: [] });",
      ].join('\n'),
      'src/billing.ts': [
        "import Stripe from 'stripe';",
        "export const stripe = new Stripe('sk_test_x', { apiVersion: '2024-06-20' });",
      ].join('\n'),
    });
    await remote(root, 'example/notes', { 'README.md': '# Notes\n' });
    const controller = new AbortController();
    let ready: (url: string) => void;
    const listening = new Promise<string>((resolve) => (ready = resolve));
    const progress: string[] = [];
    const state = join(root, 'hosted-state');
    const service = runHostedService({
      database: pool,
      app: APP,
      directory: state,
      webhookSecret: WEBHOOK_SECRET,
      controlToken: CONTROL_TOKEN,
      owner: 'Example',
      host: '127.0.0.1',
      port: 0,
      intervalSeconds: 30,
      leaseSeconds: 30,
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

    expect(
      await deliver(
        url,
        'installation',
        installation('created', ['example/application', 'example/notes']),
      ),
    ).toMatchObject({ status: 'accepted', enrolled: [] });
    // Another account's installation is ignored before anything is recorded or cloned.
    expect(
      await deliver(url, 'installation', {
        ...installation('created', []),
        installation: { id: 999, app_id: 123, account: { login: 'someone-else' } },
        repositories: [{ id: 901, full_name: 'someone-else/application' }],
      }),
    ).toMatchObject({ status: 'ignored' });

    let registry = await settled(url, 2);
    console.log(progress.join('\n'));
    // Inventory never enrolls: neither repository has an approval, so nothing may run.
    expect(registry.targets).toEqual([]);
    expect(registry.jobs).toEqual([]);
    const [first, notes] = registry.inventories;
    expect(first).toMatchObject({
      installationId: String(INSTALLATION),
      repository: 'example/application',
      state: 'idle',
      base: 'main',
      revision: application,
      status: 'complete',
      error: null,
      summary: {
        providers: ['stripe', 'openai'],
        deadlines: [{ id: 'openai-2026-10-23-gpt-4', date: '2026-10-23', live: 1 }],
        apiVersions: ['2024-06-20'],
        models: ['gpt-4'],
        modelCalls: 1,
      },
    });
    expect(first).not.toHaveProperty('inventory');
    expect(notes).toMatchObject({
      repository: 'example/notes',
      status: 'complete',
      summary: { providers: [], deadlines: [], models: [] },
    });
    expect(transport.fetches.sort()).toEqual([
      'https://github.com/example/application.git',
      'https://github.com/example/notes.git',
    ]);
    // Checkouts are deleted after each inventory.
    expect(await readdir(join(state, 'inventory'))).toEqual([]);

    // Installing the same unchanged revision again checks it without fetching or scanning.
    const before = new Date(first.checkedAt);
    await deliver(url, 'installation_repositories', {
      ...installation('added', []),
      repositories_added: [{ id: 789, full_name: 'example/application' }],
      repositories_removed: [],
    });
    registry = await settled(url, 2, { repository: 'example/application', after: before });
    expect(transport.fetches).toHaveLength(2);
    expect(registry.inventories[0]).toMatchObject({
      revision: application,
      scannedAt: first.scannedAt,
    });
    expect(progress.join('\n')).toContain(
      `Inventory unchanged at ${application.slice(0, 12)}; not scanned again.`,
    );

    // The operator command queues one and prints the stored inventory in full.
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [resolve('bin/refit.mjs'), 'hosted', 'inventory', '--repository', 'example/application'],
      { env: { ...process.env, REFIT_DATABASE_URL: databaseUrl } },
    );
    expect(stderr).toContain(
      `Queued an inventory of example/application (installation ${INSTALLATION}).`,
    );
    const printed = JSON.parse(stdout);
    expect(printed).toMatchObject({ repository: 'example/application', revision: application });
    expect(printed.inventory.models).toEqual([
      {
        provider: 'openai',
        file: 'src/chat.ts',
        line: 3,
        call: 'chat.completions.create',
        model: 'gpt-4',
        test: false,
      },
    ]);
    await expect(
      promisify(execFile)(
        process.execPath,
        [resolve('bin/refit.mjs'), 'hosted', 'inventory', '--repository', 'example/missing'],
        { env: { ...process.env, REFIT_DATABASE_URL: databaseUrl } },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        'example/missing is not installed in an active installation.',
      ),
    });

    await deliver(url, 'installation_repositories', {
      ...installation('removed', []),
      repositories_added: [],
      repositories_removed: [{ id: 790, full_name: 'example/notes' }],
    });
    expect(
      (await status(url)).inventories.map((row: { repository: string }) => row.repository),
    ).toEqual(['example/application']);

    await deliver(url, 'installation', installation('deleted', ['example/application']));
    registry = await status(url);
    expect(registry.installations).toEqual([
      expect.objectContaining({ status: 'deleted', repositories: [] }),
    ]);
    expect(registry.inventories).toEqual([]);
    expect((await pool.query('SELECT count(*)::int AS rows FROM refit_inventories')).rows).toEqual([
      { rows: 0 },
    ]);
  },
  90_000,
);
