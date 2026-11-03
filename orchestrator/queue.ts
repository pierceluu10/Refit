// The loop only needs this much from a queue, so a real one (SQS, BullMQ) can replace it later.
export type Queue = {
  // Runs the job once a slot is free, retrying with backoff; rejects with the last error when retries run out.
  add<T>(name: string, job: () => Promise<T>): Promise<T>;
  // Resolves once nothing is running or waiting.
  onIdle(): Promise<void>;
};

export function createMemoryQueue({
  concurrency,
  retries,
  backoffMs = 1000,
  log = () => {},
  shouldRetry = () => true,
}: {
  concurrency: number;
  retries: number;
  backoffMs?: number;
  log?: (line: string) => void;
  // False for an error that another try cannot fix.
  shouldRetry?: (error: unknown) => boolean;
}): Queue {
  let running = 0;
  let pending = 0;
  const waiting: (() => void)[] = [];
  let idle: (() => void)[] = [];

  async function acquire() {
    if (running < concurrency) {
      running++;
      return;
    }
    // release() hands its slot straight to the next waiter, so `running` stays the same.
    await new Promise<void>((resolve) => waiting.push(resolve));
  }

  function release() {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }

  return {
    async add<T>(name: string, job: () => Promise<T>): Promise<T> {
      pending++;
      await acquire();
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            return await job();
          } catch (error) {
            if (attempt >= retries || !shouldRetry(error)) throw error;
            const wait = backoffMs * 2 ** attempt;
            log(
              `${name}: attempt ${attempt + 1} failed (${error instanceof Error ? error.message : String(error)}); retrying in ${wait}ms`,
            );
            await new Promise((resolve) => setTimeout(resolve, wait));
          }
        }
      } finally {
        release();
        if (--pending === 0) {
          for (const resolve of idle) resolve();
          idle = [];
        }
      }
    },
    onIdle() {
      return pending === 0 ? Promise.resolve() : new Promise((resolve) => idle.push(resolve));
    },
  };
}
