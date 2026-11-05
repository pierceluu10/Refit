// One refresh run: for each provider, at most one changelog read through the shared daily cache, then
// its changes through the proposal checks. One AI read per source per day, never per repo.
import { createBudget, BudgetExceededError } from '../orchestrator/budget.ts';
import { anyProviderWatcher, type AnyWatchReport } from '../providers/core/any-watcher.ts';
import { httpFetcher, type Fetcher } from '../providers/core/fetch.ts';
import { mergeHints } from '../providers/core/folders.ts';
import { BudgetLedger } from '../providers/core/model.ts';
import {
  defaultWatchDir,
  readOutcome,
  readThroughCache,
  refreshTime,
  watchCostReport,
  type WatchRead,
} from '../providers/core/watch-cache.ts';
import type { ProviderChange, ProviderHints } from '../shared/types.ts';
import { DATA_DIR, readProviderFiles } from './list.ts';
import { PROPOSED_DIR, providerId, settleChanges, utcDay, type Proposal } from './proposals.ts';
import { FINISHED_OUTCOMES, markRead, nextInQueue, readQueue } from './queue.ts';

// The same hold as the loop's watcher (orchestrator/deps.ts): a read's worst case, with one call's
// worst case kept spare because a watcher's ledger checks its cap only before a call.
export const READ_USD = 1.5;
const READ_CALL_USD = 0.5;

/** Runs one read, led by these hints, within the dollars held for it. */
export type ReadSource = (
  provider: string,
  hints: ProviderHints,
  capUsd: number,
) => Promise<WatchRead>;

const watcherRead: ReadSource = async (provider, hints, capUsd) => {
  const ledger = new BudgetLedger(capUsd - READ_CALL_USD);
  let report: AnyWatchReport | undefined;
  try {
    const watch = anyProviderWatcher(provider, hints, {
      budget: ledger,
      onReport: (done) => (report = done),
    });
    const changes = await watch();
    return { changes, ...readOutcome(report), costUsd: ledger.spentUsd };
  } catch (error) {
    return { changes: [], finished: false, costUsd: ledger.spentUsd, error };
  }
};

// `unfinished`: the read ended early, so finding nothing in it proves nothing.
export type RefreshOutcome = 'read' | 'cached' | 'capped' | 'failed' | 'unfinished';

export type ProviderRefresh = {
  provider: string;
  outcome: RefreshOutcome;
  note?: string; // why a read failed, stopped at the cap or won't be cached
  costUsd: number; // what this provider's reads have cost today, from watchCostReport
  proposed: number;
  live: string[];
  pending: { id: string; reason: string }[];
  rejected: { id: string; reason: string }[];
  noted: { id: string; reason: string }[]; // read's changes that aren't removals
};

export type RefreshReport = {
  day: string;
  capUsd: number;
  spentUsd: number; // this run's reads, against its cap
  totalTodayUsd: number; // every read today in this cache, from watchCostReport
  providers: ProviderRefresh[];
};

export type RefreshOptions = {
  providers?: string[];
  queue?: number; // how many to take from the head of the unlisted queue
  storeDir?: string;
  cacheDir?: string;
  dataDir?: string;
  dryRun?: boolean;
  read?: ReadSource;
  fetcher?: Fetcher;
  now?: () => Date;
};

/** A run did its job only when every provider got a finished read: the rest still need one. */
export const refreshFinished = (report: RefreshReport): boolean =>
  report.providers.every((row) => FINISHED_OUTCOMES.has(row.outcome));

export async function refresh({
  providers = [],
  queue = 0,
  storeDir = PROPOSED_DIR,
  cacheDir = defaultWatchDir(),
  dataDir = DATA_DIR,
  dryRun = false,
  read = watcherRead,
  fetcher = httpFetcher(),
  now = () => new Date(),
}: RefreshOptions): Promise<RefreshReport> {
  const budget = createBudget(); // throws without APTITUDE_AI_BUDGET_USD, before anything is read
  const day = utcDay(now());
  const head = await nextInQueue(storeDir, queue, { dataDir, today: day });
  const names = [...new Set([...providers.map(providerId), ...head.map((one) => one.provider)])];
  const queued = await readQueue(storeDir);
  const files = readProviderFiles(dataDir);

  const rows: Omit<ProviderRefresh, 'costUsd'>[] = [];
  for (const provider of names) {
    // A listed provider's known docs lead its read. An unlisted one has its name and the queue's hints.
    // Not a source checked today: one that went live today would stop today's read covering these
    // hints, and pay for a second read of the same provider.
    const listed = files.find((file) => file.provider === provider);
    const docsUrls = [...(listed?.entries ?? []), ...(listed?.future ?? [])]
      .filter((one) => one.source.checkedOn < day)
      .map((one) => one.source.url);
    const hints = mergeHints(queued.find((one) => one.provider === provider)?.hints ?? {}, {
      docsUrls,
    });

    let outcome: RefreshOutcome = 'cached';
    let note: string | undefined;
    let changes: ProviderChange[] = [];
    try {
      changes = await readThroughCache({
        dir: cacheDir,
        provider,
        hints,
        now,
        refreshBefore: refreshTime(provider),
        read: async (led) => {
          const hold = await budget.reserve(`the ${provider} read`, READ_USD);
          outcome = 'read';
          let result: WatchRead | undefined;
          try {
            result = await read(provider, led, hold.usd);
            note = result.reason;
            if (!result.finished) outcome = 'unfinished';
            return result;
          } finally {
            hold.settle(result?.costUsd ?? hold.usd);
          }
        },
      });
    } catch (error) {
      outcome = error instanceof BudgetExceededError ? 'capped' : 'failed';
      note = error instanceof Error ? error.message : String(error);
    }

    let settled: Proposal[] = [];
    try {
      settled = await settleChanges({
        provider,
        changes,
        today: day,
        fetcher,
        storeDir,
        dataDir,
        dryRun,
        hints,
      });
    } catch (error) {
      // The read is paid for and cached, so one provider's bad write mustn't lose the others or the report.
      outcome = 'failed';
      note = error instanceof Error ? error.message : String(error);
    }
    // Stopped at the cap, nothing was read, so it stays at the head of the queue for the next run.
    if (outcome !== 'capped') await markRead(storeDir, provider, outcome, day);
    const verdicts = (status: string) =>
      settled.filter((one) => one.status === status).map(({ id, reason }) => ({ id, reason }));
    rows.push({
      provider,
      outcome,
      ...(note ? { note } : {}),
      proposed: settled.filter((one) => one.entry ?? one.future).length,
      live: verdicts('live').map((one) => one.id),
      pending: verdicts('pending'),
      rejected: verdicts('rejected'),
      noted: verdicts('noted'),
    });
  }

  const costs = await watchCostReport(cacheDir, day);
  return {
    day,
    capUsd: budget.capUsd,
    spentUsd: budget.spentUsd(),
    totalTodayUsd: costs.totalUsd,
    providers: rows.map((row) => ({
      ...row,
      costUsd: costs.rows.find((one) => one.provider === row.provider)?.costUsd ?? 0,
    })),
  };
}
