import { readFile } from 'node:fs/promises';
import { writeJsonAtomic } from './queue.ts';

// GitHub offers redelivery for 3 days, and a redelivery repeats the original X-GitHub-Delivery.
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type DeliveryLog = {
  // False when this delivery is finished or being handled right now.
  claim: (id: string | undefined) => boolean;
  finish: (id: string | undefined) => Promise<void>;
  release: (id: string | undefined) => void;
};

async function load(file: string): Promise<Map<string, number>> {
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }
  try {
    return new Map(Object.entries(JSON.parse(content) as Record<string, number>));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Unlike the queue, starting empty is the safe side: the queue absorbs a repeated scan.
    console.error(`${file} is corrupt, so delivery history starts again`);
    return new Map();
  }
}

// A delivery counts as done only once it was handled, so one that failed can still be redelivered.
// shortcut: one process owns the file, like the queue; move to a database for several workers.
export async function createDeliveryLog(
  file: string,
  now: () => number = Date.now,
): Promise<DeliveryLog> {
  const finished = await load(file);
  const handling = new Set<string>();
  let saving: Promise<void> = Promise.resolve();

  const save = () => {
    for (const [id, at] of finished) if (now() - at > RETENTION_MS) finished.delete(id);
    const next = saving.then(() => writeJsonAtomic(file, Object.fromEntries(finished)));
    saving = next.catch(() => undefined);
    return next;
  };

  return {
    claim(id) {
      if (id === undefined) return true;
      if (finished.has(id) || handling.has(id)) return false;
      handling.add(id);
      return true;
    },
    async finish(id) {
      if (id === undefined) return;
      handling.delete(id);
      finished.set(id, now());
      await save();
    },
    release(id) {
      if (id !== undefined) handling.delete(id);
    },
  };
}
