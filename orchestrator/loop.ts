import type {
  ApiUsage,
  InventoryRepo,
  MigrationTask,
  OpenPullRequest,
  ProviderChange,
  ProviderHints,
  RunRecord,
  RunTask,
  WatchProvider,
} from '../shared/types.ts';
import type { MatchChanges, MatchedTask } from './match.ts';
import type { Queue } from './queue.ts';

// The real version lands in memory/ (run records).
export type RecordRun = (task: MigrationTask, record: RunRecord) => Promise<void>;

// RunRecord has no free-text field, so `note` carries the match agent's reasoning for a not-affected
// verdict, or the error behind a failure. transcriptPath stays '' when no transcript exists.
export type LoopRecord = RunRecord & { note?: string };

export type LoopDeps = {
  inventory: InventoryRepo;
  // Head starts, never the limit: a watcher for each provider with a folder in providers/, by id.
  watchers: Record<string, WatchProvider>;
  // A watcher for any other provider an inventory finds (F4's anyProviderWatcher).
  watchAny: (provider: string, hints: ProviderHints) => WatchProvider;
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
// The changes to match one repo against, given its usage map.
export type WatchRepo = (usages: ApiUsage[]) => Promise<ProviderChange[]>;

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

// Every provider in a usage map that has no folder watcher, with the hints of all its usages.
// The SDK's package name is a hint too, for inventories that leave `hints` empty.
export function unlistedProviders(
  usages: ApiUsage[],
  folders: string[],
): Map<string, ProviderHints> {
  const found = new Map<string, Required<ProviderHints>>();
  for (const usage of usages) {
    const provider = usage.provider.trim().toLowerCase();
    if (!provider || folders.includes(provider)) continue;
    const hints = found.get(provider) ?? { packages: [], hosts: [], docsUrls: [] };
    hints.packages.push(...(usage.hints?.packages ?? []), ...(usage.sdk ? [usage.sdk.name] : []));
    hints.hosts.push(...(usage.hints?.hosts ?? []));
    hints.docsUrls.push(...(usage.hints?.docsUrls ?? []));
    found.set(provider, hints);
  }
  const unique = (values: string[]) => [...new Set(values)];
  return new Map(
    [...found].map(([provider, hints]) => [
      provider,
      {
        packages: unique(hints.packages),
        hosts: unique(hints.hosts),
        docsUrls: unique(hints.docsUrls),
      },
    ]),
  );
}

// Reads each provider once per org run: every folder watcher right away, alongside the inventories,
// and a watcher for each other provider as soon as an inventory finds it. A repo is matched against
// the folder watchers' changes and those of its own other providers.
// shortcut: a provider found by several repos is read with the first repo's hints; merge them if the hints start to differ.
export function watchOrg(deps: LoopDeps, opts: RunOptions, state: RunState): WatchRepo {
  const log = deps.log ?? (() => {});
  const folders = Object.keys(deps.watchers);
  const reads = new Map<string, Promise<ProviderChange[]>>();
  const read = (provider: string, watcher: () => WatchProvider) => {
    let changes = reads.get(provider);
    if (!changes) {
      // One failing watcher must not hide the others' changes.
      changes = deps.queue
        .add(`watch:${provider}`, () => watcher()(opts.since))
        .catch((error: unknown) => {
          state.errors.push(`watcher ${provider} failed: ${errorText(error)}`);
          log(`ERROR watcher ${provider} failed: ${errorText(error)}`);
          return [];
        });
      reads.set(provider, changes);
    }
    return changes;
  };
  const folderReads = () => folders.map((id) => read(id, () => deps.watchers[id]));
  folderReads();

  return async (usages) => {
    const others = [...unlistedProviders(usages, folders)];
    for (const [provider] of others)
      if (!reads.has(provider)) log(`watching ${provider}: no folder in providers/`);
    const lists = await Promise.all([
      ...folderReads(),
      ...others.map(([provider, hints]) => read(provider, () => deps.watchAny(provider, hints))),
    ]);
    return lists.flat();
  };
}

export async function runOrg(org: Org, deps: LoopDeps, opts: RunOptions = {}): Promise<RunSummary> {
  const log = deps.log ?? (() => {});
  const state: RunState = { costUsd: 0, errors: [] };
  const watch = watchOrg(deps, opts, state);
  log(
    `${org.name}: ${org.repos.length} repo(s), ${Object.keys(deps.watchers).length} provider folder watcher(s)`,
  );

  // Repos run at once; the queue bounds the work in flight and the run budget bounds the spend.
  const perRepo = await Promise.all(
    org.repos.map((target) => runRepo(target, watch, deps, opts, state)),
  );
  const records = perRepo.flat();

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
  watch: WatchRepo,
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
  let changes: ProviderChange[] = [];
  let stage = 'inventory';
  let tasks: MatchedTask[];
  let notAffected: { changeId: string; reasoning: string }[];
  try {
    usages = await queue.add(`${repo}:inventory`, () => deps.inventory(dir, repo));
    changes = await watch(usages);
    log(`${repo}: ${usages.length} API usage(s), ${changes.length} provider change(s) to match`);
    stage = 'match';
    const matched = await queue.add(`${repo}:match`, () =>
      deps.match({ repo, changes, usages, repoDir: dir }),
    );
    state.costUsd += matched.costUsd;
    ({ tasks, notAffected } = matched);
  } catch (error) {
    // Without a match there is no ranking, and running the harness on every change (160+ on
    // 2026-11-01's dev run) spends the cap on doomed tasks. Report the repo as failed instead.
    const failure = `${stage} failed after retries: ${errorText(error)}`;
    state.errors.push(`${repo}: ${failure}`);
    log(`ERROR ${repo}: ${failure}`);
    // With no usage map, the folder watchers' changes are the ones this repo is known to face.
    if (stage === 'inventory') changes = await watch([]);
    return Promise.all(
      changes.map((change) => {
        const task = verdictTask(repo, change, usages);
        return finish(task, record(task.id, 'failed', `not attempted: ${failure}`));
      }),
    );
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
