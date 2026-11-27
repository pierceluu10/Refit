import { describe, expect, it, vi } from 'vitest';
import { GITHUB_API, GitHubApiError } from './github.ts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExternalTask, MigrationTask, RunRecord } from '../shared/types.ts';
import {
  EmptyChangeError,
  UnsafeBranchError,
  branchFor,
  createOpenPullRequest,
  findPullRequestFor,
  openPullRequest,
} from './pr.ts';
import type { InstallationTokens, OpenPullRequestInput } from './types.ts';

const INSTALLATION = 42;
const REPO = '/repos/acme/shop';

type Call = { method: string; path: string; body: unknown; authorization: string };
type Reply = { status?: number; body: unknown };

function fakeGitHub(overrides: Record<string, Reply> = {}) {
  const routes: Record<string, Reply> = {
    [`GET ${REPO}`]: { body: { default_branch: 'main' } },
    [`GET ${REPO}/git/ref/heads/main`]: { body: { object: { sha: 'base-sha' } } },
    [`GET ${REPO}/git/ref/heads/release/v2`]: { body: { object: { sha: 'release-sha' } } },
    [`GET ${REPO}/git/commits/base-sha`]: { body: { tree: { sha: 'base-tree' } } },
    [`GET ${REPO}/git/commits/release-sha`]: { body: { tree: { sha: 'release-tree' } } },
    [`POST ${REPO}/git/trees`]: { status: 201, body: { sha: 'new-tree' } },
    [`POST ${REPO}/git/commits`]: { status: 201, body: { sha: 'new-commit' } },
    [`POST ${REPO}/git/refs`]: { status: 201, body: { ref: 'refs/heads/x' } },
    [`POST ${REPO}/pulls`]: {
      status: 201,
      body: { html_url: 'https://github.com/acme/shop/pull/9', number: 9 },
    },
    ...overrides,
  };
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).slice(GITHUB_API.length);
    const method = init?.method ?? 'GET';
    const headers = init?.headers as Record<string, string>;
    calls.push({
      method,
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      authorization: headers.Authorization,
    });
    const reply = routes[`${method} ${path}`];
    if (!reply)
      throw new Error(`unrouted ${method} ${path}; calls so far: ${JSON.stringify(calls)}`);
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const tokens: InstallationTokens = { token: async () => 'inst-token' };

const input = (overrides: Partial<OpenPullRequestInput> = {}): OpenPullRequestInput => ({
  repo: 'acme/shop',
  branch: 'refit/stripe-2026-10',
  title: 'Upgrade Stripe API version',
  body: 'Illustrative body',
  commitMessage: 'chore: upgrade stripe',
  files: [
    { path: 'src/billing.ts', content: 'export const version = "2026-10-01";\n' },
    { path: 'src/legacy.ts', delete: true },
  ],
  ...overrides,
});

describe('openPullRequest', () => {
  it('builds a commit on the default branch and opens a draft PR', async () => {
    const github = fakeGitHub();
    const token = vi.fn(tokens.token);
    const opened = await openPullRequest({ token }, INSTALLATION, input(), github.fetchImpl);

    expect(opened).toEqual({
      url: 'https://github.com/acme/shop/pull/9',
      number: 9,
      branch: 'refit/stripe-2026-10',
      sha: 'new-commit',
    });
    expect(token).toHaveBeenCalledWith(INSTALLATION);
    expect(github.calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `GET ${REPO}`,
      `GET ${REPO}/git/ref/heads/main`,
      `GET ${REPO}/git/commits/base-sha`,
      `POST ${REPO}/git/trees`,
      `POST ${REPO}/git/commits`,
      `POST ${REPO}/git/refs`,
      `POST ${REPO}/pulls`,
    ]);
    expect(github.calls.every((call) => call.authorization === 'Bearer inst-token')).toBe(true);
    const bodies = github.calls.map((call) => call.body);
    expect(bodies[3]).toEqual({
      base_tree: 'base-tree',
      tree: [
        {
          path: 'src/billing.ts',
          mode: '100644',
          type: 'blob',
          content: 'export const version = "2026-10-01";\n',
        },
        { path: 'src/legacy.ts', mode: '100644', type: 'blob', sha: null },
      ],
    });
    expect(bodies[4]).toEqual({
      message: 'chore: upgrade stripe',
      tree: 'new-tree',
      parents: ['base-sha'],
    });
    expect(bodies[5]).toEqual({ ref: 'refs/heads/refit/stripe-2026-10', sha: 'new-commit' });
    expect(bodies[6]).toEqual({
      title: 'Upgrade Stripe API version',
      body: 'Illustrative body',
      head: 'refit/stripe-2026-10',
      base: 'main',
      draft: true,
    });
  });

  it('uses an explicit base without looking up the repo and honours draft false', async () => {
    const github = fakeGitHub();
    await openPullRequest(
      tokens,
      INSTALLATION,
      input({ base: 'release/v2', draft: false }),
      github.fetchImpl,
    );
    const paths = github.calls.map(({ method, path }) => `${method} ${path}`);
    expect(paths).not.toContain(`GET ${REPO}`);
    expect(paths[0]).toBe(`GET ${REPO}/git/ref/heads/release/v2`);
    expect(github.calls[2].body).toMatchObject({ base_tree: 'release-tree' });
    expect(github.calls[3].body).toMatchObject({ parents: ['release-sha'] });
    expect(github.calls.at(-1)?.body).toMatchObject({ base: 'release/v2', draft: false });
  });

  it.each([
    ['branch without the prefix', input({ branch: 'stripe-upgrade' }), UnsafeBranchError],
    ['the prefix only as a substring', input({ branch: 'x/refit/y' }), UnsafeBranchError],
    [
      'branch equal to the base',
      input({ branch: 'refit/main', base: 'refit/main' }),
      UnsafeBranchError,
    ],
    ['no files', input({ files: [] }), EmptyChangeError],
  ])('rejects %s before any request', async (_, request, errorClass) => {
    const github = fakeGitHub();
    await expect(
      openPullRequest(tokens, INSTALLATION, request, github.fetchImpl),
    ).rejects.toBeInstanceOf(errorClass);
    expect(github.calls, JSON.stringify(github.calls)).toEqual([]);
  });

  it('rejects a branch equal to the default branch before any write', async () => {
    const github = fakeGitHub({
      [`GET ${REPO}`]: { body: { default_branch: 'refit/stripe-2026-10' } },
    });
    await expect(
      openPullRequest(tokens, INSTALLATION, input(), github.fetchImpl),
    ).rejects.toBeInstanceOf(UnsafeBranchError);
    expect(github.calls.map(({ method, path }) => `${method} ${path}`)).toEqual([`GET ${REPO}`]);
  });

  it('propagates GitHubApiError when the branch already exists and opens no PR', async () => {
    const github = fakeGitHub({
      [`POST ${REPO}/git/refs`]: { status: 422, body: { message: 'Reference already exists' } },
    });
    const error = await openPullRequest(tokens, INSTALLATION, input(), github.fetchImpl).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({ status: 422, method: 'POST', path: `${REPO}/git/refs` });
    expect((error as Error).message).toContain('Reference already exists');
    expect(github.calls.map((call) => call.path)).not.toContain(`${REPO}/pulls`);
  });
});

describe('branchFor', () => {
  it('slugs the task id under refit/', () => {
    expect(branchFor('acme/shop:Stripe 2026-10 / api_version')).toBe(
      'refit/acme-shop-stripe-2026-10-api-version',
    );
    expect(branchFor('x'.repeat(200))).toHaveLength('refit/'.length + 80);
  });
});

describe('createOpenPullRequest', () => {
  const OPEN_PULLS = `GET ${REPO}/pulls?state=open&head=${encodeURIComponent('acme:refit/task-1')}`;
  const TASK = {
    id: 'task-1',
    repo: 'acme/shop',
    change: {
      provider: 'stripe',
      id: 'illustrative-change',
      kind: 'api-version',
      title: 'Upgrade Stripe API version',
      source: { url: 'https://example.com/changelog', quote: 'Illustrative.' },
      affects: {},
    },
    usages: [],
    priority: 1,
  } satisfies MigrationTask;

  function checkout() {
    const dir = mkdtempSync(join(tmpdir(), 'refit-pr-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@localhost');
    writeFileSync(join(dir, 'billing.ts'), 'old\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    writeFileSync(join(dir, 'billing.ts'), 'new\n');
    const diff = git('diff');
    git('checkout', '-q', '.');
    return { dir, diff };
  }

  it("opens a verified run ready for review on refit/<slug> with the record's diff and prBody", async () => {
    const { dir, diff } = checkout();
    try {
      const github = fakeGitHub({ [OPEN_PULLS]: { body: [] } });
      const record: RunRecord & { prBody: string } = {
        taskId: 'task-1',
        outcome: 'verified',
        diff,
        checks: [],
        costUsd: 0,
        transcriptPath: '',
        prBody: 'Illustrative PR body from the harness.',
      };
      const open = createOpenPullRequest(tokens, INSTALLATION, github.fetchImpl);
      expect(await open(TASK, record, dir)).toBe('https://github.com/acme/shop/pull/9');
      const body = (method: string, path: string) =>
        github.calls.find((call) => call.method === method && call.path === `${REPO}${path}`)?.body;
      expect(body('POST', '/git/trees')).toMatchObject({
        tree: [{ path: 'billing.ts', content: 'new\n' }],
      });
      expect(body('POST', '/git/refs')).toEqual({
        ref: 'refs/heads/refit/task-1',
        sha: 'new-commit',
      });
      expect(body('POST', '/pulls')).toEqual({
        title: 'Upgrade Stripe API version',
        body: 'Illustrative PR body from the harness.',
        head: 'refit/task-1',
        base: 'main',
        draft: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opens a needs-review run as a draft', async () => {
    const { dir, diff } = checkout();
    try {
      const github = fakeGitHub({ [OPEN_PULLS]: { body: [] } });
      const record: RunRecord = {
        taskId: 'task-1',
        outcome: 'needs-review',
        diff,
        checks: [],
        costUsd: 0,
        transcriptPath: '',
      };
      await createOpenPullRequest(tokens, INSTALLATION, github.fetchImpl)(TASK, record, dir);
      const pull = github.calls.find(
        (call) => call.method === 'POST' && call.path.endsWith('/pulls'),
      );
      expect(pull?.body).toMatchObject({ draft: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("titles the PR with the harness's prTitle when it wrote one", async () => {
    const { dir, diff } = checkout();
    try {
      const github = fakeGitHub({ [OPEN_PULLS]: { body: [] } });
      const record: RunRecord & { prTitle: string } = {
        taskId: 'task-1',
        outcome: 'needs-review',
        diff,
        checks: [],
        costUsd: 0,
        transcriptPath: '',
        prTitle: 'Upgrade node 18 → 22',
      };
      await createOpenPullRequest(tokens, INSTALLATION, github.fetchImpl)(TASK, record, dir);
      expect(github.calls.at(-1)?.body).toMatchObject({ title: 'Upgrade node 18 → 22' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the open PR for the same task instead of opening another', async () => {
    const github = fakeGitHub({
      [OPEN_PULLS]: { body: [{ html_url: 'https://github.com/acme/shop/pull/7' }] },
    });
    const record = {
      taskId: 'task-1',
      outcome: 'verified',
      diff: '',
      checks: [],
      costUsd: 0,
      transcriptPath: '',
    } satisfies RunRecord;
    const open = createOpenPullRequest(tokens, INSTALLATION, github.fetchImpl);
    expect(await open(TASK, record, '/nonexistent')).toBe('https://github.com/acme/shop/pull/7');
    expect(github.calls.map((call) => call.method)).toEqual(['GET']);
  });
});

describe('findPullRequestFor', () => {
  const ALL_PULLS = `GET ${REPO}/pulls?state=all&head=${encodeURIComponent('acme:refit/task-1')}`;
  const TASK = { id: 'task-1', repo: 'acme/shop' } as ExternalTask;
  const pull = (number: number, state: string, merged_at: string | null = null) => ({
    html_url: `https://github.com/acme/shop/pull/${number}`,
    state,
    merged_at,
  });
  const find = (pulls: unknown[]) =>
    findPullRequestFor(
      tokens,
      INSTALLATION,
      fakeGitHub({ [ALL_PULLS]: { body: pulls } }).fetchImpl,
    )(TASK);

  it('returns nothing when the branch has no PR', async () => {
    expect(await find([])).toBeUndefined();
  });

  it('prefers open, then merged, then closed, whatever order GitHub returns', async () => {
    const merged = pull(2, 'closed', '2026-11-01T00:00:00Z');
    expect(await find([pull(1, 'closed'), merged, pull(3, 'open')])).toEqual({
      url: 'https://github.com/acme/shop/pull/3',
      state: 'open',
    });
    expect(await find([pull(1, 'closed'), merged])).toEqual({
      url: 'https://github.com/acme/shop/pull/2',
      state: 'merged',
    });
    expect(await find([pull(4, 'closed'), pull(1, 'closed')])).toEqual({
      url: 'https://github.com/acme/shop/pull/4',
      state: 'closed',
    });
  });
});
