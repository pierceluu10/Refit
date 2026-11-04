// understand -> match -> harness -> (advisory review) for each repo, under one dollar cap.
// Scoring reads the RepoResult files this writes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MigrationTask, RunRecord } from '../../shared/types.ts';
import type { DevSet, RepoEntry } from '../sets/index.ts';
import { BudgetExceededError, BudgetLedger } from './budget.ts';
import type { PipelineFactory, RepoResult, RunConfig, TaskResult } from './types.ts';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Did the agent attempt this task? An attempt is a diff, or an explicit not-affected verdict.
 * Anything else (a throw, an empty needs-review, a 'failed' with no diff) is a bug: Aptitude
 * always tries.
 */
export function judgeAttempt(record: RunRecord): { attempted: boolean; reason?: string } {
  if (record.outcome === 'not-affected') return { attempted: true };
  if (record.diff.trim() === '') {
    return { attempted: false, reason: `outcome ${record.outcome} with an empty diff` };
  }
  return { attempted: true };
}

/** What the match agent said about a task: its reasoning and call sites, when it gave them. */
function matchContext(task: MigrationTask): Pick<TaskResult, 'reasoning' | 'callSites'> {
  const named = (task as { callSites?: unknown }).callSites;
  const callSites = Array.isArray(named)
    ? named.flatMap((site) => {
        const { file, line, why } = (site ?? {}) as {
          file?: unknown;
          line?: unknown;
          why?: unknown;
        };
        return typeof file === 'string' && typeof line === 'number'
          ? [{ file, line, ...(typeof why === 'string' ? { why } : {}) }]
          : [];
      })
    : [];
  return {
    ...(task.notes ? { reasoning: task.notes } : {}),
    ...(callSites.length > 0 ? { callSites } : {}),
  };
}

function unrunTask(task: MigrationTask, reason?: string): TaskResult {
  return {
    taskId: task.id,
    changeId: task.change.id,
    kind: task.change.kind,
    change: task.change,
    ...matchContext(task),
    attempted: false,
    unrun: 'budget',
    ...(reason ? { unrunReason: reason } : {}),
  };
}

export async function runRepo(
  entry: RepoEntry,
  index: number,
  set: Pick<DevSet, 'name' | 'provider'>,
  factory: PipelineFactory,
  ledger: BudgetLedger,
): Promise<RepoResult> {
  const started = Date.now();
  const meter = ledger.meter(entry.repo);
  // A mixed set (the smoke set) names each entry's provider; a dev set names one for all.
  const provider = typeof entry.provider === 'string' ? entry.provider : set.provider;
  const result: RepoResult = {
    set: set.name,
    index,
    repo: entry.repo,
    commit: entry.commit,
    provider,
    usages: 0,
    changes: 0,
    verdict: 'tasks',
    tasks: [],
    costUsd: 0,
    durationMs: 0,
  };
  const finish = () => {
    result.costUsd = meter.totalUsd();
    result.costByPart = meter.byPart();
    result.durationMs = Date.now() - started;
    return result;
  };
  if (ledger.exhausted()) {
    result.verdict = 'unrun';
    result.error = ledger.stopReason
      ? `dollar cap reached before this repo started: ${ledger.stopReason}`
      : 'dollar cap reached before this repo started';
    return finish();
  }

  const pipeline = factory({ entry, provider, meter });
  let checkout: Awaited<ReturnType<typeof pipeline.checkout>> | undefined;
  let tasks: MigrationTask[] = [];
  try {
    checkout = await pipeline.checkout(entry);
    const usages = await pipeline.inventory(checkout.repoDir, entry.repo);
    result.usages = usages.length;
    const changes = await pipeline.watch(usages);
    result.changes = changes.length;
    const matched = await pipeline.match(changes, usages);
    result.matchReasoning = matched.reasoning;
    if (matched.tasks.length === 0) {
      result.verdict = 'not-affected';
      return finish();
    }
    // Priority 1 is the most urgent task, so it reaches the dollar cap first.
    tasks = [...matched.tasks].sort((a, b) => a.priority - b.priority);
    // Every task is recorded first, in priority order; then they run at once (one per provider
    // since the bundle, so independent), within the process's TASK_SLOTS.
    const results = tasks.map((task): TaskResult => ({
      taskId: task.id,
      changeId: task.change.id,
      kind: task.change.kind,
      change: task.change,
      ...matchContext(task),
      attempted: false,
    }));
    result.tasks.push(...results);
    const runOne = async (task: MigrationTask, taskResult: TaskResult) => {
      if (ledger.exhausted()) {
        Object.assign(taskResult, unrunTask(task));
        return;
      }
      try {
        const record = await pipeline.runTask(task, checkout!.repoDir);
        taskResult.record = record;
        const verdict = judgeAttempt(record);
        taskResult.attempted = verdict.attempted;
        if (verdict.reason) taskResult.noAttemptReason = verdict.reason;
        meter.charge(record.costUsd, `task ${task.id}`);
      } catch (error) {
        if (error instanceof BudgetExceededError) throw error;
        taskResult.noAttemptReason = `runTask threw: ${message(error)}`;
        return;
      }
      const record = taskResult.record;
      // A second opinion needs a diff to read; an empty one would only spend.
      if (pipeline.review && record && record.diff.trim() !== '') {
        // Advisory only. A reviewer failure is logged and never touches the grade.
        try {
          taskResult.review = await pipeline.review({
            task,
            record,
            meter,
            repoDir: checkout!.repoDir,
          });
        } catch (error) {
          if (error instanceof BudgetExceededError) throw error;
          taskResult.review = {
            opinion: 'unavailable',
            summary: `reviewer failed: ${message(error)}`,
            concerns: [],
            costUsd: 0,
            model: 'none',
          };
        }
      }
    };
    const settled = await Promise.allSettled(
      tasks.map((task, i) => taskSlot(() => runOne(task, results[i] as TaskResult))),
    );
    // What the tasks started in the background (memory learning) finishes before the repo is
    // recorded, so its cost is the repo's.
    await pipeline.drain?.();
    const failure = settled.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    if (failure) throw failure.reason;
  } catch (error) {
    if (error instanceof BudgetExceededError) {
      // The cap is a hard limit: tasks it stopped are reported as unrun, not as attempts. That
      // includes the task it interrupted, unless that task already has a record to grade.
      for (const task of result.tasks) {
        if (task.record || task.unrun || task.noAttemptReason) continue;
        task.unrun = 'budget';
        task.unrunReason = error.message;
      }
      result.tasks.push(
        ...tasks.slice(result.tasks.length).map((rest) => unrunTask(rest, error.message)),
      );
      if (result.tasks.length === 0) result.verdict = 'unrun';
      result.error = error.message;
      if (error.runOver) ledger.stop(error.message);
    } else {
      if (result.tasks.length === 0) result.verdict = 'error';
      result.error = `pipeline threw: ${message(error)}`;
    }
  } finally {
    await checkout?.cleanup().catch(() => undefined);
  }
  return finish();
}

// Harness runs at once across the whole process. A repo's tasks run in parallel; this keeps the
// sandboxes they install and build in within what one machine holds.
const TASK_SLOTS = 6;
let freeSlots = TASK_SLOTS;
const waitingForSlot: (() => void)[] = [];
async function taskSlot<T>(work: () => Promise<T>): Promise<T> {
  if (freeSlots === 0) await new Promise<void>((resolve) => waitingForSlot.push(resolve));
  else freeSlots -= 1;
  try {
    return await work();
  } finally {
    const next = waitingForSlot.shift();
    if (next) next();
    else freeSlots += 1;
  }
}

/** Runs a set (or one shard of it) with bounded concurrency and writes one JSON per repo. */
export async function runSet(
  config: RunConfig,
  set: DevSet,
  factory: PipelineFactory,
): Promise<{ results: RepoResult[]; ledger: BudgetLedger }> {
  const ledger = new BudgetLedger(config.budgetUsd);
  const indices = config.shard === undefined ? set.repos.map((_, index) => index) : [config.shard];
  for (const index of indices) {
    if (!set.repos[index])
      throw new Error(`shard ${index} is outside ${set.name} (${set.repos.length} repos)`);
  }
  const outDir = join(config.outDir, set.name);
  mkdirSync(outDir, { recursive: true });
  const results: RepoResult[] = [];
  let next = 0;
  const worker = async () => {
    while (next < indices.length) {
      const index = indices[next] as number;
      next += 1;
      const entry = set.repos[index] as RepoEntry;
      const result = await runRepo(entry, index, set, factory, ledger);
      results.push(result);
      const file = `${String(index).padStart(3, '0')}-${entry.repo.replace('/', '__')}.json`;
      writeFileSync(join(outDir, file), `${JSON.stringify(result, null, 2)}\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(config.concurrency, indices.length) }, worker));
  results.sort((a, b) => a.index - b.index);
  return { results, ledger };
}
