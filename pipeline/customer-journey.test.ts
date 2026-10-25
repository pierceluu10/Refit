import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { startFakeGitHub, type FakeGitHub } from './fixtures/fake-github.ts';
import { runHostedService } from './hosted-service.ts';
import { hostedTargetId } from './hosted-store.ts';
import { hostedTenancy } from './hosted-tenancy.ts';
import {
  approveRepositoryEnrollment,
  inspectRepositoryEnrollment,
} from './repository-enrollment.ts';
import { verifyArtifacts } from './verification.ts';
import { readEvidence } from './state-files.ts';

vi.mock('node:child_process', async (original) =>
  (await import('./fixtures/fake-github-git.ts')).throughFakeGitHub(await original()),
);

const execute = promisify(execFile);
const DATABASE = process.env.REFIT_TEST_DATABASE_URL ?? process.env.REFIT_POSTGRES_URL;
const IMAGE = process.env.REFIT_DOCKER_IMAGE;
const SKIPPED =
  'Set REFIT_TEST_DATABASE_URL (a disposable PostgreSQL database) and REFIT_DOCKER_IMAGE=node:22-alpine (pulled locally) to run the customer journey.';
const APP_ID = 123;
const OWNER = 'example';
const APPROVED = 'example/billing';
const UNAPPROVED = 'example/storefront';
const WEBHOOK_SECRET = 'webhook-secret-for-the-customer-journey-123';
const CONTROL_TOKEN = 'control-secret-for-the-customer-journey-456';
const POLL_MS = 250;
const WAIT_MS = 240_000;
// No scheduled polls during the journey: every job comes from a webhook or a worker starting.
const INTERVAL_SECONDS = 3600;
const LEASE_SECONDS = 60;
// The killed worker's lease, short so that it lapses soon after the kill.
const KILLED_LEASE_SECONDS = 5;
const fixture = resolve('pipeline/fixtures/customer-journey/repository');
const workerScript = resolve('pipeline/fixtures/fake-github-worker.ts');
const isolated = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// Each run gets its own schema, also reachable by the CLI through the URL's search_path.
async function database() {
  const schema = `refit_journey_${randomBytes(6).toString('hex')}`;
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

// The Stripe fixture with the customer's committed .refit.json, as a Git working copy.
async function repository(root: string, name: string) {
  const source = join(root, name);
  await cp(fixture, source, { recursive: true });
  await writeFile(
    join(source, '.refit.json'),
    JSON.stringify({
      formatVersion: 1,
      before: './contracts/stripe-before.json',
      after: './contracts/stripe-after.json',
      apiVersion: '2022-08-01',
      image: IMAGE,
      baselineCommand: ['node', '--experimental-strip-types', 'simulator/check.mjs', 'before'],
      command: ['node', '--experimental-strip-types', 'simulator/check.mjs', 'after'],
    }),
  );
  const git = (args: string[]) => execute('git', ['-C', source, ...args], { env: isolated });
  await git(['init', '--quiet', '--initial-branch=main']);
  await git(['add', '.']);
  await git([
    '-c',
    'user.name=Refit Tests',
    '-c',
    'user.email=tests@refit.local',
    'commit',
    '--quiet',
    '-m',
    'feat: read charge history',
  ]);
  return source;
}

function refit(url: string, args: string[]) {
  return execute(process.execPath, [resolve('bin/refit.mjs'), 'hosted', ...args], {
    env: { ...process.env, REFIT_DATABASE_URL: url },
  });
}

// The customer's repositories on the fake GitHub, and the operator's approval of one of them: they
// review the committed configuration with refit enroll and store its receipt with the CLI.
async function customer() {
  const root = await mkdtemp(join(tmpdir(), 'refit-journey-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const { pool, url } = await database();
  const github = await startFakeGitHub({ appId: APP_ID, webhookSecret: WEBHOOK_SECRET });
  cleanups.push(() => github.close());
  vi.stubGlobal('fetch', github.fetch);
  const head = await github.publish(APPROVED, await repository(root, 'billing'));
  await github.publish(UNAPPROVED, await repository(root, 'storefront'));
  const enrollment = await inspectRepositoryEnrollment({
    repository: join(root, 'billing'),
    github: APPROVED,
    base: 'main',
  });
  const receipt = join(root, 'approval.json');
  await approveRepositoryEnrollment({
    enrollment,
    fingerprint: enrollment.fingerprint,
    output: receipt,
  });
  await refit(url, ['approve', '--approval', receipt, '--approved-by', 'octo-operator']);
  return { root, pool, url, github, head };
}

async function serve(pool: pg.Pool, github: FakeGitHub, directory: string, worker: string) {
  const controller = new AbortController();
  let ready: (url: string) => void;
  const listening = new Promise<string>((resolve) => (ready = resolve));
  const progress: string[] = [];
  const service = runHostedService({
    database: pool,
    app: github.app,
    directory,
    webhookSecret: WEBHOOK_SECRET,
    controlToken: CONTROL_TOKEN,
    tenancy: hostedTenancy({ REFIT_HOSTED_OWNER: OWNER }),
    host: '127.0.0.1',
    port: 0,
    intervalSeconds: INTERVAL_SECONDS,
    leaseSeconds: LEASE_SECONDS,
    worker,
    signal: controller.signal,
    onReady: (url) => ready(url),
    onProgress: (message) => progress.push(message),
  });
  const stop = async () => {
    controller.abort();
    await service.catch(() => undefined);
  };
  cleanups.push(stop);
  const url = await listening;
  async function status() {
    const response = await fetch(`${url}/status`, {
      headers: { Authorization: `Bearer ${CONTROL_TOKEN}` },
    });
    expect(response.status).toBe(200);
    return response.json();
  }
  // Polls /status until the condition holds; fails with the last status and the worker's progress.
  async function until(description: string, condition: (registry: any) => boolean) {
    const deadline = Date.now() + WAIT_MS;
    for (let registry = await status(); ; registry = await status()) {
      if (condition(registry)) return registry;
      if (Date.now() > deadline)
        throw new Error(
          `Timed out waiting until ${description}.\n${JSON.stringify(registry, null, 2)}\n${progress.join('\n')}`,
        );
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
  return { url, progress, status, until, stop };
}

// A worker in its own process (fixtures/fake-github-worker.ts), so it can be killed mid-job.
async function workerProcess(databaseUrl: string, github: FakeGitHub, directory: string) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      workerScript,
      github.url,
      JSON.stringify({
        database: databaseUrl,
        owner: OWNER,
        app: github.app,
        directory,
        webhookSecret: WEBHOOK_SECRET,
        controlToken: CONTROL_TOKEN,
        intervalSeconds: INTERVAL_SECONDS,
        leaseSeconds: KILLED_LEASE_SECONDS,
        worker: 'journey-worker-killed',
      }),
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const exited = once(child, 'exit');
  const kill = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  };
  cleanups.push(kill);
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const output: string[] = [];
  // The worker's next output line that matches; fails if the worker exits first.
  async function reached(pattern: RegExp) {
    for (let next = await lines.next(); !next.done; next = await lines.next()) {
      output.push(next.value);
      if (pattern.test(next.value)) return next.value;
    }
    throw new Error(`The worker process exited before printing ${pattern}:\n${output.join('\n')}`);
  }
  const url = (await reached(/^ready /)).slice('ready '.length);
  return { url, reached, kill };
}

const finished = (registry: any, count: number) =>
  registry.jobs.length === count &&
  registry.jobs.every((candidate: any) => candidate.status === 'finished');

async function expectValidated(output: string) {
  const report = JSON.parse((await readEvidence(output, 'report.json'))!);
  expect(report.patch.generator).toBe('deterministic');
  expect(report.validation.baseline.status).toBe('passed');
  expect(report.validation.patched.status).toBe('passed');
  expect((await verifyArtifacts(output)).status).toBe('integrity-verified');
}

// Every request, refused ones included: each token asks for contents read only (or metadata read
// only, to reconcile the installation's repository list), and nothing else writes (no issue,
// comment, branch, push or pull request). Git fetches POST to git-upload-pack.
function expectReadOnly(github: FakeGitHub) {
  const tokens = github.requests.filter(({ path }) => path.endsWith('/access_tokens'));
  expect(tokens.length, 'Refit asked for installation tokens').toBeGreaterThan(0);
  for (const token of tokens)
    expect(
      [{ contents: 'read' }, { metadata: 'read' }],
      `${token.method} ${token.path}`,
    ).toContainEqual(token.body?.permissions);
  expect(
    github.requests.filter(
      ({ method, path }) =>
        method !== 'GET' && !path.endsWith('/access_tokens') && !path.endsWith('/git-upload-pack'),
    ),
    'Refit writes nothing to the customer’s repositories',
  ).toEqual([]);
}

it('drives the hosted worker through a customer install, offline validation, removal, reinstall and uninstall', async (context) => {
  context.skip(!DATABASE || !IMAGE, SKIPPED);
  const { root, pool, github, head } = await customer();
  const target = hostedTargetId(APPROVED, 'main');
  const hosted = await serve(pool, github, join(root, 'hosted-state'), 'journey-worker');

  // 1. Install: the customer installs the App on both repositories; only the approved one enrolls.
  const installed = await github.install(hosted.url, {
    id: 456,
    login: OWNER,
    repositories: [APPROVED, UNAPPROVED],
  });
  expect(installed).toMatchObject({ status: 202, body: { enrolled: [target] } });

  // 2–5. Doctor, scan, offline Docker validation and the receipt, all from one job.
  const validated = await hosted.until(
    'the job has a receipt and both repositories are inventoried',
    (registry) =>
      finished(registry, 1) &&
      registry.inventories.length === 2 &&
      registry.inventories.every((row: any) => row.status === 'complete'),
  );
  // Both installed repositories get a read-only inventory; only the approved one has a target.
  expect(validated.inventories.map((row: any) => row.repository).sort()).toEqual([
    APPROVED,
    UNAPPROVED,
  ]);
  expect(validated.targets).toEqual([
    expect.objectContaining({ id: target, repository: APPROVED, status: 'enrolled' }),
  ]);
  expect(validated.jobs).toHaveLength(1);
  const [job] = validated.jobs;
  expect(job).toMatchObject({
    targetId: target,
    attempts: 1,
    receipt: { status: 'validated', readiness: 'ready-for-validation', revision: head },
  });
  await expectValidated(job.receipt.output);
  expectReadOnly(github);

  // 6. A redelivered installation webhook is a duplicate and changes nothing.
  const duplicate = await github.redeliver(hosted.url, installed.delivery);
  expect(duplicate).toMatchObject({ status: 202, body: { status: 'duplicate', enrolled: [] } });
  expect((await hosted.status()).jobs).toEqual(validated.jobs);

  // 7. The customer removes the approved repository from the installation: its target is cancelled.
  const removed = await github.changeRepositories(hosted.url, 456, 'removed', [APPROVED]);
  expect(removed).toMatchObject({ status: 202, body: { cancelled: [target] } });
  expect((await hosted.status()).targets).toEqual([
    expect.objectContaining({ id: target, status: 'cancelled' }),
  ]);

  // 8. Reinstall: the customer uninstalls and installs the App again, which GitHub gives a new
  // installation ID. The approved repository enrolls again and gets a second receipt.
  expect(await github.uninstall(hosted.url, 456)).toMatchObject({ status: 202 });
  const reinstalled = await github.install(hosted.url, {
    id: 457,
    login: OWNER,
    repositories: [APPROVED, UNAPPROVED],
  });
  expect(reinstalled).toMatchObject({ status: 202, body: { enrolled: [target] } });
  const resumed = await hosted.until('the reinstalled target has a second receipt', (registry) =>
    finished(registry, 2),
  );
  expect(resumed.targets).toEqual([
    expect.objectContaining({ id: target, status: 'enrolled', installationId: '457' }),
  ]);
  expect(resumed.jobs.map((candidate: any) => candidate.receipt.revision)).toEqual([head, head]);

  // 9. Uninstall: everything stops and nothing stays queued.
  const uninstalled = await github.uninstall(hosted.url, 457);
  expect(uninstalled).toMatchObject({ status: 202, body: { cancelled: [target] } });
  const settled = await hosted.until(
    'nothing is queued or running',
    (registry) =>
      registry.jobs.every((candidate: any) => !['queued', 'running'].includes(candidate.status)) &&
      registry.inventories.every((row: any) => row.state !== 'queued' && row.state !== 'running'),
  );
  expect(settled.targets).toEqual([expect.objectContaining({ id: target, status: 'cancelled' })]);
  expectReadOnly(github);
  // Any request after the uninstall, refused or not, would show up here.
  const seen = github.requests.length;
  await new Promise((resolve) => setTimeout(resolve, 3 * 1000));
  expect(github.requests.slice(seen), 'no GitHub request after uninstall').toEqual([]);
}, 600_000);

it('reclaims a killed worker’s job after its lease lapses, and validates it again on `refit hosted retry`', async (context) => {
  context.skip(!DATABASE || !IMAGE, SKIPPED);
  const { root, pool, url, github, head } = await customer();
  const target = hostedTargetId(APPROVED, 'main');
  // Every worker shares one state directory, as a restarted machine keeps its volume.
  const directory = join(root, 'hosted-state');

  // 1. A worker in its own process takes the install's job and is killed once the migration starts.
  const killed = await workerProcess(url, github, directory);
  const installed = await github.install(killed.url, {
    id: 456,
    login: OWNER,
    repositories: [APPROVED],
  });
  expect(installed).toMatchObject({ status: 202, body: { enrolled: [target] } });
  await killed.reached(/processing \w+ migration/);
  await killed.kill();

  // 2. Its lease lapses without renewal, and the next worker reclaims the job. The killed run left
  // no evidence, so the job finishes as interrupted; the checks do not run again unasked.
  for (const deadline = Date.now() + WAIT_MS; ;) {
    const { rows } = await pool.query<{ expired: boolean }>(
      `SELECT lease_expires_at < now() AS expired FROM refit_jobs WHERE status = 'running'`,
    );
    if (rows[0]?.expired) break;
    if (Date.now() > deadline)
      throw new Error(`The killed worker's lease did not lapse: ${JSON.stringify(rows)}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  const second = await serve(pool, github, directory, 'journey-worker-second');
  const reclaimed = await second.until('the reclaimed job finishes', (registry) =>
    finished(registry, 1),
  );
  expect(reclaimed.jobs).toEqual([
    expect.objectContaining({
      targetId: target,
      attempts: 2,
      retry: false,
      receipt: expect.objectContaining({ status: 'interrupted' }),
    }),
  ]);

  // 3. The operator retries with the CLI. A worker takes the retry at its next poll (here a
  // restart, which polls at once) and runs the checks again on the same revision.
  await second.stop();
  const { stdout } = await refit(url, ['retry', '--target', target]);
  expect(stdout).toMatch(/^Queued retry job \d+ for /);
  expect(stdout).toContain(`for ${target}.`);
  const third = await serve(pool, github, directory, 'journey-worker-third');
  const retried = await third.until('the retry has a receipt', (registry) => finished(registry, 2));
  const retry = retried.jobs[1];
  expect(retry).toMatchObject({
    targetId: target,
    attempts: 1,
    retry: true,
    receipt: { status: 'validated', revision: head },
  });
  await expectValidated(retry.receipt.output);
  expectReadOnly(github);
}, 600_000);
