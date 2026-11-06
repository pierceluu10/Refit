import type {
  ApiUsage,
  ExternalTask,
  InventoryRepo,
  MigrationTask,
  OpenPullRequest,
  ProviderChange,
  ProviderHints,
  RecordAudit,
  RunRecord,
  RunTask,
  WatchProvider,
} from '../shared/types.ts';
import { MATCH_BATCH, type MatchChanges, type MatchedTask } from './match.ts';
import type { Queue } from './queue.ts';
import {
  audit,
  buildReport,
  RULE_CHANGE_PREFIX,
  externalVerdictTask,
  scanExternal,
  watchExternalOrg,
  type AnyTask,
  type ApiScan,
  type ExternalDeps,
  type ExternalScan,
  type Note,
  type ScanItemReport,
  type WatchExternal,
} from './scan.ts';
import { asMigrationTask } from './stubs-external.ts';

// Stores a run in memory/. repoDir is the checkout the run read.
export type RecordRun = (task: AnyTask, record: RunRecord, repoDir: string) => Promise<void>;

// RunRecord has no free-text field, so `note` carries the match agent's reasoning for a not-affected
// verdict, or the error behind a failure. transcriptPath stays '' when no transcript exists.
export type LoopRecord = RunRecord & { note?: string };

export type LoopDeps = {
  inventory: InventoryRepo;
  // Head starts, never the limit: a watcher for each provider with a folder in providers/, by id.
  watchers: Record<string, WatchProvider>;
  // A watcher for any other provider an inventory finds (F4's anyProviderWatcher).
  watchAny: (provider: string, hints: ProviderHints, note?: Note) => WatchProvider;
  match: MatchChanges;
  runTask: RunTask;
  openPullRequest: OpenPullRequest;
  recordRun: RecordRun;
  queue: Queue;
  log?: (line: string) => void;
  // The external-change path: dependencies, their watchers, the external match agent and the
  // upgrade harness. Without it the loop runs API changes only.
  external?: ExternalDeps;
  // O5's audit trail: detected, matched, not-affected and pr-opened, with evidence.
  recordAudit?: RecordAudit;
  // Saves the repo's "what's behind" report after a run, for the dashboard.
  recordReport?: (report: ScanItemReport) => Promise<void>;
  // What the run budget has seen in all, for a report's cost: parts spend on their own holds.
  spentUsd?: () => number;
};

export type Org = { name: string; repos: { repo: string; dir: string }[] };
export type RunOptions = {
  dryRun?: boolean;
  since?: string;
  capUsd?: number;
  tasks?: ExternalTask[]; // attempt only these, from an earlier scan
};
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

const URGENCY = ['critical', 'high', 'medium', 'low'];
const urgencyRank = (task: MatchedTask) => {
  const rank = URGENCY.indexOf(task.urgency);
  return rank === -1 ? URGENCY.length : rank;
};

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
      ...others.map(([provider, hints]) =>
        read(provider, () =>
          deps.watchAny(provider, hints, (error) => state.errors.push(`${provider}: ${error}`)),
        ),
      ),
    ]);
    return lists.flat();
  };
}

export async function runOrg(org: Org, deps: LoopDeps, opts: RunOptions = {}): Promise<RunSummary> {
  const log = deps.log ?? (() => {});
  const state: RunState = { costUsd: 0, errors: [] };
  const watch = watchOrg(deps, opts, state);
  const watchExternal = deps.external && watchExternalOrg(deps.external, deps, opts, state);
  log(
    `${org.name}: ${org.repos.length} repo(s), ${Object.keys(deps.watchers).length} provider folder watcher(s)`,
  );

  // Repos run at once; the queue bounds the work in flight and the run budget bounds the spend.
  const perRepo = await Promise.all(
    org.repos.map((target) =>
      runRepo(target, watch, deps, opts, state, watchExternal || undefined),
    ),
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

// The API half of one repo's scan: its usage map, and every API change as a task, a not-affected
// verdict or a match that failed.
export type RepoScan = {
  usages: ApiUsage[];
  apiChanges: ProviderChange[];
  api: ApiScan;
  external: ExternalScan;
  report: ScanItemReport;
};

const emptyExternal: ExternalScan = {
  dependencies: [],
  surfaces: [],
  changes: [],
  tasks: [],
  notAffected: [],
  unmatched: [],
  costUsd: 0,
};

// An earlier scan's tasks, so nothing is read or matched again. API tasks keep their usages through
// apiAsExternalTask, so they go back down the API path.
function plannedScan(repo: string, tasks: ExternalTask[]): RepoScan {
  const isApi = (task: ExternalTask) => task.change.dependencyKind === 'api';
  return {
    usages: [],
    apiChanges: [],
    api: {
      tasks: tasks.filter(isApi) as unknown as MatchedTask[],
      notAffected: [],
      unmatched: [],
    },
    external: {
      ...emptyExternal,
      tasks: tasks
        .filter((task) => !isApi(task))
        .map((task) => ({ alsoResolves: [], ...task })) as unknown as ExternalScan['tasks'],
    },
    report: { repo, scannedAt: new Date().toISOString(), items: [], costUsd: 0, errors: [] },
  };
}

// inventory → watch → match for one repo, API and external changes alike. Nothing runs here: the
// result is the "what's behind" report and the tasks to attempt.
export async function scanTarget(
  { repo, dir }: { repo: string; dir: string },
  watch: WatchRepo,
  watchExternal: WatchExternal | undefined,
  deps: LoopDeps,
  state: RunState = { costUsd: 0, errors: [] },
): Promise<RepoScan> {
  const { queue } = deps;
  const log = deps.log ?? (() => {});
  const errorsBefore = state.errors.length;
  const api: ApiScan = { tasks: [], notAffected: [], unmatched: [] };
  let usages: ApiUsage[] = [];
  let changes: ProviderChange[] = [];
  let costUsd = 0;
  const inventoryOk = await (async () => {
    try {
      usages = await queue.add(`${repo}:inventory`, () => deps.inventory(dir, repo));
      changes = await watch(usages);
      return true;
    } catch (error) {
      const failure = `inventory failed after retries: ${errorText(error)}`;
      state.errors.push(`${repo}: ${failure}`);
      log(`ERROR ${repo}: ${failure}`);
      // With no usage map, the folder watchers' changes are the ones this repo is known to face.
      changes = await watch([]);
      api.unmatched.push(...changes.map((change) => ({ change, failure })));
      return false;
    }
  })();

  // The external half runs alongside the API match; it needs only the usage map.
  const externalScan = deps.external
    ? scanExternal({ repo, dir }, usages, changes, deps.external, watchExternal!, deps, state)
    : Promise.resolve(emptyExternal);

  if (inventoryOk) {
    // Each batch is one match call with its own retries, so a call that keeps failing fails only its
    // changes. Those are reported failed rather than attempted: without a match there is no ranking,
    // and running the harness on every change (160 on 2026-11-01's dev run) spends the cap on doomed tasks.
    const batches: ProviderChange[][] = [];
    for (let i = 0; i < changes.length; i += MATCH_BATCH)
      batches.push(changes.slice(i, i + MATCH_BATCH));
    log(
      `${repo}: ${usages.length} API usage(s), ${changes.length} provider change(s) to match in ${batches.length} call(s)`,
    );
    const matched = await Promise.allSettled(
      batches.map((batch, i) =>
        queue.add(`${repo}:match:${i + 1}`, () =>
          deps.match({ repo, changes: batch, usages, repoDir: dir }),
        ),
      ),
    );
    matched.forEach((result, i) => {
      const batch = batches[i];
      if (result.status === 'rejected') {
        const failure = `match failed after retries: ${errorText(result.reason)}`;
        state.errors.push(`${repo}: ${failure}`);
        log(`ERROR ${repo}: ${failure}`);
        api.unmatched.push(...batch.map((change) => ({ change, failure })));
        return;
      }
      const { tasks: found, notAffected } = result.value;
      state.costUsd += result.value.costUsd;
      costUsd += result.value.costUsd;
      api.tasks.push(...found);
      for (const change of batch.filter((c) => !found.some((t) => t.change.id === c.id))) {
        const verdict = notAffected.find((v) => v.changeId === change.id);
        if (verdict) {
          api.notAffected.push({ change, reasoning: verdict.reasoning });
          continue;
        }
        // A matcher that gave no verdict does not end the change: the harness judges it.
        const notes =
          'The match agent returned no verdict for this change. Check the repo for any use of it, then migrate or conclude not affected.';
        api.tasks.push({
          ...verdictTask(repo, change, usages),
          notes,
          reasoning: notes,
          urgency: 'unknown',
          callSites: [],
        });
      }
    });
    // Each call ranks its own tasks. Across calls the most urgent go first, so they reach the run
    // budget first; the sort is stable, so each call's own order holds within an urgency.
    if (batches.length > 1) api.tasks.sort((a, b) => urgencyRank(a) - urgencyRank(b));
    api.tasks.forEach((task, i) => (task.priority = i + 1));
  }

  const external = await externalScan;
  costUsd += external.costUsd;
  const report = buildReport(
    repo,
    api,
    external,
    usages,
    costUsd,
    state.errors.slice(errorsBefore),
  );
  // O5's obligationsToChanges already wrote the detected and not-affected entries for rule changes.
  for (const item of report.items.filter((i) => !i.change.id.startsWith(RULE_CHANGE_PREFIX)))
    await audit(deps, state, {
      repo,
      changeId: item.change.id,
      action: 'detected',
      evidence: [`${item.change.source.url}: ${item.change.source.quote}`],
    });
  return { usages, apiChanges: changes, api, external, report };
}

// Every change ends as an attempted task or a recorded verdict for this repo; nothing ends silently.
export async function runRepo(
  target: { repo: string; dir: string },
  watch: WatchRepo,
  deps: LoopDeps,
  opts: RunOptions = {},
  state: RunState = { costUsd: 0, errors: [] },
  watchExternal?: WatchExternal,
): Promise<LoopRecord[]> {
  const { repo, dir } = target;
  const { queue } = deps;
  const log = deps.log ?? (() => {});
  const external =
    deps.external && (watchExternal ?? watchExternalOrg(deps.external, deps, opts, state));
  const scan = opts.tasks
    ? plannedScan(repo, opts.tasks)
    : await scanTarget(target, watch, external || undefined, deps, state);
  const { usages } = scan;

  async function finish(task: AnyTask, result: LoopRecord): Promise<LoopRecord> {
    try {
      await queue.add(`${task.id}:record`, () => deps.recordRun(task, result, dir));
    } catch (error) {
      state.errors.push(`recording ${task.id} failed: ${errorText(error)}`);
      log(`ERROR recording ${task.id} failed: ${errorText(error)}`);
    }
    log(`${result.outcome.padEnd(12)} ${task.id}${result.pr ? ` ${result.pr}` : ''}`);
    return result;
  }

  const verdicts: Promise<LoopRecord>[] = [];
  for (const { change, failure } of scan.api.unmatched) {
    const task = verdictTask(repo, change, usages);
    verdicts.push(finish(task, record(task.id, 'failed', `not attempted: ${failure}`)));
  }
  for (const { change, reasoning } of scan.api.notAffected) {
    const task = verdictTask(repo, change, usages);
    verdicts.push(
      audit(deps, state, {
        repo,
        changeId: change.id,
        action: 'not-affected',
        evidence: [reasoning],
      }).then(() => finish(task, record(task.id, 'not-affected', reasoning))),
    );
  }
  for (const { change, failure } of scan.external.unmatched) {
    const task = externalVerdictTask(repo, change, scan.external.dependencies);
    verdicts.push(finish(task, record(task.id, 'failed', `not attempted: ${failure}`)));
  }
  for (const { change, reasoning } of scan.external.notAffected) {
    const task = externalVerdictTask(repo, change, scan.external.dependencies);
    verdicts.push(
      audit(deps, state, {
        repo,
        changeId: change.id,
        action: 'not-affected',
        evidence: [reasoning],
      }).then(() => finish(task, record(task.id, 'not-affected', reasoning))),
    );
  }

  const capReached = () => opts.capUsd !== undefined && state.costUsd >= opts.capUsd;

  // One attempt, for an API task (runTask) or an external one (runExternalTask), then its PR.
  async function attempt(
    task: AnyTask,
    prTask: MigrationTask,
    run: () => Promise<RunRecord>,
    alsoResolves: string[] = [],
  ): Promise<LoopRecord> {
    await audit(deps, state, {
      repo,
      changeId: task.change.id,
      action: 'matched',
      evidence: [task.notes ?? '', ...alsoResolves.map((id) => `also resolves ${id}`)].filter(
        Boolean,
      ),
    });
    let result: LoopRecord;
    try {
      result = await queue.add(task.id, async () =>
        capReached()
          ? record(
              task.id,
              'failed',
              `run budget reached before this task: $${state.costUsd.toFixed(4)} spent of the $${opts.capUsd} cap`,
            )
          : // The harness runs repo code only in its sandbox, never on this host.
            run(),
      );
    } catch (error) {
      result = record(task.id, 'failed', `runTask failed after retries: ${errorText(error)}`);
    }
    state.costUsd += result.costUsd;

    const shippable = result.outcome === 'verified' || result.outcome === 'needs-review';
    if (shippable && result.diff && !opts.dryRun) {
      const ready = result;
      try {
        const pr = await queue.add(`${task.id}:pr`, () => deps.openPullRequest(prTask, ready, dir));
        result = { ...ready, pr };
        for (const changeId of [task.change.id, ...alsoResolves])
          await audit(deps, state, {
            repo,
            changeId,
            action: 'pr-opened',
            pr,
            evidence: ready.checks.map((c) => `${c.name}: before ${c.before}; after ${c.after}`),
          });
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

  const apiAttempts = scan.api.tasks.map((task) =>
    attempt(task, task, () => deps.runTask(task, dir)),
  );
  const externalAttempts = scan.external.tasks.map((task) =>
    attempt(
      task,
      // The PR opener takes the API task shape; the external change and its declarations ride along.
      { ...asMigrationTask(task), dependencies: task.dependencies } as MigrationTask,
      () => deps.external!.runExternalTask(task, dir),
      task.alsoResolves.map((a) => a.changeId),
    ),
  );
  const records = await Promise.all([...verdicts, ...apiAttempts, ...externalAttempts]);

  if (deps.recordReport && !opts.tasks) {
    // The report as it stands after the run: rows whose task opened a PR are pr-open.
    const prs = new Map(records.flatMap((r) => (r.pr ? [[r.taskId, r.pr] as const] : [])));
    const items = scan.report.items.map((item) =>
      item.taskId && prs.has(item.taskId)
        ? { ...item, status: 'pr-open' as const, pr: prs.get(item.taskId) }
        : item,
    );
    try {
      await deps.recordReport({ ...scan.report, items });
    } catch (error) {
      state.errors.push(`saving the ${repo} report failed: ${errorText(error)}`);
    }
  }
  return records;
}
