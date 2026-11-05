import { readJsonFile, writeJsonFile } from './json-file.ts';
import type { AppJob, JobQueue, UnderstandJob } from './types.ts';

export type FileQueue = JobQueue & {
  pending: () => UnderstandJob[];
  idle: () => Promise<void>;
};

const sameRepo = (a: AppJob, b: AppJob) =>
  a.installationId === b.installationId && a.repo === b.repo;

// Pending jobs live in one JSON file, rewritten atomically on every change, and run one at a time.
// A job leaves the file only when it ends, so a restart reruns the job it interrupted.
// shortcut: one process owns the file (as memory/ owns its store); move to a database for several workers.
export async function createFileQueue(
  file: string,
  run: (job: UnderstandJob) => Promise<void>,
  onMerged?: (job: UnderstandJob) => Promise<void>,
): Promise<FileQueue> {
  let jobs = (await readJsonFile<UnderstandJob[]>(file)) ?? [];
  let running: UnderstandJob | undefined;
  let working: Promise<void> | undefined;
  let saving: Promise<void> = Promise.resolve();

  const save = () => {
    const next = saving.then(() => writeJsonFile(file, jobs));
    saving = next.catch(() => undefined);
    return next;
  };

  async function work() {
    while (jobs.length > 0) {
      const job = jobs[0];
      running = job;
      try {
        await run(job);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`job ${job.kind} ${job.repo} failed: ${message}`);
      }
      jobs = jobs.filter((other) => other !== job);
      running = undefined;
      await save();
    }
  }
  const start = () => {
    working ??= work().finally(() => (working = undefined));
  };

  if (jobs.length > 0) start();
  return {
    async enqueue(job) {
      const waiting = (other: UnderstandJob) => other !== running && sameRepo(other, job);
      if (job.kind === 'forget') {
        // memory/ has no forget yet; a removed repo just stops waiting to be read.
        jobs = jobs.filter((other) => !waiting(other));
      } else if (jobs.some(waiting)) {
        // A read of this repo is already waiting and will see the newest code.
        await onMerged?.(job);
        return;
      } else {
        jobs.push(job);
      }
      await save();
      console.log(`queued ${job.kind} ${job.repo}`);
      start();
    },
    pending: () => [...jobs],
    idle: async () => {
      while (working) await working;
    },
  };
}
