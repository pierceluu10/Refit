import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpenPullRequest, RunRepoJob } from '../shared/types.ts';
import type { InstallationTokens, UnderstandJob } from './types.ts';

export type JobRunnerDeps = {
  tokens: InstallationTokens;
  runRepoJob: RunRepoJob;
  checkout: (token: string, repo: string, dir: string) => Promise<void>;
  openPullRequestFor: (installationId: number) => OpenPullRequest;
  // Looks for fixed entries back in the checkout. `at` is from before the clone.
  rescan: (job: UnderstandJob, dir: string, at: string) => Promise<void>;
};

// One job: a fresh checkout, the whole loop on it, then the checkout is deleted. The app only reads
// the checkout; the orchestrator's harness runs repo code in its Docker sandbox.
export function createJobRunner(deps: JobRunnerDeps) {
  return async (job: UnderstandJob): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), 'aptitude-checkout-'));
    const at = new Date().toISOString();
    try {
      await deps.checkout(await deps.tokens.token(job.installationId), job.repo, dir);
      try {
        await deps.rescan(job, dir, at);
      } catch (error) {
        // Learning from a rescan never stands between a repo and its fix.
        const message = error instanceof Error ? error.message : String(error);
        console.error(`rescan of ${job.repo} failed: ${message}`);
      }
      // runRepoJob throws when a job has errors and no records; the queue logs that as a failed job.
      const records = await deps.runRepoJob({
        repo: job.repo,
        dir,
        openPullRequest: deps.openPullRequestFor(job.installationId),
      });
      const outcomes = records.map((record) => `${record.taskId} ${record.outcome}`);
      console.log(`ran ${job.repo}: ${outcomes.join(', ') || 'no provider changes'}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
