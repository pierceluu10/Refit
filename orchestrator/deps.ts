import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  Budget as ComplianceBudget,
  createComplianceModel,
  matchObligations,
  obligationsToChanges,
  readRegulations,
  recordAudit,
  saveObligations,
  watchRegulations,
} from '../compliance/index.ts';
import { runExternalTask, runTask, type HarnessRunRecord } from '../harness/index.ts';
import {
  BudgetLedger as InventoryLedger,
  DEFAULT_DEPENDENCY_RUN_CAP_USD,
  runDependencyInventory,
} from '../inventory/index.ts';
import {
  createInventorySurfaces,
  DEFAULT_RUN_CAP_USD as SURFACES_RUN_CAP_USD,
} from '../inventory/surfaces/index.ts';
import {
  Budget as MemoryBudget,
  createRetriever,
  defaultAi,
  defaultMemory,
  JsonMemoryStore,
  learnFromRun,
  recordScanReport,
} from '../memory/index.ts';
import { anyProviderWatcher } from '../providers/core/any-watcher.ts';
import { watchDependency } from '../providers/core/dependency-watcher.ts';
import { BudgetLedger as WatchLedger, watchModelId } from '../providers/core/model.ts';
import { folderWatcher } from '../providers/core/registry.ts';
import { WatchFailedError } from '../providers/core/watcher.ts';
import { hintsFor, loadToolPack } from '../providers/toolkit/pack.ts';
import type {
  MigrationTask,
  ProviderChange,
  ProviderHints,
  RunRecord,
  ToolPack,
  WatchProvider,
} from '../shared/types.ts';
import { BudgetExceededError, worstCaseUsd, type Budget, type Hold } from './budget.ts';
import type { LoopDeps } from './loop.ts';
import { createExternalMatchAgent } from './external-match.ts';
import { createMatchAgent } from './match.ts';
import type { AnyTask, ExternalDeps, Note, ScanItemReport } from './scan.ts';
import { createMemoryQueue, FinalError } from './queue.ts';
import {
  stubInventory,
  stubMatch,
  stubOpenPullRequest,
  stubRecordRun,
  stubRunTask,
  stubWatcher,
} from './stubs.ts';
import {
  stubInventoryDependencies,
  stubMatchExternal,
  stubRunExternalTask,
  stubWatchDependency,
} from './stubs-external.ts';

// Run records go outside the target repo; Refit never writes into a repo except through a PR.
export const defaultOut = join(tmpdir(), 'refit-runs.jsonl');

// The latest "what's behind" report per repo, outside every target repo.
export const defaultReports = join(tmpdir(), 'refit-reports');

// Saves a repo's report as <dir>/<owner_name>.json.
export function saveReport(dir: string): (report: ScanItemReport) => Promise<void> {
  return async (report) => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${report.repo.replace(/[^\w.-]+/g, '_')}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  };
}

// An ExternalTask carries the dependencies it moves; an API task does not.
export const isExternalTask = (task: AnyTask): task is Exclude<AnyTask, MigrationTask> =>
  'dependencies' in task && Array.isArray(task.dependencies);

// Provider changelogs change at most daily, so one read per provider per UTC day serves every run.
export const defaultWatchCache = join(tmpdir(), 'refit-watch');

// Below this, a harness run cannot get past its overshoot reserve (TURN_RESERVE_USD) to edit.
export const MIN_TASK_USD = 2;
// The most one task holds of a small run, so several tasks run at once. In a big run a task may hold
// a fair share of what is free instead: a CONCURRENCY-th of it. What it leaves goes back to the run.
export const TASK_USD = 5;
// The most one read of a provider, dependency or rule set holds, and the least worth starting it on.
export const WATCH_USD = 1.5;
// A read's first call: a changelog page and an answer, priced for the watch model.
const READ_START_INPUT_TOKENS = 100_000;
const READ_START_OUTPUT_TOKENS = 8_000;
const SMALL_RUN_WATCH_USD = 0.4;
// A read also holds this for a match call, so a small run's reads cannot use up what matching needs.
const MATCH_FLOOR_USD = 0.2;
// One inventory: P2's agent, then P5's on the same ledger. A small run keeps some for reading what it finds.
const INVENTORY_USD = DEFAULT_DEPENDENCY_RUN_CAP_USD + SURFACES_RUN_CAP_USD;
const INVENTORY_MIN_USD = 0.3;
const INVENTORY_RUN_SHARE = 0.5;
const DEPENDENCY_INVENTORY_SHARE = 0.6;
// One recipe retrieval or extraction; memory refuses an Opus call whose worst case (about $0.40) passes its cap.
export const MEMORY_USD = 1;
// Parts in flight at once. The run budget's holds, not this, keep the spend under the cap.
const CONCURRENCY = 4;

const inflight = new Map<string, Promise<unknown>>();

// Returns the cached result for key when there is one; otherwise runs the call and caches it.
// Calls for the same key at the same time share one read, so jobs that start together pay once.
export function cachedChanges<T = ProviderChange[]>(
  dir: string,
  key: string,
  call: () => Promise<T>,
): Promise<T> {
  const file = join(dir, `${key.replace(/[^\w.-]+/g, '_')}.json`);
  let read = inflight.get(file) as Promise<T> | undefined;
  if (!read) {
    read = (async () => {
      const cached = await readFile(file, 'utf8').catch(() => undefined);
      if (cached !== undefined) return JSON.parse(cached) as T;
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

// One read on its own ledger, which never spends the part of the hold kept for matching.
async function heldRead<L extends { readonly spentUsd: number }, T>(
  budget: Budget,
  label: string,
  ledger: (capUsd: number) => L,
  call: (ledger: L) => Promise<T>,
): Promise<T> {
  const readUsd = Math.max(SMALL_RUN_WATCH_USD, Math.min(WATCH_USD, budget.capUsd / CONCURRENCY));
  const hold = await budget.reserve(
    label,
    readUsd + MATCH_FLOOR_USD,
    worstCaseUsd(watchModelId(), READ_START_INPUT_TOKENS, READ_START_OUTPUT_TOKENS) +
      MATCH_FLOOR_USD,
  );
  let part: L | undefined;
  try {
    part = ledger(hold.usd - MATCH_FLOOR_USD);
    return await call(part);
  } finally {
    hold.settle(part?.spentUsd ?? 0);
  }
}

// A read, cached for the UTC day with what it could not read, so a cached answer stays as honest.
async function readOncePerDay<T>(
  key: string,
  label: string,
  budget: Budget,
  cacheDir: string,
  read: (ledger: WatchLedger, note: Note) => Promise<T>,
  note?: Note,
): Promise<T> {
  const day = new Date().toISOString().slice(0, 10);
  const { found, errors } = await cachedChanges(
    cacheDir,
    `${key}-${watchModelId()}-${day}`,
    async () => {
      const errors: string[] = [];
      const found = await heldRead(
        budget,
        label,
        (capUsd) => new WatchLedger(capUsd),
        (ledger) => read(ledger, (error) => errors.push(error)),
      );
      return { found, errors };
    },
  );
  for (const error of errors) note?.(error);
  return found;
}

// One provider folder's changelog watcher.
export function providerWatcher(
  id: string,
  budget: Budget,
  cacheDir = defaultWatchCache,
): WatchProvider {
  return (since) =>
    readOncePerDay(`${id}-${since ?? 'latest'}`, `the ${id} watcher`, budget, cacheDir, (ledger) =>
      folderWatcher(id, { budget: ledger })(since),
    );
}

// Any provider the inventory found, led by its hints; a folder in providers/ is a head start.
export function anyWatcher(
  provider: string,
  hints: ProviderHints,
  budget: Budget,
  cacheDir = defaultWatchCache,
  note?: Note,
): WatchProvider {
  return (since) =>
    readOncePerDay(
      `any-${provider}-${since ?? 'latest'}`,
      `the ${provider} watcher`,
      budget,
      cacheDir,
      (ledger, noted) =>
        anyProviderWatcher(provider, hints, {
          budget: ledger,
          onReport: (report) => report.errors.forEach(noted),
        })(since),
      note,
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
  reports = defaultReports,
}: {
  out?: string;
  budget?: Budget;
  log?: (line: string) => void;
  watchCache?: string;
  reports?: string;
}): LoopDeps {
  const queue = createMemoryQueue({
    concurrency: CONCURRENCY,
    retries: 2,
    backoffMs: 1000,
    log,
    // A refusal from any part's budget is final, and a read that never got an answer already had its turns.
    shouldRetry: (error) =>
      (error as Error).name !== BudgetExceededError.name && !(error instanceof WatchFailedError),
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
      external: {
        inventoryDependencies: stubInventoryDependencies(),
        watchDependency: stubWatchDependency(),
        match: stubMatchExternal,
        runExternalTask: stubRunExternalTask,
        // With no key these read nothing and say why.
        watchRegulations,
        obligationsToChanges,
      },
      recordAudit,
      recordReport: saveReport(reports),
    };
  }
  if (!budget) throw new Error('ANTHROPIC_API_KEY is set, so pass a budget from createBudget().');

  // One cap for the whole run. Each part holds its share while it runs and settles to what it spent,
  // so parts running at once never spend the same remainder.
  const memory = (memoryBudget: MemoryBudget) => ({
    ...defaultMemory(),
    ...defaultAi(process.env, memoryBudget),
  });
  const appendRecord = stubRecordRun(out);

  // A harness run on its own hold of the run budget, with recipes from memory.
  const harnessTask = async (task: AnyTask, dir: string): Promise<RunRecord> => {
    const freeUsd = budget.capUsd - budget.spentUsd() - budget.heldUsd();
    let hold: Hold;
    try {
      hold = await budget.reserve(
        `task ${task.id}`,
        Math.max(TASK_USD, freeUsd / CONCURRENCY),
        MIN_TASK_USD,
      );
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      const leftUsd = budget.capUsd - budget.spentUsd();
      return failed(
        task.id,
        0,
        `not attempted: $${leftUsd.toFixed(2)} of the run cap left, below the $${MIN_TASK_USD} a task needs`,
      );
    }
    // Charged as the harness spends, so a run that throws still reports what it cost.
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
      spentUsd = ai.budget.spentUsd;
      const shared = {
        budgetUsd: hold.usd - spentUsd,
        chargeRun: (usd: number) => {
          spentUsd += usd;
        },
        // Any provider: its own pack when its folder has one, plus the generic tools and
        // playbooks, led by the inventory's hints. Only folder ids are ever imported.
        loadToolPack: (provider: string): Promise<ToolPack> =>
          loadToolPack(provider, { hints: hintsFor(task.usages ?? []) }),
      };
      return isExternalTask(task)
        ? await runExternalTask(task, dir, {
            ...shared,
            retrieveExternalRecipes: async () => recipes,
          })
        : await runTask(task, dir, { ...shared, retrieveRecipes: async () => recipes });
    } catch (error) {
      // Returned rather than thrown: a queue retry would pay for the whole attempt again.
      const message = error instanceof Error ? error.message : String(error);
      return failed(task.id, spentUsd, `the harness failed: ${message}`);
    } finally {
      hold.settle(spentUsd);
    }
  };

  // P2's agent finds APIs and dependencies in one pass and P5's adds surfaces, so a scan pays for one
  // inventory. The API path and the external path both read it; whichever comes second takes it.
  const readInventory = async (dir: string, repo: string) => {
    const hold = await budget.reserve(
      `the ${repo} inventory`,
      Math.max(INVENTORY_MIN_USD, Math.min(INVENTORY_USD, budget.capUsd * INVENTORY_RUN_SHARE)),
      INVENTORY_MIN_USD,
    );
    // Inventory charges its ledger only once the Agent SDK returns a result, so until it returns its
    // whole hold counts as spent.
    let ledger: InventoryLedger | undefined;
    let spentUsd = hold.usd;
    try {
      ledger = new InventoryLedger({ capUsd: hold.usd });
      const report = await runDependencyInventory(dir, repo, {
        ledger,
        runCapUsd: hold.usd * DEPENDENCY_INVENTORY_SHARE,
        surfaces: createInventorySurfaces({ ledger }),
      });
      spentUsd = ledger.spentUsd;
      return report;
    } catch (error) {
      // Another try would pay for the same read again.
      throw new FinalError(error instanceof Error ? error.message : String(error));
    } finally {
      hold.settle(Math.max(spentUsd, ledger?.spentUsd ?? 0));
    }
  };
  const inventories = new Map<string, ReturnType<typeof readInventory>>();
  const inventoryOnce = (dir: string, repo: string) => {
    const key = `${repo}\n${dir}`;
    const started = inventories.get(key);
    if (started) {
      inventories.delete(key);
      return started;
    }
    const run = readInventory(dir, repo);
    inventories.set(key, run);
    return run;
  };

  return {
    inventory: async (dir, repo) => (await inventoryOnce(dir, repo)).usages,
    // Every provider is read through watchAny, only once the inventory has found it. A folder in
    // providers/ is its head start, so nothing here pays to read a provider this org does not use.
    watchers: {},
    watchAny: (provider, hints, note) => anyWatcher(provider, hints, budget, watchCache, note),
    match: createMatchAgent({ budget }),
    runTask: harnessTask,
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
      const learn = (memoryBudget: MemoryBudget) => learnFromRun(run, memory(memoryBudget));
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
    external: {
      inventoryDependencies: async (dir, repo, note) => {
        const report = await inventoryOnce(dir, repo);
        report.errors.forEach((error) => note?.(error));
        return report.dependencies;
      },
      watchDependency: async (dep, since, note) => {
        // O5's rules agent reads these; F1 has nothing to read for them, so nothing is held.
        if (dep.kind === 'regulated-surface') return [];
        const place = [dep.kind, dep.ecosystem, dep.name, dep.version, since ?? 'latest'];
        return readOncePerDay(
          `dep-${place.join('-')}`,
          `the ${dep.name} watcher`,
          budget,
          watchCache,
          (ledger, noted) =>
            watchDependency(dep, since, {
              budget: ledger,
              hints: dep.hints,
              onReport: (report) => report.errors.forEach(noted),
            }),
          note,
        );
      },
      watchRegulations: async (since, note) => {
        const day = new Date().toISOString().slice(0, 10);
        const { obligations, errors } = await cachedChanges(
          watchCache,
          `regulations-${since ?? 'latest'}-${watchModelId()}-${day}`,
          () =>
            heldRead(
              budget,
              'the regulations watcher',
              (capUsd) => new ComplianceBudget(capUsd),
              async (ledger) => {
                const read = await readRegulations(since, {
                  model: createComplianceModel(process.env, ledger),
                });
                // Not cached: nothing was read, so the next run should try again.
                if (read.obligations.length === 0 && read.errors.length > 0)
                  throw new FinalError(read.errors.join('; '));
                await saveObligations(read.obligations);
                return { obligations: read.obligations, errors: read.errors };
              },
            ),
        );
        errors.forEach((error) => note?.(error));
        return obligations;
      },
      obligationsToChanges: (repo, surfaces, obligations, repoDir, note) =>
        heldRead(
          budget,
          `the ${repo} rules match`,
          (capUsd) => new ComplianceBudget(capUsd),
          async (ledger) => {
            const match = await matchObligations(repo, surfaces, obligations, {
              model: createComplianceModel(process.env, ledger),
              repoDir,
            });
            match.errors.forEach((error) => note?.(error));
            return match.changes;
          },
        ),
      match: createExternalMatchAgent({ budget }),
      runExternalTask: harnessTask,
    } satisfies ExternalDeps,
    recordAudit,
    recordReport: async (report) => {
      await saveReport(reports)(report);
      await recordScanReport(report, JsonMemoryStore.fromEnv());
    },
    spentUsd: () => budget.spentUsd(),
  };
}
