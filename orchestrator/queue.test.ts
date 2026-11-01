import { describe, expect, it, vi } from 'vitest';
import { createMemoryQueue } from './queue.ts';

describe('createMemoryQueue', () => {
  it('never runs more jobs at once than the concurrency limit', async () => {
    const queue = createMemoryQueue({ concurrency: 2, retries: 0 });
    let running = 0;
    let peak = 0;
    const job = async (n: number) => {
      peak = Math.max(peak, ++running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return n;
    };
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => queue.add(`job ${n}`, () => job(n))),
    );
    expect(results).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
    await queue.onIdle();
  });

  it('retries a failing job until it succeeds', async () => {
    const log = vi.fn();
    const queue = createMemoryQueue({ concurrency: 1, retries: 2, backoffMs: 1, log });
    let calls = 0;
    const result = await queue.add('flaky', async () => {
      if (++calls < 3) throw new Error(`boom ${calls}`);
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('flaky: attempt 1 failed (boom 1)'));
  });

  it('rejects with the last error once retries run out, and keeps serving other jobs', async () => {
    const queue = createMemoryQueue({ concurrency: 1, retries: 1, backoffMs: 1 });
    let calls = 0;
    await expect(
      queue.add('doomed', async () => {
        throw new Error(`fail ${++calls}`);
      }),
    ).rejects.toThrow('fail 2');
    expect(calls).toBe(2);
    await expect(queue.add('next', async () => 'still running')).resolves.toBe('still running');
  });

  it('onIdle waits for queued jobs', async () => {
    const queue = createMemoryQueue({ concurrency: 1, retries: 0 });
    const done: number[] = [];
    for (const n of [1, 2, 3]) {
      void queue.add(`job ${n}`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        done.push(n);
      });
    }
    await queue.onIdle();
    expect(done).toEqual([1, 2, 3]);
  });
});
