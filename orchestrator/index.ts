// The orchestrator's entry point for the GitHub App: the whole loop on one checked-out repo.
import type { RunRepoJob } from '../shared/types.ts';
import { createBudget } from './budget.ts';
import { PROPOSED_DIR } from '../dead-apis/proposals.ts';
import { createDeps, deadApiScan } from './deps.ts';
import { runOrg, type LoopDeps } from './loop.ts';

// inventory → watch → match → harness → the caller's PR opener → record, for one repo.
export function createRunRepoJob(
  deps: Omit<LoopDeps, 'openPullRequest'>,
  capUsd?: number,
): RunRepoJob {
  return async ({ repo, dir, openPullRequest, dryRun, scan }) => {
    const summary = await runOrg(
      { name: repo, repos: [{ repo, dir }] },
      { ...deps, openPullRequest, ...(scan && { scan: async () => scan }) },
      { dryRun, capUsd },
    );
    // No records and errors would read as "nothing changed", so the job fails with the errors instead.
    if (summary.records.length === 0 && summary.errors.length > 0)
      throw new Error(`no run records for ${repo}: ${summary.errors.join('; ')}`);
    return summary.records;
  };
}

let shared: RunRepoJob | undefined;

// Every job in this process shares one run budget (APTITUDE_AI_BUDGET_USD) and one queue, so jobs
// the app runs at once can never each spend the cap. Without ANTHROPIC_API_KEY, offline stubs stand in.
export const runRepoJob: RunRepoJob = (input) => {
  if (!shared) {
    const budget = process.env.ANTHROPIC_API_KEY ? createBudget() : undefined;
    const scan = budget && deadApiScan(budget, { storeDir: PROPOSED_DIR });
    shared = createRunRepoJob(createDeps({ budget, ...scan }), budget?.capUsd);
  }
  return shared(input);
};
