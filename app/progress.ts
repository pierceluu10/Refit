import { redactSecrets } from '../harness/secrets.ts';
import { logged } from './jobs.ts';
import type { ReportStore } from './reports.ts';
import type { QueuedJob } from './types.ts';

// Marks a report that holds no findings because the scan itself never finished.
export const SCAN_FAILED = 'The scan couldn’t finish';

type RunJob = (job: QueuedJob, signal: AbortSignal) => Promise<void>;

// The queue knows what's waiting; this adds what's running now and leaves a report when a scan fails.
export function trackJobs(run: RunJob, reports: ReportStore) {
  const active = new Map<QueuedJob, Promise<void>>();

  async function attempt(job: QueuedJob, signal: AbortSignal) {
    try {
      await run(job, signal);
    } catch (error) {
      // Saved on every failed try: a later try that works replaces it, and the last one is what stays.
      if (job.kind === 'scan' && !signal.aborted) {
        const message = redactSecrets(error instanceof Error ? error.message : String(error));
        await logged(`saving the failed scan of ${job.repo}`, async () => {
          if (await reports.latest(job.repo)) return;
          await reports.save(job.installationId, {
            repo: job.repo,
            scannedAt: new Date().toISOString(),
            items: [],
            costUsd: 0,
            errors: [`${SCAN_FAILED}: ${message}`],
          });
        });
      }
      throw error;
    }
  }

  return {
    run: (job: QueuedJob, signal: AbortSignal) => {
      const work = attempt(job, signal).finally(() => active.delete(job));
      active.set(job, work);
      return work;
    },
    scanning: (repo: string) =>
      [...active.keys()].some((job) => job.kind === 'scan' && job.repo === repo),
    // Resolves when this installation's running jobs have stopped, however they ended.
    settled: async (installationId: number) => {
      const running = [...active].filter(([job]) => job.installationId === installationId);
      await Promise.allSettled(running.map(([, work]) => work));
    },
  };
}
