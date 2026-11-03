// Runs the advisory reviewer again on PRs a past run produced, from their result files, so a change
// to the reviewer can be measured on real diffs for cents. Grades are never touched.
import { BudgetExceededError as RunBudgetRefusal } from '../../orchestrator/budget.ts';
import type { ApiUsage, MigrationTask } from '../../shared/types.ts';
import { BudgetExceededError } from '../runner/budget.ts';
import type { CheckoutRepo, Meter, RepoResult, ReviewPr, TaskResult } from '../runner/types.ts';
import type { AdvisoryReview } from './reviewer.ts';

export type Rereview = {
  repo: string;
  taskId: string;
  grade: string;
  first?: AdvisoryReview;
  second?: AdvisoryReview;
  /** Why this PR was not reviewed again. */
  skipped?: string;
};

/** The task a result came from, rebuilt from what the result file kept. */
export function taskFromResult(repo: RepoResult, task: TaskResult): MigrationTask | undefined {
  if (!task.change) return undefined;
  const usage: ApiUsage = {
    repo: repo.repo,
    provider: task.change.provider,
    via: 'sdk',
    callSites: (task.callSites ?? []).map((site) => ({
      file: site.file,
      line: site.line,
      operation: site.why ?? 'named by the match agent',
    })),
  };
  return {
    id: task.taskId,
    repo: repo.repo,
    change: task.change,
    usages: [usage],
    priority: 1,
    ...(task.reasoning ? { notes: task.reasoning } : {}),
  };
}

/**
 * Reviews every PR with a diff in the results again, one checkout per repo. A result written
 * before results kept their change is skipped and says so. Stops at the first budget refusal.
 */
export async function rereview(
  results: RepoResult[],
  deps: { review: ReviewPr; checkout: CheckoutRepo; meter: (repo: string) => Meter; only?: string },
): Promise<Rereview[]> {
  const out: Rereview[] = [];
  for (const repo of results) {
    const tasks = repo.tasks.filter(
      (task) =>
        task.record &&
        task.record.diff.trim() !== '' &&
        (!deps.only || task.taskId.includes(deps.only)),
    );
    if (tasks.length === 0) continue;
    const reviewable = tasks.filter((task) => task.change);
    for (const task of tasks.filter((t) => !t.change)) {
      out.push({
        repo: repo.repo,
        taskId: task.taskId,
        grade: task.record?.outcome ?? 'unknown',
        ...(task.review ? { first: task.review } : {}),
        skipped: 'the result file has no change for this task (written before results kept it)',
      });
    }
    if (reviewable.length === 0) continue;
    const checkout = await deps.checkout({ repo: repo.repo, commit: repo.commit });
    try {
      for (const task of reviewable) {
        const migrationTask = taskFromResult(repo, task);
        if (!migrationTask || !task.record) continue;
        const second = await deps.review({
          task: migrationTask,
          record: task.record,
          meter: deps.meter(repo.repo),
          repoDir: checkout.repoDir,
        });
        out.push({
          repo: repo.repo,
          taskId: task.taskId,
          grade: task.record.outcome,
          ...(task.review ? { first: task.review } : {}),
          second,
        });
      }
    } catch (error) {
      // The cap: the meter's own, or the run budget refusing a review's worst case.
      if (!(error instanceof BudgetExceededError || error instanceof RunBudgetRefusal)) throw error;
      out.push({ repo: repo.repo, taskId: '', grade: '', skipped: error.message });
      return out;
    } finally {
      await checkout.cleanup().catch(() => undefined);
    }
  }
  return out;
}

/** first and second opinion side by side, one line per PR. */
export function formatRereviews(rows: Rereview[]): string {
  const lines = [
    '| PR | Grade | First | Second | Cost |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map(
      (row) =>
        `| ${row.taskId || row.repo} | ${row.grade} | ${row.first?.opinion ?? '-'} | ${
          row.second?.opinion ?? `skipped: ${row.skipped ?? ''}`
        } | ${row.second ? `$${row.second.costUsd.toFixed(4)}` : '-'} |`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}
