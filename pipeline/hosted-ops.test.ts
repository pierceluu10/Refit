import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import {
  checkHostedHealth,
  failedJobNotifier,
  hostedRedactor,
  filterHostedStatus,
  hostedLogging,
  JOBS_SHOWN,
  listHostedJobs,
  listHostedTargets,
  readHostedReceipt,
} from './hosted-ops.ts';
import { hostedTargetId, openHostedStore } from './hosted-store.ts';
import type { RepositoryApproval } from './repository-enrollment.ts';

const execute = promisify(execFile);
const DATABASE = process.env.REFIT_POSTGRES_URL;
const IMAGE = process.env.REFIT_DOCKER_IMAGE;
const bin = resolve('bin/refit.mjs');
const PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAtestkeymaterial0123456789abcdef\nZZZsecondlineofkeymaterial9876543210\n-----END RSA PRIVATE KEY-----`;
const SECRETS = {
  GITHUB_APP_PRIVATE_KEY: PRIVATE_KEY,
  REFIT_WEBHOOK_SECRET: 'webhook-secret-for-hosted-ops-tests-0123456789',
  REFIT_SERVICE_TOKEN: 'control-secret-for-hosted-ops-tests-9876543210',
  REFIT_DATABASE_URL:
    'postgresql://refit_hosted.project:p%40ss-w0rd-value@db.example.invalid:5432/postgres',
  OPENAI_API_KEY: 'sk-proj-openaitestkey0123456789abcdefghij',
  REFIT_SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T0000/B0000/slackpathsecret123',
};
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
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
  const url = new URL(DATABASE!);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return { pool, url: url.href };
}

function approval(repository: string, integrations?: string[]): RepositoryApproval {
  return {
    formatVersion: integrations ? 2 : 1,
    ...(integrations ? { integrations } : {}),
    kind: 'refit-repository-approval',
    repository,
    base: 'main',
    fingerprint: randomBytes(32).toString('hex'),
    files: [],
    reviewedRevision: 'a'.repeat(40),
    approvedAt: '2026-10-22T00:00:00.000Z',
  };
}

// Two approved, installed repositories: one plain target and one Stripe integration target.
async function installedStore(pool: pg.Pool) {
  const store = await openHostedStore(pool);
  await store.approve(approval('example/application'), 'octo-reviewer');
  await store.approve(approval('example/billing', ['stripe']), 'octo-reviewer');
  // Separate deliveries keep job ids in a known order: the application's job comes first.
  for (const [id, name] of [
    [789, 'example/application'],
    [790, 'example/billing'],
  ] as const)
    await store.accept(randomUUID(), 'installation_repositories', new TextEncoder().encode(name), {
      kind: 'repositories',
      installationId: 456,
      owner: 'example',
      action: 'added',
      added: [{ id, name }],
      removed: [],
    });
  return {
    store,
    application: hostedTargetId('example/application', 'main'),
    billing: hostedTargetId('example/billing', 'main', 'stripe'),
  };
}

async function refit(args: string[], env: NodeJS.ProcessEnv) {
  try {
    const { stdout, stderr } = await execute(process.execPath, [bin, ...args], {
      env: { PATH: process.env.PATH, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
}

function expectNoSecrets(text: string) {
  const password = 'p%40ss-w0rd-value';
  for (const secret of [
    ...Object.values(SECRETS),
    password,
    decodeURIComponent(password),
    'MIIEowIBAAKCAQEAtestkeymaterial0123456789abcdef',
    'ghs_installationtoken0123456789abcdefghij',
    'bearertokenvalue0123456789',
  ])
    expect(text).not.toContain(secret);
}

it('writes one redacted JSON object per log line with job, target and installation ids', () => {
  const lines: string[] = [];
  const { log } = hostedLogging(SECRETS, (line) => lines.push(line));
  const leaks = [
    ...Object.values(SECRETS),
    'p@ss-w0rd-value',
    'p%40ss-w0rd-value',
    'git remote https://x-access-token:ghs_installationtoken0123456789abcdefghij@github.com/a/b',
    'Authorization: Bearer bearertokenvalue0123456789',
    `fragment ${PRIVATE_KEY.split('\n').slice(0, 2).join('\n')}`,
  ];
  for (const leak of leaks)
    log(`failed with ${leak}`, { job: 7, target: 'abc123', installation: 456 });
  log('Webhook processing failed', { level: 'error', delivery: 'd-1', installation: 456 });
  console.log(lines.join('\n'));
  expect(lines).toHaveLength(leaks.length + 1);
  for (const line of lines) expectNoSecrets(line);
  const entries = lines.map((line) => JSON.parse(line));
  expect(entries[0]).toEqual({
    time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    level: 'info',
    message: 'failed with [redacted]',
    job: 7,
    target: 'abc123',
    installation: 456,
  });
  expect(entries.at(-1)).toMatchObject({ level: 'error', delivery: 'd-1', installation: 456 });
  for (const entry of entries.slice(0, leaks.length))
    expect(entry.message).toMatch(/^failed with .*\[redacted\]/s);
  // A short or empty variable never turns ordinary words into redactions.
  const short: string[] = [];
  hostedLogging({ REFIT_SERVICE_TOKEN: 'job', OPENAI_API_KEY: '' }, (line) => short.push(line)).log(
    'job finished',
  );
  expect(JSON.parse(short[0]).message).toBe('job finished');
});

it('redacts Slack notices and logs a failed send as a redacted JSON error line', async () => {
  const lines: string[] = [];
  const bodies: string[] = [];
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementationOnce(async (_url, init) => {
      bodies.push(String(init?.body));
      return new Response('ok');
    })
    .mockRejectedValueOnce(new Error(`request to ${SECRETS.REFIT_SLACK_WEBHOOK_URL} failed`));
  const { notify } = hostedLogging(SECRETS, (line) => lines.push(line));
  await notify!(`job failed: ${SECRETS.OPENAI_API_KEY}`);
  await notify!('second notice');
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(bodies[0])).toEqual({ text: 'job failed: [redacted]' });
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0])).toMatchObject({
    level: 'error',
    message: 'Slack notification not sent: request to [redacted] failed.',
  });
  expectNoSecrets([...bodies, ...lines].join('\n'));
  expect(hostedLogging({}).notify).toBeUndefined();
});

it('narrows status to one target, its installation and its jobs', () => {
  const registry = {
    installations: [{ id: '1' }, { id: '2' }],
    targets: [
      { id: 'a', installationId: '1' },
      { id: 'b', installationId: '2' },
    ],
    jobs: [{ targetId: 'a' }, { targetId: 'b' }, { targetId: 'b' }],
  };
  expect(filterHostedStatus(registry, new URLSearchParams())).toBe(registry);
  expect(filterHostedStatus(registry, new URLSearchParams('target=b'))).toEqual({
    installations: [{ id: '2' }],
    targets: [{ id: 'b', installationId: '2' }],
    jobs: [{ targetId: 'b' }, { targetId: 'b' }],
  });
  expect(() => filterHostedStatus(registry, new URLSearchParams('target=c'))).toThrow(
    expect.objectContaining({ status: 404 }),
  );
  for (const query of ['status=failed', 'target=a&target=b'])
    expect(() => filterHostedStatus(registry, new URLSearchParams(query))).toThrow(
      expect.objectContaining({ status: 400 }),
    );
});

it('reports unreachable PostgreSQL and Docker as failed health checks', async () => {
  vi.stubEnv('DOCKER_HOST', 'unix:///nonexistent/refit-health-test.sock');
  const pool = new pg.Pool({
    connectionString: 'postgres://refit:unused@127.0.0.1:1/refit',
    connectionTimeoutMillis: 2_000,
  });
  cleanups.push(() => pool.end());
  const checks = await checkHostedHealth(pool, ['node:22-alpine']);
  console.log(checks);
  expect(checks.map(({ check, status }) => [check, status])).toEqual([
    ['postgres', 'failed'],
    ['schema', 'failed'],
    ['docker', 'failed'],
    ['images', 'failed'],
  ]);
  expect(checks[0].detail).toMatch(/ECONNREFUSED|connect/);
  expect(checks[3].detail).toBe('Not checked: Docker is unreachable.');
});

it.skipIf(!DATABASE)(
  'lists jobs with filters, prints receipts with evidence paths and summarizes targets',
  async () => {
    const { pool, url } = await database();
    const { store, application, billing } = await installedStore(pool);
    const evidence = await mkdtemp(join(tmpdir(), 'refit-hosted-evidence-'));
    cleanups.push(() => rm(evidence, { recursive: true, force: true }));
    await writeFile(join(evidence, 'report.json'), '{}');
    await writeFile(join(evidence, 'manifest.json'), '{}');

    const first = await store.claim('worker-a', 30);
    expect(first?.target.id).toBe(application);
    await store.finish(first!.job, 'worker-a', 'failed', {
      status: 'error',
      output: evidence,
      message: 'Error: boom',
    });
    const second = await store.claim('worker-a', 30);
    expect(second?.target.id).toBe(billing);
    await store.finish(second!.job, 'worker-a', 'finished', {
      status: 'validated',
      output: '/data/state/targets/missing/runs/1',
      message: 'Validated.',
      revision: 'b'.repeat(40),
      readiness: 'ready-for-validation',
    });
    const retried = await store.retry(application);

    const all = await listHostedJobs(pool, {});
    expect(all.total).toBe(3);
    expect(all.jobs.map((job) => [job.id, job.status, job.outcome])).toEqual([
      [String(retried), 'queued', null],
      [String(second!.job), 'finished', 'validated'],
      [String(first!.job), 'failed', 'error'],
    ]);
    expect(all.jobs[0]).toMatchObject({ targetId: application, retry: true, attempts: 0 });
    expect((await listHostedJobs(pool, { status: 'failed' })).jobs.map((job) => job.id)).toEqual([
      String(first!.job),
    ]);
    expect((await listHostedJobs(pool, { target: billing })).jobs).toHaveLength(1);
    expect((await listHostedJobs(pool, { since: '2999-01-01' })).total).toBe(0);
    expect((await listHostedJobs(pool, { since: '2026-01-01T00:00:00Z' })).total).toBe(3);
    await expect(listHostedJobs(pool, { status: 'done' })).rejects.toThrow('--status must be');
    await expect(listHostedJobs(pool, { since: 'yesterday' })).rejects.toThrow('--since requires');

    expect(await readHostedReceipt(pool, String(first!.job))).toMatchObject({
      status: 'failed',
      repository: 'example/application',
      receipt: { status: 'error', output: evidence, message: 'Error: boom' },
      evidence: [join(evidence, 'manifest.json'), join(evidence, 'report.json')],
    });
    expect(await readHostedReceipt(pool, String(second!.job))).toMatchObject({
      integration: 'stripe',
      receipt: { revision: 'b'.repeat(40) },
      evidence: null,
    });
    expect((await readHostedReceipt(pool, String(retried))).receipt).toBeNull();
    await expect(readHostedReceipt(pool, '999999')).rejects.toThrow('No hosted job 999999.');
    await expect(readHostedReceipt(pool, '1; DROP TABLE refit_jobs')).rejects.toThrow(
      'A job id is required.',
    );

    expect(await listHostedTargets(pool)).toEqual([
      expect.objectContaining({
        id: application,
        status: 'enrolled',
        lastJob: String(retried),
        lastJobStatus: 'queued',
        receiptJob: String(first!.job),
        receiptStatus: 'error',
        receiptMessage: 'Error: boom',
      }),
      expect.objectContaining({
        id: billing,
        integration: 'stripe',
        lastJob: String(second!.job),
        receiptJob: String(second!.job),
        receiptStatus: 'validated',
      }),
    ]);

    // Only the newest jobs are listed; the total says how many matched.
    await pool.query(
      `INSERT INTO refit_jobs (target_id, status) SELECT $1, 'finished' FROM generate_series(1, $2)`,
      [billing, JOBS_SHOWN],
    );
    const capped = await listHostedJobs(pool, {});
    expect(capped).toMatchObject({ total: JOBS_SHOWN + 3 });
    expect(capped.jobs).toHaveLength(JOBS_SHOWN);

    const env = { REFIT_DATABASE_URL: url };
    const jobs = await refit(['hosted', 'jobs', '--status', 'failed'], env);
    console.log(jobs.stdout, jobs.stderr);
    expect(jobs.code).toBe(0);
    expect(jobs.stdout).toMatch(new RegExp(`^${first!.job}\\s+failed\\s+error\\s+1\\s`, 'm'));
    expect(jobs.stdout).not.toContain('Showing the newest');
    expect((await refit(['hosted', 'jobs'], env)).stdout).toContain(
      `Showing the newest ${JOBS_SHOWN} of ${JOBS_SHOWN + 3} matching jobs`,
    );
    const receipt = await refit(['hosted', 'receipt', String(first!.job)], env);
    console.log(receipt.stdout);
    expect(receipt.stdout).toContain(`Evidence  ${evidence}\n  ${join(evidence, 'manifest.json')}`);
    expect((await refit(['hosted', 'receipt', String(second!.job)], env)).stdout).toContain(
      'Evidence  /data/state/targets/missing/runs/1 (not on this machine)',
    );
    const targets = await refit(['hosted', 'targets'], env);
    console.log(targets.stdout);
    expect(targets.stdout).toContain(
      `${application}  example/application (main), installation 456\nState     enrolled\nLast job  ${retried} queued`,
    );
    expect(targets.stdout).toContain(`Receipt   job ${first!.job} error at `);
    const missing = await refit(['hosted', 'receipt'], env);
    expect(missing).toMatchObject({ code: 1 });
    expect(missing.stderr).toContain('Usage: refit hosted serve');
  },
  60_000,
);

it.skipIf(!DATABASE)(
  'notifies each failed job once, at most once per target per hour, and skips failures before start',
  async () => {
    const { pool } = await database();
    const { store, application, billing } = await installedStore(pool);
    const fail = async (target: string, message: string) => {
      await store.retry(target).catch(() => undefined);
      const claimed = await store.claim('worker-a', 30);
      expect(claimed?.target.id).toBe(target);
      await store.finish(claimed!.job, 'worker-a', 'failed', {
        status: 'error',
        output: null,
        message,
      });
      return claimed!.job;
    };
    const sent: string[] = [];
    const notify = failedJobNotifier(
      pool,
      async (text) => {
        sent.push(text);
      },
      hostedRedactor(SECRETS),
    );
    await fail(application, 'Error: before start');
    await notify();
    expect(sent).toEqual([]);
    await notify();
    expect(sent).toEqual([]);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T03:00:00Z'));
    const job = await fail(billing, 'Error: <!channel> GitHub API returned 502');
    await notify();
    expect(sent).toEqual([
      `🚨 [URGENT] example/billing: hosted job ${job} failed (error: Error: &lt;!channel&gt; GitHub API returned 502); see refit hosted receipt ${job}.`,
    ]);
    await notify();
    expect(sent).toHaveLength(1);

    vi.setSystemTime(new Date('2026-10-22T03:59:00Z'));
    await fail(billing, 'Error: again within the hour');
    await notify();
    expect(sent).toHaveLength(1);

    // A job whose lease expired too often is failed by the next claim and still notified.
    await store.retry(application);
    const crashed = await store.claim('worker-crashed', 30);
    expect(crashed?.target.id).toBe(application);
    await pool.query(
      `UPDATE refit_jobs SET attempts = 3, lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [crashed!.job],
    );
    expect(await store.claim('worker-b', 30)).toBeNull();
    await notify();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain(
      `example/application: hosted job ${crashed!.job} failed (error: Worker lease expired repeatedly`,
    );

    vi.setSystemTime(new Date('2026-10-22T04:01:00Z'));
    const later = await fail(billing, 'Error: an hour later');
    await notify();
    expect(sent).toHaveLength(3);
    expect(sent[2]).toContain(`hosted job ${later} failed (error: Error: an hour later)`);

    // A secret that the notice's length cut would split is redacted before the cut.
    vi.setSystemTime(new Date('2026-10-22T05:02:00Z'));
    await fail(billing, `Error: ${'x'.repeat(170)}${SECRETS.OPENAI_API_KEY} tail`);
    await notify();
    expect(sent).toHaveLength(4);
    console.log('Cut notice:', sent[3]);
    expect(sent[3]).not.toContain('sk-proj');
  },
  30_000,
);

it.skipIf(!DATABASE)(
  'checks the Refit tables and exits non-zero from the CLI on any failed health check',
  async () => {
    const { pool, url } = await database();
    const before = await checkHostedHealth(pool, []);
    expect(before.slice(0, 2)).toEqual([
      { check: 'postgres', status: 'ok', detail: 'Connected.' },
      {
        check: 'schema',
        status: 'failed',
        detail:
          'missing refit_installations, refit_installation_repositories, refit_deliveries, refit_approvals, refit_targets, refit_jobs',
      },
    ]);
    await openHostedStore(pool);
    expect((await checkHostedHealth(pool, []))[1]).toEqual({
      check: 'schema',
      status: 'ok',
      detail: 'All 6 Refit tables are present and writable.',
    });
    const health = await refit(['hosted', 'health'], {
      REFIT_DATABASE_URL: url,
      DOCKER_HOST: 'unix:///nonexistent/refit-health-test.sock',
    });
    console.log(health.stdout);
    expect(health.code).toBe(1);
    expect(health.stdout).toMatch(/^ok {6}postgres {2}Connected\.$/m);
    expect(health.stdout).toMatch(/^ok {6}schema {4}All 6 Refit tables/m);
    expect(health.stdout).toMatch(/^failed {2}docker /m);
  },
  30_000,
);

it.skipIf(!DATABASE || !IMAGE)(
  'passes health with a reachable daemon and present image, and fails for a missing image',
  async () => {
    const { pool, url } = await database();
    await openHostedStore(pool);
    const checks = await checkHostedHealth(pool, [IMAGE!, 'refit-health-missing:never']);
    console.log(checks);
    expect(checks.map(({ check, status }) => [check, status])).toEqual([
      ['postgres', 'ok'],
      ['schema', 'ok'],
      ['docker', 'ok'],
      ['images', 'ok'],
      ['images', 'failed'],
    ]);
    expect(checks[3].detail).toMatch(new RegExp(`^${IMAGE} sha256:[a-f0-9]{12}$`));
    const env = { REFIT_DATABASE_URL: url, HOME: process.env.HOME, REFIT_HOSTED_IMAGES: IMAGE };
    const healthy = await refit(['hosted', 'health'], env);
    console.log(healthy.stdout);
    expect(healthy).toMatchObject({ code: 0 });
    expect(
      (await refit(['hosted', 'health'], { ...env, REFIT_HOSTED_IMAGES: '' })).stdout,
    ).toContain('failed  images    REFIT_HOSTED_IMAGES names no validation image.');
  },
  60_000,
);
