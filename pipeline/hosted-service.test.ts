import { execFile } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { gitEnvironment } from './git-environment.ts';
import { runHostedService } from './hosted-service.ts';
import { hostedTargetId, openHostedStore } from './hosted-store.ts';
import { hostedTenancy, TENANCY_REFUSALS } from './hosted-tenancy.ts';
import {
  approveRepositoryEnrollment,
  inspectRepositoryEnrollment,
  readRepositoryApproval,
} from './repository-enrollment.ts';
import { verifyArtifacts } from './verification.ts';
import { startFakeGitHub } from './fixtures/fake-github.ts';
import { readEvidence } from './state-files.ts';

const transport = vi.hoisted(() => ({
  source: '',
  head: '',
  calls: [] as { binary: string; args: string[] }[],
}));
vi.mock('node:child_process', async (original) =>
  (await import('./fixtures/fake-github-git.ts')).throughFakeGitHub(
    await original(),
    (binary, args) => transport.calls.push({ binary, args }),
  ),
);

const git = (args: string[], cwd: string) =>
  promisify(execFile)('git', args, { cwd, env: gitEnvironment() });
const DATABASE = process.env.REFIT_POSTGRES_URL;
const INSTALLATION = 456;
const WEBHOOK_SECRET = 'webhook-secret-for-hosted-service-tests-123';
const CONTROL_TOKEN = 'control-secret-for-hosted-service-tests-456';
const fixture = resolve('pipeline/fixtures/endpoint-replacement');
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
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
  await git(['add', '.'], transport.source);
  await git(
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
  transport.head = (await git(['rev-parse', 'HEAD'], transport.source)).stdout.trim();
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
  await git(['init', '--quiet', '--initial-branch=main'], transport.source);
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
    const github = await startFakeGitHub({ appId: 123, webhookSecret: WEBHOOK_SECRET });
    cleanups.push(() => github.close());
    vi.stubGlobal('fetch', github.fetch);
    // Both installed repositories are inventoried from the same source; only one is approved.
    const repositories = ['example/application', 'example/unapproved'];
    for (const [index, repository] of repositories.entries())
      await github.publish(repository, transport.source, { id: 789 + index });
    github.installations.set(INSTALLATION, {
      id: INSTALLATION,
      login: 'example',
      repositories,
      suspended: false,
    });
    expect(await (await openHostedStore(pool)).approve(sample.approval, 'octo-reviewer')).toEqual(
      [],
    );
    const controller = new AbortController();
    let ready: (url: string) => void;
    const listening = new Promise<string>((resolve) => (ready = resolve));
    const progress: string[] = [];
    const service = runHostedService({
      database: pool,
      app: github.app,
      directory: join(sample.root, 'hosted-state'),
      webhookSecret: WEBHOOK_SECRET,
      controlToken: CONTROL_TOKEN,
      tenancy: hostedTenancy({ REFIT_HOSTED_OWNER: 'Example' }),
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
    expect(foreign.body).toMatchObject({ status: 'not-allowed', enrolled: [] });

    let registry = await status(url);
    for (
      const deadline = Date.now() + 90_000;
      (registry.jobs[0]?.status !== 'finished' ||
        registry.installations[0]?.inventoriesToday !== repositories.length) &&
      Date.now() < deadline;
      registry = await status(url)
    )
      await new Promise((resolve) => setTimeout(resolve, 250));
    console.log(progress.join('\n'));
    expect(registry.installations).toEqual([
      {
        id: String(INSTALLATION),
        owner: 'example',
        status: 'active',
        allowed: true,
        repositories: ['example/application', 'example/unapproved'],
        jobsToday: 1,
        inventoriesToday: repositories.length,
        refusals: [],
      },
      {
        id: '999',
        owner: 'someone-else',
        status: 'active',
        allowed: false,
        repositories: ['someone-else/application'],
        jobsToday: 0,
        inventoriesToday: 0,
        refusals: [TENANCY_REFUSALS.notAllowed],
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
    const report = JSON.parse((await readEvidence(job.receipt.output, 'report.json'))!);
    expect(report.validation.baseline.status).toBe('passed');
    expect(report.validation.patched.status).toBe('passed');
    expect(report.patch.generator).toBe('deterministic');
    expect((await verifyArtifacts(job.receipt.output)).status).toBe('integrity-verified');
    expect(transport.calls.some((call) => call.binary === 'docker')).toBe(true);
    expect(github.issued().length).toBeGreaterThan(0);
    expect(
      transport.calls.every((call) =>
        github.issued().every((token) => !call.args.join(' ').includes(token)),
      ),
    ).toBe(true);
    // Installation tokens only read both installed repositories and their base branch.
    const reads = github.requests.filter(
      ({ path }) => path.startsWith('/repos/') && !path.endsWith('/installation'),
    );
    expect(reads.length).toBeGreaterThan(0);
    for (const { method, path } of reads) {
      expect(method).toBe('GET');
      expect(path).toMatch(
        /^\/repos\/example\/(?:application|unapproved)(?:\/git\/ref\/heads\/main)?$/,
      );
    }
    // No credential reaches the evidence, managed checkouts or receipts the worker keeps on disk.
    const kept = await readdir(join(sample.root, 'hosted-state'), {
      withFileTypes: true,
      recursive: true,
    });
    const stored = await Promise.all(
      kept
        .filter((entry) => entry.isFile())
        .map((entry) => readFile(join(entry.parentPath, entry.name))),
    );
    expect(stored.length).toBeGreaterThan(0);
    for (const secret of [WEBHOOK_SECRET, CONTROL_TOKEN, ...github.issued()])
      expect(stored.some((content) => content.includes(secret))).toBe(false);

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

it.skipIf(!DATABASE || !process.env.REFIT_DOCKER_IMAGE)(
  "reuses an unchanged target's receipt on a scheduled poll without fetching, scanning or using the daily cap",
  async () => {
    const pool = await database();
    const sample = await approvedRepository();
    const github = await startFakeGitHub({ appId: 123, webhookSecret: WEBHOOK_SECRET });
    cleanups.push(() => github.close());
    vi.stubGlobal('fetch', github.fetch);
    await github.publish('example/application', transport.source, { id: 789 });
    github.installations.set(INSTALLATION, {
      id: INSTALLATION,
      login: 'example',
      repositories: ['example/application'],
      suspended: false,
    });
    const store = await openHostedStore(pool, hostedTenancy({ REFIT_HOSTED_OWNER: 'example' }));
    await store.approve(sample.approval, 'octo-reviewer');
    const target = hostedTargetId('example/application', 'main');
    const progress: string[] = [];
    // Runs one worker with the given build until the target has `jobs` ended jobs.
    const serve = async (build: string, jobs: number) => {
      const controller = new AbortController();
      let ready: (url: string) => void;
      const listening = new Promise<string>((resolve) => (ready = resolve));
      const service = runHostedService({
        database: pool,
        app: github.app,
        directory: join(sample.root, 'hosted-state'),
        webhookSecret: WEBHOOK_SECRET,
        controlToken: CONTROL_TOKEN,
        tenancy: hostedTenancy({ REFIT_HOSTED_OWNER: 'example' }),
        build,
        host: '127.0.0.1',
        port: 0,
        intervalSeconds: 3600,
        leaseSeconds: 30,
        worker: 'test-worker',
        signal: controller.signal,
        onReady: (url) => ready(url),
        onProgress: (message) => progress.push(message),
      });
      try {
        const url = await listening;
        if (jobs === 1)
          await deliver(
            url,
            'installation',
            installationPayload('created', ['example/application']),
          );
        let registry = await store.read();
        for (
          const deadline = Date.now() + 60_000;
          registry.jobs.filter((job) => job.finishedAt).length < jobs && Date.now() < deadline;
          registry = await store.read()
        )
          await new Promise((resolve) => setTimeout(resolve, 250));
        return registry;
      } finally {
        controller.abort();
        await service;
      }
    };

    const first = await serve('registry.fly.io/refit-hosted:deployment-1', 1);
    console.log(progress.join('\n'));
    expect(first.jobs).toHaveLength(1);
    const ran = first.jobs[0].receipt;
    expect(ran).toMatchObject({
      status: 'validated',
      readiness: 'ready-for-validation',
      revision: transport.head,
      fingerprint: sample.approval.fingerprint,
      liveContract: false,
      build: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(transport.calls.some((call) => call.binary === 'docker')).toBe(true);

    // The next scheduled poll finds the same commit, approval and build: nothing is fetched or run,
    // and the poll gives its job reservation back.
    transport.calls = [];
    expect(await store.enqueueDue(0)).toBe(1);
    const second = await serve('registry.fly.io/refit-hosted:deployment-1', 2);
    console.log(progress.join('\n'));
    expect(second.jobs[1]).toMatchObject({
      status: 'finished',
      receipt: {
        ...ran,
        message: `Reused the receipt of job ${first.jobs[0].id}: same commit, approval and worker build, so nothing ran. ${ran.message}`,
        unchangedSince: Number(first.jobs[0].id),
      },
    });
    // The fake GitHub API answers the branch-head read from its own bare repository.
    expect(transport.calls.filter((call) => !call.args[1]?.includes('refit-fake-github-'))).toEqual(
      [],
    );
    expect(second.installations[0].jobsToday).toBe(1);
    expect(progress).toContain(
      `validated: unchanged since job ${first.jobs[0].id} at ${transport.head.slice(0, 12)}; nothing ran.`,
    );

    // A new worker build runs the poll again; the watch state still knows the job.
    expect(await store.enqueueDue(0)).toBe(1);
    const third = await serve('registry.fly.io/refit-hosted:deployment-2', 3);
    expect(third.jobs[2].receipt).toMatchObject({
      status: 'validated',
      // The reused job keeps its reason, as a reused stop does.
      message:
        'Saved worker result reused; checks were not rerun. That run recorded: Baseline and patched checks passed. Review artifacts are ready; publication was not requested.',
      revision: transport.head,
    });
    expect(third.jobs[2].receipt.unchangedSince).toBeUndefined();
    expect(third.jobs[2].receipt.build).not.toBe(ran.build);
    expect(transport.calls.some((call) => call.binary === 'git')).toBe(true);
    expect(third.installations[0].jobsToday).toBe(2);

    // An operator retry always runs, even when nothing changed.
    transport.calls = [];
    await store.retry(target);
    const fourth = await serve('registry.fly.io/refit-hosted:deployment-2', 4);
    expect(fourth.jobs[3]).toMatchObject({ retry: true, status: 'finished' });
    expect(fourth.jobs[3].receipt.unchangedSince).toBeUndefined();
    expect(transport.calls.some((call) => call.binary === 'git')).toBe(true);
  },
  180_000,
);

it.skipIf(!DATABASE)(
  'leases jobs durably, stops a running job on repository removal and keeps its evidence as cancelled',
  async () => {
    const pool = await database();
    const sample = await approvedRepository();
    const store = await openHostedStore(pool, hostedTenancy({ REFIT_HOSTED_OWNER: 'example' }));
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

it.skipIf(!DATABASE)(
  'queues one operator retry per enrolled target and hands the retry flag to the claiming worker',
  async () => {
    const pool = await database();
    const sample = await approvedRepository();
    const store = await openHostedStore(pool, hostedTenancy({ REFIT_HOSTED_OWNER: 'example' }));
    const target = hostedTargetId('example/application', 'main');
    const change = (action: string, added: string[], removed: string[] = []) => ({
      kind: 'repositories' as const,
      installationId: 456,
      owner: 'example',
      action,
      added: added.map((name) => ({ id: 789, name })),
      removed: removed.map((name) => ({ id: 789, name })),
    });
    const body = (value: string) => new TextEncoder().encode(value);
    await expect(store.retry(target)).rejects.toThrow(`No enrolled hosted target ${target}.`);
    await store.approve(sample.approval, 'octo-reviewer');
    await store.accept(
      randomUUID(),
      'installation_repositories',
      body('a'),
      change('added', ['example/application']),
    );

    // The enrollment job is still queued, so retry marks it instead of queueing a second job.
    const queued = await store.retry(target);
    const first = await store.claim('worker-a', 30);
    expect(first).toMatchObject({ job: queued, retry: true, target: { id: target } });
    await expect(store.retry(target)).rejects.toThrow('has a running job');
    await store.finish(first!.job, 'worker-a', 'finished', {
      status: 'error',
      output: null,
      message: 'boom',
    });

    expect(await store.enqueueDue(0)).toBe(1);
    const scheduled = await store.claim('worker-a', 30);
    expect(scheduled).toMatchObject({ retry: false });
    await store.finish(scheduled!.job, 'worker-a', 'finished', {
      status: 'error',
      output: null,
      message: 'boom',
    });
    const retried = await store.retry(target);
    expect(retried).toBeGreaterThan(scheduled!.job);
    expect(await store.claim('worker-b', 30)).toMatchObject({ job: retried, retry: true });
    expect((await store.read()).jobs.map((job) => job.retry)).toEqual([true, false, true]);

    await store.accept(
      randomUUID(),
      'installation_repositories',
      body('b'),
      change('removed', [], ['example/application']),
    );
    await expect(store.retry(target)).rejects.toThrow(`No enrolled hosted target ${target}.`);
  },
  30_000,
);
