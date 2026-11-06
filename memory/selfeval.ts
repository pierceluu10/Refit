import type { RunExternalTask, RunTask } from '../shared/types.ts';
import { BudgetExceededError } from './ai.ts';
import type { MemoryStore } from './store.ts';
import type { AnyTask, SelfEvalReport, StoredRun } from './types.ts';
import { isExternalTask } from './upgrade.ts';

// Reruns a fixed set of past tasks with today's memory to see whether learning helps.
// Running happens in the injected RunTask, which owns the sandbox.
export async function runSelfEval({
  store,
  runTask,
  runExternalTask,
  prepareRepo,
  size = 5,
  now = () => new Date(),
}: {
  store: MemoryStore;
  runTask: RunTask;
  // Reruns an upgrade or other external task. Without it, those tasks are reported as not rerun.
  runExternalTask?: RunExternalTask;
  // A working copy of the repo at the run's commit. Throwing BudgetExceededError ends the reruns.
  prepareRepo: (task: AnyTask, run: StoredRun) => Promise<string>;
  size?: number;
  now?: () => Date;
}): Promise<SelfEvalReport> {
  const ranAt = now().toISOString();
  // Only runs the harness attempted, which have a transcript: rerunning a match verdict tests no memory.
  const runs = (await store.listRuns())
    .filter((run) => run.transcript)
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));

  let taskIds = await store.getSelfEvalTaskIds();
  if (!taskIds) {
    taskIds = [...new Set(runs.map((run) => run.task.id))].slice(0, size);
    // An empty set would lock every later night to nothing, so wait until there are runs.
    if (taskIds.length > 0) await store.setSelfEvalTaskIds(taskIds);
  }

  const results: SelfEvalReport['results'] = [];
  const notes: string[] = [];
  let costUsd = 0;
  let withoutCommit = 0;
  for (const [index, taskId] of taskIds.entries()) {
    const latest = runs.filter((run) => run.task.id === taskId).at(-1);
    if (!latest) continue;
    const { task } = latest;
    if (isExternalTask(task) && !runExternalTask) {
      notes.push(
        `${taskId} is an external task and no runExternalTask was given, so it was not rerun.`,
      );
      continue;
    }
    let after: SelfEvalReport['results'][number]['after'];
    try {
      const dir = await prepareRepo(task, latest);
      const record = isExternalTask(task)
        ? await runExternalTask!(task, dir)
        : await runTask(task, dir);
      costUsd += record.costUsd;
      after = record.outcome;
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        // Left out of both rates rather than counted as failures, so the comparison stays like for like.
        notes.push(
          `Stopped before ${taskIds.length - index} of ${taskIds.length} tasks: ${error.message}`,
        );
        break;
      }
      after = 'error';
    }
    if (!latest.commit) withoutCommit++;
    results.push({ taskId, before: latest.record.outcome, after });
  }
  if (withoutCommit) {
    notes.push(
      `${withoutCommit} rerun${withoutCommit === 1 ? '' : 's'} used today's code, since the original commit was not recorded.`,
    );
  }

  const rate = (key: 'before' | 'after') =>
    results.length ? results.filter((r) => r[key] === 'verified').length / results.length : 0;
  const verifiedRateBefore = rate('before');
  const verifiedRateAfter = rate('after');
  // A self-eval that reran nothing has no rate to compare against.
  const previousVerifiedRate = (await store.listSelfEvals())
    .filter((report) => report.ranAt < ranAt && report.results.length > 0)
    .sort((a, b) => a.ranAt.localeCompare(b.ranAt))
    .at(-1)?.verifiedRateAfter;

  const report: SelfEvalReport = {
    id: `selfeval-${ranAt}`,
    ranAt,
    taskIds: results.map((r) => r.taskId),
    results,
    verifiedRateBefore,
    verifiedRateAfter,
    ...(previousVerifiedRate === undefined ? {} : { previousVerifiedRate }),
    costUsd,
    summary: summarise(results, verifiedRateBefore, verifiedRateAfter, previousVerifiedRate, notes),
  };
  await store.saveSelfEval(report);
  return report;
}

function summarise(
  results: SelfEvalReport['results'],
  before: number,
  after: number,
  previous: number | undefined,
  notes: string[],
): string {
  const pct = (rate: number) => Math.round(rate * 100);
  const errors = results.filter((r) => r.after === 'error').length;
  const delta = pct(after) - pct(before);
  const first = results.length
    ? `Verified rate moved from ${pct(before)}% to ${pct(after)}% (${delta >= 0 ? '+' : ''}${delta} pts) on ${results.length} past tasks${errors ? `, ${errors} of which errored` : ''}.`
    : 'No past tasks to rerun yet.';
  const last = previous === undefined ? [] : [`Previous self-eval: ${pct(previous)}%.`];
  return [first, ...notes, ...last].join(' ');
}
