import { describe, expect, it, vi } from 'vitest';
import type { MigrationTask, RunRecord } from '../../shared/types.ts';
import type { StoredRun } from '../../memory/types.ts';
import { findTaskForPr, refreshConflicts } from './conflicts.ts';
import type { ConflictDeps } from './conflicts.ts';
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

const INSTALLATION = 42;
const SHA = 'head-7';

const TASK = { id: 'task-1', repo: REPO } as MigrationTask;

const BOT_COMMIT = { parents: [{}], author: { type: 'Bot' } };
const PERSON_COMMIT = { parents: [{}], author: { type: 'User' } };

const CONFLICTED = { number: 7, mergeable: false, mergeableState: 'dirty' };

// Comments persist across calls, as GitHub's do, so once-per-sha is tested against what was posted.
function setup(pull: Route, { commits = [BOT_COMMIT], sha = SHA } = {}) {
  const comments: { body: string }[] = [];
  const github = fakeGitHub({
    [OPEN_PULLS]: { body: [pullFixture({ number: 7 })] },
    [`GET ${API}/pulls/7`]: pull,
    [`GET ${API}/issues/7/comments?per_page=100`]: () => ({ body: comments }),
    [`POST ${API}/issues/7/comments`]: (call) => {
      comments.push(call.body as { body: string });
      return { status: 201, body: {} };
    },
    [`GET ${API}/compare/main...${sha}`]: { body: { commits } },
  });
  const rerun = vi.fn(async () => undefined);
  const findTask = vi.fn(async (): Promise<MigrationTask | undefined> => TASK);
  const sleep = vi.fn(async () => undefined);
  const deps: ConflictDeps = {
    installationId: INSTALLATION,
    tokens: { token: async () => 'inst-token' },
    findTask,
    rerun,
    sleep,
    fetchImpl: github.fetchImpl,
  };
  return { github, comments, rerun, findTask, sleep, deps };
}

describe('refreshConflicts', () => {
  it('re-runs a conflicted PR nobody edited, commenting first', async () => {
    const { github, comments, rerun, findTask, deps } = setup({
      body: pullFixture(CONFLICTED),
    });
    const order: string[] = [];
    rerun.mockImplementation(async () => {
      order.push(`rerun after ${comments.length} comment(s)`);
    });

    expect(await refreshConflicts(REPO, deps)).toEqual({ rerun: [7], blocked: [], unknown: [] });

    expect(findTask).toHaveBeenCalledWith(pullUrl(7));
    expect(rerun).toHaveBeenCalledExactlyOnceWith(TASK);
    expect(order).toEqual(['rerun after 1 comment(s)']);
    expect(comments[0].body).toContain('re-running it on a fresh checkout');
    expect(comments[0].body).toContain(`<!-- refit:conflict ${SHA} -->`);
    expectOnlySafeWrites(github.calls);
  });

  it('reads the sha from the fresh PR, not the list', async () => {
    const fresh = pullFixture({ ...CONFLICTED, sha: 'newer-sha' });
    const { comments, deps } = setup({ body: fresh }, { sha: 'newer-sha' });
    await refreshConflicts(REPO, deps);
    expect(comments[0].body).toContain('<!-- refit:conflict newer-sha -->');
  });

  it("blocks a PR with a person's commits: comments, never re-runs, and looks up no task", async () => {
    const { github, comments, rerun, findTask, deps } = setup(
      { body: pullFixture(CONFLICTED) },
      { commits: [BOT_COMMIT, PERSON_COMMIT] },
    );

    expect(await refreshConflicts(REPO, deps)).toEqual({ rerun: [], blocked: [7], unknown: [] });

    expect(rerun).not.toHaveBeenCalled();
    expect(findTask).not.toHaveBeenCalled();
    expect(comments[0].body).toContain("won't overwrite");
    expectOnlySafeWrites(github.calls);
  });

  it('says so honestly when there is no stored task', async () => {
    const { comments, rerun, findTask, deps } = setup({ body: pullFixture(CONFLICTED) });
    findTask.mockResolvedValue(undefined);

    expect(await refreshConflicts(REPO, deps)).toEqual({ rerun: [], blocked: [7], unknown: [] });

    expect(rerun).not.toHaveBeenCalled();
    expect(comments[0].body).toContain('no stored run');
  });

  it('asks again while mergeable is null, then acts on the answer', async () => {
    const { github, rerun, sleep, deps } = setup([
      { body: pullFixture({ number: 7, mergeable: null, mergeableState: 'unknown' }) },
      { body: pullFixture(CONFLICTED) },
    ]);

    expect(await refreshConflicts(REPO, deps)).toEqual({ rerun: [7], blocked: [], unknown: [] });

    expect(sleep.mock.calls).toEqual([[2000]]);
    expect(
      describeCalls(github.calls).filter((call) => call === `GET ${API}/pulls/7`),
    ).toHaveLength(2);
    expect(rerun).toHaveBeenCalledOnce();
  });

  it('counts a still-null PR as unknown after three attempts and writes nothing', async () => {
    const { github, rerun, sleep, deps } = setup({
      body: pullFixture({ number: 7, mergeable: null, mergeableState: 'unknown' }),
    });

    expect(await refreshConflicts(REPO, deps)).toEqual({ rerun: [], blocked: [], unknown: [7] });

    expect(
      describeCalls(github.calls).filter((call) => call === `GET ${API}/pulls/7`),
    ).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(rerun).not.toHaveBeenCalled();
    expect(writesOf(github.calls)).toEqual([]);
  });

  it('treats a dirty state as a conflict even while mergeable is still null, without waiting', async () => {
    const { rerun, sleep, deps } = setup({
      body: pullFixture({ number: 7, mergeable: null, mergeableState: 'dirty' }),
    });
    expect(await refreshConflicts(REPO, deps)).toEqual({ rerun: [7], blocked: [], unknown: [] });
    expect(sleep).not.toHaveBeenCalled();
    expect(rerun).toHaveBeenCalledOnce();
  });

  it('re-runs once per head sha: a second trigger neither comments nor pays again', async () => {
    const { github, comments, rerun, deps } = setup({ body: pullFixture(CONFLICTED) });

    await refreshConflicts(REPO, deps);
    const second = await refreshConflicts(REPO, deps);

    expect(second).toEqual({ rerun: [], blocked: [], unknown: [] });
    expect(rerun).toHaveBeenCalledOnce();
    expect(comments, JSON.stringify(github.calls)).toHaveLength(1);
  });

  it('re-runs again once the head sha moves and the PR conflicts again', async () => {
    const first = pullFixture(CONFLICTED);
    const moved = pullFixture({ ...CONFLICTED, sha: 'moved-sha' });
    const comments: { body: string }[] = [];
    const github = fakeGitHub({
      [OPEN_PULLS]: { body: [pullFixture({ number: 7 })] },
      [`GET ${API}/pulls/7`]: [{ body: first }, { body: moved }],
      [`GET ${API}/issues/7/comments?per_page=100`]: () => ({ body: comments }),
      [`POST ${API}/issues/7/comments`]: (call) => {
        comments.push(call.body as { body: string });
        return { status: 201 };
      },
      [`GET ${API}/compare/main...${SHA}`]: { body: { commits: [BOT_COMMIT] } },
      [`GET ${API}/compare/main...moved-sha`]: { body: { commits: [BOT_COMMIT] } },
    });
    const rerun = vi.fn(async () => undefined);
    const deps: ConflictDeps = {
      installationId: INSTALLATION,
      tokens: { token: async () => 'inst-token' },
      findTask: async () => TASK,
      rerun,
      fetchImpl: github.fetchImpl,
    };

    await refreshConflicts(REPO, deps);
    await refreshConflicts(REPO, deps);

    expect(rerun).toHaveBeenCalledTimes(2);
    expect(comments).toHaveLength(2);
  });

  it('comments once per sha on a blocked PR but keeps reporting it as blocked', async () => {
    const { comments, deps } = setup(
      { body: pullFixture(CONFLICTED) },
      { commits: [PERSON_COMMIT] },
    );
    await refreshConflicts(REPO, deps);
    expect(await refreshConflicts(REPO, deps)).toEqual({ rerun: [], blocked: [7], unknown: [] });
    expect(comments).toHaveLength(1);
  });

  it('does nothing for a clean PR', async () => {
    const { github, rerun, sleep, findTask, deps } = setup({
      body: pullFixture({ number: 7, mergeable: true, mergeableState: 'clean' }),
    });
    expect(await refreshConflicts(REPO, deps)).toEqual({ rerun: [], blocked: [], unknown: [] });
    expect(rerun).not.toHaveBeenCalled();
    expect(findTask).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(writesOf(github.calls)).toEqual([]);
  });

  it('does not read a non-conflict state such as blocked or behind as a conflict', async () => {
    const { rerun, deps } = setup({
      body: pullFixture({ number: 7, mergeable: true, mergeableState: 'behind' }),
    });
    expect(await refreshConflicts(REPO, deps)).toEqual({ rerun: [], blocked: [], unknown: [] });
    expect(rerun).not.toHaveBeenCalled();
  });
});

describe('findTaskForPr', () => {
  const stored = (id: string, recordedAt: string, pr?: string): StoredRun => ({
    id,
    recordedAt,
    task: { id } as MigrationTask,
    record: { pr } as RunRecord,
    transcript: '',
    usedRecipeIds: [],
  });

  it('returns the task of the latest run for that PR, whatever order the store returns', async () => {
    const find = findTaskForPr(async () => [
      stored('middle', '2026-11-02T00:00:00.000Z', 'url'),
      stored('newest', '2026-11-03T00:00:00.000Z', 'url'),
      stored('other-pr', '2026-11-09T00:00:00.000Z', 'other'),
      stored('oldest', '2026-11-01T00:00:00.000Z', 'url'),
      stored('no-pr', '2026-11-08T00:00:00.000Z'),
    ]);
    expect((await find('url'))?.id).toBe('newest');
  });

  it('returns undefined when no run opened that PR', async () => {
    const find = findTaskForPr(async () => [stored('other', '2026-11-01T00:00:00.000Z', 'other')]);
    expect(await find('url')).toBeUndefined();
  });
});
