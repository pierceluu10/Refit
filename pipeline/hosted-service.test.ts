import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { gitEnvironment } from './git-environment.ts';
import { runHostedService } from './hosted-service.ts';
import { hostedTargetId, openHostedStore } from './hosted-store.ts';
import {
  approveRepositoryEnrollment,
  inspectRepositoryEnrollment,
  readRepositoryApproval,
} from './repository-enrollment.ts';
import { verifyArtifacts } from './verification.ts';

const transport = vi.hoisted(() => ({
  source: '',
  head: '',
  calls: [] as { binary: string; args: string[] }[],
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
      transport.calls.push({ binary, args });
      if (binary !== 'git' || !args.includes('fetch')) return execute(binary, args, options);
      const local = [...args];
      local[local.indexOf('origin')] = transport.source;
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
    if (path === '/repos/example/application')
      return { id: 789, full_name: 'example/application', archived: false, disabled: false };
    expect(path).toBe('/repos/example/application/git/ref/heads/main');
    return { object: { type: 'commit', sha: transport.head } };
  }),
}));

const DATABASE = process.env.REFIT_POSTGRES_URL;
const INSTALLATION = 456;
const APP = { appId: '123', privateKeyFile: 'unused-test-key' };
const WEBHOOK_SECRET = 'webhook-secret-for-hosted-service-tests-123';
const CONTROL_TOKEN = 'control-secret-for-hosted-service-tests-456';
const fixture = resolve('pipeline/fixtures/endpoint-replacement');
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  transport.calls = [];
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

async function commit() {
  await transport.native!(['add', '.'], transport.source);
  await transport.native!(
    [
      '-c',
      'user.name=Refit Tests',
      '-c',
      'user.email=tests@refit.local',
      'commit',
      '--quiet',
      '-m',
      'test: update hosted application',
    ],
    transport.source,
  );
  transport.head = (await transport.native!(['rev-parse', 'HEAD'], transport.source)).stdout.trim();
}

// A committed application whose contract already changed, with a reviewed approval receipt.
async function approvedRepository() {
  const root = await mkdtemp(join(tmpdir(), 'refit-hosted-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  transport.source = join(root, 'source');
  await cp(join(fixture, 'repository'), transport.source, { recursive: true });
  for (const name of ['before.json', 'provider.json', 'after.json'])
    await cp(join(fixture, name), join(transport.source, name));
  await writeFile(
    join(transport.source, '.refit.json'),
    JSON.stringify({
      formatVersion: 1,
      before: './before.json',
      after: './after.json',
      providerConfig: './provider.json',
      apiVersion: '1',
      fullDiff: Boolean(process.env.REFIT_OASDIFF),
      image: process.env.REFIT_DOCKER_IMAGE ?? 'unused-test-image',
      baselineCommand: ['node', '--experimental-strip-types', 'simulator/check.mjs', 'before'],
      command: ['node', '--experimental-strip-types', 'simulator/check.mjs', 'after'],
    }),
  );
  await transport.native!(['init', '--quiet', '--initial-branch=main'], transport.source);
  await commit();
  const enrollment = await inspectRepositoryEnrollment({
    repository: transport.source,
    github: 'example/application',
    base: 'main',
  });
  const output = join(root, 'approval.json');
  await approveRepositoryEnrollment({ enrollment, fingerprint: enrollment.fingerprint, output });
  return { root, approval: await readRepositoryApproval(output) };
}

function installationPayload(action: string, repositories: string[]) {
  return {
    action,
    installation: { id: INSTALLATION, app_id: 123, account: { login: 'example' } },
    repositories: repositories.map((full_name, index) => ({ id: 789 + index, full_name })),
  };
}

async function deliver(url: string, event: string, payload: unknown, delivery = randomUUID()) {
  const body = JSON.stringify(payload);
  const response = await fetch(`${url}/github/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': event,
      'X-GitHub-Delivery': delivery,
      'X-Hub-Signature-256': `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`,
    },
    body,
  });
  return { status: response.status, body: await response.json(), delivery };
}

async function status(url: string) {
  const response = await fetch(`${url}/status`, {
    headers: { Authorization: `Bearer ${CONTROL_TOKEN}` },
  });
  expect(response.status).toBe(200);
  return response.json();
}

it.skipIf(!DATABASE || !process.env.REFIT_DOCKER_IMAGE || !process.env.REFIT_OASDIFF)(
  'enrolls an approved repository on App installation, validates it in offline Docker, stores the receipt and cancels on uninstall',
  async () => {
    const pool = await database();
    const sample = await approvedRepository();
    expect(await (await openHostedStore(pool)).approve(sample.approval, 'octo-reviewer')).toEqual(
      [],
    );
    const controller = new AbortController();
    let ready: (url: string) => void;
    const listening = new Promise<string>((resolve) => (ready = resolve));
    const progress: string[] = [];
    const service = runHostedService({
      database: pool,
      app: APP,
      directory: join(sample.root, 'hosted-state'),
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
    const target = hostedTargetId('example/application', 'main');

    const created = installationPayload('created', ['example/application', 'example/unapproved']);
    const installed = await deliver(url, 'installation', created);
    expect(installed).toMatchObject({ status: 202, body: { enrolled: [target] } });
    expect((await deliver(url, 'installation', created, installed.delivery)).body).toMatchObject({
      status: 'duplicate',
      enrolled: [],
    });
    expect(
      (
        await deliver(
          url,
          'installation',
          installationPayload('created', ['example/application']),
          installed.delivery,
        )
      ).status,
    ).toBe(409);

    const foreign = await deliver(url, 'installation', {
      ...installationPayload('created', []),
      installation: { id: 999, app_id: 123, account: { login: 'someone-else' } },
      repositories: [{ id: 901, full_name: 'someone-else/application' }],
    });
    expect(foreign.body).toMatchObject({ status: 'ignored', enrolled: [] });

    let registry = await status(url);
    for (
      const deadline = Date.now() + 90_000;
      registry.jobs[0]?.status !== 'finished' && Date.now() < deadline;
      registry = await status(url)
    )
      await new Promise((resolve) => setTimeout(resolve, 250));
    console.log(progress.join('\n'));
    expect(registry.installations).toEqual([
      {
        id: String(INSTALLATION),
        owner: 'example',
        status: 'active',
        repositories: ['example/application', 'example/unapproved'],
      },
    ]);
    expect(registry.targets).toEqual([
      expect.objectContaining({
        id: target,
        repository: 'example/application',
        status: 'enrolled',
        fingerprint: sample.approval.fingerprint,
      }),
    ]);
    expect(registry.jobs).toHaveLength(1);
    const [job] = registry.jobs;
    expect(job).toMatchObject({
      targetId: target,
      status: 'finished',
      attempts: 1,
      receipt: { status: 'validated', readiness: 'ready-for-validation', revision: transport.head },
    });
    const report = JSON.parse(await readFile(join(job.receipt.output, 'report.json'), 'utf8'));
    expect(report.validation.baseline.status).toBe('passed');
    expect(report.validation.patched.status).toBe('passed');
    expect(report.patch.generator).toBe('deterministic');
    expect((await verifyArtifacts(job.receipt.output)).status).toBe('integrity-verified');
    expect(transport.calls.some((call) => call.binary === 'docker')).toBe(true);
    expect(
      transport.calls.every((call) => !call.args.join(' ').includes('private-read-test-token')),
    ).toBe(true);

    const uninstalled = await deliver(url, 'installation', installationPayload('deleted', []));
    expect(uninstalled).toMatchObject({ status: 202, body: { cancelled: [target] } });
    registry = await status(url);
    expect(registry.installations[0].status).toBe('deleted');
    expect(registry.targets[0]).toMatchObject({
      status: 'cancelled',
      message: 'Installation deleted.',
    });
    const store = await openHostedStore(pool);
    expect(await store.enqueueDue(0)).toBe(0);
    expect(await store.claim('other-worker', 30)).toBeNull();
    expect(await readFile(join(transport.source, 'src/items.ts'), 'utf8')).toBe(
      await readFile(join(fixture, 'repository/src/items.ts'), 'utf8'),
    );
  },
  120_000,
);

it.skipIf(!DATABASE)(
  'leases jobs durably, stops a running job on repository removal and keeps its evidence as cancelled',
  async () => {
    const pool = await database();
    const sample = await approvedRepository();
    const store = await openHostedStore(pool);
    const change = (action: string, added: string[], removed: string[] = []) => ({
      kind: 'repositories' as const,
      installationId: 456,
      owner: 'example',
      action,
      added: added.map((name, index) => ({ id: 789 + index, name })),
      removed: removed.map((name, index) => ({ id: 789 + index, name })),
    });
    const body = (value: string) => new TextEncoder().encode(value);
    const unapproved = await store.accept(
      randomUUID(),
      'installation_repositories',
      body('a'),
      change('added', ['example/application']),
    );
    expect(unapproved.enrolled).toEqual([]);
    const target = hostedTargetId('example/application', 'main');
    expect(await store.approve(sample.approval, 'octo-reviewer')).toEqual([target]);
    expect(await store.enqueueDue(0)).toBe(0);

    const first = await store.claim('worker-a', 3);
    expect(first).toMatchObject({
      target: { id: target, installationId: INSTALLATION, approval: sample.approval },
    });
    expect(await store.claim('worker-b', 3)).toBeNull();
    // worker-a stops renewing; after expiry another worker reclaims the same job.
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    const reclaimed = await store.claim('worker-b', 30);
    expect(reclaimed?.job).toBe(first!.job);
    expect(await store.renew(first!.job, 'worker-a', 30)).toBe(false);
    expect(
      await store.finish(first!.job, 'worker-a', 'finished', {
        status: 'validated',
        output: null,
        message: null,
      }),
    ).toBe(false);

    const delivery = randomUUID();
    const removed = await store.accept(
      delivery,
      'installation_repositories',
      body('b'),
      change('removed', [], ['example/application']),
    );
    expect(removed).toMatchObject({ cancelled: [target], running: [first!.job] });
    await expect(
      store.accept(
        delivery,
        'installation_repositories',
        body('c'),
        change('removed', [], ['example/application']),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await store.renew(first!.job, 'worker-b', 30)).toBe(false);
    expect(
      await store.finish(first!.job, 'worker-b', 'finished', {
        status: 'interrupted',
        output: '/evidence',
        message: null,
      }),
    ).toBe(true);
    const registry = await store.read();
    expect(registry.jobs).toEqual([
      expect.objectContaining({
        status: 'cancelled',
        attempts: 2,
        receipt: { status: 'interrupted', output: '/evidence', message: null },
      }),
    ]);
    expect(await store.claim('worker-c', 30)).toBeNull();

    const readded = await store.accept(
      randomUUID(),
      'installation_repositories',
      body('d'),
      change('added', ['example/application']),
    );
    expect(readded.enrolled).toEqual([target]);
    expect((await store.read()).targets[0]).toMatchObject({ status: 'enrolled', message: null });
  },
  30_000,
);
