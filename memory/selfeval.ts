import type { MigrationTask, RunTask } from '../shared/types.ts';
import type { MemoryStore } from './store.ts';
import type { SelfEvalReport } from './types.ts';

// Reruns a fixed set of past tasks with today's memory to see whether learning helps.
// Running happens in the injected RunTask, which owns the sandbox.
export async function runSelfEval({
  store,
  runTask,
  prepareRepo,
  size = 5,
  now = () => new Date(),
}: {
  store: MemoryStore;
  runTask: RunTask;
  prepareRepo: (task: MigrationTask) => Promise<string>;
  size?: number;
  now?: () => Date;
}): Promise<SelfEvalReport> {
  const ranAt = now().toISOString();
  const runs = (await store.listRuns()).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));

  let taskIds = await store.getSelfEvalTaskIds();
  if (!taskIds) {
    taskIds = [...new Set(runs.map((run) => run.task.id))].slice(0, size);
    // An empty set would lock every later night to nothing, so wait until there are runs.
    if (taskIds.length > 0) await store.setSelfEvalTaskIds(taskIds);
  }

  const results: SelfEvalReport['results'] = [];
  let costUsd = 0;
  for (const taskId of taskIds) {
    const latest = runs.filter((run) => run.task.id === taskId).at(-1);
    if (!latest) continue;
    let after: SelfEvalReport['results'][number]['after'];
    try {
      const record = await runTask(latest.task, await prepareRepo(latest.task));
      costUsd += record.costUsd;
      after = record.outcome;
    } catch {
      after = 'error';
    }
    results.push({ taskId, before: latest.record.outcome, after });
  }

  const rate = (key: 'before' | 'after') =>
    results.length ? results.filter((r) => r[key] === 'verified').length / results.length : 0;
  const verifiedRateBefore = rate('before');
  const verifiedRateAfter = rate('after');
  const previousVerifiedRate = (await store.listSelfEvals())
    .filter((report) => report.ranAt < ranAt)
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
    summary: summarise(results, verifiedRateBefore, verifiedRateAfter, previousVerifiedRate),
  };
  await store.saveSelfEval(report);
  return report;
}

function summarise(
  results: SelfEvalReport['results'],
  before: number,
  after: number,
  previous: number | undefined,
): string {
  const pct = (rate: number) => Math.round(rate * 100);
  const errors = results.filter((r) => r.after === 'error').length;
  const delta = pct(after) - pct(before);
  const first = results.length
    ? `Verified rate moved from ${pct(before)}% to ${pct(after)}% (${delta >= 0 ? '+' : ''}${delta} pts) on ${results.length} past tasks${errors ? `, ${errors} of which errored` : ''}.`
    : 'No past tasks to rerun yet.';
  return previous === undefined ? first : `${first} Previous self-eval: ${pct(previous)}%.`;
}
