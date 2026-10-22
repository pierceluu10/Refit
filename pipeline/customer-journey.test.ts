import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
const fixture = resolve('pipeline/fixtures/customer-journey/repository');
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

async function serve(pool: pg.Pool, github: FakeGitHub, directory: string) {
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
    // No scheduled polls during the journey: every job comes from a webhook.
    intervalSeconds: 3600,
    leaseSeconds: 60,
    worker: 'journey-worker',
    signal: controller.signal,
    onReady: (url) => ready(url),
    onProgress: (message) => progress.push(message),
  });
  cleanups.push(async () => {
    controller.abort();
    await service.catch(() => undefined);
  });
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
    const deadline = Date.now() + 240_000;
    for (let registry = await status(); ; registry = await status()) {
      if (condition(registry)) return registry;
      if (Date.now() > deadline)
        throw new Error(
          `Timed out waiting until ${description}.\n${JSON.stringify(registry, null, 2)}\n${progress.join('\n')}`,
        );
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
  return { url, progress, status, until };
}

it('drives the hosted worker through a customer install, offline validation, removal, reinstall and uninstall', async (context) => {
  context.skip(!DATABASE || !IMAGE, SKIPPED);
  const root = await mkdtemp(join(tmpdir(), 'refit-journey-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const { pool, url: databaseUrl } = await database();
  const github = await startFakeGitHub({ appId: APP_ID, webhookSecret: WEBHOOK_SECRET });
  cleanups.push(() => github.close());
  vi.stubGlobal('fetch', github.fetch);
  const head = await github.publish(APPROVED, await repository(root, 'billing'));
  await github.publish(UNAPPROVED, await repository(root, 'storefront'));
  const target = hostedTargetId(APPROVED, 'main');

  // The operator reviews the customer's configuration and approves one repository with the CLI.
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
  const hosted = await serve(pool, github, join(root, 'hosted-state'));
  await refit(databaseUrl, ['approve', '--approval', receipt, '--approved-by', 'octo-operator']);

  // 1. Install: the customer installs the App on both repositories; only the approved one enrolls.
  const installed = await github.install(hosted.url, {
    id: 456,
    login: OWNER,
    repositories: [APPROVED, UNAPPROVED],
  });
  expect(installed).toMatchObject({ status: 202, body: { enrolled: [target] } });

  // 2–5. Doctor, scan, offline Docker validation and the receipt, all from one job.
  const finished = (registry: any, count: number) =>
    registry.jobs.length === count &&
    registry.jobs.every((candidate: any) => candidate.status === 'finished');
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
  const report = JSON.parse(await readFile(join(job.receipt.output, 'report.json'), 'utf8'));
  expect(report.patch.generator).toBe('deterministic');
  expect(report.validation.baseline.status).toBe('passed');
  expect(report.validation.patched.status).toBe('passed');
  expect((await verifyArtifacts(job.receipt.output)).status).toBe('integrity-verified');
  expect(hosted.progress.join('\n')).toMatch(/doctor/i);
  // Nothing was written to GitHub: the App only minted read tokens.
  expect(
    github.writes.filter(({ path }) => !path.endsWith('/access_tokens')),
    'Refit writes nothing to the customer’s repositories',
  ).toEqual([]);

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
  console.log(JSON.stringify(resumed, null, 2));
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
  const tokens = github.writes.length;
  await new Promise((resolve) => setTimeout(resolve, 3 * 1000));
  expect(github.writes, 'no GitHub access after uninstall').toHaveLength(tokens);
}, 600_000);
