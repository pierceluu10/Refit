// The benchmark runner's contract. Real modules (inventory, match, harness) land on other
// branches; the runner codes against shared/types.ts entry points plus the one local type the
// match agent will export (O1 owns it).
import type {
  ApiUsage,
  InventoryRepo,
  MigrationTask,
  ProviderChange,
  RunRecord,
  RunTask,
  WatchProvider,
} from '../../shared/types.ts';
import type { RepoEntry } from '../sets/index.ts';
import type { AdvisoryReview, ReviewTask } from '../reviewer/reviewer.ts';

/** The match agent's entry point. Not in shared/types.ts yet; O1 exports it from orchestrator/. */
export type MatchChanges = (
  changes: ProviderChange[],
  usages: ApiUsage[],
) => Promise<{ tasks: MigrationTask[]; reasoning: string }>;

/** Gets a working copy of a repo at its frozen commit. Never runs repo code. */
export type CheckoutRepo = (entry: RepoEntry) => Promise<{
  repoDir: string;
  cleanup: () => Promise<void>;
}>;

/** Charges AI spend against the run's dollar cap. Throws BudgetExceededError past the cap. */
export type Meter = { charge: (usd: number, label: string) => void };

/**
 * Second-opinion reviewer. Advisory only: its answer never changes a grade. repoDir is the
 * untouched checkout, which it may read (never run) for context.
 */
export type ReviewPr = (input: {
  task: ReviewTask;
  record: RunRecord;
  meter: Meter;
  repoDir?: string;
}) => Promise<AdvisoryReview>;

/**
 * Reads the changes to match one repo against. It gets the repo's usage map, so a watcher for a
 * provider with no folder in providers/ can start from what the inventory found (its hints).
 */
export type WatchRepo = (usages: ApiUsage[]) => ReturnType<WatchProvider>;

/**
 * Everything one repo's run needs. A factory builds it per repo with that repo's meter, so
 * modules that spend money (inventory, match, reviewer) charge the right repo.
 * runTask reports its own spend in RunRecord.costUsd; the runner charges that to the meter.
 * A part the run can't afford throws BudgetExceededError (runner/budget.ts): what it stopped is
 * reported as unrun, never as an attempt.
 */
export type Pipeline = {
  checkout: CheckoutRepo;
  inventory: InventoryRepo;
  watch: WatchRepo;
  match: MatchChanges;
  runTask: RunTask;
  review?: ReviewPr;
};
export type PipelineFactory = (context: {
  entry: RepoEntry;
  provider: string;
  meter: Meter;
}) => Pipeline;

export type RunConfig = {
  set: string;
  /** Hard dollar cap for this run (or this shard). Required, finite and above zero. */
  budgetUsd: number;
  /** How many repos run at once. Required, a positive integer. */
  concurrency: number;
  /** Run only this index of the set (one GitHub Actions shard). Omit to run every repo. */
  shard?: number;
  /** Run only this many repos, taken round-robin across the set's providers. Omit to run every repo. */
  limit?: number;
  outDir: string;
  /**
   * Where provider reads are cached for the UTC day. Shards point it at the cache a single
   * `watch` job wrote, so each shard doesn't pay for its own read.
   */
  watchCache?: string;
};

export type TaskResult = {
  taskId: string;
  changeId: string;
  kind: string;
  /** The change the task migrates, with its quoted source, for hand-checks and re-reviews. */
  change?: ProviderChange;
  /** The match agent's reasoning for this task, and the call sites it named. */
  reasoning?: string;
  callSites?: { file: string; line: number; why?: string }[];
  /** True when the agent made an attempt: a diff, or an explicit not-affected verdict. */
  attempted: boolean;
  /** Why a task counts as not attempted. Every one of these is a bug to fix. */
  noAttemptReason?: string;
  record?: RunRecord;
  review?: AdvisoryReview;
  /** Set when the dollar cap was reached before this task could start. */
  unrun?: 'budget';
  /** What the cap left and what the task needed, for an unrun task. */
  unrunReason?: string;
};

export type RepoResult = {
  set: string;
  index: number;
  repo: string;
  commit: string;
  provider: string;
  usages: number;
  changes: number;
  matchReasoning?: string;
  /** 'not-affected' when the match agent found no task for this repo. */
  verdict: 'tasks' | 'not-affected' | 'error' | 'unrun';
  error?: string;
  tasks: TaskResult[];
  costUsd: number;
  /** costUsd split by part (inventory, watch, match, harness, review), from the meter's labels. */
  costByPart?: Record<string, number>;
  durationMs: number;
};
