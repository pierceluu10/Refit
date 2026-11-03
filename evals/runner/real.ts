// Wires the runner to the real Aptitude modules through the orchestrator's createDeps, so the
// benchmark runs what the loop runs, under one run budget. It refuses to start without a key.
import { AsyncLocalStorage } from 'node:async_hooks';
import { TURN_RESERVE_USD } from '../../harness/index.ts';
import {
  BudgetExceededError as RunBudgetRefusal,
  createBudget,
  type Budget,
} from '../../orchestrator/budget.ts';
import {
  cachedChanges,
  createDeps,
  defaultWatchCache,
  providerWatcher,
  WATCH_USD,
} from '../../orchestrator/deps.ts';
import { unlistedProviders } from '../../orchestrator/loop.ts';
import { bundleTasks } from '../../orchestrator/bundle.ts';
import { MATCH_BATCH, type MatchedTask } from '../../orchestrator/match.ts';
import { BudgetLedger as WatchLedger } from '../../providers/core/model.ts';
import { listProviderIds } from '../../providers/core/registry.ts';
import type {
  ApiUsage,
  ProviderChange,
  ProviderHints,
  RunRecord,
  WatchProvider,
} from '../../shared/types.ts';
import { anthropicModelClient } from '../reviewer/model.ts';
import { createReviewer } from '../reviewer/reviewer.ts';
import { BudgetExceededError } from './budget.ts';
import { gitCheckout } from './checkout.ts';
import type { Meter, PipelineFactory } from './types.ts';

/**
 * F4's watcher for a provider with no folder in providers/ (providers/core/any-watcher.ts), by the
 * contract in docs/NEXT-FURQAN.md and the call orchestrator/deps.ts makes. Typed here rather than
 * from the orchestrator's stub, which goes away when F4's function lands.
 */
export type AnyProviderWatcher = (
  provider: string,
  hints: ProviderHints,
  deps?: { budget?: WatchLedger },
) => WatchProvider;

export type RealPipelineOptions = {
  /**
   * Watches a provider that has no folder in providers/. Without it, a repo whose provider has no
   * folder stops before any spend. Pass F4's anyProviderWatcher once it merges.
   */
  watchAny?: AnyProviderWatcher;
  /** Where provider reads are cached for the UTC day, shared with the orchestrator's loop. */
  watchCache?: string;
};

export type RealPipeline = {
  factory: PipelineFactory;
  /** What the run budget (the hard cap every real part holds against) has spent. */
  spentUsd: () => number;
};

// A watcher's ledger checks its cap only before a call, so its hold keeps one call's worst case
// spare (the same margin as orchestrator/deps.ts).
const WATCH_CALL_USD = 0.5;
// The most one advisory review can cost: a 60,000-character diff, 40,000 characters of repo files
// and the rest of the prompt (about 35,000 tokens at $4/M) plus a full REVIEW_MAX_TOKENS of output
// at $20/M.
export const REVIEW_RESERVE_USD = 0.27;

const URGENCY = ['critical', 'high', 'medium', 'low'];
const urgencyRank = (task: MatchedTask) => {
  const rank = URGENCY.indexOf(task.urgency);
  return rank === -1 ? URGENCY.length : rank;
};

const normalName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The folder in providers/ for a set's provider label, when there is one. */
export function providerFolder(provider: string, folders: string[]): string | undefined {
  return folders.find((id) => normalName(id) === normalName(provider));
}

/**
 * Hints for a provider with no folder, from the usages the inventory attributed to it (names can
 * differ: "openweathermap" and "OpenWeather"). The same fields the loop passes its watchers.
 */
export function hintsFor(provider: string, usages: ApiUsage[]): ProviderHints {
  const want = normalName(provider);
  const found = [...unlistedProviders(usages, [])].filter(([name]) => {
    const have = normalName(name);
    return have !== '' && (have === want || have.includes(want) || want.includes(have));
  });
  const merged = (key: keyof ProviderHints) => [
    ...new Set(found.flatMap(([, hints]) => hints[key] ?? [])),
  ];
  return { packages: merged('packages'), hosts: merged('hosts'), docsUrls: merged('docsUrls') };
}

type NotedRecord = RunRecord & { note?: unknown };

/** The record orchestrator/deps.ts returns when the run can't hold a task's overshoot reserve. */
export function unaffordableNote(record: NotedRecord): string | undefined {
  const note = typeof record.note === 'string' ? record.note : '';
  const nothingRan =
    record.outcome === 'failed' &&
    record.diff.trim() === '' &&
    record.costUsd === 0 &&
    !record.transcriptPath;
  return nothingRan && note.startsWith('not attempted:') ? note : undefined;
}

export async function loadRealPipeline(
  budgetUsd: number,
  options: RealPipelineOptions = {},
): Promise<RealPipeline> {
  // Without a key createDeps falls back to offline stubs, and the benchmark would grade fake work.
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'Set ANTHROPIC_API_KEY for a real run. For a $0 check run "npm run smoke -w evals".',
    );
  }
  const runBudget = createBudget(budgetUsd);
  // The repo and part a spending call runs for. Repos run at once, so each hold charges the meter of
  // the call that took it when it settles, rather than a before-and-after read of the run's spend.
  const charging = new AsyncLocalStorage<{ meter: Meter; label: string }>();
  const budget: Budget = {
    ...runBudget,
    chargeUsd: (costUsd) => {
      const spent = runBudget.chargeUsd(costUsd);
      const context = charging.getStore();
      context?.meter.charge(costUsd, context.label);
      return spent;
    },
    reserve: async (label, maxUsd, minUsd) => {
      const hold = await runBudget.reserve(label, maxUsd, minUsd);
      const context = charging.getStore();
      return {
        usd: hold.usd,
        settle: (spentUsd) => {
          const left = hold.settle(spentUsd);
          context?.meter.charge(spentUsd, context.label);
          return left;
        },
      };
    },
  };
  const deps = createDeps({ budget });
  const folders = listProviderIds();
  const watchCache = options.watchCache ?? defaultWatchCache;

  // Charges the repo's meter with what the call's holds settled. A part the run budget refuses is
  // the cap being reached: what it stops is unrun, not an attempt.
  const spending = async <T>(
    meter: Meter,
    label: string,
    call: () => Promise<T>,
    runOver = true,
  ): Promise<T> => {
    try {
      return await charging.run({ meter, label }, call);
    } catch (error) {
      if (error instanceof RunBudgetRefusal) {
        throw new BudgetExceededError(error.message, { runOver });
      }
      throw error;
    }
  };

  const checkout = gitCheckout();
  const review = createReviewer(anthropicModelClient({ budget }));
  const changesByProvider = new Map<string, Promise<ProviderChange[]>>();
  const watcherFor = (provider: string, usages: ApiUsage[]) => {
    const folder = providerFolder(provider, folders);
    if (folder) return providerWatcher(folder, budget, watchCache);
    return anyWatcher(provider, hintsFor(provider, usages), budget, watchCache, options.watchAny);
  };

  const factory: PipelineFactory = ({ entry, provider, meter }) => ({
    checkout,
    // Inventory is the first step that spends, so a provider nothing can watch stops before any
    // spend, and so does one whose read already failed in this run.
    inventory: async (repoDir, repo) => {
      if (!providerFolder(provider, folders) && !options.watchAny) {
        throw new Error(
          `no changelog watcher for ${provider} yet: providers/ has no ${provider} folder and no any-provider watcher was passed`,
        );
      }
      const read = changesByProvider.get(provider);
      if (read) await read;
      return spending(meter, 'inventory', () => deps.inventory(repoDir, repo));
    },
    watch: async (usages) => {
      // Every provider the inventory found, as the loop watches them, not only the set's: a repo on
      // OpenAI and Gemini must see Gemini's changes too. One watcher read per provider per run, so
      // every repo is matched against the same changes. A refused read is not the end of the run:
      // repos of providers already read can still go.
      const providers = [
        ...new Set([provider, ...usages.map((usage) => usage.provider.toLowerCase())]),
      ];
      const reads = providers.map((name) => {
        let changes = changesByProvider.get(name);
        if (!changes) {
          changes = spending(meter, 'watch', () => watcherFor(name, usages)(), false);
          changesByProvider.set(name, changes);
        }
        // Only the set's provider can fail the repo; another's failed read adds no changes.
        return name === provider ? changes : changes.catch(() => []);
      });
      return (await Promise.all(reads)).flat();
    },
    // The loop's batching: each call judges at most MATCH_BATCH changes, and across calls the most
    // urgent tasks go first.
    match: (changes, usages) =>
      spending(meter, 'match', async () => {
        const tasks: MatchedTask[] = [];
        const reasons: string[] = [];
        for (let start = 0; start < changes.length; start += MATCH_BATCH) {
          const result = await deps.match({
            repo: entry.repo,
            changes: changes.slice(start, start + MATCH_BATCH),
            usages,
          });
          tasks.push(...result.tasks);
          reasons.push(
            ...result.notAffected.map((n) => `${n.changeId}: not affected: ${n.reasoning}`),
          );
        }
        if (changes.length > MATCH_BATCH) tasks.sort((a, b) => urgencyRank(a) - urgencyRank(b));
        tasks.forEach((task, index) => (task.priority = index + 1));
        return {
          // One harness run and one PR per repo and provider, as the loop does.
          tasks: bundleTasks(tasks),
          reasoning: [...tasks.map((task) => `${task.id}: ${task.reasoning}`), ...reasons].join(
            '\n',
          ),
        };
      }),
    // The runner charges each record's costUsd to the meter itself. A task the run can't afford is
    // not started: it, and what follows it in this repo, is reported unrun.
    runTask: async (task, repoDir) => {
      // The harness holds a share of what is free, so the advisory review's worst case is set aside
      // first, when the run can spare it, and handed back as soon as the harness returns.
      const freeUsd = budget.capUsd - budget.spentUsd() - budget.heldUsd();
      const spare =
        freeUsd - TURN_RESERVE_USD >= REVIEW_RESERVE_USD
          ? await budget.reserve(`the review of ${task.id}`, REVIEW_RESERVE_USD)
          : undefined;
      let record: RunRecord;
      try {
        record = await deps.runTask(task, repoDir);
      } finally {
        spare?.settle(0);
      }
      const note = unaffordableNote(record);
      if (note) throw new BudgetExceededError(note, { runOver: false });
      // Memory learns from the attempt, as the loop's recordRun does, so recipes carry across
      // iterations. A failure to learn never touches the task.
      await spending(meter, 'memory', () => deps.recordRun(task, record, repoDir)).catch(
        (error: unknown) =>
          console.error(
            `memory: ${task.id} not recorded: ${error instanceof Error ? error.message : error}`,
          ),
      );
      return record;
    },
    // Charges the meter itself.
    review: (input) => review(input),
  });
  return { factory, spentUsd: () => runBudget.spentUsd() };
}

/**
 * A provider with no folder, read by the injected watcher under a hold of the run budget and
 * cached for the UTC day under the same key the orchestrator's loop uses.
 */
function anyWatcher(
  provider: string,
  hints: ProviderHints,
  budget: Budget,
  cacheDir: string,
  watchAny: AnyProviderWatcher | undefined,
) {
  return () => {
    if (!watchAny) throw new Error(`no changelog watcher for ${provider}`);
    const day = new Date().toISOString().slice(0, 10);
    return cachedChanges(cacheDir, `any-${provider}-latest-${day}`, async () => {
      const hold = await budget.reserve(`the ${provider} watcher`, WATCH_USD);
      let ledger: WatchLedger | undefined;
      try {
        ledger = new WatchLedger(Math.max(hold.usd - WATCH_CALL_USD, 0));
        return await watchAny(provider, hints, { budget: ledger })();
      } finally {
        hold.settle(ledger?.spentUsd ?? 0);
      }
    });
  };
}
