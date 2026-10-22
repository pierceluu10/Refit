import { createHmac, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { runHostedService } from './hosted-service.ts';
import { hostedTargetId, openHostedStore } from './hosted-store.ts';
import type { RepositoryApproval } from './repository-enrollment.ts';
import { pollServiceTarget } from './service-worker.ts';

vi.mock('./service-worker.ts', async (original) => ({
  ...(await original<typeof import('./service-worker.ts')>()),
  confirmRepositoryAccess: vi.fn(async () => ({ installationId: 456, id: 789 })),
  pollServiceTarget: vi.fn(),
}));

const DATABASE = process.env.REFIT_POSTGRES_URL;
const INSTALLATION = 456;
const APP = { appId: '123', privateKeyFile: 'unused-test-key' };
const WEBHOOK_SECRET = 'webhook-secret-for-hosted-security-tests-123';
const CONTROL_TOKEN = 'control-secret-for-hosted-security-tests-456';
const OPENAI_KEY = `sk-proj-${randomBytes(24).toString('hex')}`;
const INSTALLATION_TOKEN = `ghs_${randomBytes(18).toString('hex')}`;
const PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 1024 })
  .privateKey.export({ type: 'pkcs1', format: 'pem' })
  .toString();
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  vi.clearAllMocks();
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

// Storage that fails on demand, with the failure text chosen by the test.
function failing(pool: pg.Pool, faults: { renewal?: string; delivery?: string }) {
  const bound = <T extends object>(target: T, property: string | symbol) => {
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  };
  return new Proxy(pool, {
    get(target, property) {
      if (property === 'query')
        return (text: string, values?: unknown[]) =>
          faults.renewal && text.includes('SET lease_expires_at')
            ? Promise.reject(new Error(faults.renewal))
            : target.query(text, values);
      if (property === 'connect')
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(inner, name) {
              if (name !== 'query') return bound(inner, name);
              return (text: string, values?: unknown[]) =>
                faults.delivery && text.includes('INSERT INTO refit_deliveries')
                  ? Promise.reject(new Error(faults.delivery))
                  : inner.query(text, values);
            },
          });
        };
      return bound(target, property);
    },
  });
}

function approval(repository: string): RepositoryApproval {
  return {
    formatVersion: 1,
    kind: 'refit-repository-approval',
    repository,
    base: 'main',
    fingerprint: randomBytes(32).toString('hex'),
    files: [],
    reviewedRevision: 'a'.repeat(40),
    approvedAt: new Date().toISOString(),
  };
}

function sign(body: string) {
  return `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;
}

async function deliver(url: string, event: string, payload: unknown, delivery = randomUUID()) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const response = await fetch(`${url}/github/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': event,
      'X-GitHub-Delivery': delivery,
      'X-Hub-Signature-256': sign(body),
    },
    body,
  });
  return { status: response.status, text: await response.text(), delivery };
}

function repositories(action: string, added: string[], removed: string[] = []) {
  const repository = (full_name: string) => ({ id: 789, full_name });
  return {
    action,
    installation: { id: INSTALLATION, app_id: 123, account: { login: 'example' } },
    repositories_added: added.map(repository),
    repositories_removed: removed.map(repository),
  };
}

async function start(pool: pg.Pool, root: string, options: { aiPatch?: boolean } = {}) {
  const controller = new AbortController();
  let ready: (url: string) => void;
  const listening = new Promise<string>((resolve) => (ready = resolve));
  const progress: string[] = [];
  const service = runHostedService({
    database: pool,
    app: APP,
    directory: join(root, 'hosted-state'),
    webhookSecret: WEBHOOK_SECRET,
    controlToken: CONTROL_TOKEN,
    owner: 'example',
    ...(options.aiPatch ? { aiPatch: { apiKey: OPENAI_KEY, model: 'gpt-5.6-luna' } } : {}),
    host: '127.0.0.1',
    port: 0,
    intervalSeconds: 30,
    leaseSeconds: 3,
    worker: 'security-worker',
    signal: controller.signal,
    onReady: (url) => ready(url),
    onProgress: (message) => progress.push(message),
  });
  cleanups.push(async () => {
    controller.abort();
    await service.catch(() => undefined);
  });
  return { url: await listening, progress };
}

async function status(url: string) {
  const response = await fetch(`${url}/status`, {
    headers: { Authorization: `Bearer ${CONTROL_TOKEN}` },
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function settled(url: string, count: number) {
  let registry = await status(url);
  for (
    const deadline = Date.now() + 20_000;
    registry.jobs.filter((job: { finishedAt: string | null }) => job.finishedAt).length < count &&
    Date.now() < deadline;
    registry = await status(url)
  )
    await new Promise((resolve) => setTimeout(resolve, 100));
  return registry;
}

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => readFile(join(entry.parentPath, entry.name), 'utf8')),
  );
}

it.skipIf(!DATABASE)(
  'keeps every known secret out of logs, stored receipts, /status, HTTP responses and the state directory',
  async () => {
    const pool = await database();
    const databasePassword = decodeURIComponent(new URL(DATABASE!).password);
    const secrets = [
      WEBHOOK_SECRET,
      CONTROL_TOKEN,
      OPENAI_KEY,
      INSTALLATION_TOKEN,
      PRIVATE_KEY,
      ...(databasePassword.length >= 8 ? [databasePassword] : []),
    ];
    const leak = [
      ...secrets,
      `postgresql://refit_hosted:${randomBytes(9).toString('hex')}@db.example.test/postgres`,
      `Authorization: Basic ${Buffer.from(`x-access-token:${INSTALLATION_TOKEN}`).toString('base64')}`,
    ].join(' | ');
    const faults: { renewal?: string; delivery?: string } = {};
    const store = await openHostedStore(pool);
    for (const name of ['example/failing', 'example/reporting', 'example/renewing'])
      await store.approve(approval(name), 'octo-reviewer');
    vi.mocked(pollServiceTarget).mockImplementation(async (options) => {
      options.onProgress?.(`Fetching with ${leak}`);
      if (options.target.repository === 'example/failing') throw new Error(`git said ${leak}`);
      if (options.target.repository === 'example/renewing') {
        faults.renewal = `connection lost: ${leak}`;
        await new Promise((resolve) => setTimeout(resolve, 1_600));
        options.signal.throwIfAborted();
      }
      return {
        status: 'processed',
        output: null,
        result: { manifest: { status: 'needs-review', reason: `Checks printed ${leak}` } },
        checkout: { revision: 'b'.repeat(40) },
      } as never;
    });
    const root = await mkdtemp(join(tmpdir(), 'refit-hosted-security-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const { url, progress } = await start(failing(pool, faults), root, { aiPatch: true });
    const responses: string[] = [];

    for (const [index, name] of [
      'example/failing',
      'example/reporting',
      'example/renewing',
    ].entries()) {
      const added = await deliver(url, 'installation_repositories', repositories('added', [name]));
      expect(added.status).toBe(202);
      responses.push(added.text);
      await settled(url, index + 1);
    }
    delete faults.renewal;

    // A storage failure is logged, and the sender sees only a generic message.
    faults.delivery = `could not write ${leak}`;
    const failed = await deliver(url, 'installation_repositories', repositories('added', []));
    delete faults.delivery;
    expect(failed.status).toBe(500);
    // Malformed signed JSON is refused with its parser's message.
    const malformed = await deliver(url, 'installation', `{"token": "${INSTALLATION_TOKEN}`);
    expect(malformed.status).toBe(400);
    responses.push(failed.text, malformed.text);

    const registry = await status(url);
    expect(registry.jobs.map((job: { receipt: { status: string } }) => job.receipt.status)).toEqual(
      ['error', 'needs-review', 'interrupted'],
    );
    const output = [
      ...progress,
      JSON.stringify(registry),
      ...responses,
      JSON.stringify((await pool.query('SELECT receipt FROM refit_jobs')).rows),
      ...(await files(join(root, 'hosted-state'))),
    ].join('\n');
    for (const secret of [
      ...secrets,
      ...secrets.map((secret) => Buffer.from(secret).toString('base64')),
      'BEGIN RSA PRIVATE KEY',
      `x-access-token:${INSTALLATION_TOKEN}`,
    ])
      expect(output).not.toContain(secret);
    // The diagnostics stay useful: each path still says what happened.
    expect(registry.jobs[0].receipt.message).toMatch(/^Error: git said \[redacted\]/);
    expect(registry.jobs[1].receipt.message).toMatch(/^Checks printed \[redacted\]/);
    expect(progress.join('\n')).toMatch(/Lease renewal failed: connection lost: \[redacted\]/);
    expect(progress.join('\n')).toMatch(/Webhook processing failed: could not write \[redacted\]/);
    expect(failed.text).toContain('Inspect service logs before redelivery.');
  },
  60_000,
);

it.skipIf(!DATABASE)(
  'refuses a signed payload replayed under a new delivery GUID but accepts GitHub redeliveries',
  async () => {
    const pool = await database();
    const store = await openHostedStore(pool);
    await store.approve(approval('example/application'), 'octo-reviewer');
    vi.mocked(pollServiceTarget).mockImplementation(async () => {
      throw new Error('not reached');
    });
    const root = await mkdtemp(join(tmpdir(), 'refit-hosted-replay-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const { url } = await start(pool, root);
    const target = hostedTargetId('example/application', 'main');

    const added = repositories('added', ['example/application']);
    const first = await deliver(url, 'installation_repositories', added);
    expect(first.status).toBe(202);
    await settled(url, 1);
    const removed = repositories('removed', [], ['example/application']);
    expect((await deliver(url, 'installation_repositories', removed)).status).toBe(202);
    expect((await status(url)).targets[0]).toMatchObject({ id: target, status: 'cancelled' });

    // An attacker who captured the signed "added" body re-sends it under a fresh GUID.
    const replay = await deliver(url, 'installation_repositories', added);
    expect(replay.status).toBe(409);
    expect(JSON.parse(replay.text).error).toMatch(/replay/);
    const registry = await status(url);
    expect(registry.targets[0]).toMatchObject({ id: target, status: 'cancelled' });
    expect(registry.installations[0].repositories).toEqual([]);
    expect(await store.claim('other-worker', 30)).toBeNull();

    // GitHub's own redelivery keeps the original GUID and is a harmless duplicate.
    const redelivery = await deliver(url, 'installation_repositories', added, first.delivery);
    expect(redelivery.status).toBe(202);
    expect(JSON.parse(redelivery.text)).toMatchObject({ status: 'duplicate', enrolled: [] });
    // A distinct event for the same repository is still accepted.
    const readded = await deliver(url, 'installation_repositories', {
      ...added,
      sender: { login: 'octo-admin' },
    });
    expect(JSON.parse(readded.text)).toMatchObject({ status: 'accepted', enrolled: [target] });
  },
  60_000,
);

it.skipIf(!DATABASE)(
  'stores hostile text verbatim through parameterised queries',
  async () => {
    const pool = await database();
    const store = await openHostedStore(pool);
    const hostile = "x'); DROP TABLE refit_jobs; --";
    const injected = approval("example/app'; DELETE FROM refit_approvals; --");
    await store.approve(injected, hostile);
    const accepted = await store.accept(
      randomUUID(),
      'installation_repositories',
      new TextEncoder().encode(hostile),
      {
        kind: 'repositories',
        installationId: INSTALLATION,
        owner: 'example',
        action: 'added',
        added: [{ id: 1, name: injected.repository }],
        removed: [],
      },
    );
    expect(accepted.enrolled).toHaveLength(1);
    const claimed = await store.claim(hostile, 30);
    expect(claimed?.target.repository).toBe(injected.repository);
    expect(
      await store.finish(claimed!.job, hostile, 'failed', {
        status: 'error',
        output: hostile,
        message: hostile,
      }),
    ).toBe(true);
    const { rows } = await pool.query('SELECT approved_by FROM refit_approvals');
    expect(rows).toEqual([{ approved_by: hostile }]);
    expect((await store.read()).jobs[0].receipt).toMatchObject({ message: hostile });
  },
  30_000,
);
