// The orchestrator's entry points: runRepoJob for the GitHub App, scanRepo for the "what's behind" report.
import type { ExternalTask, RunRepoJob, ScanRepo } from '../shared/types.ts';
import { createBudget, type Budget } from './budget.ts';
import { createDeps } from './deps.ts';
import { runOrg, scanTarget, watchOrg, type LoopDeps, type RunState } from './loop.ts';
import { apiAsExternalTask, watchExternalOrg, type ScanItemReport } from './scan.ts';

// inventory → watch → match → harness → the caller's PR opener → record, for one repo.
export function createRunRepoJob(
  deps: Omit<LoopDeps, 'openPullRequest'>,
  capUsd?: number,
): RunRepoJob {
  return async ({ repo, dir, openPullRequest, dryRun }) => {
    const summary = await runOrg(
      { name: repo, repos: [{ repo, dir }] },
      { ...deps, openPullRequest },
      { dryRun, capUsd },
    );
    // No records and errors would read as "nothing changed", so the job fails with the errors instead.
    if (summary.records.length === 0 && summary.errors.length > 0)
      throw new Error(`no run records for ${repo}: ${summary.errors.join('; ')}`);
    return summary.records;
  };
}

// inventory → watch → match for one repo, with nothing attempted: the report, and every task in one
// shape (API tasks carry dependencyKind 'api'), most urgent first.
export function createScanRepo(
  deps: Omit<LoopDeps, 'openPullRequest'>,
): (...args: Parameters<ScanRepo>) => Promise<{ report: ScanItemReport; tasks: ExternalTask[] }> {
  return async (repo, dir) => {
    const state: RunState = { costUsd: 0, errors: [] };
    const full: LoopDeps = { ...deps, openPullRequest: async () => '' };
    const watch = watchOrg(full, {}, state);
    const watchExternal = deps.external && watchExternalOrg(deps.external, deps, {}, state);
    const scan = await scanTarget({ repo, dir }, watch, watchExternal || undefined, full, state);
    const byId = new Map<string, ExternalTask>([
      ...scan.external.tasks.map((t) => [t.id, t] as const),
      ...scan.api.tasks.map((t) => [t.id, apiAsExternalTask(t)] as const),
    ]);
    // The report's rows are already ranked; the tasks follow them.
    const order = [...new Set(scan.report.items.flatMap((i) => (i.taskId ? [i.taskId] : [])))];
    const tasks = order.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    tasks.forEach((task, i) => (task.priority = i + 1));
    return { report: scan.report, tasks };
  };
}

let shared: { deps: Omit<LoopDeps, 'openPullRequest'>; budget?: Budget } | undefined;

// Every job in this process shares one run budget (REFIT_AI_BUDGET_USD) and one queue, so jobs
// the app runs at once can never each spend the cap. Without ANTHROPIC_API_KEY, offline stubs stand in.
function sharedDeps() {
  if (!shared) {
    const budget = process.env.ANTHROPIC_API_KEY ? createBudget() : undefined;
    shared = { deps: createDeps({ budget }), budget };
  }
  return shared;
}

let job: RunRepoJob | undefined;
export const runRepoJob: RunRepoJob = (input) => {
  if (!job) {
    const { deps, budget } = sharedDeps();
    job = createRunRepoJob(deps, budget?.capUsd);
  }
  return job(input);
};

let scanner: ReturnType<typeof createScanRepo> | undefined;
export const scanRepo: ScanRepo = (repo, dir) => {
  scanner ??= createScanRepo(sharedDeps().deps);
  return scanner(repo, dir);
};
