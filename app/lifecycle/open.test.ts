import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExternalTask, MigrationTask, RunRecord } from '../../shared/types.ts';
import { GitHubApiError } from '../github.ts';
import { EmptyChangeError, UnsafeBranchError } from '../pr.ts';
import {
  API,
  OPEN_PULLS,
  REPO,
  describeCalls,
  expectOnlySafeWrites,
  fakeGitHub,
  pullFixture,
  pullUrl,
  writesOf,
} from './fixtures/fake-github.ts';
import type { Route } from './fixtures/fake-github.ts';
import { formatMarker, parseMarker } from './marker.ts';
import type { LifecycleMarker } from './marker.ts';
import { createBeforeOpenPullRequest, createFindOpenPullRequest, isOlderTarget } from './open.ts';

const INSTALLATION = 42;
const tokens = { token: vi.fn(async () => 'inst-token') };

const USAGE = { repo: REPO, kind: 'runtime' as const, name: 'node', declaredIn: [] };

const nodeTask = (toVersion: string | undefined = '22', kind = 'runtime-eol'): ExternalTask =>
  ({
    id: `task-node-${toVersion}`,
    repo: REPO,
    change: {
      provider: 'node',
      id: `node-change-${toVersion}`,
      kind,
      dependencyKind: 'runtime',
      dependency: 'node',
      toVersion,
      title: `Move Node to ${toVersion}`,
      source: { url: 'https://example.com/illustrative', quote: 'Illustrative.' },
      affects: {},
    },
    usages: [],
    dependencies: [USAGE],
    priority: 1,
  }) as ExternalTask;

const PLAIN_TASK: MigrationTask = {
  id: 'task-plain',
  repo: REPO,
  change: {
    provider: 'stripe',
    id: 'stripe-field-removed-a',
    kind: 'field-removed',
    title: 'Stop reading a removed field',
    source: { url: 'https://example.com/illustrative', quote: 'Illustrative.' },
    affects: {},
  },
  usages: [],
  priority: 1,
};

const markerFor = (target: string, overrides: Partial<LifecycleMarker> = {}): LifecycleMarker => ({
  dependency: 'node',
  kind: 'runtime-eol',
  target,
  changeId: `node-change-${target}`,
  ...overrides,
});

const checkouts: string[] = [];
afterEach(() => {
  for (const dir of checkouts.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A real repo so filesFromDiff runs for real: billing.ts changes and legacy.ts is deleted.
function checkout() {
  const dir = mkdtempSync(join(tmpdir(), 'refit-lifecycle-'));
  checkouts.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@localhost');
  writeFileSync(join(dir, 'billing.ts'), 'old\n');
  writeFileSync(join(dir, 'legacy.ts'), 'legacy\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  writeFileSync(join(dir, 'billing.ts'), 'new\n');
  rmSync(join(dir, 'legacy.ts'));
  const diff = git('diff');
  const forward = git('diff', '--', 'billing.ts');
  git('checkout', '-q', '.');
  return { dir, diff, forward };
}

const recordWith = (diff: string, prBody?: string): RunRecord & { prBody?: string } => ({
  taskId: 'task',
  outcome: 'verified',
  diff,
  checks: [],
  costUsd: 0,
  transcriptPath: '',
  ...(prBody === undefined ? {} : { prBody }),
});

const BOT_COMMIT = { parents: [{}], author: { type: 'Bot' } };
const PERSON_COMMIT = { parents: [{}], author: { type: 'User' } };

function updateRoutes(
  pulls: ReturnType<typeof pullFixture>[],
  target: ReturnType<typeof pullFixture>,
  commits: unknown[] = [BOT_COMMIT],
  overrides: Record<string, Route> = {},
): Record<string, Route> {
  const { sha, ref } = target.head;
  return {
    [OPEN_PULLS]: { body: pulls },
    [`GET ${API}/compare/main...${sha}`]: { body: { commits } },
    [`GET ${API}/git/ref/heads/main`]: { body: { object: { sha: 'base-tip' } } },
    [`GET ${API}/git/commits/base-tip`]: { body: { tree: { sha: 'base-tree' } } },
    [`GET ${API}/git/commits/${sha}`]: { body: { tree: { sha: 'head-tree' } } },
    [`POST ${API}/git/trees`]: { status: 201, body: { sha: 'new-tree' } },
    [`POST ${API}/git/commits`]: { status: 201, body: { sha: 'new-commit' } },
    [`PATCH ${API}/git/refs/heads/${ref}`]: { body: {} },
    [`PATCH ${API}/pulls/${target.number}`]: { body: {} },
    [`POST ${API}/issues/${target.number}/comments`]: { status: 201, body: {} },
    ...overrides,
  };
}

const bodyOf = (github: ReturnType<typeof fakeGitHub>, method: string, path: string) =>
  github.calls.find((call) => call.method === method && call.path === `${API}${path}`)?.body as
    Record<string, unknown> | undefined;

describe('isOlderTarget', () => {
  it.each([
    ['20.1', '22', true],
    ['22', '20.1', false],
    ['9', '10', true],
    ['1.9', '1.10', true],
    ['1.10', '1.9', false],
    ['2024-10-28.acacia', '2025-01-27.acacia', true],
    ['2025-01-27.acacia', '2024-10-28.acacia', false],
    ['22', '22.0', false],
    ['22.0', '22', false],
    ['v20', '22', true],
    ['gpt-4o', 'gpt-5', false],
    ['gpt-5', 'gpt-4o', false],
    ['latest', '22', false],
    ['22', 'latest', false],
  ])('%s older than %s: %s', (target, than, expected) => {
    expect(isOlderTarget(target, than)).toBe(expected);
  });
});

describe('createBeforeOpenPullRequest', () => {
  const run = (
    github: ReturnType<typeof fakeGitHub>,
    task: MigrationTask | ExternalTask,
    record: RunRecord,
    repoDir: string,
  ) =>
    createBeforeOpenPullRequest({ tokens, fetchImpl: github.fetchImpl })({
      installationId: INSTALLATION,
      task,
      record,
      repoDir,
    });

  it('updates the open PR for the same dependency and target with a merge commit and opens nothing', async () => {
    const { dir, diff } = checkout();
    const pull = pullFixture({ number: 7, body: `Old.\n\n${formatMarker(markerFor('22'))}` });
    const github = fakeGitHub(updateRoutes([pull], pull));

    const result = await run(github, nodeTask('22'), recordWith(diff, 'Harness body.'), dir);

    expect(result).toEqual({ pr: pullUrl(7) });
    expect(tokens.token).toHaveBeenCalledWith(INSTALLATION);
    expect(describeCalls(writesOf(github.calls))).toEqual([
      `POST ${API}/git/trees`,
      `POST ${API}/git/commits`,
      `PATCH ${API}/git/refs/heads/refit/pull-7`,
      `PATCH ${API}/pulls/7`,
      `POST ${API}/issues/7/comments`,
    ]);
    expect(bodyOf(github, 'POST', '/git/trees')).toEqual({
      base_tree: 'base-tree',
      tree: [
        { path: 'billing.ts', mode: '100644', type: 'blob', content: 'new\n' },
        { path: 'legacy.ts', mode: '100644', type: 'blob', sha: null },
      ],
    });
    expect(bodyOf(github, 'POST', '/git/commits')).toEqual({
      message: 'chore(node): Move Node to 22',
      tree: 'new-tree',
      parents: ['head-7', 'base-tip'],
    });
    expect(bodyOf(github, 'PATCH', '/git/refs/heads/refit/pull-7')).toEqual({
      sha: 'new-commit',
      force: false,
    });
    const patched = bodyOf(github, 'PATCH', '/pulls/7');
    expect(patched?.title).toBe('Move Node to 22');
    expect(patched?.body).toContain('Harness body.');
    expect(parseMarker(patched?.body as string)).toEqual(markerFor('22'));
    expect(bodyOf(github, 'POST', '/issues/7/comments')?.body).toContain('node 22 again');
    expectOnlySafeWrites(github.calls, ['refit/pull-7']);
  });

  it('matches the same dependency and target across kinds', async () => {
    const { dir, diff } = checkout();
    const pull = pullFixture({
      number: 7,
      body: formatMarker(markerFor('22', { kind: 'security-fix' })),
    });
    const github = fakeGitHub(updateRoutes([pull], pull));
    expect(await run(github, nodeTask('22'), recordWith(diff), dir)).toEqual({ pr: pullUrl(7) });
    expectOnlySafeWrites(github.calls, ['refit/pull-7']);
  });

  it("builds on the head's own tree when a person committed, and says so", async () => {
    const { dir, diff } = checkout();
    const pull = pullFixture({ number: 7, body: formatMarker(markerFor('22')) });
    const github = fakeGitHub(updateRoutes([pull], pull, [BOT_COMMIT, PERSON_COMMIT]));

    await run(github, nodeTask('22'), recordWith(diff), dir);

    expect(bodyOf(github, 'POST', '/git/trees')?.base_tree).toBe('head-tree');
    expect(bodyOf(github, 'POST', '/git/commits')?.parents).toEqual(['head-7']);
    const comment = bodyOf(github, 'POST', '/issues/7/comments')?.body as string;
    expect(comment).toContain('those commits stay');
    expect(comment).toContain("Refit's version");
    expectOnlySafeWrites(github.calls, ['refit/pull-7']);
  });

  it.each([
    ['a person', [PERSON_COMMIT], ['head-7']],
    ['an author GitHub cannot link', [{ parents: [{}], author: null }], ['head-7']],
    ['a bot', [BOT_COMMIT], ['head-7', 'base-tip']],
    [
      "a person's merge commit",
      [{ parents: [{}, {}], author: { type: 'User' } }],
      ['head-7', 'base-tip'],
    ],
  ])('picks commit parents for %s', async (_, commits, parents) => {
    const { dir, diff } = checkout();
    const pull = pullFixture({ number: 7, body: formatMarker(markerFor('22')) });
    const github = fakeGitHub(updateRoutes([pull], pull, commits));
    await run(github, nodeTask('22'), recordWith(diff), dir);
    expect(bodyOf(github, 'POST', '/git/commits')?.parents).toEqual(parents);
  });

  it('moves the PR to a newer target in place and names both targets', async () => {
    const { dir, diff } = checkout();
    const pull = pullFixture({ number: 7, body: formatMarker(markerFor('20.1')) });
    const github = fakeGitHub(updateRoutes([pull], pull));

    const result = await run(github, nodeTask('22'), recordWith(diff), dir);

    expect(result).toEqual({ pr: pullUrl(7) });
    expect(parseMarker(bodyOf(github, 'PATCH', '/pulls/7')?.body as string)).toEqual(
      markerFor('22'),
    );
    expect(bodyOf(github, 'PATCH', '/pulls/7')?.title).toBe('Move Node to 22');
    const comment = bodyOf(github, 'POST', '/issues/7/comments')?.body as string;
    expect(comment).toContain('from 20.1 to 22');
    expect(comment).toContain('supersedes');
    expect(bodyOf(github, 'POST', '/git/commits')?.parents).toEqual(['head-7', 'base-tip']);
    expectOnlySafeWrites(github.calls, ['refit/pull-7']);
  });

  it("keeps a person's commits when a newer target takes over the PR", async () => {
    const { dir, diff } = checkout();
    const pull = pullFixture({ number: 7, body: formatMarker(markerFor('20')) });
    const github = fakeGitHub(updateRoutes([pull], pull, [BOT_COMMIT, PERSON_COMMIT]));

    await run(github, nodeTask('22'), recordWith(diff), dir);

    expect(bodyOf(github, 'POST', '/git/commits')?.parents).toEqual(['head-7']);
    expect(bodyOf(github, 'POST', '/git/trees')?.base_tree).toBe('head-tree');
    expect(bodyOf(github, 'PATCH', '/git/refs/heads/refit/pull-7')?.force).toBe(false);
    expect(bodyOf(github, 'POST', '/issues/7/comments')?.body).toContain('those commits stay');
    expectOnlySafeWrites(github.calls, ['refit/pull-7']);
  });

  it('moves only the most recently updated PR when several qualify', async () => {
    const { dir, diff } = checkout();
    const newest = pullFixture({ number: 8, body: formatMarker(markerFor('21')) });
    const oldest = pullFixture({ number: 7, body: formatMarker(markerFor('20')) });
    const github = fakeGitHub(updateRoutes([newest, oldest], newest));

    expect(await run(github, nodeTask('22'), recordWith(diff), dir)).toEqual({ pr: pullUrl(8) });

    expectOnlySafeWrites(github.calls, ['refit/pull-8']);
    expect(describeCalls(github.calls).filter((call) => call.includes('/7'))).toEqual([]);
  });

  it('prefers the PR with the same target over one it could supersede', async () => {
    const { dir, diff } = checkout();
    const older = pullFixture({ number: 8, body: formatMarker(markerFor('20')) });
    const same = pullFixture({ number: 7, body: formatMarker(markerFor('22')) });
    const github = fakeGitHub(updateRoutes([older, same], same));
    expect(await run(github, nodeTask('22'), recordWith(diff), dir)).toEqual({ pr: pullUrl(7) });
    expectOnlySafeWrites(github.calls, ['refit/pull-7']);
  });

  it.each([
    ['an older target than the open PR', '20', markerFor('22')],
    ['another kind on the same dependency', '22', markerFor('21', { kind: 'security-fix' })],
    ['another dependency', '22', markerFor('21', { dependency: 'python' })],
    [
      'an open PR whose target is only its change id',
      '22',
      markerFor('field-a', { changeId: 'field-a' }),
    ],
  ])('leaves the PR alone and hands the marked body to P1 for %s', async (_, target, marker) => {
    const { dir, diff } = checkout();
    const pull = pullFixture({ number: 7, body: formatMarker(marker) });
    const github = fakeGitHub({ [OPEN_PULLS]: { body: [pull] } });
    const record = recordWith(diff, 'Harness body.');

    expect(await run(github, nodeTask(target), record, dir)).toEqual({});

    expect(writesOf(github.calls), JSON.stringify(github.calls)).toEqual([]);
    expect(record.prBody).toContain('Harness body.');
    expect(parseMarker(record.prBody as string)).toEqual(markerFor(target));
  });

  it('does not let one id-only change replace another on the same provider and kind', async () => {
    const { dir, diff } = checkout();
    const other = markerFor('stripe-field-removed-b', {
      dependency: 'stripe',
      kind: 'field-removed',
      changeId: 'stripe-field-removed-b',
    });
    const pull = pullFixture({ number: 7, body: formatMarker(other) });
    const github = fakeGitHub({ [OPEN_PULLS]: { body: [pull] } });

    expect(await run(github, PLAIN_TASK, recordWith(diff), dir)).toEqual({});
    expect(writesOf(github.calls), JSON.stringify(github.calls)).toEqual([]);
  });

  it('mutates the record P1 passes to its opener, with the same fallback body as app/pr.ts', async () => {
    const github = fakeGitHub({ [OPEN_PULLS]: { body: [] } });
    const record = recordWith('');

    expect(await run(github, PLAIN_TASK, record, '/nonexistent')).toEqual({});

    const body = (record as { prBody?: string }).prBody as string;
    expect(body).toContain(
      'Stop reading a removed field\n\nSource: https://example.com/illustrative',
    );
    expect(parseMarker(body)).toEqual({
      dependency: 'stripe',
      kind: 'field-removed',
      target: 'stripe-field-removed-a',
      changeId: 'stripe-field-removed-a',
    });
  });

  it('marks the record before any request, so a PR P1 opens after a failed hook is still matched', async () => {
    const github = fakeGitHub({ [OPEN_PULLS]: { status: 500, body: { message: 'boom' } } });
    const record = recordWith('');
    await expect(run(github, nodeTask('22'), record, '/nonexistent')).rejects.toBeInstanceOf(
      GitHubApiError,
    );
    expect(parseMarker(record.prBody as string)).toEqual(markerFor('22'));
  });

  it('keeps a malicious dependency name inside the comment on the way through a task', async () => {
    const github = fakeGitHub({ [OPEN_PULLS]: { body: [] } });
    const task = nodeTask('22');
    task.change.dependency = 'x --> <script>alert(1)</script>';
    const record = recordWith('', 'Body.');

    await run(github, task, record, '/nonexistent');

    const body = record.prBody as string;
    expect(body.indexOf('-->'), body).toBe(body.length - '-->'.length);
    expect(parseMarker(body)?.dependency).toBe('x --> <script>alert(1)</script>');
  });

  it.each([
    ['a fork that names its branch refit/', { headRepo: 'someone/fork' }],
    ['a person-named branch', { ref: 'feature/node-22' }],
  ])('never touches %s, even with a matching marker', async (_, options) => {
    const { dir, diff } = checkout();
    const pull = pullFixture({ number: 7, body: formatMarker(markerFor('22')), ...options });
    const github = fakeGitHub({ [OPEN_PULLS]: { body: [pull] } });
    expect(await run(github, nodeTask('22'), recordWith(diff), dir)).toEqual({});
    expect(writesOf(github.calls), JSON.stringify(github.calls)).toEqual([]);
  });

  it.each([
    ['no marker', 'A person wrote this.'],
    ['an unparsable marker', '<!-- refit:lifecycle {broken -->'],
    ['no body', null],
  ])('does not match an open Refit PR with %s', async (_, body) => {
    const { dir, diff } = checkout();
    const github = fakeGitHub({ [OPEN_PULLS]: { body: [pullFixture({ number: 7, body })] } });
    expect(await run(github, nodeTask('22'), recordWith(diff), dir)).toEqual({});
    expect(writesOf(github.calls), JSON.stringify(github.calls)).toEqual([]);
  });

  it('throws EmptyChangeError before any write when the diff nets out to no files', async () => {
    const { dir, forward } = checkout();
    // The same file changed and changed back: git applies both and the index matches HEAD.
    const backward = forward
      .replace('-old\n+new\n', '-new\n+old\n')
      .replace(/^index .*$/m, 'index 0000000..0000000 100644');
    const pull = pullFixture({ number: 7, body: formatMarker(markerFor('22')) });
    const github = fakeGitHub(updateRoutes([pull], pull));

    await expect(
      run(github, nodeTask('22'), recordWith(`${forward}${backward}`), dir),
    ).rejects.toBeInstanceOf(EmptyChangeError);

    expect(writesOf(github.calls), JSON.stringify(github.calls)).toEqual([]);
  });

  it('throws UnsafeBranchError before any write when the head is the base', async () => {
    const { dir, diff } = checkout();
    const pull = {
      ...pullFixture({ number: 7, ref: 'refit/main', body: formatMarker(markerFor('22')) }),
      base: { ref: 'refit/main', sha: 'base-tip' },
    };
    const github = fakeGitHub({ [OPEN_PULLS]: { body: [pull] } });
    await expect(run(github, nodeTask('22'), recordWith(diff), dir)).rejects.toBeInstanceOf(
      UnsafeBranchError,
    );
    expect(writesOf(github.calls), JSON.stringify(github.calls)).toEqual([]);
  });

  it('stops at a rejected fast-forward, leaving the PR and its comments untouched', async () => {
    const { dir, diff } = checkout();
    const pull = pullFixture({ number: 7, body: formatMarker(markerFor('22')) });
    const github = fakeGitHub(
      updateRoutes([pull], pull, [BOT_COMMIT], {
        [`PATCH ${API}/git/refs/heads/refit/pull-7`]: {
          status: 422,
          body: { message: 'Update is not a fast forward' },
        },
      }),
    );
    await expect(run(github, nodeTask('22'), recordWith(diff), dir)).rejects.toMatchObject({
      status: 422,
    });
    expect(bodyOf(github, 'PATCH', '/pulls/7')).toBeUndefined();
    expect(bodyOf(github, 'POST', '/issues/7/comments')).toBeUndefined();
    expectOnlySafeWrites(github.calls, ['refit/pull-7']);
  });
});

describe('createFindOpenPullRequest', () => {
  const find = (github: ReturnType<typeof fakeGitHub>, task: MigrationTask | ExternalTask) =>
    createFindOpenPullRequest({ tokens, fetchImpl: github.fetchImpl })(INSTALLATION, task);

  it('finds the open PR with the same dependency and target, whatever branch it is on', async () => {
    const pull = pullFixture({
      number: 7,
      ref: 'refit/another-task',
      body: formatMarker(markerFor('22', { kind: 'security-fix', changeId: 'other' })),
    });
    const github = fakeGitHub({ [OPEN_PULLS]: { body: [pull] } });
    expect(await find(github, nodeTask('22'))).toEqual({ url: pullUrl(7), state: 'open' });
    expect(writesOf(github.calls)).toEqual([]);
  });

  it.each([
    ['a newer target, so the task still runs', '24', markerFor('22')],
    ['an older target', '20', markerFor('22')],
    ['another dependency', '22', markerFor('22', { dependency: 'python' })],
  ])('returns undefined for %s', async (_, target, marker) => {
    const pull = pullFixture({ number: 7, body: formatMarker(marker) });
    const github = fakeGitHub({ [OPEN_PULLS]: { body: [pull] } });
    expect(await find(github, nodeTask(target))).toBeUndefined();
  });

  it('ignores a fork and an unmarked PR', async () => {
    const github = fakeGitHub({
      [OPEN_PULLS]: {
        body: [
          pullFixture({ number: 7, headRepo: 'someone/fork', body: formatMarker(markerFor('22')) }),
          pullFixture({ number: 8, body: 'No marker.' }),
        ],
      },
    });
    expect(await find(github, nodeTask('22'))).toBeUndefined();
  });

  it('matches a plain MigrationTask by provider and change id', async () => {
    const marker = {
      dependency: 'stripe',
      kind: 'field-removed',
      target: PLAIN_TASK.change.id,
      changeId: PLAIN_TASK.change.id,
    };
    const pull = pullFixture({ number: 7, body: formatMarker(marker) });
    const github = fakeGitHub({ [OPEN_PULLS]: { body: [pull] } });
    expect(await find(github, PLAIN_TASK)).toEqual({ url: pullUrl(7), state: 'open' });
  });
});

describe('expectOnlySafeWrites', () => {
  const call = (method: string, path: string, body?: unknown) => ({
    method,
    path,
    body,
    authorization: '',
  });

  it.each([
    ['a forced ref write', call('PATCH', `${API}/git/refs/heads/refit/x`, { force: true })],
    ['a write to main', call('PATCH', `${API}/git/refs/heads/main`, { force: false })],
    ['a close', call('PATCH', `${API}/pulls/1`, { state: 'closed' })],
    ['a merge', call('PUT', `${API}/pulls/1/merge`)],
    ['a branch deletion', call('DELETE', `${API}/git/refs/heads/refit/x`)],
    ['a new PR', call('POST', `${API}/pulls`, {})],
  ])('catches %s', (_, bad) => {
    expect(() => expectOnlySafeWrites([bad], ['refit/x'])).toThrow();
  });
});
