import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTask, type HarnessRunRecord } from '../harness/index.ts';
import { DEFAULT_RUN_CAP_USD } from '../inventory/agent.ts';
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
import type {
  ProviderChange,
  ProviderHints,
  RunRecord,
  ToolPack,
  WatchProvider,
} from '../shared/types.ts';
import { BudgetExceededError, type Budget, type Hold } from './budget.ts';
import type { LoopDeps } from './loop.ts';
import { createMatchAgent } from './match.ts';
import { createMemoryQueue } from './queue.ts';
import {
  anyProviderWatcher,
  stubInventory,
  stubMatch,
  stubOpenPullRequest,
  stubRecordRun,
  stubRunTask,
  stubWatcher,
} from './stubs.ts';

// Run records go outside the target repo; Aptitude never writes into a repo except through a PR.
export const defaultOut = join(tmpdir(), 'aptitude-runs.jsonl');

// Provider changelogs change at most daily, so one read per provider per UTC day serves every run.
export const defaultWatchCache = join(tmpdir(), 'aptitude-watch');

// Below this, a harness run cannot get past its overshoot reserve (TURN_RESERVE_USD) to edit.
export const MIN_TASK_USD = 2;
// The most one task holds of the run, so several tasks run at once. What it leaves goes back to the run.
export const TASK_USD = 5;
// One provider read. The six folder reads cost about $2.60 together on 2026-11-01's dev run.
export const WATCH_USD = 1.5;
// A watcher's ledger checks its cap only before a call, so its hold keeps one call's worst case spare.
const WATCH_CALL_USD = 0.5;
// One recipe retrieval or extraction; memory refuses an Opus call whose worst case (about $0.40) passes its cap.
export const MEMORY_USD = 1;
// Parts in flight at once. The run budget's holds, not this, keep the spend under the cap.
const CONCURRENCY = 4;

const inflight = new Map<string, Promise<ProviderChange[]>>();

// Returns the cached result for key when there is one; otherwise runs the call and caches it.
// Calls for the same key at the same time share one read, so jobs that start together pay once.
export function cachedChanges(
  dir: string,
  key: string,
  call: () => Promise<ProviderChange[]>,
): Promise<ProviderChange[]> {
  const file = join(dir, `${key.replace(/[^\w.-]+/g, '_')}.json`);
  let read = inflight.get(file);
  if (!read) {
    read = (async () => {
      const cached = await readFile(file, 'utf8').catch(() => undefined);
      if (cached !== undefined) return JSON.parse(cached) as ProviderChange[];
      const changes = await call();
      await mkdir(dir, { recursive: true });
      await writeFile(file, JSON.stringify(changes));
      return changes;
    })().finally(() => inflight.delete(file));
    inflight.set(file, read);
  }
  return read;
}

// Holds up to usd of the run for one part, runs the part on its own ledger capped at the hold, then
// settles the hold to what that ledger spent.
async function held<L extends { readonly spentUsd: number }, T>(
  budget: Budget,
  label: string,
  usd: number,
  ledger: (capUsd: number) => L,
  call: (ledger: L) => Promise<T>,
): Promise<T> {
  const hold = await budget.reserve(label, usd);
  let part: L | undefined;
  try {
    part = ledger(hold.usd);
    return await call(part);
  } finally {
    hold.settle(part?.spentUsd ?? 0);
  }
}

// A provider read, cached for the UTC day, holding WATCH_USD of the run while it reads.
function readOncePerDay(
  key: string,
  label: string,
  budget: Budget,
  cacheDir: string,
  watcher: (ledger: WatchLedger) => WatchProvider,
): WatchProvider {
  return (since) => {
    const day = new Date().toISOString().slice(0, 10);
    return cachedChanges(cacheDir, `${key}-${since ?? 'latest'}-${day}`, () =>
      held(
        budget,
        label,
        WATCH_USD,
        (capUsd) => new WatchLedger(capUsd - WATCH_CALL_USD),
        (ledger) => watcher(ledger)(since),
      ),
    );
  };
}

// One provider folder's changelog watcher.
export function providerWatcher(
  id: string,
  budget: Budget,
  cacheDir = defaultWatchCache,
): WatchProvider {
  return readOncePerDay(id, `the ${id} watcher`, budget, cacheDir, (ledger) =>
    folderWatcher(id, { budget: ledger }),
  );
}

// A watcher for a provider the inventory found that has no folder in providers/, led by its hints.
export function anyWatcher(
  provider: string,
  hints: ProviderHints,
  budget: Budget,
  cacheDir = defaultWatchCache,
): WatchProvider {
  return readOncePerDay(`any-${provider}`, `the ${provider} watcher`, budget, cacheDir, (ledger) =>
    anyProviderWatcher(provider, hints, { budget: ledger }),
  );
}

const budgetSkipped = (taskId: string, remainingUsd: number): RunRecord & { note: string } => ({
  taskId,
  outcome: 'failed',
  diff: '',
  checks: [],
  costUsd: 0,
  transcriptPath: '',
  note: `not attempted: $${remainingUsd.toFixed(2)} of the run cap left, below the $${MIN_TASK_USD} a task needs`,
});

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
  const queue = createMemoryQueue({ concurrency: CONCURRENCY, retries: 2, backoffMs: 1000, log });
  if (!process.env.ANTHROPIC_API_KEY) {
    log(
      'WARNING: ANTHROPIC_API_KEY is not set. Offline stubs stand in for every AI part; nothing is read, matched or migrated by a model.',
    );
    return {
      inventory: stubInventory(),
      // Offline there are no folder watchers: every provider in the fixture usage map takes the
      // any-provider path and replays its fixture changes.
      watchers: {},
      watchAny: (provider) => stubWatcher(provider),
      match: stubMatch,
      runTask: stubRunTask,
      openPullRequest: stubOpenPullRequest,
      recordRun: stubRecordRun(out),
      queue,
      log,
    };
  }
  if (!budget) throw new Error('ANTHROPIC_API_KEY is set, so pass a budget from createBudget().');

  // One cap for the whole run. Each part holds its share while it runs and settles to what it spent,
  // so parts running at once never spend the same remainder.
  const memory = (memoryBudget: MemoryBudget) => ({
    ...defaultMemory(),
    ...defaultAi(process.env, memoryBudget),
  });
  const providerIds = listProviderIds();
  const appendRecord = stubRecordRun(out);

  return {
    inventory: (dir, repo) =>
      held(
        budget,
        `the ${repo} inventory`,
        DEFAULT_RUN_CAP_USD,
        (capUsd) => new InventoryLedger({ capUsd }),
        async (ledger) => (await runInventory(dir, repo, { ledger })).usages,
      ),
    watchers: Object.fromEntries(providerIds.map((id) => [id, providerWatcher(id, budget)])),
    watchAny: (provider, hints) => anyWatcher(provider, hints, budget),
    match: createMatchAgent({ budget }),
    runTask: async (task, dir) => {
      let hold: Hold;
      try {
        hold = await budget.reserve(`task ${task.id}`, TASK_USD, MIN_TASK_USD);
      } catch (error) {
        if (!(error instanceof BudgetExceededError)) throw error;
        return budgetSkipped(task.id, budget.capUsd - budget.spentUsd());
      }
      let spentUsd = 0;
      try {
        // Recipes come first, from what the hold has above the harness's minimum.
        const ai = memory(
          new MemoryBudget(Math.max(Math.min(MEMORY_USD, hold.usd - MIN_TASK_USD), 0)),
        );
        const recipes = await createRetriever(ai)(task).catch((error) => {
          log(`memory: no recipes for ${task.id}: ${error}`);
          return [];
        });
        const recipesUsd = ai.budget.spentUsd;
        // shortcut: a harness that throws reports no spend, so until it returns its whole share counts as spent; charge it live through the harness's chargeRun (O5) once that lands.
        spentUsd = hold.usd;
        const record = await runTask(task, dir, {
          budgetUsd: hold.usd - recipesUsd,
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
        spentUsd = recipesUsd + record.costUsd;
        return record;
      } finally {
        hold.settle(spentUsd);
      }
    },
    // shortcut: a real PR needs the GitHub App's installation token and the repo's owner/name, which only the app has; the app passes its opener to runRepoJob.
    openPullRequest: stubOpenPullRequest,
    recordRun: async (task, record) => {
      await appendRecord(task, record);
      const { recipeIds } = record as Partial<HarnessRunRecord>;
      const transcript = record.transcriptPath
        ? await readFile(record.transcriptPath, 'utf8').catch(() => undefined)
        : undefined;
      const learn = (memoryBudget: MemoryBudget) =>
        learnFromRun({ task, record, transcript, usedRecipeIds: recipeIds }, memory(memoryBudget));
      // A record with no transcript was never attempted, so it is stored with nothing to distill.
      // Learning from an attempt waits for its share of the run; when the run can never free it,
      // the run is still stored, with nothing to spend.
      const learned = !record.transcriptPath
        ? await learn(new MemoryBudget(0))
        : await held(
            budget,
            `learning from ${task.id}`,
            MEMORY_USD,
            (capUsd) => new MemoryBudget(capUsd),
            learn,
          ).catch((error: unknown) => {
            if (error instanceof BudgetExceededError) return learn(new MemoryBudget(0));
            throw error;
          });
      if (learned.error) log(`memory: stored ${task.id} but learned no recipe: ${learned.error}`);
    },
    queue,
    log,
  };
}
