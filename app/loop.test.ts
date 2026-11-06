// The whole app loop with recorded webhook payloads: only GitHub's API and the orchestrator are fake.
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BehindItem,
  DependencyUsage,
  ExternalChange,
  ExternalTask,
  RunRecord,
  ScanRepo,
} from '../shared/types.ts';
import { createJobRunner } from './jobs.ts';
import { createOpenPullRequest, findPullRequestFor } from './pr.ts';
import { createFileQueue } from './queue.ts';
import type { FileQueue } from './queue.ts';
import { createReportStore } from './reports.ts';
import { createWebhookServer } from './server.ts';
import { isIgnored, readRepoSettings } from './settings.ts';
import type { InstallationTokens, RunTasks } from './types.ts';

const SECRET = 'test-webhook-secret';
const REPO = 'refit-example-org/billing-api'; // the repo in the recorded payloads
const PR_URL = `https://github.com/${REPO}/pull/41`;
const ORIGINAL = '{ "engines": { "node": "18" } }\n';
const UPGRADED = '{ "engines": { "node": "22" } }\n';

// Illustrative: the shape O1's scan returns for a runtime end of life.
const DEPENDENCY: DependencyUsage = {
  repo: REPO,
  kind: 'runtime',
  name: 'node',
  version: '18',
  declaredIn: [{ file: 'package.json', line: 1 }],
};
const CHANGE: ExternalChange = {
  provider: 'node',
  id: 'node-18-eol',
  kind: 'runtime-eol',
  title: 'Upgrade node 18 → 22',
  source: { url: 'https://example.com/illustrative', quote: 'Illustrative quote.' },
  affects: {},
  dependencyKind: 'runtime',
  dependency: 'node',
  toVersion: '22',
};
const TASK: ExternalTask = {
  id: `${REPO}:node-18-eol`,
  repo: REPO,
  change: CHANGE,
  usages: [],
  dependencies: [DEPENDENCY],
  priority: 1,
};
const ITEM: BehindItem = { repo: REPO, dependency: DEPENDENCY, change: CHANGE, status: 'open' };

const raw = (name: string) => readFileSync(new URL(`fixtures/${name}.json`, import.meta.url));
const sign = (body: Buffer) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;

// A checkout: a real git repo, so the PR opener applies a real diff to it.
function fakeCheckout(settings?: string) {
  return async (_token: string, _repo: string, dir: string) => {
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@e', ...args]);
    git('init', '--quiet');
    writeFileSync(join(dir, 'package.json'), ORIGINAL);
    if (settings) writeFileSync(join(dir, '.refit.yml'), settings);
    git('add', '.');
    git('commit', '--quiet', '-m', 'init');
  };
}

const realDiff = async (dir: string) => {
  writeFileSync(join(dir, 'package.json'), UPGRADED);
  const diff = execFileSync('git', ['-C', dir, 'diff']).toString();
  execFileSync('git', ['-C', dir, 'checkout', '--quiet', '.']);
  return diff;
};

// GitHub as far as the opener touches it. `merged` makes the PR lookup answer with a merged PR.
function fakeGitHub() {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  const state = { pulls: [] as { html_url: string; state: string; merged_at: string | null }[] };
  const fetchImpl: typeof fetch = async (input, init) => {
    const path = String(input).replace('https://api.github.com', '');
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      path,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    });
    const ok = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    if (method === 'GET' && path.includes('/pulls?')) return ok(state.pulls);
    if (method === 'GET' && path === `/repos/${REPO}`) return ok({ default_branch: 'main' });
    if (path.includes('/git/ref/heads/main')) return ok({ object: { sha: 'base-sha' } });
    if (path.includes('/git/commits/base-sha')) return ok({ tree: { sha: 'tree-sha' } });
    if (path.endsWith('/git/trees')) return ok({ sha: 'new-tree' });
    if (path.endsWith('/git/commits')) return ok({ sha: 'new-commit' });
    if (path.endsWith('/git/refs')) return ok({});
    if (method === 'POST' && path.endsWith('/pulls')) {
      state.pulls = [{ html_url: PR_URL, state: 'open', merged_at: null }];
      return ok({ html_url: PR_URL, number: 41 });
    }
    throw new Error(`unexpected GitHub call: ${method} ${path}`);
  };
  return { calls, state, fetchImpl };
}

let dir: string;
let server: Server | undefined;
let queue: FileQueue | undefined;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  dir = mkdtempSync(join(tmpdir(), 'refit-loop-'));
});
afterEach(async () => {
  queue?.close();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  queue = undefined;
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

async function startApp({ settings }: { settings?: string } = {}) {
  const github = fakeGitHub();
  const tokens: InstallationTokens = { token: async () => 'ghs_test_installation_token' };
  const reports = createReportStore(join(dir, 'reports'));
  const verdicts: [string, string][] = [];
  const notified: RunRecord[][] = [];
  const scans: string[] = [];
  const runs: string[] = [];
  const scanRepo: ScanRepo = async (repo) => {
    scans.push(repo);
    return {
      report: {
        repo,
        scannedAt: '2026-11-06T00:00:00.000Z',
        items: [ITEM],
        costUsd: 0,
        errors: [],
      },
      tasks: [TASK],
    };
  };
  const runTasks: RunTasks = async ({ dir: checkout, tasks, openPullRequest }) => {
    const [task] = tasks;
    runs.push(task.id);
    const record: RunRecord = {
      taskId: task.id,
      outcome: 'verified',
      diff: await realDiff(checkout),
      checks: [],
      costUsd: 0,
      transcriptPath: '',
    };
    return [{ ...record, pr: await openPullRequest(task, record, checkout) }];
  };
  queue = await createFileQueue(
    join(dir, 'queue.json'),
    createJobRunner({
      tokens,
      checkout: fakeCheckout(settings),
      scanRepo,
      runTasks,
      openPullRequestFor: (id) => createOpenPullRequest(tokens, id, github.fetchImpl),
      findPullRequest: (id, task) => findPullRequestFor(tokens, id, github.fetchImpl)(task),
      beforeOpenPullRequest: async () => ({}),
      refreshConflicts: async () => {},
      notifyRun: async ({ records }) => void notified.push(records),
      readSettings: readRepoSettings,
      isIgnored,
      reports,
      enqueue: (job) => queue!.enqueue(job),
    }),
    {
      concurrency: 2,
      retries: 0,
      onForget: (job) =>
        job.repo ? reports.remove(job.repo) : reports.removeInstallation(job.installationId),
    },
  );
  server = createWebhookServer({
    webhookSecret: SECRET,
    tokens,
    listRepos: async () => [REPO],
    compareCommits: async () => [],
    pullDiff: async () => '',
    queue,
    recordVerdict: async (pr, human) => {
      verdicts.push([pr, human]);
      await reports.markVerdict(pr, human);
    },
    listRunViews: async () => [],
    viewerRepos: async () => [],
    isServiceToken: () => false,
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const deliver = async (event: string, name: string) => {
    const body = raw(name);
    const response = await fetch(`http://127.0.0.1:${port}/webhooks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': event,
        'X-GitHub-Delivery': '00000000-0000-4000-8000-000000000001',
        'X-Hub-Signature-256': sign(body),
      },
      body,
    });
    expect(response.status).toBe(202);
  };
  const settled = async () => {
    await vi.waitFor(() => expect(queue!.pending()).toEqual([]), { timeout: 5000 });
    await queue!.idle();
  };
  return { github, reports, verdicts, notified, scans, runs, deliver, settled };
}

describe('the app loop', () => {
  it('install → scan → stored report → draft PR → merged verdict → re-scan → uninstall', async () => {
    const app = await startApp();

    await app.deliver('installation', 'installation.created');
    await vi.waitFor(() => expect(app.runs).toEqual([TASK.id]), { timeout: 5000 });
    await app.settled();

    expect(app.scans).toEqual([REPO]);
    const pull = app.github.calls.find((c) => c.method === 'POST' && c.path.endsWith('/pulls'));
    expect(pull?.body).toMatchObject({ draft: true, base: 'main', title: CHANGE.title });
    expect(String(pull?.body?.head)).toMatch(/^refit\//);
    const ref = app.github.calls.find((c) => c.path.endsWith('/git/refs'));
    expect(String(ref?.body?.ref)).toMatch(/^refs\/heads\/refit\//);
    const tree = app.github.calls.find((c) => c.path.endsWith('/git/trees'));
    expect(tree?.body?.tree).toEqual([
      { path: 'package.json', mode: '100644', type: 'blob', content: UPGRADED },
    ]);
    expect(app.github.calls.some((c) => c.path.includes('/merge'))).toBe(false);
    expect(app.notified.filter((records) => records.length > 0)).toHaveLength(1);
    expect((await app.reports.latest(REPO))?.items[0]).toMatchObject({
      status: 'pr-open',
      pr: PR_URL,
    });

    await app.deliver('pull_request', 'pull_request.closed.merged');
    await vi.waitFor(() => expect(app.verdicts).toEqual([[PR_URL, 'merged']]));
    await vi.waitFor(async () =>
      expect((await app.reports.latest(REPO))?.items[0].status).toBe('merged'),
    );

    // The same finding after a push: its PR already exists, so no second run pays for it.
    app.github.state.pulls = [
      { html_url: PR_URL, state: 'closed', merged_at: '2026-11-06T01:00:00Z' },
    ];
    await app.deliver('push', 'push.default-branch');
    await vi.waitFor(() => expect(app.scans).toHaveLength(2), { timeout: 5000 });
    await app.settled();
    expect(app.runs).toEqual([TASK.id]);
    expect((await app.reports.latest(REPO))?.items[0]).toMatchObject({
      status: 'merged',
      pr: PR_URL,
    });

    await app.deliver('installation', 'installation.deleted');
    await vi.waitFor(async () => expect(await app.reports.list()).toEqual([]));
  });

  it("a push to another branch and a human branch's PR change nothing", async () => {
    const app = await startApp();
    await app.deliver('push', 'push.other-branch');
    await app.deliver('pull_request', 'pull_request.closed.human-branch');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await app.settled();
    expect(app.scans).toEqual([]);
    expect(app.verdicts).toEqual([]);
  });

  it('a repo paused in .refit.yml scans nothing and opens no PR', async () => {
    const app = await startApp({ settings: 'paused: true\n' });
    await app.deliver('push', 'push.default-branch');
    await vi.waitFor(() => expect(queue!.pending()).toHaveLength(0), { timeout: 5000 });
    await app.settled();
    expect(app.scans).toEqual([]);
    expect(app.runs).toEqual([]);
    expect(await app.reports.list()).toEqual([]);
  });

  it('a dependency ignored in .refit.yml gets no report item and no run', async () => {
    const app = await startApp({ settings: 'ignore:\n  - NODE\n' });
    await app.deliver('push', 'push.default-branch');
    await vi.waitFor(() => expect(app.scans).toHaveLength(1), { timeout: 5000 });
    await app.settled();
    expect(app.runs).toEqual([]);
    expect((await app.reports.latest(REPO))?.items).toEqual([]);
  });
});
