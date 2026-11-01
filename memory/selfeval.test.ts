import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunRecord, RunTask } from '../shared/types.ts';
import { BudgetExceededError, LocalEmbedder, type JsonRequest, type Model } from './ai.ts';
import { makeRecipe, makeRecord, makeTask } from './fixtures/tasks.ts';
import { createRetriever } from './retrieve.ts';
import { runSelfEval } from './selfeval.ts';
import { JsonMemoryStore } from './store.ts';

afterEach(() => {
  vi.useRealTimers();
});

async function tempStore() {
  return new JsonMemoryStore(await mkdtemp(join(tmpdir(), 'aptitude-selfeval-')));
}

// Illustrative history: records harness runs at fixed times so "oldest first" is deterministic.
async function record(
  store: JsonMemoryStore,
  taskId: string,
  outcome: RunRecord['outcome'],
  at: string,
  stored: { transcript?: string; commit?: string } = {},
) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(at));
  await store.recordRun({
    task: makeTask({ id: taskId }),
    record: makeRecord({ taskId, outcome }),
    transcript: 'harness transcript',
    commit: 'abc1234',
    ...stored,
  });
  vi.useRealTimers();
}

function fakeRunTask(outcomes: Record<string, RunRecord['outcome'] | Error>) {
  return vi.fn<RunTask>(async (task) => {
    const outcome = outcomes[task.id] ?? 'verified';
    if (outcome instanceof Error) throw outcome;
    return makeRecord({ taskId: task.id, outcome, costUsd: 0.5 });
  });
}

const prepareRepo = async () => '/sandbox/repo';
const night = (iso: string) => () => new Date(iso);

describe('runSelfEval', () => {
  it('picks the oldest tasks, persists the set and reuses it on later nights', async () => {
    const store = await tempStore();
    await record(store, 'task-c', 'failed', '2026-10-03T00:00:00.000Z');
    await record(store, 'task-a', 'failed', '2026-10-01T00:00:00.000Z');
    await record(store, 'task-b', 'verified', '2026-10-02T00:00:00.000Z');

    const first = await runSelfEval({
      store,
      runTask: fakeRunTask({}),
      prepareRepo,
      size: 2,
      now: night('2026-11-01T03:00:00.000Z'),
    });
    expect(first.taskIds).toEqual(['task-a', 'task-b']);
    expect(await store.getSelfEvalTaskIds()).toEqual(['task-a', 'task-b']);

    await record(store, 'task-new', 'failed', '2026-09-01T00:00:00.000Z');
    const runTask = fakeRunTask({});
    const second = await runSelfEval({
      store,
      runTask,
      prepareRepo,
      size: 2,
      now: night('2026-11-02T03:00:00.000Z'),
    });
    expect(second.taskIds).toEqual(['task-a', 'task-b']);
    expect(runTask.mock.calls.map(([task]) => task.id)).toEqual(['task-a', 'task-b']);
  });

  it('computes before and after rates and the previous rate across two nights', async () => {
    const store = await tempStore();
    await record(store, 'task-a', 'failed', '2026-10-01T00:00:00.000Z');
    await record(store, 'task-b', 'verified', '2026-10-02T00:00:00.000Z');
    await record(store, 'task-a', 'needs-review', '2026-10-05T00:00:00.000Z');

    const first = await runSelfEval({
      store,
      runTask: fakeRunTask({ 'task-b': 'failed' }),
      prepareRepo,
      now: night('2026-11-01T03:00:00.000Z'),
    });
    expect(first.results).toEqual([
      { taskId: 'task-a', before: 'needs-review', after: 'verified' },
      { taskId: 'task-b', before: 'verified', after: 'failed' },
    ]);
    expect(first.verifiedRateBefore).toBe(0.5);
    expect(first.verifiedRateAfter).toBe(0.5);
    expect(first.previousVerifiedRate).toBeUndefined();
    expect(first.costUsd).toBe(1);

    const second = await runSelfEval({
      store,
      runTask: fakeRunTask({}),
      prepareRepo,
      now: night('2026-11-02T03:00:00.000Z'),
    });
    expect(second.verifiedRateAfter).toBe(1);
    expect(second.previousVerifiedRate).toBe(0.5);
    expect(second.summary).toBe(
      'Verified rate moved from 50% to 100% (+50 pts) on 2 past tasks. Previous self-eval: 50%.',
    );
    expect((await store.listSelfEvals()).map((report) => report.id)).toEqual([
      'selfeval-2026-11-01T03:00:00.000Z',
      'selfeval-2026-11-02T03:00:00.000Z',
    ]);
  });

  it('marks a throwing rerun as error, continues, and records no reruns as runs', async () => {
    const store = await tempStore();
    await record(store, 'task-a', 'verified', '2026-10-01T00:00:00.000Z');
    await record(store, 'task-b', 'verified', '2026-10-02T00:00:00.000Z');
    const runTask = fakeRunTask({ 'task-a': new Error('sandbox crashed') });

    const report = await runSelfEval({ store, runTask, prepareRepo });

    expect(report.results.map((r) => r.after)).toEqual(['error', 'verified']);
    expect(report.verifiedRateAfter).toBe(0.5);
    expect(report.summary).toContain('1 of which errored');
    expect(runTask).toHaveBeenCalledTimes(2);
    expect(await store.listRuns()).toHaveLength(2);
  });

  it('respects size and skips set tasks that are no longer stored', async () => {
    const store = await tempStore();
    for (let day = 1; day <= 7; day++) {
      await record(store, `task-${day}`, 'failed', `2026-10-0${day}T00:00:00.000Z`);
    }
    expect((await runSelfEval({ store, runTask: fakeRunTask({}), prepareRepo })).taskIds).toEqual([
      'task-1',
      'task-2',
      'task-3',
      'task-4',
      'task-5',
    ]);

    await store.setSelfEvalTaskIds(['task-1', 'task-gone']);
    const report = await runSelfEval({ store, runTask: fakeRunTask({}), prepareRepo });
    expect(report.taskIds).toEqual(['task-1']);
  });

  it('leaves out stored verdicts the harness never ran', async () => {
    const store = await tempStore();
    await record(store, 'match-verdict', 'not-affected', '2026-10-01T00:00:00.000Z', {
      transcript: '',
    });
    await record(store, 'task-a', 'failed', '2026-10-02T00:00:00.000Z');

    const report = await runSelfEval({ store, runTask: fakeRunTask({}), prepareRepo });

    expect(report.taskIds).toEqual(['task-a']);
  });

  it('hands prepareRepo the run, so the rerun can use its commit, and says when none was recorded', async () => {
    const store = await tempStore();
    await record(store, 'task-a', 'failed', '2026-10-01T00:00:00.000Z');
    await record(store, 'task-b', 'failed', '2026-10-02T00:00:00.000Z', { commit: undefined });
    const commits: (string | undefined)[] = [];

    const report = await runSelfEval({
      store,
      runTask: fakeRunTask({}),
      prepareRepo: async (_task, run) => {
        commits.push(run.commit);
        return '/sandbox/repo';
      },
    });

    expect(commits).toEqual(['abc1234', undefined]);
    expect(report.summary).toContain(
      "1 rerun used today's code, since the original commit was not recorded.",
    );
  });

  it('stops at the budget and leaves the tasks it did not rerun out of both rates', async () => {
    const store = await tempStore();
    await record(store, 'task-a', 'verified', '2026-10-01T00:00:00.000Z');
    await record(store, 'task-b', 'failed', '2026-10-02T00:00:00.000Z');
    await record(store, 'task-c', 'failed', '2026-10-03T00:00:00.000Z');
    let reruns = 0;

    const report = await runSelfEval({
      store,
      runTask: fakeRunTask({}),
      prepareRepo: async () => {
        if (reruns++ === 1) throw new BudgetExceededError('$1.00 of the $3 cap is left');
        return '/sandbox/repo';
      },
    });

    expect(report.results).toEqual([{ taskId: 'task-a', before: 'verified', after: 'verified' }]);
    expect(report.verifiedRateBefore).toBe(1);
    expect(report.summary).toContain('Stopped before 2 of 3 tasks: $1.00 of the $3 cap is left');
  });

  it("reruns with today's memory: a recipe learned since the original run moves the rate", async () => {
    const store = await tempStore();
    await record(store, 'task-a', 'failed', '2026-10-01T00:00:00.000Z');
    await store.saveRecipe(makeRecipe());
    // Fake model: the retrieval judge picks the stored recipe.
    const model: Model = {
      async json<T>(_request: JsonRequest) {
        return { picks: [{ id: 'recipe-stripe-charges', why: 'same change' }] } as T;
      },
    };
    const retrieve = createRetriever({ store, embedder: new LocalEmbedder(), model });
    // Fake harness: it verifies only when memory hands it a recipe.
    const runTask: RunTask = async (task) => {
      const recipes = await retrieve(task);
      return makeRecord({ taskId: task.id, outcome: recipes.length ? 'verified' : 'failed' });
    };

    const report = await runSelfEval({ store, runTask, prepareRepo });

    expect(report.results).toEqual([{ taskId: 'task-a', before: 'failed', after: 'verified' }]);
    expect(report.summary).toBe('Verified rate moved from 0% to 100% (+100 pts) on 1 past tasks.');
  });

  it('compares against the last self-eval that reran something', async () => {
    const store = await tempStore();
    const empty = await runSelfEval({
      store,
      runTask: fakeRunTask({}),
      prepareRepo,
      now: night('2026-11-01T03:00:00.000Z'),
    });
    expect(empty.summary).toBe('No past tasks to rerun yet.');
    await record(store, 'task-a', 'failed', '2026-11-01T12:00:00.000Z');

    const first = await runSelfEval({
      store,
      runTask: fakeRunTask({}),
      prepareRepo,
      now: night('2026-11-02T03:00:00.000Z'),
    });

    expect(first.previousVerifiedRate).toBeUndefined();
  });
});
