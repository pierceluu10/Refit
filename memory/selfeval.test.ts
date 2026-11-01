import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunRecord, RunTask } from '../shared/types.ts';
import { makeRecord, makeTask } from './fixtures/tasks.ts';
import { runSelfEval } from './selfeval.ts';
import { JsonMemoryStore } from './store.ts';

afterEach(() => {
  vi.useRealTimers();
});

async function tempStore() {
  return new JsonMemoryStore(await mkdtemp(join(tmpdir(), 'aptitude-selfeval-')));
}

// Illustrative history: records runs at fixed times so "oldest first" is deterministic.
async function record(
  store: JsonMemoryStore,
  taskId: string,
  outcome: RunRecord['outcome'],
  at: string,
) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(at));
  await store.recordRun({
    task: makeTask({ id: taskId }),
    record: makeRecord({ taskId, outcome }),
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
});
