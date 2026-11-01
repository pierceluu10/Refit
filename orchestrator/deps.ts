import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTask, type HarnessRunRecord } from '../harness/index.ts';
import { BudgetLedger as InventoryLedger, runInventory } from '../inventory/index.ts';
import {
  Budget as MemoryBudget,
  createRetriever,
  defaultAi,
  defaultMemory,
  learnFromRun,
} from '../memory/index.ts';
import { BudgetLedger as WatchLedger } from '../providers/core/model.ts';
import { folderWatcher, listProviderIds } from '../providers/core/registry.ts';
import type { ToolPack, WatchProvider } from '../shared/types.ts';
import type { Budget } from './budget.ts';
import type { LoopDeps } from './loop.ts';
import { createMatchAgent } from './match.ts';
import { createMemoryQueue } from './queue.ts';
import {
  stubInventory,
  stubMatch,
  stubOpenPullRequest,
  stubRecordRun,
  stubRunTask,
  stubWatcher,
} from './stubs.ts';

// Run records go outside the target repo; Aptitude never writes into a repo except through a PR.
export const defaultOut = join(tmpdir(), 'aptitude-runs.jsonl');

const remainingOf = (budget: Budget) => Math.max(budget.capUsd - budget.spentUsd(), 0);

// Runs a part's call, then charges the run budget with what the part's own ledger spent.
async function chargedTo<T>(
  budget: Budget,
  spentUsd: () => number,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } finally {
    budget.chargeUsd(spentUsd());
  }
}

// One provider's changelog watcher: it may spend what is left of the run, then charges it.
export function providerWatcher(id: string, budget: Budget): WatchProvider {
  return (since) => {
    const ledger = new WatchLedger(remainingOf(budget));
    return chargedTo(
      budget,
      () => ledger.spentUsd,
      () => folderWatcher(id, { budget: ledger })(since),
    );
  };
}

// The one place that picks real or stub modules for the loop.
export function createDeps({
  out = defaultOut,
  budget,
  log = (line: string) => console.error(line),
}: {
  out?: string;
  budget?: Budget;
  log?: (line: string) => void;
}): LoopDeps {
  const queue = (concurrency: number) =>
    createMemoryQueue({ concurrency, retries: 2, backoffMs: 1000, log });
  if (!process.env.ANTHROPIC_API_KEY) {
    log(
      'WARNING: ANTHROPIC_API_KEY is not set. Offline stubs stand in for every AI part; nothing is read, matched or migrated by a model.',
    );
    return {
      inventory: stubInventory(),
      watchers: [stubWatcher()],
      match: stubMatch,
      runTask: stubRunTask,
      openPullRequest: stubOpenPullRequest,
      recordRun: stubRecordRun(out),
      queue: queue(4),
      log,
    };
  }
  if (!budget) throw new Error('ANTHROPIC_API_KEY is set, so pass a budget from createBudget().');

  // One cap for the whole run: each part may spend what is left of it, then charges what it spent.
  const remaining = () => remainingOf(budget);
  const charged = <T>(spentUsd: () => number, call: () => Promise<T>) =>
    chargedTo(budget, spentUsd, call);
  const memory = () => ({
    ...defaultMemory(),
    ...defaultAi(process.env, new MemoryBudget(remaining())),
  });
  const providerIds = listProviderIds();
  const appendRecord = stubRecordRun(out);

  return {
    inventory: (dir, repo) => {
      const ledger = new InventoryLedger({ capUsd: remaining() });
      return charged(
        () => ledger.spentUsd,
        async () => (await runInventory(dir, repo, { ledger })).usages,
      );
    },
    watchers: providerIds.map((id) => providerWatcher(id, budget)),
    match: createMatchAgent({ budget }),
    runTask: async (task, dir) => {
      // Recipes come first, so the harness's cap is what is left after them.
      const ai = memory();
      const recipes = await charged(
        () => ai.budget.spentUsd,
        () => createRetriever(ai)(task),
      ).catch((error) => {
        log(`memory: no recipes for ${task.id}: ${error}`);
        return [];
      });
      const record = await runTask(task, dir, {
        budgetUsd: remaining(),
        // Only provider folders, so a provider name never becomes an arbitrary import path.
        loadToolPack: async (provider) => {
          if (!providerIds.includes(provider)) throw new Error(`no tool pack for ${provider}`);
          const pack = (await import(`../providers/${provider}/tools.ts`)) as {
            toolPack: ToolPack;
          };
          return pack.toolPack;
        },
        retrieveRecipes: async () => recipes,
      });
      // shortcut: if the harness throws instead of returning a record, its spend is not charged here; pass it a shared ledger to close that gap.
      budget.chargeUsd(record.costUsd);
      return record;
    },
    // shortcut: a real PR needs the GitHub App's installation token and the repo's owner/name, which only the app has; swap in its opener when the app runs the loop.
    openPullRequest: stubOpenPullRequest,
    recordRun: async (task, record) => {
      await appendRecord(task, record);
      const { recipeIds } = record as Partial<HarnessRunRecord>;
      const transcript = record.transcriptPath
        ? await readFile(record.transcriptPath, 'utf8').catch(() => undefined)
        : undefined;
      const ai = memory();
      const learned = await charged(
        () => ai.budget.spentUsd,
        () => learnFromRun({ task, record, transcript, usedRecipeIds: recipeIds }, ai),
      );
      if (learned.error) log(`memory: stored ${task.id} but learned no recipe: ${learned.error}`);
    },
    // One call at a time: each part's cap is what is left of the run, so parallel calls could each spend it.
    queue: queue(1),
    log,
  };
}
