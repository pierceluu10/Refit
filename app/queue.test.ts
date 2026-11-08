import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalTask } from '../shared/types.ts';
import { createFileQueue, HoldJobError } from './queue.ts';
import type { FileQueueOptions } from './queue.ts';
import type { QueuedJob, RunJob, ScanJob } from './types.ts';

const INSTALLATION = 70000001;
const scan = (repo: string, sha?: string, installationId = INSTALLATION): ScanJob => ({
  kind: 'scan',
  installationId,
  repo,
  reason: 'push',
  ...(sha && { sha }),
});
const runJob = (repo: string, taskId: string): RunJob => ({
  kind: 'run',
  installationId: INSTALLATION,
  repo,
  task: { id: taskId } as ExternalTask,
});
const shaOf = (job: QueuedJob) => (job.kind === 'scan' ? job.sha : undefined);

let dir: string;
let file: string;

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  dir = await mkdtemp(join(tmpdir(), 'refit-queue-'));
  file = join(dir, 'nested', 'queue.json');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

// A runner that holds each job until the test releases it, oldest first.
function gatedRunner() {
  const ran: QueuedJob[] = [];
  const signals: AbortSignal[] = [];
  const gates: { resolve: () => void; reject: (error: Error) => void }[] = [];
  const run = (job: QueuedJob, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      ran.push(job);
      signals.push(signal);
      gates.push({ resolve, reject });
    });
  const next = async () => {
    await vi.waitFor(() => expect(gates.length).toBeGreaterThan(0));
    return gates.shift()!;
  };
  const release = async () => (await next()).resolve();
  const fail = async (message = 'boom') => (await next()).reject(new Error(message));
  return { ran, signals, run, release, fail, open: () => gates.length };
}

const stored = async () => JSON.parse(await readFile(file, 'utf8')) as QueuedJob[];
const open = (runner: ReturnType<typeof gatedRunner>, options: FileQueueOptions = {}) =>
  createFileQueue(file, runner.run, { concurrency: 1, backoffMs: 1, ...options });

describe('createFileQueue', () => {
  it('persists a job before enqueue returns and removes it only once it has run', async () => {
    const runner = gatedRunner();
    const queue = await open(runner);
    await queue.enqueue(scan('org/a'));
    expect(await stored()).toEqual([scan('org/a')]);
    await runner.release();
    await queue.idle();
    expect(await stored()).toEqual([]);
    expect(runner.ran).toEqual([scan('org/a')]);
  });

  it('reruns jobs left in the file by a previous process', async () => {
    const leftover = join(dir, 'queue.json');
    await writeFile(leftover, JSON.stringify([scan('org/left'), runJob('org/left', 'task-1')]));
    const ran: string[] = [];
    const queue = await createFileQueue(leftover, async (job) => void ran.push(job.kind));
    await queue.idle();
    expect(ran).toEqual(['scan', 'run']);
  });

  it('runs one job at a time when told to, in order', async () => {
    const runner = gatedRunner();
    const queue = await open(runner);
    await queue.enqueue(scan('org/a'));
    await queue.enqueue(scan('org/b'));
    await vi.waitFor(() => expect(runner.ran).toHaveLength(1));
    await runner.release();
    await vi.waitFor(() => expect(runner.ran).toHaveLength(2));
    expect(runner.ran.map((job) => job.repo)).toEqual(['org/a', 'org/b']);
    await runner.release();
    await queue.idle();
  });

  it('never runs more than the concurrency cap, and starts jobs first in, first out', async () => {
    const runner = gatedRunner();
    const queue = await createFileQueue(file, runner.run);
    for (const repo of ['org/a', 'org/b', 'org/c', 'org/d']) await queue.enqueue(scan(repo));
    await vi.waitFor(() => expect(runner.ran).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runner.ran.map((job) => job.repo)).toEqual(['org/a', 'org/b']);
    await runner.release();
    await vi.waitFor(() => expect(runner.ran).toHaveLength(3));
    expect(runner.ran[2].repo).toBe('org/c');
    expect(runner.open()).toBe(2);
    for (let released = 0; released < 3; released++) await runner.release();
    await queue.idle();
    expect(runner.ran.map((job) => job.repo)).toEqual(['org/a', 'org/b', 'org/c', 'org/d']);
  });

  it('keeps one waiting scan per repo, but queues a new one while that repo is running', async () => {
    const runner = gatedRunner();
    const queue = await open(runner);
    await queue.enqueue(scan('org/a', 'one'));
    await vi.waitFor(() => expect(runner.ran).toHaveLength(1));
    await queue.enqueue(scan('org/a', 'two'));
    await queue.enqueue(scan('org/a', 'three'));
    expect(queue.pending().map(shaOf)).toEqual(['one', 'two']);
    await runner.release();
    await runner.release();
    await queue.idle();
    expect(runner.ran.map(shaOf)).toEqual(['one', 'two']);
  });

  it('drops a run job whose task is already waiting or running, but not another task', async () => {
    const runner = gatedRunner();
    const queue = await open(runner);
    await queue.enqueue(runJob('org/a', 'task-1'));
    await vi.waitFor(() => expect(runner.ran).toHaveLength(1));
    await queue.enqueue(runJob('org/a', 'task-1')); // running
    await queue.enqueue(runJob('org/a', 'task-2'));
    await queue.enqueue(runJob('org/a', 'task-2')); // waiting
    await queue.enqueue(runJob('org/b', 'task-1')); // another repo
    expect(queue.pending()).toEqual([
      runJob('org/a', 'task-1'),
      runJob('org/a', 'task-2'),
      runJob('org/b', 'task-1'),
    ]);
    for (let released = 0; released < 3; released++) await runner.release();
    await queue.idle();
  });

  it('a retry keeps its place in the file, frees its slot while it waits, then succeeds', async () => {
    const runner = gatedRunner();
    const queue = await open(runner, { backoffMs: 40 });
    await queue.enqueue(scan('org/a'));
    await queue.enqueue(scan('org/b'));
    await runner.fail('clone failed');
    await vi.waitFor(() => expect(runner.ran.map((job) => job.repo)).toEqual(['org/a', 'org/b']));
    expect((await stored()).map((job) => job.repo)).toEqual(['org/a', 'org/b']);
    await runner.release();
    await vi.waitFor(() => expect(runner.ran).toHaveLength(3));
    expect(runner.ran[2].repo).toBe('org/a');
    await runner.release();
    await queue.idle();
    expect(await stored()).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(
      'job scan org/a try 1 failed: clone failed; retrying in 40ms',
    );
  });

  it('gives up when retries run out, logs it, drops the job and carries on', async () => {
    const tries: string[] = [];
    const queue = await createFileQueue(
      file,
      async (job) => {
        tries.push(job.repo);
        if (job.repo === 'org/bad') throw new Error('inventory failed');
      },
      { backoffMs: 1, retries: 2, concurrency: 1 },
    );
    await queue.enqueue(scan('org/bad'));
    await queue.enqueue(scan('org/good'));
    await queue.idle();
    expect(tries.filter((repo) => repo === 'org/bad')).toHaveLength(3);
    expect(tries).toContain('org/good');
    expect(console.error).toHaveBeenCalledWith('job scan org/bad failed: inventory failed');
    expect(await stored()).toEqual([]);
  });

  it('keeps a held job in the file without rerunning it, and runs it on the next start', async () => {
    const tries: string[] = [];
    const holdFirst = async (job: QueuedJob) => {
      tries.push(job.repo);
      if (job.repo === 'org/held') throw new HoldJobError('no budget');
    };
    const queue = await createFileQueue(file, holdFirst, { concurrency: 1, backoffMs: 1 });
    await queue.enqueue(runJob('org/held', 't1'));
    await queue.enqueue(runJob('org/next', 't2'));
    // idle resolves though a held job is still in the file, and the job behind it got its slot.
    await queue.idle();
    expect(tries).toEqual(['org/held', 'org/next']);
    expect((await stored()).map((job) => job.repo)).toEqual(['org/held']);
    // Enqueuing the same task again neither duplicates nor wakes it.
    await queue.enqueue(runJob('org/held', 't1'));
    await queue.idle();
    expect(tries).toEqual(['org/held', 'org/next']);
    queue.close();

    const started: string[] = [];
    const next = await createFileQueue(file, async (job) => void started.push(job.repo), {
      concurrency: 1,
    });
    await next.idle();
    expect(started).toEqual(['org/held']);
    expect(await stored()).toEqual([]);
    next.close();
  });

  it('does not retry when shouldRetry says no', async () => {
    class BudgetGone extends Error {}
    const tries: string[] = [];
    const queue = await createFileQueue(
      file,
      async (job) => {
        tries.push(job.repo);
        throw new BudgetGone('over the cap');
      },
      { backoffMs: 1, shouldRetry: (error) => !(error instanceof BudgetGone) },
    );
    await queue.enqueue(scan('org/a'));
    await queue.idle();
    expect(tries).toEqual(['org/a']);
    expect(console.error).toHaveBeenCalledWith('job scan org/a failed: over the cap');
  });

  it('forget aborts a running job with no retry, drops waiting ones and calls onForget', async () => {
    const runner = gatedRunner();
    const forgotten: unknown[] = [];
    const queue = await open(runner, { onForget: async (job) => void forgotten.push(job) });
    await queue.enqueue(scan('org/a', 'running'));
    await vi.waitFor(() => expect(runner.ran).toHaveLength(1));
    await queue.enqueue(scan('org/a', 'waiting'));
    await queue.enqueue(scan('org/b'));
    const job = { kind: 'forget', installationId: INSTALLATION, repo: 'org/a' } as const;
    await queue.enqueue(job);
    expect(runner.signals[0].aborted).toBe(true);
    expect(forgotten).toEqual([job]);
    expect(queue.pending().map((other) => other.repo)).toEqual(['org/b']);
    expect((await stored()).map((other) => other.repo)).toEqual(['org/b']);
    await runner.fail('checkout deleted');
    await runner.release();
    await queue.idle();
    expect(runner.ran.map((other) => other.repo)).toEqual(['org/a', 'org/b']);
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('org/a'));
  });

  it('a forgotten job that finishes anyway does not come back', async () => {
    const runner = gatedRunner();
    const queue = await open(runner);
    await queue.enqueue(scan('org/a'));
    await vi.waitFor(() => expect(runner.ran).toHaveLength(1));
    await queue.enqueue({ kind: 'forget', installationId: INSTALLATION, repo: 'org/a' });
    await runner.release();
    await queue.idle();
    expect(await stored()).toEqual([]);
  });

  it('forget without a repo clears the whole installation and nothing else', async () => {
    const runner = gatedRunner();
    const queue = await open(runner);
    await queue.enqueue(scan('org/a'));
    await queue.enqueue(scan('org/b'));
    await queue.enqueue(scan('other/c', undefined, 2));
    await vi.waitFor(() => expect(runner.ran).toHaveLength(1));
    await queue.enqueue({ kind: 'forget', installationId: INSTALLATION });
    expect(runner.signals[0].aborted).toBe(true);
    expect(queue.pending().map((job) => job.repo)).toEqual(['other/c']);
    await runner.release();
    await runner.release();
    await queue.idle();
  });

  it('forget clears a waiting retry so it never runs again', async () => {
    const runner = gatedRunner();
    const queue = await open(runner, { backoffMs: 20 });
    await queue.enqueue(scan('org/a'));
    await runner.fail();
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled());
    await queue.enqueue({ kind: 'forget', installationId: INSTALLATION, repo: 'org/a' });
    await queue.idle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runner.ran).toHaveLength(1);
    expect(await stored()).toEqual([]);
  });

  it('close stops new work and clears retry timers, keeping jobs for the next start', async () => {
    const runner = gatedRunner();
    const queue = await open(runner, { backoffMs: 20 });
    await queue.enqueue(scan('org/retry'));
    await runner.fail();
    await vi.waitFor(() => expect(runner.ran).toHaveLength(1));
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled());
    queue.close();
    await queue.enqueue(scan('org/later'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await queue.idle();
    expect(runner.ran).toHaveLength(1);
    expect((await stored()).map((job) => job.repo)).toEqual(['org/retry', 'org/later']);

    const ran: string[] = [];
    const reopened = await createFileQueue(file, async (job) => void ran.push(job.repo));
    await reopened.idle();
    expect(ran.sort()).toEqual(['org/later', 'org/retry']);
  });

  it('close lets a running job finish, and a failed one stays in the file for the next start', async () => {
    const runner = gatedRunner();
    const queue = await open(runner, { concurrency: 2 });
    await queue.enqueue(scan('org/done'));
    await queue.enqueue(scan('org/failing'));
    await vi.waitFor(() => expect(runner.ran).toHaveLength(2));
    queue.close();
    await runner.release();
    await runner.fail();
    await queue.idle();
    expect((await stored()).map((job) => job.repo)).toEqual(['org/failing']);
  });

  it('refuses to start on a corrupt queue file rather than drop its jobs', async () => {
    const corrupt = join(dir, 'corrupt.json');
    await writeFile(corrupt, '[{"kind":');
    await expect(createFileQueue(corrupt, async () => {})).rejects.toThrow(SyntaxError);
  });
});
