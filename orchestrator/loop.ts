import type {
  ApiUsage,
  InventoryRepo,
  MigrationTask,
  ProviderChange,
  RunRecord,
  RunTask,
  WatchProvider,
} from '../shared/types.ts';
import type { MatchChanges, MatchedTask } from './match.ts';
import type { Queue } from './queue.ts';

// The real versions land in app/ (PR opener, with harness/'s PR writer) and memory/ (run records).
export type OpenPullRequest = (
  task: MigrationTask,
  record: RunRecord,
  repoDir: string,
) => Promise<string>;
export type RecordRun = (task: MigrationTask, record: RunRecord) => Promise<void>;

// RunRecord has no free-text field, so `note` carries the match agent's reasoning for a not-affected
// verdict, or the error behind a failure. transcriptPath stays '' when no transcript exists.
export type LoopRecord = RunRecord & { note?: string };

export type LoopDeps = {
  inventory: InventoryRepo;
  watchers: WatchProvider[];
  match: MatchChanges;
  runTask: RunTask;
  openPullRequest: OpenPullRequest;
  recordRun: RecordRun;
  queue: Queue;
  log?: (line: string) => void;
};

export type Org = { name: string; repos: { repo: string; dir: string }[] };
export type RunOptions = { dryRun?: boolean; since?: string; capUsd?: number };
export type RunState = { costUsd: number; errors: string[] };

export type RunSummary = {
  counts: Record<RunRecord['outcome'], number>;
  prs: string[];
  costUsd: number;
  records: LoopRecord[];
  // Problems that are not a task outcome: a watcher that failed, a record that could not be saved.
  errors: string[];
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const record = (taskId: string, outcome: RunRecord['outcome'], note: string): LoopRecord => ({
  taskId,
  outcome,
  diff: '',
  checks: [],
  costUsd: 0,
  transcriptPath: '',
  note,
});

// A change with no MatchedTask still gets a task, so its verdict is recorded against the change.
const verdictTask = (repo: string, change: ProviderChange, usages: ApiUsage[]): MigrationTask => ({
  id: `${repo}:${change.id}`,
  repo,
  change,
  usages,
  priority: 0,
});

export async function runOrg(org: Org, deps: LoopDeps, opts: RunOptions = {}): Promise<RunSummary> {
  const log = deps.log ?? (() => {});
  const state: RunState = { costUsd: 0, errors: [] };

  // Watch once per org run; one failing watcher must not hide the others' changes.
  const watched = await Promise.allSettled(
    deps.watchers.map((watch, i) => deps.queue.add(`watch:${i}`, () => watch(opts.since))),
  );
  const changes = watched.flatMap((result, i) => {
    if (result.status === 'fulfilled') return result.value;
    state.errors.push(`watcher ${i} failed: ${errorText(result.reason)}`);
    log(`ERROR watcher ${i} failed: ${errorText(result.reason)}`);
    return [];
  });
  log(`${org.name}: ${changes.length} provider changes from ${deps.watchers.length} watcher(s)`);

  const records: LoopRecord[] = [];
  for (const target of org.repos)
    records.push(...(await runRepo(target, changes, deps, opts, state)));

  const counts = { verified: 0, 'needs-review': 0, 'not-affected': 0, failed: 0 };
  for (const r of records) counts[r.outcome]++;
  return {
    counts,
    prs: records.flatMap((r) => (r.pr ? [r.pr] : [])),
    costUsd: state.costUsd,
    records,
    errors: state.errors,
  };
}

// Every change ends as an attempted task or a recorded verdict for this repo; nothing ends silently.
export async function runRepo(
  { repo, dir }: { repo: string; dir: string },
  changes: ProviderChange[],
  deps: LoopDeps,
  opts: RunOptions = {},
  state: RunState = { costUsd: 0, errors: [] },
): Promise<LoopRecord[]> {
  const { queue } = deps;
  const log = deps.log ?? (() => {});

  async function finish(task: MigrationTask, result: LoopRecord): Promise<LoopRecord> {
    try {
      await queue.add(`${task.id}:record`, () => deps.recordRun(task, result));
    } catch (error) {
      state.errors.push(`recording ${task.id} failed: ${errorText(error)}`);
      log(`ERROR recording ${task.id} failed: ${errorText(error)}`);
    }
    log(`${result.outcome.padEnd(12)} ${task.id}${result.pr ? ` ${result.pr}` : ''}`);
    return result;
  }

  let usages: ApiUsage[] = [];
  let stage = 'inventory';
  let tasks: MatchedTask[];
  let notAffected: { changeId: string; reasoning: string }[];
  try {
    usages = await queue.add(`${repo}:inventory`, () => deps.inventory(dir, repo));
    stage = 'match';
    const matched = await queue.add(`${repo}:match`, () =>
      deps.match({ repo, changes, usages, repoDir: dir }),
    );
    state.costUsd += matched.costUsd;
    ({ tasks, notAffected } = matched);
  } catch (error) {
    // No usage map or verdicts: still attempt every change and let the harness read the repo itself.
    const failure = `${stage} failed after retries: ${errorText(error)}`;
    state.errors.push(`${repo}: ${failure}`);
    log(`ERROR ${repo}: ${failure}`);
    const notes = `${failure}. There is no ${stage === 'inventory' ? 'usage map' : 'match verdict'} for this repo: read the code yourself to find any use of this change, then migrate it or conclude not affected.`;
    tasks = changes.map((change, i) => ({
      ...verdictTask(repo, change, usages),
      priority: i + 1,
      notes,
      reasoning: notes,
      urgency: 'unknown',
      callSites: [],
    }));
    notAffected = [];
  }

  const capReached = () => opts.capUsd !== undefined && state.costUsd >= opts.capUsd;

  async function attempt(task: MatchedTask): Promise<LoopRecord> {
    let result: LoopRecord;
    try {
      result = await queue.add(task.id, async () =>
        capReached()
          ? record(
              task.id,
              'failed',
              `run budget reached before this task: $${state.costUsd.toFixed(4)} spent of the $${opts.capUsd} cap`,
            )
          : // runTask hands the repo to the harness, which runs repo code only in its sandbox, never on this host.
            deps.runTask(task, dir),
      );
    } catch (error) {
      result = record(task.id, 'failed', `runTask failed after retries: ${errorText(error)}`);
    }
    state.costUsd += result.costUsd;

    const shippable = result.outcome === 'verified' || result.outcome === 'needs-review';
    if (shippable && result.diff && !opts.dryRun) {
      const ready = result;
      try {
        const pr = await queue.add(`${task.id}:pr`, () => deps.openPullRequest(task, ready, dir));
        result = { ...ready, pr };
      } catch (error) {
        result = {
          ...ready,
          outcome: 'failed',
          note: `harness outcome was ${ready.outcome}; opening the PR failed: ${errorText(error)}`,
        };
      }
    }
    return finish(task, result);
  }

  const verdicts: Promise<LoopRecord>[] = [];
  for (const change of changes.filter((c) => !tasks.some((t) => t.change.id === c.id))) {
    const verdict = notAffected.find((v) => v.changeId === change.id);
    if (verdict) {
      const task = verdictTask(repo, change, usages);
      verdicts.push(finish(task, record(task.id, 'not-affected', verdict.reasoning)));
      continue;
    }
    // A matcher that gave no verdict does not end the change: the harness judges it.
    const notes =
      'The match agent returned no verdict for this change. Check the repo for any use of it, then migrate or conclude not affected.';
    tasks.push({
      ...verdictTask(repo, change, usages),
      priority: tasks.length + 1,
      notes,
      reasoning: notes,
      urgency: 'unknown',
      callSites: [],
    });
  }

  return Promise.all([...verdicts, ...tasks.map(attempt)]);
}
