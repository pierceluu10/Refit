import type { AppJob, JobQueue, RecordVerdict } from './types.ts';

// shortcut: in-memory and lost on restart, replace with the orchestrator's queue once it lands.
export function createMemoryQueue(): JobQueue & { jobs: AppJob[] } {
  const jobs: AppJob[] = [];
  return {
    jobs,
    async enqueue(job) {
      jobs.push(job);
      console.log(`queued ${job.kind} ${job.repo}`);
    },
  };
}

// shortcut: logs only, replace with memory/'s run store once it lands.
export const logVerdict: RecordVerdict = async (pr, verdict) => {
  console.log(`verdict ${verdict} ${pr}`);
};
