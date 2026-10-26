import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { approvedRepository } from './fixtures/approved-repository.ts';
import { fakeFlyMachines, type FakeMachine } from './fixtures/fake-fly-machines.ts';
import { flyMachines } from './fly-machines.ts';
import { authenticateGitHubRead } from './github-app.ts';
import { JOB_GUEST, runHostedJob } from './hosted-runner.ts';
import { runHostedService } from './hosted-service.ts';
import { hostedTargetId, openHostedStore } from './hosted-store.ts';
import { DEFAULT_TENANCY_LIMITS } from './hosted-tenancy.ts';
import { verifyArtifacts } from './verification.ts';
import { readEvidence } from './state-files.ts';

const TENANCY = { accounts: ['example'], limits: DEFAULT_TENANCY_LIMITS };
const transport = vi.hoisted(() => ({ source: '', head: '', tokens: [] as string[] }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execute = promisify(actual.execFile);
  const execFile = vi.fn();
  Object.defineProperty(execFile, promisify.custom, {
    value: async (binary: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      if (binary !== 'git' || !args.includes('fetch')) return execute(binary, args, options);
      const local = [...args];
      local[local.indexOf('origin')] = transport.source;
      return execute(binary, ['-c', 'protocol.file.allow=always', ...local], options);
    },
  });
  return { ...actual, execFile };
});
// The control process holds the App key; job machines only receive the token it mints.
vi.mock('./github-app.ts', async (original) => {
  const actual = await original<typeof import('./github-app.ts')>();
  return {
    ...actual,
    authenticateGitHubRead: vi.fn(
      async (
        configuration: Parameters<typeof actual.authenticateGitHubRead>[0],
        repository: string,
      ) =>
        'installationToken' in configuration
          ? actual.authenticateGitHubRead(configuration, repository)
          : { token: 'minted-read-token', appId: 123, installationId: 456 },
    ),
  };
});
vi.mock('./github.ts', async (original) => ({
  ...(await original<typeof import('./github.ts')>()),
  requestGitHub: vi.fn(async (token: string, method: string, path: string) => {
    transport.tokens.push(token);
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
const JOB_APP = 'refit-jobs-test';
const FLY_TOKEN = 'fly-test-token';
const WEBHOOK_SECRET = 'webhook-secret-for-job-machine-tests-123';
const CONTROL_TOKEN = 'control-secret-for-job-machine-tests-456';
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  transport.tokens = [];
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
  return { status: response.status, body: await response.json() };
}

function repositories(action: string, added: string[], removed: string[] = []) {
  const installation = { id: INSTALLATION, app_id: 123, account: { login: 'example' } };
  const list = (names: string[]) => names.map((full_name) => ({ id: 789, full_name }));
  return action === 'created'
    ? { action, installation, repositories: list(added) }
    : {
        action,
        installation,
        repository_selection: 'selected',
        repositories_added: list(added),
        repositories_removed: list(removed),
      };
}

async function status(url: string) {
  const response = await fetch(`${url}/status`, {
    headers: { Authorization: `Bearer ${CONTROL_TOKEN}` },
  });
  return response.json();
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, seconds = 60) {
  let value = await read();
  for (const deadline = Date.now() + seconds * 1000; !done(value) && Date.now() < deadline;)
    value = await new Promise((resolve) => setTimeout(resolve, 100)).then(read);
  expect(done(value)).toBe(true);
  return value;
}

// A control process on port 0 against its own schema, a simulated Machines API, and `machine`
// playing each created machine's part.
async function service(
  pool: pg.Pool,
  root: string,
  machine: (created: FakeMachine) => void,
  worker = 'control-worker',
) {
  const fake = await fakeFlyMachines({ app: JOB_APP, token: FLY_TOKEN, onCreate: machine });
  cleanups.push(fake.close);
  const machines = flyMachines({ app: JOB_APP, token: FLY_TOKEN, api: fake.api });
  const controller = new AbortController();
  let ready: (url: string) => void;
  const listening = new Promise<string>((resolve) => (ready = resolve));
  const progress: string[] = [];
  const running = runHostedService({
    database: pool,
    app: APP,
    directory: join(root, 'hosted-state'),
    webhookSecret: WEBHOOK_SECRET,
    controlToken: CONTROL_TOKEN,
    tenancy: TENANCY,
    host: '127.0.0.1',
    port: 0,
    intervalSeconds: 30,
    leaseSeconds: 3,
    worker,
    jobMachines: {
      machines,
      image: 'registry.example/refit:job',
      region: 'iad',
      images: [process.env.REFIT_DOCKER_IMAGE ?? 'unused-test-image'],
      host: '127.0.0.1',
      port: 0,
      pollSeconds: 0.1,
    },
    signal: controller.signal,
    onReady: (url) => ready(url),
    onProgress: (message) => progress.push(message),
  });
  cleanups.push(async () => {
    controller.abort();
    await running.catch(() => undefined);
    console.log(progress.join('\n'));
  });
  return {
    url: await listening,
    fake,
    machines,
    progress,
    stop: () => controller.abort(),
    running,
  };
}

function boot(created: FakeMachine) {
  return runHostedJob({
    url: created.config.env.REFIT_JOB_URL,
    job: Number(created.config.env.REFIT_JOB_ID),
    secret: created.config.env.REFIT_JOB_SECRET,
    signal: AbortSignal.timeout(120_000),
  });
}

it.skipIf(!DATABASE)(
  'runs an installed repository on a job machine, stores its receipt and destroys the machine',
  async () => {
    const pool = await database();
    const root = await mkdtemp(join(tmpdir(), 'refit-job-machines-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const sample = await approvedRepository(root);
    transport.source = sample.source;
    transport.head = sample.head;
    await (await openHostedStore(pool)).approve(sample.approval, 'octo-reviewer');
    const control = await service(pool, root, (created) => void boot(created));
    const target = hostedTargetId('example/application', 'main');

    const installed = await deliver(
      control.url,
      'installation',
      repositories('created', ['example/application']),
    );
    expect(installed).toMatchObject({ status: 202, body: { enrolled: [target] } });
    const registry = await until(
      () => status(control.url),
      (value) => value.jobs[0]?.status === 'finished',
    );
    // refit doctor stops before checks when the approved image is not present locally.
    const outcome = process.env.REFIT_DOCKER_IMAGE
      ? { status: 'validated', readiness: 'ready-for-validation' }
      : { status: 'needs-attention', readiness: 'needs-attention' };
    expect(registry.jobs[0]).toMatchObject({
      targetId: target,
      attempts: 1,
      receipt: { ...outcome, revision: sample.head },
    });
    const [created] = control.fake.machines.values();
    expect(created).toMatchObject({
      state: 'destroyed',
      config: { guest: JOB_GUEST, metadata: { refit: 'job', refit_job: registry.jobs[0].id } },
    });
    expect(created.config.env.REFIT_JOB_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // The control process checked access with its own token; the machine fetched with the one it was given.
    expect(new Set(transport.tokens)).toEqual(new Set(['minted-read-token']));
    const reads = vi
      .mocked(authenticateGitHubRead)
      .mock.calls.map(([configuration]) =>
        'privateKeyFile' in configuration ? 'control' : 'machine',
      );
    expect(reads).toContain('machine');
    // One for the job's access check, one for the install's inventory, which the fake GitHub
    // record (no default branch or size) stops before any checkout.
    expect(reads.filter((read) => read === 'control')).toHaveLength(2);
    expect(control.progress).toContain(`Job machine ${created.id} destroyed.`);
  },
  90_000,
);

it.skipIf(!DATABASE)(
  'destroys a running job machine when its repository is removed',
  async () => {
    const pool = await database();
    const root = await mkdtemp(join(tmpdir(), 'refit-job-machines-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const sample = await approvedRepository(root);
    transport.source = sample.source;
    transport.head = sample.head;
    await (await openHostedStore(pool)).approve(sample.approval, 'octo-reviewer');
    // This machine never reports, like a long validation.
    const control = await service(pool, root, () => undefined);
    await deliver(control.url, 'installation', repositories('created', ['example/application']));
    await until(
      async () => [...control.fake.machines.values()],
      (machines) => machines.length === 1,
    );
    const removed = await deliver(
      control.url,
      'installation_repositories',
      repositories('removed', [], ['example/application']),
    );
    expect(removed.body.cancelled).toHaveLength(1);
    const registry = await until(
      () => status(control.url),
      (value) => value.jobs[0]?.receipt !== null,
    );
    expect(registry.jobs[0]).toMatchObject({
      status: 'cancelled',
      receipt: { status: 'interrupted', message: expect.stringContaining('was cancelled') },
    });
    expect([...control.fake.machines.values()][0].state).toBe('destroyed');
  },
  90_000,
);

it.skipIf(!DATABASE)(
  'after a control crash, reaps the orphaned machine and reruns its job on a new one',
  async () => {
    const pool = await database();
    const root = await mkdtemp(join(tmpdir(), 'refit-job-machines-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const sample = await approvedRepository(root);
    transport.source = sample.source;
    transport.head = sample.head;
    const store = await openHostedStore(pool, TENANCY);
    await store.accept(randomUUID(), 'installation', new TextEncoder().encode('crash'), {
      kind: 'installation',
      installationId: INSTALLATION,
      owner: 'example',
      action: 'created',
      added: [{ id: 789, name: 'example/application' }],
      removed: [],
    });
    expect(await store.approve(sample.approval, 'octo-reviewer')).toHaveLength(1);
    // A control process claims the job, starts its machine and dies without destroying it.
    const crashed = await store.claim('crashed-worker', 3);
    expect(crashed).not.toBeNull();
    const machines: FakeMachine[] = [];
    const control = await service(
      pool,
      root,
      (created) => {
        if (!created.config.env.REFIT_JOB_URL) return;
        machines.push(created);
        void boot(created);
      },
      'restarted-worker',
    );
    const orphan = await control.machines.create({
      region: 'iad',
      image: 'registry.example/refit:job',
      env: {},
      guest: { ...JOB_GUEST },
      metadata: { refit: 'job', refit_job: String(crashed!.job) },
    });
    const stray = await control.machines.create({
      region: 'iad',
      image: 'registry.example/refit:job',
      env: {},
      guest: { ...JOB_GUEST },
      metadata: { refit: 'job', refit_job: '999999' },
    });
    // The restarted control process reaps on its next pass, once the crashed lease has expired.
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    await deliver(
      control.url,
      'installation_repositories',
      repositories('added', ['example/application']),
    );
    const registry = await until(
      () => status(control.url),
      (value) => value.jobs[0]?.status === 'finished',
    );
    expect(registry.jobs[0]).toMatchObject({ id: String(crashed!.job), attempts: 2 });
    expect(control.fake.machines.get(orphan.id)?.state).toBe('destroyed');
    expect(control.fake.machines.get(stray.id)?.state).toBe('destroyed');
    expect(control.progress).toEqual(
      expect.arrayContaining([
        `Destroyed orphaned job machine ${orphan.id}.`,
        `Destroyed orphaned job machine ${stray.id}.`,
      ]),
    );
    expect(machines).toHaveLength(1);
    expect(machines[0].state).toBe('destroyed');
  },
  90_000,
);

it.skipIf(!DATABASE || !process.env.REFIT_DOCKER_IMAGE || !process.env.REFIT_OASDIFF)(
  'validates on a job machine in offline Docker and reuses the carried result on the next job',
  async () => {
    const pool = await database();
    const root = await mkdtemp(join(tmpdir(), 'refit-job-machines-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const sample = await approvedRepository(root);
    transport.source = sample.source;
    transport.head = sample.head;
    await (await openHostedStore(pool)).approve(sample.approval, 'octo-reviewer');
    const control = await service(pool, root, (created) => void boot(created));
    await deliver(control.url, 'installation', repositories('created', ['example/application']));
    let registry = await until(
      () => status(control.url),
      (value) => value.jobs[0]?.status === 'finished',
      120,
    );
    expect(registry.jobs[0]).toMatchObject({
      receipt: { status: 'validated', readiness: 'ready-for-validation', revision: sample.head },
    });
    const report = JSON.parse(
      (await readEvidence(registry.jobs[0].receipt.output, 'report.json'))!,
    );
    expect(report.validation.patched.status).toBe('passed');
    expect((await verifyArtifacts(registry.jobs[0].receipt.output)).status).toBe(
      'integrity-verified',
    );

    // Adding the repository again queues a second job; its machine starts from the carried state.
    await deliver(
      control.url,
      'installation_repositories',
      repositories('added', ['example/application']),
    );
    registry = await until(
      () => status(control.url),
      (value) => value.jobs[1]?.status === 'finished',
      120,
    );
    expect(registry.jobs[1].receipt).toMatchObject({
      status: 'validated',
      message: expect.stringMatching(/^Saved worker result reused; checks were not rerun\./),
      output: registry.jobs[0].receipt.output,
    });
    expect(control.fake.machines.size).toBe(2);
  },
  240_000,
);
