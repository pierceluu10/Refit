import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { enrollmentReviewText } from './enrollment-review.ts';
import { gitEnvironment } from './git-environment.ts';
import { parseWebhook } from './github-webhooks.ts';
import { APPROVAL_OUTCOMES, processApprovalIssues } from './hosted-approval.ts';
import { openApprovalStore } from './hosted-approval-store.ts';
import { runHostedService } from './hosted-service.ts';
import { hostedTargetId, openHostedStore } from './hosted-store.ts';
import { hostedTenancy, TENANCY_REFUSALS } from './hosted-tenancy.ts';
import {
  inspectRepositoryEnrollment,
  readRepositoryApproval,
  repositoryApproval,
} from './repository-enrollment.ts';

const transport = vi.hoisted(() => ({
  source: '',
  head: '',
  calls: [] as { binary: string; args: string[] }[],
  native: undefined as
    undefined | ((args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>),
}));
// A fake GitHub: one repository, its issues and comments, and each user's role on it.
const github = vi.hoisted(() => ({
  issues: new Map<number, { title: string; body: string; state: string }>(),
  comments: [] as { issue: number; body: string }[],
  roles: new Map<string, string>(),
  // Runs when Refit posts a comment, before the request returns.
  onComment: undefined as undefined | ((body: string) => Promise<void>),
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
vi.mock('./github-app.ts', async (original) => ({
  ...(await original<typeof import('./github-app.ts')>()),
  authenticateGitHubRead: vi.fn(async () => ({
    token: 'private-read-test-token',
    appId: 123,
    installationId: 456,
  })),
  authenticateGitHubIssues: vi.fn(async () => ({ token: 'private-issues-test-token' })),
}));
vi.mock('./github.ts', async (original) => {
  const actual = await original<typeof import('./github.ts')>();
  const root = '/repos/example/application';
  return {
    ...actual,
    requestGitHub: vi.fn(
      async (_token: string, method: string, path: string, body?: Record<string, string>) => {
        if (method === 'GET' && path === root)
          return {
            id: 789,
            full_name: 'example/application',
            default_branch: 'main',
            archived: false,
            disabled: false,
          };
        if (method === 'GET' && path === `${root}/git/ref/heads/main`)
          return { object: { type: 'commit', sha: transport.head } };
        if (method === 'POST' && path === `${root}/issues`) {
          const number = github.issues.size + 1;
          github.issues.set(number, { title: body!.title, body: body!.body, state: 'open' });
          return { number };
        }
        const issue = /^\/repos\/example\/application\/issues\/(\d+)(\/comments)?$/.exec(path);
        if (issue && method === 'PATCH' && !issue[2] && github.issues.has(Number(issue[1]))) {
          github.issues.set(Number(issue[1]), { ...github.issues.get(Number(issue[1]))!, ...body });
          return {};
        }
        if (issue && method === 'POST' && issue[2]) {
          github.comments.push({ issue: Number(issue[1]), body: body!.body });
          await github.onComment?.(body!.body);
          return { id: github.comments.length };
        }
        const permission =
          /^\/repos\/example\/application\/collaborators\/([^/]+)\/permission$/.exec(path);
        if (permission && method === 'GET') {
          const role = github.roles.get(permission[1]);
          if (!role) throw new actual.GitHubRequestError(404, method, path);
          return { permission: role === 'maintain' ? 'write' : role, role_name: role };
        }
        throw new Error(`Unexpected GitHub request ${method} ${path}`);
      },
    ),
  };
});

const DATABASE = process.env.REFIT_POSTGRES_URL;
const INSTALLATION = 456;
const APP = { appId: '123', privateKeyFile: 'unused-test-key' };
const WEBHOOK_SECRET = 'webhook-secret-for-approval-issue-tests-1';
const CONTROL_TOKEN = 'control-secret-for-approval-issue-tests-2';
const REPOSITORY = 'example/application';
const fixture = resolve('pipeline/fixtures/endpoint-replacement');
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  transport.calls = [];
  github.issues.clear();
  github.comments = [];
  github.roles.clear();
  github.onComment = undefined;
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

async function commit() {
  await transport.native!(['add', '-A'], transport.source);
  await transport.native!(
    [
      '-c',
      'user.name=Refit Tests',
      '-c',
      'user.email=tests@refit.local',
      'commit',
      '--quiet',
      '-m',
      'test: update application',
    ],
    transport.source,
  );
  transport.head = (await transport.native!(['rev-parse', 'HEAD'], transport.source)).stdout.trim();
}

function configuration(command = 'after') {
  return JSON.stringify({
    formatVersion: 1,
    before: './before.json',
    after: './after.json',
    providerConfig: './provider.json',
    apiVersion: '1',
    image: 'unused-test-image',
    baselineCommand: ['node', '--experimental-strip-types', 'simulator/check.mjs', 'before'],
    command: ['node', '--experimental-strip-types', 'simulator/check.mjs', command],
  });
}

async function addConfiguration(command?: string) {
  for (const name of ['before.json', 'provider.json', 'after.json'])
    await cp(join(fixture, name), join(transport.source, name));
  await writeFile(join(transport.source, '.refit.json'), configuration(command));
  await commit();
}

// The repository the fake GitHub serves, with a committed .refit.json unless `bare`.
async function repository(options: { bare?: boolean; files?: Record<string, string> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'refit-approval-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  transport.source = join(root, 'source');
  await cp(join(fixture, 'repository'), transport.source, { recursive: true });
  for (const [name, content] of Object.entries(options.files ?? {}))
    await writeFile(join(transport.source, name), content);
  await transport.native!(['init', '--quiet', '--initial-branch=main'], transport.source);
  if (options.bare) await commit();
  else await addConfiguration();
  return root;
}

const enrollment = () =>
  inspectRepositoryEnrollment({ repository: transport.source, github: REPOSITORY, base: 'main' });

async function setup(root: string, environment: NodeJS.ProcessEnv = {}) {
  const pool = await database();
  const store = await openHostedStore(
    pool,
    hostedTenancy({ REFIT_HOSTED_OWNER: 'example', ...environment }),
  );
  const approvals = openApprovalStore(pool);
  await store.accept(randomUUID(), 'installation', encode({}), {
    kind: 'installation',
    installationId: INSTALLATION,
    owner: 'example',
    action: 'created',
    added: [{ id: 789, name: REPOSITORY }],
    removed: [],
  });
  const cancelled: number[] = [];
  const progress: string[] = [];
  const context = {
    app: APP,
    directory: join(root, 'approvals'),
    store,
    approvals,
    signal: new AbortController().signal,
    onCancelled: (jobs: number[]) => cancelled.push(...jobs),
    onProgress: (message: string) => progress.push(message),
  };
  let printed = 0;
  const process = async () => {
    await processApprovalIssues(context);
    console.log(progress.slice(printed).join('\n'));
    printed = progress.length;
  };
  // Delivers a signed-equivalent comment through the same parser and transaction as the service.
  let commentId = 1000;
  const comment = (
    author: string,
    body: string,
    options: { issue?: number; edited?: boolean; id?: number; installation?: number } = {},
  ) => {
    const payload = encode({
      action: options.edited ? 'edited' : 'created',
      installation: { id: options.installation ?? INSTALLATION },
      repository: { full_name: REPOSITORY },
      issue: { number: options.issue ?? 1 },
      comment: { id: options.id ?? ++commentId, body, user: { login: author, type: 'User' } },
    });
    return store.accept(
      randomUUID(),
      'issue_comment',
      payload,
      parseWebhook(payload, 'issue_comment', 123),
    );
  };
  const stored = async () =>
    (
      await pool.query<{ approval: Record<string, unknown>; approved_by: string }>(
        'SELECT approval, approved_by FROM refit_approvals',
      )
    ).rows;
  const outcomes = async () =>
    (await approvals.read()).commands.map((command: { outcome: string }) => command.outcome);
  return {
    pool,
    store,
    approvals,
    context,
    process,
    comment,
    stored,
    outcomes,
    cancelled,
    progress,
  };
}

const lastReply = () => github.comments.at(-1)?.body ?? '';

it.skipIf(!DATABASE)(
  'opens one issue showing the refit enroll review and approves on a maintainer’s fingerprint prefix',
  async () => {
    const root = await repository();
    const sample = await setup(root);
    const reviewed = await enrollment();
    github.roles.set('octo-maintainer', 'maintain');

    await sample.process();
    expect([...github.issues.keys()]).toEqual([1]);
    const opened = github.issues.get(1)!;
    expect(opened).toMatchObject({ title: 'Approve Refit for this repository', state: 'open' });
    expect(opened.body).toContain(enrollmentReviewText(reviewed));
    expect(opened.body).toContain(`/refit approve ${reviewed.fingerprint.slice(0, 12)}`);
    // The issue shows exactly what the refit enroll command prints.
    const printed = await promisify(execFile)(process.execPath, [
      'bin/refit.mjs',
      'enroll',
      '--repository',
      transport.source,
      '--github',
      REPOSITORY,
      '--base',
      'main',
    ]);
    expect(printed.stdout).toContain(enrollmentReviewText(reviewed));

    await sample.process();
    expect(github.issues.size).toBe(1);
    expect(github.comments).toEqual([]);

    const prefix = reviewed.fingerprint.slice(0, 16).toUpperCase();
    expect((await sample.comment('Octo-Maintainer', `  /refit approve ${prefix}\n`)).status).toBe(
      'queued',
    );
    await sample.process();
    expect(await sample.outcomes()).toEqual([APPROVAL_OUTCOMES.approved]);
    expect(lastReply()).toContain('Approved by `octo-maintainer`');
    expect(github.issues.get(1)).toMatchObject({
      title: 'Refit is approved for this repository',
      state: 'closed',
    });

    // The stored approval is the receipt `refit enroll --approve` writes, apart from its time.
    const [row] = await sample.stored();
    expect(row.approved_by).toBe('octo-maintainer');
    expect({ ...row.approval, approvedAt: null }).toEqual({
      ...repositoryApproval(reviewed, reviewed.fingerprint),
      approvedAt: null,
    });
    const receipt = join(root, 'receipts', 'approval.json');
    await mkdir(join(root, 'receipts'));
    await writeFile(receipt, JSON.stringify(row.approval));
    expect(await readRepositoryApproval(receipt)).toEqual(row.approval);

    const { targets, jobs } = await sample.store.read();
    expect(targets).toEqual([
      expect.objectContaining({
        id: hostedTargetId(REPOSITORY, 'main'),
        status: 'enrolled',
        fingerprint: reviewed.fingerprint,
      }),
    ]);
    expect(jobs).toEqual([expect.objectContaining({ status: 'queued' })]);
    // No issue reopens for a repository that is approved.
    await sample.process();
    expect(github.issues.get(1)!.state).toBe('closed');
    expect(transport.calls.some((call) => call.binary === 'docker')).toBe(false);
  },
  60_000,
);

it.skipIf(!DATABASE)(
  'refuses users without permission, wrong and stale prefixes, edited comments and replayed deliveries, naming each reason',
  async () => {
    await repository();
    const sample = await setup(await mkdtemp(join(tmpdir(), 'refit-approval-state-')));
    const first = await enrollment();
    github.roles.set('octo-triager', 'triage');
    github.roles.set('octo-admin', 'admin');
    await sample.process();
    const prefix = first.fingerprint.slice(0, 12);

    await sample.comment('octo-triager', `/refit approve ${prefix}`);
    await sample.comment('stranger', `/refit approve ${prefix}`);
    await sample.comment('octo-admin', '/refit approve abc');
    await sample.comment('octo-admin', '/refit approve 0123456789abcdef');
    await sample.comment('octo-admin', '/refit approve');
    await sample.comment('octo-admin', `/refit approve ${prefix}`, { edited: true, id: 42 });
    await sample.process();
    expect(await sample.outcomes()).toEqual([
      APPROVAL_OUTCOMES.permission,
      APPROVAL_OUTCOMES.permission,
      APPROVAL_OUTCOMES.wrongPrefix,
      APPROVAL_OUTCOMES.wrongPrefix,
      APPROVAL_OUTCOMES.wrongPrefix,
      APPROVAL_OUTCOMES.edited,
    ]);
    const replies = github.comments.map((entry) => entry.body);
    expect(replies[0]).toContain('`octo-triager` has the `triage` role');
    expect(replies[1]).toContain('`stranger` has no role');
    expect(replies[2]).toContain('does not match');
    expect(replies[5]).toContain('never acts on edited comments');
    expect(await sample.stored()).toEqual([]);

    // A replay of an already handled comment, under a new delivery GUID, is refused and silent.
    const replied = github.comments.length;
    expect(
      (await sample.comment('octo-admin', `/refit approve ${prefix}`, { edited: true, id: 42 }))
        .status,
    ).toBe('duplicate');
    // Comments that are not commands, on other issues or from other installations do nothing.
    expect(
      (await sample.comment('octo-admin', `Looks good. /refit approve ${prefix}`)).status,
    ).toBe('ignored');
    await sample.comment('octo-admin', `/refit approve ${prefix}`, { issue: 99 });
    await sample.comment('octo-admin', `/refit approve ${prefix}`, { installation: 999 });
    await sample.process();
    expect(github.comments).toHaveLength(replied);
    expect((await sample.outcomes()).slice(-2)).toEqual([
      APPROVAL_OUTCOMES.ignored,
      APPROVAL_OUTCOMES.ignored,
    ]);

    // The configuration changes after the issue was written: the shown prefix is refused and the
    // issue shows the new review; the old prefix is then stale and the new one approves.
    await addConfiguration('after-changed');
    const second = await enrollment();
    expect(second.fingerprint).not.toBe(first.fingerprint);
    await sample.comment('octo-admin', `/refit approve ${prefix}`);
    await sample.process();
    expect((await sample.outcomes()).at(-1)).toBe(APPROVAL_OUTCOMES.changed);
    expect(lastReply()).toContain('changed after this issue was written');
    expect(github.issues.get(1)!.body).toContain(enrollmentReviewText(second));
    expect(await sample.stored()).toEqual([]);

    await sample.comment('octo-admin', `/refit approve ${prefix}`);
    await sample.process();
    expect((await sample.outcomes()).at(-1)).toBe(APPROVAL_OUTCOMES.stalePrefix);
    expect(lastReply()).toContain('earlier version of this issue');

    await sample.comment('octo-admin', `/refit approve ${second.fingerprint.slice(0, 12)}`);
    await sample.process();
    expect((await sample.outcomes()).at(-1)).toBe(APPROVAL_OUTCOMES.approved);
    expect((await sample.stored())[0].approval.fingerprint).toBe(second.fingerprint);
  },
  60_000,
);

it.skipIf(!DATABASE)(
  'proposes the configuration refit agents --add writes when the repository has none',
  async () => {
    const files = {
      'package.json': JSON.stringify({
        name: 'application',
        dependencies: { stripe: '^17.0.0' },
        scripts: { test: 'vitest run' },
      }),
      'package-lock.json': '{}',
    };
    const root = await repository({ bare: true, files });
    const sample = await setup(root);
    github.roles.set('octo-admin', 'admin');
    await sample.process();
    const proposal = github.issues.get(1)!;
    expect(proposal.title).toBe('Set up Refit for this repository');
    expect(proposal.body).toContain('has no committed `.refit.json`');
    expect(proposal.body).toContain('`refit agents --add stripe` writes');
    const proposed = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(proposal.body)![1]);

    // The same configuration the agents command writes into a copy of the repository.
    const copy = join(root, 'copy');
    await cp(transport.source, copy, { recursive: true });
    await promisify(execFile)(process.execPath, [
      'bin/refit.mjs',
      'agents',
      '--repository',
      copy,
      '--add',
      'stripe',
    ]);
    expect(proposed).toEqual(JSON.parse(await readFile(join(copy, '.refit.json'), 'utf8')));
    expect(proposed.integrations[0]).toMatchObject({
      id: 'stripe',
      command: ['npm', 'test'],
      prepareDependencies: true,
    });

    // Approving before a configuration is committed only refreshes the issue.
    await sample.comment('octo-admin', '/refit approve');
    await sample.process();
    expect(await sample.outcomes()).toEqual([APPROVAL_OUTCOMES.unreviewed]);
    expect(lastReply()).toContain('showed no reviewed configuration');
    expect(github.issues.get(1)!.title).toBe('Set up Refit for this repository');

    await addConfiguration();
    const reviewed = await enrollment();
    await sample.comment('octo-admin', '/refit approve 0123456789ab');
    await sample.process();
    expect((await sample.outcomes()).at(-1)).toBe(APPROVAL_OUTCOMES.unreviewed);
    expect(lastReply()).toContain('approve with the fingerprint it shows');
    expect(github.issues.get(1)!.body).toContain(enrollmentReviewText(reviewed));
    await sample.comment('octo-admin', `/refit approve ${reviewed.fingerprint.slice(0, 12)}`);
    await sample.process();
    expect((await sample.outcomes()).at(-1)).toBe(APPROVAL_OUTCOMES.approved);
  },
  60_000,
);

it.skipIf(!DATABASE)(
  'opens no issue when no provider with an agent is detected',
  async () => {
    const root = await repository({
      bare: true,
      files: { 'package.json': JSON.stringify({ name: 'application', dependencies: {} }) },
    });
    const sample = await setup(root);
    await sample.process();
    expect(github.issues.size).toBe(0);
    expect((await sample.approvals.read()).issues).toEqual([
      expect.objectContaining({ repository: REPOSITORY, state: 'no-providers', issue: null }),
    ]);
    await sample.process();
    expect(github.issues.size).toBe(0);
  },
  60_000,
);

it.skipIf(!DATABASE)(
  'counts each issue inspection against the installation’s daily inventory cap',
  async () => {
    const root = await repository();
    const sample = await setup(root, { REFIT_HOSTED_DAILY_INVENTORIES: '1' });
    expect(await sample.store.reserveInventory(INSTALLATION)).toBeNull();
    await sample.process();
    expect(github.issues.size).toBe(0);
    expect(sample.progress).toContain(
      `[${REPOSITORY}] Approval issue waits: ${TENANCY_REFUSALS.dailyInventories}.`,
    );
    expect((await sample.approvals.read()).issues).toEqual([]);
    expect((await sample.store.read()).installations[0]).toMatchObject({ inventoriesToday: 1 });
  },
  60_000,
);

it.skipIf(!DATABASE)(
  '/refit revoke removes the approval, cancels the target and shows the configuration again',
  async () => {
    const root = await repository();
    const sample = await setup(root);
    const reviewed = await enrollment();
    github.roles.set('octo-admin', 'admin');
    github.roles.set('octo-writer', 'write');
    await sample.process();
    await sample.comment('octo-admin', `/refit approve ${reviewed.fingerprint.slice(0, 12)}`);
    await sample.process();
    const target = hostedTargetId(REPOSITORY, 'main');
    const claimed = await sample.store.claim('test-worker', 60);
    expect(claimed?.target.id).toBe(target);

    await sample.comment('octo-writer', '/refit revoke');
    await sample.process();
    expect((await sample.outcomes()).at(-1)).toBe(APPROVAL_OUTCOMES.permission);
    expect(await sample.stored()).toHaveLength(1);

    await sample.comment('octo-admin', '/refit revoke');
    await sample.process();
    expect((await sample.outcomes()).at(-1)).toBe(APPROVAL_OUTCOMES.revoked);
    expect(lastReply()).toContain('Revoked by `octo-admin`');
    expect(await sample.stored()).toEqual([]);
    expect(sample.cancelled).toEqual([claimed!.job]);
    const { targets, jobs } = await sample.store.read();
    expect(targets).toEqual([
      expect.objectContaining({
        id: target,
        status: 'cancelled',
        message: 'Approval revoked by octo-admin.',
      }),
    ]);
    expect(jobs).toEqual([expect.objectContaining({ status: 'cancelled' })]);
    expect(github.issues.get(1)).toMatchObject({
      title: 'Approve Refit for this repository',
      state: 'open',
    });
    expect(github.issues.get(1)!.body).toContain(enrollmentReviewText(reviewed));

    await sample.comment('octo-admin', '/refit revoke');
    await sample.process();
    expect((await sample.outcomes()).at(-1)).toBe(APPROVAL_OUTCOMES.notApproved);
    expect(lastReply()).toContain('no stored approval');

    // Approving again works from the reopened issue.
    await sample.comment('octo-admin', `/refit approve ${reviewed.fingerprint.slice(0, 12)}`);
    await sample.process();
    expect((await sample.outcomes()).at(-1)).toBe(APPROVAL_OUTCOMES.approved);
    expect((await sample.store.read()).targets[0]).toMatchObject({ status: 'enrolled' });
  },
  60_000,
);

async function deliver(
  url: string,
  event: string,
  payload: unknown,
  options: { delivery?: string; secret?: string } = {},
) {
  const body = JSON.stringify(payload);
  const response = await fetch(`${url}/github/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': event,
      'X-GitHub-Delivery': options.delivery ?? randomUUID(),
      'X-Hub-Signature-256': `sha256=${createHmac('sha256', options.secret ?? WEBHOOK_SECRET)
        .update(body)
        .digest('hex')}`,
    },
    body,
  });
  return { status: response.status, body: await response.json() };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean) {
  let value = await read();
  for (const deadline = Date.now() + 30_000; !done(value) && Date.now() < deadline;) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    value = await read();
  }
  return value;
}

async function serve(pool: pg.Pool, root: string, approvalIssues: boolean) {
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
    tenancy: hostedTenancy({ REFIT_HOSTED_OWNER: 'example' }),
    approvalIssues,
    host: '127.0.0.1',
    port: 0,
    intervalSeconds: 3600,
    leaseSeconds: 30,
    worker: 'test-worker',
    signal: controller.signal,
    onReady: (url) => ready(url),
    onProgress: (message) => progress.push(message),
  });
  cleanups.push(async () => {
    controller.abort();
    await service.catch(() => undefined);
    console.log(progress.join('\n'));
  });
  const url = await listening;
  const status = async () =>
    (
      await fetch(`${url}/status`, { headers: { Authorization: `Bearer ${CONTROL_TOKEN}` } })
    ).json();
  return { url, status };
}

const installation = {
  action: 'created',
  installation: { id: INSTALLATION, app_id: 123, account: { login: 'example' } },
  repositories: [{ id: 789, full_name: REPOSITORY }],
};
const approveComment = (body: string, id: number, type = 'User', login = 'octo-admin') => ({
  action: 'created',
  installation: { id: INSTALLATION },
  repository: { full_name: REPOSITORY },
  issue: { number: 1 },
  comment: { id, body, user: { login, type } },
});

it.skipIf(!DATABASE)(
  'serves approval through webhooks: refuses forged and replayed deliveries, and reopens the issue when a job finds the configuration changed after approval',
  async () => {
    const root = await repository();
    const pool = await database();
    const reviewed = await enrollment();
    github.roles.set('octo-admin', 'admin');
    const { url, status } = await serve(pool, root, true);

    expect((await deliver(url, 'installation', installation)).status).toBe(202);
    await until(
      async () => github.issues.size,
      (size) => size === 1,
    );
    const command = approveComment(`/refit approve ${reviewed.fingerprint.slice(0, 12)}`, 7);
    const forged = await deliver(url, 'issue_comment', command, {
      secret: 'not-the-webhook-secret',
    });
    expect(forged).toEqual({ status: 401, body: { error: 'Webhook signature did not match.' } });
    expect(
      (
        await deliver(
          url,
          'issue_comment',
          approveComment('/refit approve', 8, 'Bot', 'refit-agent[bot]'),
        )
      ).body,
    ).toMatchObject({ status: 'ignored' });
    // Approval enrolls the repository; a commit lands while Refit replies, before the job runs, so
    // the job stops for review and the issue shows the new configuration.
    github.onComment = async (body) => {
      if (!body.includes('Approved by')) return;
      github.onComment = undefined;
      await addConfiguration('after-changed');
    };
    const delivery = randomUUID();
    expect((await deliver(url, 'issue_comment', command, { delivery })).body).toMatchObject({
      status: 'queued',
    });
    expect((await deliver(url, 'issue_comment', command, { delivery })).body).toMatchObject({
      status: 'duplicate',
    });
    expect((await deliver(url, 'issue_comment', command)).body).toMatchObject({
      status: 'duplicate',
    });

    const registry = await until(status, (value) => value.jobs[0]?.status === 'finished');
    expect(github.comments.map((entry) => entry.body)).toEqual([
      expect.stringContaining('Approved by `octo-admin`'),
    ]);
    const changed = await enrollment();
    expect(registry.jobs[0].receipt).toMatchObject({
      status: 'needs-review',
      message: expect.stringContaining('Approved repository inputs changed: .refit.json'),
    });
    // A ping wakes the loop, which refreshes the issue the job flagged.
    await deliver(url, 'ping', { zen: 'Keep it logically awesome.' });
    await until(
      async () => github.comments.length,
      (count) => count === 2,
    );
    expect(github.comments[1].body).toContain('changed after it was approved');
    expect(github.issues.get(1)).toMatchObject({
      title: 'Approve Refit for this repository',
      state: 'open',
    });
    expect(github.issues.get(1)!.body).toContain(enrollmentReviewText(changed));
    expect((await status()).approvals.issues[0]).toMatchObject({
      state: 'review',
      fingerprint: changed.fingerprint,
      shown: [reviewed.fingerprint, changed.fingerprint],
    });
    // Only the one human comment became a command; the bot's comment was never recorded.
    expect((await status()).approvals.commands).toEqual([
      expect.objectContaining({ author: 'octo-admin', outcome: APPROVAL_OUTCOMES.approved }),
    ]);
    expect(transport.calls.some((call) => call.binary === 'docker')).toBe(false);
  },
  60_000,
);

it.skipIf(!DATABASE)(
  'ignores issue comments and opens no issues unless REFIT_HOSTED_APPROVAL_ISSUES is on',
  async () => {
    const root = await repository();
    const pool = await database();
    const { url, status } = await serve(pool, root, false);
    expect((await deliver(url, 'installation', installation)).status).toBe(202);
    expect(
      (await deliver(url, 'issue_comment', approveComment('/refit approve 0123456789ab', 7))).body,
    ).toMatchObject({ status: 'ignored' });
    const registry = await status();
    expect(registry.approvals).toBeUndefined();
    expect(
      (await pool.query('SELECT count(*)::int AS count FROM refit_approval_commands')).rows[0],
    ).toEqual({ count: 0 });
    expect(github.issues.size).toBe(0);
  },
  60_000,
);
