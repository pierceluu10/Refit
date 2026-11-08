import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ForgetJob, JobQueue, QueuedJob } from './types.ts';

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 30_000;

// Thrown by a job that cannot run until the process restarts with a new budget. It stays in the file.
export class HoldJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HoldJobError';
  }
}

export type FileQueue = JobQueue & {
  pending: () => QueuedJob[];
  idle: () => Promise<void>;
  close: () => void;
};

export type FileQueueOptions = {
  concurrency?: number;
  retries?: number; // tries after the first
  backoffMs?: number; // doubled each try
  shouldRetry?: (error: unknown) => boolean;
  onForget?: (job: ForgetJob) => Promise<void>;
};

type Entry = {
  job: QueuedJob;
  state: 'waiting' | 'running' | 'retrying' | 'held';
  attempts: number;
  controller?: AbortController;
  timer?: NodeJS.Timeout;
};

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, file);
}

async function load(file: string): Promise<QueuedJob[]> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as QueuedJob[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error; // a corrupt queue file must not silently drop jobs
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Pending jobs live in one JSON file, rewritten atomically on every change. A job leaves the file
// only when it ends, so a restart reruns whatever it interrupted, including one waiting to retry.
// shortcut: one process owns the file (as memory/ owns its store); move to a database for several workers.
export async function createFileQueue(
  file: string,
  run: (job: QueuedJob, signal: AbortSignal) => Promise<void>,
  {
    concurrency = DEFAULT_CONCURRENCY,
    retries = DEFAULT_RETRIES,
    backoffMs = DEFAULT_BACKOFF_MS,
    shouldRetry = () => true,
    onForget,
  }: FileQueueOptions = {},
): Promise<FileQueue> {
  const entryFor = (job: QueuedJob): Entry => ({ job, state: 'waiting', attempts: 0 });
  // A forgotten job leaves `entries` at once but stays in `running` until its promise settles.
  let entries = (await load(file)).map(entryFor);
  const running = new Set<Entry>();
  let closed = false;
  let saving: Promise<void> = Promise.resolve();
  let idleWaiters: (() => void)[] = [];

  const save = () => {
    const next = saving.then(() =>
      writeJsonAtomic(
        file,
        entries.map((entry) => entry.job),
      ),
    );
    saving = next.catch(() => undefined);
    return next;
  };
  const saveLogged = () =>
    save().catch((error: unknown) => {
      console.error(`saving the job queue failed: ${messageOf(error)}`);
    });

  // A held job waits for a restart, so nothing in this process is still working on it.
  const busy = () =>
    running.size > 0 || (!closed && entries.some((entry) => entry.state !== 'held'));
  const wakeIdle = () => {
    if (busy()) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters = [];
  };

  const drop = (entry: Entry) => {
    entries = entries.filter((other) => other !== entry);
  };

  function retryLater(entry: Entry, error: unknown) {
    const wait = backoffMs * 2 ** (entry.attempts - 1);
    console.error(
      `job ${entry.job.kind} ${entry.job.repo} try ${entry.attempts} failed: ${messageOf(error)}; retrying in ${wait}ms`,
    );
    entry.state = 'retrying';
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      entry.state = 'waiting';
      pump();
    }, wait);
  }

  async function execute(entry: Entry) {
    const controller = new AbortController();
    entry.controller = controller;
    entry.state = 'running';
    entry.attempts++;
    running.add(entry);
    try {
      await run(entry.job, controller.signal);
      drop(entry);
    } catch (error) {
      if (controller.signal.aborted) {
        console.log(`job ${entry.job.kind} ${entry.job.repo} stopped`);
        drop(entry);
      } else if (error instanceof HoldJobError) {
        console.log(
          `job ${entry.job.kind} ${entry.job.repo} held until the next start: ${error.message}`,
        );
        entry.state = 'held';
      } else if (entry.attempts > retries || !shouldRetry(error)) {
        console.error(`job ${entry.job.kind} ${entry.job.repo} failed: ${messageOf(error)}`);
        drop(entry);
      } else if (closed) {
        entry.state = 'waiting'; // stays in the file for the next start
      } else {
        retryLater(entry, error);
      }
    }
    running.delete(entry);
    pump();
    await saveLogged();
    wakeIdle();
  }

  function pump() {
    if (closed) return;
    for (const entry of entries) {
      if (running.size >= concurrency) return;
      if (entry.state === 'waiting') void execute(entry);
    }
  }

  const absorbs = (other: Entry, job: QueuedJob) => {
    if (other.job.installationId !== job.installationId || other.job.repo !== job.repo)
      return false;
    if (job.kind === 'run') return other.job.kind === 'run' && other.job.task.id === job.task.id;
    // A running scan may have read older code, so only one that hasn't started yet absorbs a new one.
    return other.job.kind === 'scan' && other.state !== 'running';
  };

  async function forget(job: ForgetJob) {
    const gone = entries.filter(
      (entry) =>
        entry.job.installationId === job.installationId &&
        (job.repo === undefined || entry.job.repo === job.repo),
    );
    for (const entry of gone) {
      clearTimeout(entry.timer);
      entry.controller?.abort();
      drop(entry);
    }
    await save();
    console.log(`forgot ${job.repo ?? `installation ${job.installationId}`}`);
    await onForget?.(job);
    wakeIdle();
  }

  pump();
  return {
    async enqueue(job) {
      if (job.kind === 'forget') return forget(job);
      if (entries.some((other) => absorbs(other, job))) return;
      entries.push(entryFor(job));
      await save();
      console.log(`queued ${job.kind} ${job.repo}`);
      pump();
    },
    pending: () => entries.map((entry) => entry.job),
    idle: async () => {
      while (busy()) await new Promise<void>((resolve) => idleWaiters.push(resolve));
      await saving;
    },
    close: () => {
      closed = true;
      for (const entry of entries) {
        if (!entry.timer) continue;
        clearTimeout(entry.timer);
        entry.timer = undefined;
        entry.state = 'waiting';
      }
      wakeIdle();
    },
  };
}
