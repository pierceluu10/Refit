// The orchestrator's entry point for the GitHub App: the whole loop on one checked-out repo.
import type { RunRepoJob } from '../shared/types.ts';
import { createBudget } from './budget.ts';
import { createDeps } from './deps.ts';
import { runOrg, type LoopDeps } from './loop.ts';

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
    return summary.records;
  };
}

let shared: RunRepoJob | undefined;

// Every job in this process shares one run budget (APTITUDE_AI_BUDGET_USD) and one queue, so jobs
// the app runs at once can never each spend the cap. Without ANTHROPIC_API_KEY, offline stubs stand in.
export const runRepoJob: RunRepoJob = (input) => {
  if (!shared) {
    const budget = process.env.ANTHROPIC_API_KEY ? createBudget() : undefined;
    shared = createRunRepoJob(createDeps({ budget }), budget?.capUsd);
  }
  return shared(input);
};
