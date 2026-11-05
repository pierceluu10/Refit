import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runTask, TURN_RESERVE_USD, type HarnessRunRecord } from '../harness/index.ts';
import { isRepoTask, providersOf } from '../harness/findings.ts';
import { modelPlan } from '../harness/prepare.ts';
import { DEFAULT_RUN_CAP_USD } from '../inventory/agent.ts';
import { BudgetLedger as InventoryLedger, runInventory } from '../inventory/index.ts';
import {
  Budget as MemoryBudget,
  createRetriever,
  defaultAi,
  defaultMemory,
  habitNotes,
  knownPlan,
  learnFromRun,
  provenAllowed,
  recipesForEntries,
} from '../memory/index.ts';
import { anyProviderWatcher } from '../providers/core/any-watcher.ts';
import { BudgetLedger as WatchLedger } from '../providers/core/model.ts';
import { folderWatcher, listProviderIds } from '../providers/core/registry.ts';
import { hintsFor, loadToolPack } from '../providers/toolkit/pack.ts';
import { loadProvenFixes } from '../providers/toolkit/proven.ts';
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

// The cap on one repo's fix: one session for everything the scan found. What it leaves goes back to
// the run.
export const REPO_USD = 1;
// One provider read. The six folder reads cost about $2.60 together on 2026-11-01's dev run.
export const WATCH_USD = 1.5;
// A watcher's ledger checks its cap only before a call, so its hold keeps one call's worst case spare.
const WATCH_CALL_USD = 0.5;
// One recipe retrieval or extraction; memory refuses an Opus call whose worst case passes its cap. A
// 150KB transcript's worst case was $1.06 in round 3's first iteration, so $1 lost that recipe.
export const MEMORY_USD = 2;
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

// The commit a checkout is at, so memory's self-eval can rerun a task on what the run read. A read of
// the checkout's own git metadata on the host; nothing in the repo runs.
async function headCommit(dir: string): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)(
      'git',
      ['-C', dir, 'rev-parse', '--show-toplevel', 'HEAD'],
      { timeout: 10_000 },
    );
    const [top, commit] = stdout.trim().split('\n');
    // git looks up the tree, so a folder inside another repo would give that repo's commit.
    return top === (await realpath(dir)) ? commit : undefined;
  } catch {
    return undefined;
  }
}

const failed = (taskId: string, costUsd: number, note: string): RunRecord & { note: string } => ({
  taskId,
  outcome: 'failed',
  diff: '',
  checks: [],
  costUsd,
  transcriptPath: '',
  note,
});

// The one place that picks real or stub modules for the loop.
export function createDeps({
  out = defaultOut,
  budget,
  log = (line: string) => console.error(line),
  watchCache = defaultWatchCache,
}: {
  out?: string;
  budget?: Budget;
  log?: (line: string) => void;
  watchCache?: string;
}): LoopDeps {
  const queue = createMemoryQueue({
    concurrency: CONCURRENCY,
    retries: 2,
    backoffMs: 1000,
    log,
    // A refusal from the run budget is final, so another try would only hold a slot.
    shouldRetry: (error) => !(error instanceof BudgetExceededError),
  });
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
  const memory = (memoryBudget: MemoryBudget, repo: string) => ({
    ...defaultMemory(repo),
    ...defaultAi(process.env, memoryBudget),
  });
  const providerIds = listProviderIds();
  const appendRecord = stubRecordRun(out);

  return {
    inventory: async (dir, repo) => {
      const hold = await budget.reserve(`the ${repo} inventory`, DEFAULT_RUN_CAP_USD);
      // Inventory charges its ledger only once the Agent SDK returns a result, so until it returns
      // its whole hold counts as spent.
      let ledger: InventoryLedger | undefined;
      let spentUsd = hold.usd;
      try {
        ledger = new InventoryLedger({ capUsd: hold.usd });
        const { usages } = await runInventory(dir, repo, { ledger });
        spentUsd = ledger.spentUsd;
        return usages;
      } finally {
        hold.settle(Math.max(spentUsd, ledger?.spentUsd ?? 0));
      }
    },
    watchers: Object.fromEntries(
      providerIds.map((id) => [id, providerWatcher(id, budget, watchCache)]),
    ),
    watchAny: (provider, hints) => anyWatcher(provider, hints, budget, watchCache),
    // Opus: on Sonnet, round 3's second iteration missed dota2-helper's stripe-node 23 upgrade and
    // over-matched the Coinbase bot (10 changes, where Opus found 4), to save about $0.07 a repo.
    match: createMatchAgent({ budget }),
    runTask: async (task, dir) => {
      let hold: Hold;
      try {
        // A task starts whenever the run has room for the harness's overshoot reserve.
        hold = await budget.reserve(`task ${task.id}`, REPO_USD, TURN_RESERVE_USD);
      } catch (error) {
        if (!(error instanceof BudgetExceededError)) throw error;
        const leftUsd = budget.capUsd - budget.spentUsd();
        return failed(
          task.id,
          0,
          `not attempted: $${leftUsd.toFixed(2)} of the run cap left, below the $${TURN_RESERVE_USD} overshoot reserve a task needs`,
        );
      }
      let spentUsd = 0;
      try {
        // Recipes come first. A repo session's are a plain lookup, so memory spends nothing of its
        // cap; a changelog task's come from what the hold has above the overshoot reserve.
        const ai = memory(
          new MemoryBudget(
            isRepoTask(task) ? 0 : Math.max(Math.min(MEMORY_USD, hold.usd - TURN_RESERVE_USD), 0),
          ),
          task.repo,
        );
        const recipes = await (
          isRepoTask(task)
            ? recipesForEntries(
                task.entries.map((entry) => entry.id),
                ai.store,
              )
            : createRetriever(ai)(task)
        ).catch((error) => {
          log(`memory: no recipes for ${task.id}: ${error}`);
          return [];
        });
        const recipesUsd = ai.budget.spentUsd;
        const habits = await ai.store.getHabits(task.repo).catch(() => undefined);
        const proved = knownPlan(habits);
        // The first plan is the repo's proven setup. A second means the checks still failed, so a
        // model reads what went wrong.
        let planned = false;
        // shortcut: a harness that throws reports no spend, so until it returns its whole share counts as spent; charge it live through the harness's chargeRun (O5) once that lands.
        spentUsd = hold.usd;
        const record = await runTask(task, dir, {
          budgetUsd: hold.usd - recipesUsd,
          // Any provider: its own pack when its folder has one, plus the generic tools and
          // playbooks, led by the inventory's hints. Only folder ids are ever imported.
          loadToolPack: (provider): Promise<ToolPack> =>
            loadToolPack(provider, { hints: hintsFor(task.usages) }),
          retrieveRecipes: async () => recipes,
          habitNotes: habitNotes(habits),
          provenFixes: async (repo) => {
            const runs = await ai.store.listRuns();
            const ladder = await ai.store.listLadder();
            const allowed = repo.entries
              .map((entry) => entry.id)
              .filter((id) =>
                provenAllowed(
                  ladder.find((entry) => entry.entryId === id),
                  runs,
                ),
              );
            return loadProvenFixes(providersOf(repo), allowed);
          },
          ...(proved && {
            planPreparation: (evidence, ledger) => {
              if (planned) return modelPlan(evidence, ledger);
              planned = true;
              return Promise.resolve(proved);
            },
          }),
        });
        spentUsd = recipesUsd + record.costUsd;
        return record;
      } catch (error) {
        // Returned rather than thrown: a queue retry would count the share as spent again.
        const message = error instanceof Error ? error.message : String(error);
        return failed(
          task.id,
          spentUsd,
          spentUsd > 0
            ? `runTask failed: ${message}; its spend is unknown, so its whole $${spentUsd.toFixed(2)} share counts as spent`
            : `runTask failed: ${message}`,
        );
      } finally {
        hold.settle(spentUsd);
      }
    },
    // shortcut: a real PR needs the GitHub App's installation token and the repo's owner/name, which only the app has; the app passes its opener to runRepoJob.
    openPullRequest: stubOpenPullRequest,
    recordRun: async (task, record, dir) => {
      await appendRecord(task, record, dir);
      const { recipeIds } = record as Partial<HarnessRunRecord>;
      const transcript = record.transcriptPath
        ? await readFile(record.transcriptPath, 'utf8').catch(() => undefined)
        : undefined;
      // `commit` is read by memory from r2/memory (O6) on; a memory without it ignores the field.
      const run = {
        task,
        record,
        transcript,
        usedRecipeIds: recipeIds,
        commit: await headCommit(dir),
      };
      // Stored with no model: learning reads stored runs later, in batches, on its own budget, so it
      // can't delay a fix or spend from a repo's cap (memory/scripts/learn.ts).
      const learned = await learnFromRun(run, { ...defaultMemory(task.repo), model: undefined });
      if (learned.error) log(`memory: stored ${task.id} but learned no recipe: ${learned.error}`);
    },
    queue,
    log,
  };
}
