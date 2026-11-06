import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileQueue } from './queue.ts';
import type { UnderstandJob } from './types.ts';

const INSTALLATION = 70000001;
const understand = (repo: string, sha?: string): UnderstandJob => ({
  kind: 'understand',
  installationId: INSTALLATION,
  repo,
  reason: 'push',
  ...(sha && { sha }),
});

let dir: string;
let file: string;

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  dir = await mkdtemp(join(tmpdir(), 'refit-queue-'));
  file = join(dir, 'nested', 'queue.json');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

// A runner that holds each job until the test releases it.
function gatedRunner() {
  const ran: UnderstandJob[] = [];
  const gates: (() => void)[] = [];
  const run = (job: UnderstandJob) =>
    new Promise<void>((resolve) => {
      ran.push(job);
      gates.push(resolve);
    });
  const release = async () => {
    await vi.waitFor(() => expect(gates.length).toBeGreaterThan(0));
    gates.shift()!();
  };
  return { ran, run, release };
}

const stored = async () => JSON.parse(await readFile(file, 'utf8')) as UnderstandJob[];

describe('createFileQueue', () => {
  it('persists a job before enqueue returns and removes it only once it has run', async () => {
    const runner = gatedRunner();
    const queue = await createFileQueue(file, runner.run);
    await queue.enqueue(understand('org/a'));
    expect(await stored()).toEqual([understand('org/a')]);
    await runner.release();
    await queue.idle();
    expect(await stored()).toEqual([]);
    expect(runner.ran).toEqual([understand('org/a')]);
  });

  it('reruns jobs left in the file by a previous process', async () => {
    await writeFile(file.replace('nested/', ''), JSON.stringify([understand('org/left')]));
    const ran: string[] = [];
    const queue = await createFileQueue(file.replace('nested/', ''), async (job) => {
      ran.push(job.repo);
    });
    await queue.idle();
    expect(ran).toEqual(['org/left']);
  });

  it('runs jobs one at a time, in order', async () => {
    const runner = gatedRunner();
    const queue = await createFileQueue(file, runner.run);
    await queue.enqueue(understand('org/a'));
    await queue.enqueue(understand('org/b'));
    await vi.waitFor(() => expect(runner.ran).toHaveLength(1));
    await runner.release();
    await vi.waitFor(() => expect(runner.ran).toHaveLength(2));
    expect(runner.ran.map((job) => job.repo)).toEqual(['org/a', 'org/b']);
    await runner.release();
    await queue.idle();
  });

  it('keeps one waiting read per repo, but queues a new one while that repo is running', async () => {
    const runner = gatedRunner();
    const queue = await createFileQueue(file, runner.run);
    await queue.enqueue(understand('org/a', 'one'));
    await vi.waitFor(() => expect(runner.ran).toHaveLength(1));
    await queue.enqueue(understand('org/a', 'two'));
    await queue.enqueue(understand('org/a', 'three'));
    expect(queue.pending().map((job) => job.sha)).toEqual(['one', 'two']);
    await runner.release();
    await runner.release();
    await queue.idle();
    expect(runner.ran.map((job) => job.sha)).toEqual(['one', 'two']);
  });

  it('forget drops waiting reads of that repo but not the running one or other repos', async () => {
    const runner = gatedRunner();
    const queue = await createFileQueue(file, runner.run);
    await queue.enqueue(understand('org/a', 'running'));
    await vi.waitFor(() => expect(runner.ran).toHaveLength(1));
    await queue.enqueue(understand('org/a', 'waiting'));
    await queue.enqueue(understand('org/b'));
    await queue.enqueue({ kind: 'forget', installationId: INSTALLATION, repo: 'org/a' });
    expect(queue.pending().map((job) => `${job.repo} ${job.sha ?? ''}`)).toEqual([
      'org/a running',
      'org/b ',
    ]);
    expect((await stored()).map((job) => job.repo)).toEqual(['org/a', 'org/b']);
    await runner.release();
    await runner.release();
    await queue.idle();
  });

  it('logs a failed job, drops it and carries on', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ran: string[] = [];
    const queue = await createFileQueue(file, async (job) => {
      ran.push(job.repo);
      if (job.repo === 'org/bad') throw new Error('no run records for org/bad: inventory failed');
    });
    await queue.enqueue(understand('org/bad'));
    await queue.enqueue(understand('org/good'));
    await queue.idle();
    expect(ran).toEqual(['org/bad', 'org/good']);
    expect(errors).toHaveBeenCalledWith(
      'job understand org/bad failed: no run records for org/bad: inventory failed',
    );
    expect(await stored()).toEqual([]);
  });

  it('refuses to start on a corrupt queue file rather than drop its jobs', async () => {
    const corrupt = join(dir, 'corrupt.json');
    await writeFile(corrupt, '[{"kind":');
    await expect(createFileQueue(corrupt, async () => {})).rejects.toThrow(SyntaxError);
  });
});
