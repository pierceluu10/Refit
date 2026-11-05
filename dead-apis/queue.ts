// The unlisted-provider queue. A scan that names a provider the list doesn't cover has not found
// nothing to do: the provider waits here until one finished AI read of its sources, most common first.
import path from 'node:path';
import { mergeHints } from '../providers/core/folders.ts';
import type { ProviderHints } from '../shared/types.ts';
import { DATA_DIR, readProviderFiles } from './list.ts';
import { providerId, readJsonOr, utcDay, writeJson } from './proposals.ts';

export type QueueItem = {
  provider: string;
  repos: string[]; // distinct repos that named it
  hints: ProviderHints;
  lastRead?: { day: string; outcome: string };
};

// A finished read is the one read a queued provider gets, removals or not. --provider reads it again.
export const FINISHED_OUTCOMES: ReadonlySet<string> = new Set(['read', 'cached']);
const FAILED_OUTCOME = 'failed';

// A folder of its own: every <provider>.json beside it is a provider's proposals.
const queueFile = (storeDir: string) => path.join(storeDir, 'queue', 'unlisted.json');

export const readQueue = (storeDir: string) => readJsonOr<QueueItem[]>(queueFile(storeDir), []);

const writeQueue = (storeDir: string, items: QueueItem[]) => writeJson(queueFile(storeDir), items);

let lastChange: Promise<unknown> = Promise.resolve();

// shortcut: changes run one at a time in this process, but two processes can still lose an update (the
// last rename wins), change that to a lock or a database once scans enqueue from more than one process.
function inTurn(change: () => Promise<void>): Promise<void> {
  const turn = lastChange.then(change, change);
  lastChange = turn;
  return turn;
}

export function enqueueUnlisted(
  storeDir: string,
  repo: string,
  providers: string[],
  hints: Record<string, ProviderHints> = {},
): Promise<void> {
  return inTurn(async () => {
    const items = await readQueue(storeDir);
    for (const name of providers) {
      const provider = providerId(name);
      if (!provider) continue;
      let item = items.find((one) => one.provider === provider);
      if (!item) {
        item = { provider, repos: [], hints: {} };
        items.push(item);
      }
      if (!item.repos.includes(repo)) item.repos.push(repo);
      item.hints = mergeHints(item.hints, Object.hasOwn(hints, name) ? hints[name] : {});
    }
    await writeQueue(storeDir, items);
  });
}

/**
 * The next providers to read, most repos first: not on the list, no finished read yet, and not failed
 * today. A read that ended early comes straight back, because it's the budget's fault, not the source's.
 */
export async function nextInQueue(
  storeDir: string,
  limit: number,
  { dataDir = DATA_DIR, today = utcDay(new Date()) }: { dataDir?: string; today?: string } = {},
): Promise<QueueItem[]> {
  const listed = new Set(readProviderFiles(dataDir).map((file) => file.provider));
  const items = await readQueue(storeDir);
  return items
    .filter(({ provider, lastRead }) => {
      if (listed.has(provider) || FINISHED_OUTCOMES.has(lastRead?.outcome ?? '')) return false;
      return !(lastRead?.outcome === FAILED_OUTCOME && lastRead.day === today);
    })
    .sort((a, b) => b.repos.length - a.repos.length || a.provider.localeCompare(b.provider))
    .slice(0, limit);
}

/** Records a read of a queued provider. A provider that was never queued has nothing to record. */
export function markRead(
  storeDir: string,
  provider: string,
  outcome: string,
  today = utcDay(new Date()),
): Promise<void> {
  return inTurn(async () => {
    const items = await readQueue(storeDir);
    const item = items.find((one) => one.provider === providerId(provider));
    if (!item) return;
    item.lastRead = { day: today, outcome };
    await writeQueue(storeDir, items);
  });
}
