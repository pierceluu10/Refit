// The external-change half of a repo's scan: every dependency the repo has (runtimes, frameworks,
// libraries, models, images, CI, platforms, regulated surfaces), what has changed for each, and the
// match agent's verdicts. Its tasks and the API path's tasks make one "what's behind" report.
import type {
  ApiUsage,
  AuditEntry,
  BehindItem,
  DependencyUsage,
  ExternalChange,
  ExternalTask,
  MigrationTask,
  Obligation,
  ProviderChange,
  RunExternalTask,
  ScanReport,
} from '../shared/types.ts';
import { SURFACE_KINDS } from '../inventory/surfaces/collector.ts';
import {
  baseName,
  NO_VERDICT,
  type ExternalMatchedTask,
  type MatchExternal,
} from './external-match.ts';
import type { LoopDeps, LoopRecord, RunOptions, RunState } from './loop.ts';
import type { MatchedTask } from './match.ts';

// What a part could not read, for ScanReport.errors.
export type Note = (error: string) => void;

export type ExternalDeps = {
  // P2, with P5's surfaces in the same list. Platform, infrastructure and security-standard entries
  // are read by F1's watcher, which hands them to F3.
  inventoryDependencies: (repoDir: string, repo: string, note?: Note) => Promise<DependencyUsage[]>;
  watchDependency: (
    dep: DependencyUsage,
    since: string | undefined,
    note?: Note,
  ) => Promise<ExternalChange[]>; // F1
  watchRegulations?: (since: string | undefined, note?: Note) => Promise<Obligation[]>; // O5
  obligationsToChanges?: (
    repo: string,
    surfaces: DependencyUsage[],
    obligations: Obligation[],
    repoDir: string,
    note?: Note,
  ) => Promise<ExternalChange[]>; // O5
  match: MatchExternal;
  runExternalTask: RunExternalTask; // O2
};

// One report row. BehindItem plus what the dashboard and CLI need to explain it.
export type ScanItem = BehindItem & {
  // Why the change is open, merged into a task, or not affected: the match agent's words.
  reason?: string;
};

export type ScanItemReport = Omit<ScanReport, 'items'> & { items: ScanItem[] };

// The changes one repo faces, given its dependency map and surfaces.
export type WatchExternal = (
  repo: string,
  dir: string,
  dependencies: DependencyUsage[],
  surfaces: DependencyUsage[],
) => Promise<ExternalChange[]>;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// O5's id for a change that comes from an obligation: rule:<obligation id>.
export const RULE_CHANGE_PREFIX = 'rule:';

const depKey = (dep: DependencyUsage) =>
  `${dep.kind}|${dep.ecosystem ?? ''}|${dep.name}|${dep.version ?? ''}`;

// Reads each dependency once per org run: two repos on node 18 share one read. Rules are read once
// per run and matched to each repo's surfaces by O5's agent.
export function watchExternalOrg(
  ext: ExternalDeps,
  deps: Pick<LoopDeps, 'queue' | 'log'>,
  opts: RunOptions,
  state: RunState,
): WatchExternal {
  const log = deps.log ?? (() => {});
  const reads = new Map<string, Promise<ExternalChange[]>>();
  const read = (key: string, label: string, call: () => Promise<ExternalChange[]>) => {
    let changes = reads.get(key);
    if (!changes) {
      // One failing watcher must not hide the others' changes.
      changes = deps.queue.add(label, call).catch((error: unknown) => {
        state.errors.push(`${label} failed: ${errorText(error)}`);
        log(`ERROR ${label} failed: ${errorText(error)}`);
        return [];
      });
      reads.set(key, changes);
    }
    return changes;
  };
  let obligations: Promise<Obligation[]> | undefined;
  const rules = () =>
    (obligations ??= ext.watchRegulations
      ? deps.queue
          .add('watch:regulations', () =>
            ext.watchRegulations!(opts.since, (error) =>
              state.errors.push(`regulations: ${error}`),
            ),
          )
          .catch((error) => {
            state.errors.push(`the regulations watcher failed: ${errorText(error)}`);
            return [];
          })
      : Promise.resolve([]));

  return async (repo, dir, dependencies, surfaces) => {
    const lists = await Promise.all([
      // Rules, then surfaces: they are few, and a small cap should not lose them to the libraries.
      (async () => {
        const found = await rules();
        if (!found.length || !ext.obligationsToChanges) return [];
        return deps.queue
          .add(`${repo}:rules`, () =>
            ext.obligationsToChanges!(repo, surfaces, found, dir, (error) =>
              state.errors.push(`${repo}: rules: ${error}`),
            ),
          )
          .catch((error: unknown) => {
            state.errors.push(`${repo}: matching rules failed: ${errorText(error)}`);
            return [];
          });
      })(),
      ...[...surfaces, ...dependencies].map((dep) =>
        read(`dep:${depKey(dep)}`, `watch:${dep.name}`, () =>
          ext.watchDependency(dep, opts.since, (error) =>
            state.errors.push(`watch:${dep.name}: ${error}`),
          ),
        ),
      ),
    ]);
    // The same change can come from two watchers (node the runtime, node the base image): keep one.
    const byId = new Map<string, ExternalChange>();
    for (const change of lists.flat()) if (!byId.has(change.id)) byId.set(change.id, change);
    return [...byId.values()];
  };
}

export type ExternalScan = {
  dependencies: DependencyUsage[];
  surfaces: DependencyUsage[];
  changes: ExternalChange[];
  tasks: ExternalMatchedTask[];
  notAffected: { change: ExternalChange; reasoning: string }[];
  // Changes the match call failed on: open, unranked, and not attempted.
  unmatched: { change: ExternalChange; failure: string }[];
  costUsd: number;
};

// inventory → watch → match for the external half of one repo. Every change ends as a task, a
// not-affected verdict with its reason, or (when the match call keeps failing) an honest error.
export async function scanExternal(
  { repo, dir }: { repo: string; dir: string },
  usages: ApiUsage[],
  apiChanges: ProviderChange[],
  ext: ExternalDeps,
  watch: WatchExternal,
  deps: Pick<LoopDeps, 'queue' | 'log'>,
  state: RunState,
): Promise<ExternalScan> {
  const log = deps.log ?? (() => {});
  const empty: ExternalScan = {
    dependencies: [],
    surfaces: [],
    changes: [],
    tasks: [],
    notAffected: [],
    unmatched: [],
    costUsd: 0,
  };
  const all = await deps.queue
    .add(`${repo}:dependencies`, () =>
      ext.inventoryDependencies(dir, repo, (error) => state.errors.push(`${repo}: ${error}`)),
    )
    .catch((error: unknown) => {
      state.errors.push(`${repo}: dependency inventory failed: ${errorText(error)}`);
      return [] as DependencyUsage[];
    });
  const isSurface = (dep: DependencyUsage) =>
    (SURFACE_KINDS as readonly string[]).includes(dep.kind);
  const dependencies = all.filter((dep) => !isSurface(dep));
  const surfaces = all.filter(isSurface);
  // An API or SDK the usage map names is read on the API path, so nothing pays for the same changelog twice.
  const unread = dependencies.filter(
    (dep) =>
      !usages.some(
        (usage) =>
          usage.provider.trim().toLowerCase() === baseName(dep.name) ||
          usage.sdk?.name === dep.name,
      ),
  );
  const apiIds = new Set(apiChanges.map((c) => c.id));
  // A change the API path already has is matched there, once.
  const changes = (await watch(repo, dir, unread, surfaces)).filter((c) => !apiIds.has(c.id));
  if (changes.length === 0) return { ...empty, dependencies, surfaces };
  log(`${repo}: ${all.length} dependency(ies), ${changes.length} external change(s) to match`);
  try {
    const result = await deps.queue.add(`${repo}:match-external`, () =>
      ext.match({ repo, changes, dependencies: all, usages, apiChanges, repoDir: dir }),
    );
    state.costUsd += result.costUsd;
    const byId = new Map(changes.map((c) => [c.id, c]));
    const covered = new Set(
      result.tasks.flatMap((t) => [t.change.id, ...t.alsoResolves.map((a) => a.changeId)]),
    );
    const notAffected = result.notAffected.flatMap((n) =>
      byId.has(n.changeId) && !covered.has(n.changeId)
        ? [{ change: byId.get(n.changeId)!, reasoning: n.reasoning }]
        : [],
    );
    const judged = new Set([...covered, ...notAffected.map((n) => n.change.id)]);
    // A matcher that gave no verdict does not end the change: the harness judges it.
    const tasks = [...result.tasks];
    for (const change of changes.filter((c) => !judged.has(c.id)))
      tasks.push({
        id: `${repo}:${change.id}`,
        repo,
        change,
        dependencies: all.filter((d) => baseName(d.name) === baseName(change.dependency)),
        usages: [],
        deadline: change.effectiveDate,
        priority: tasks.length + 1,
        notes: NO_VERDICT,
        reasoning: NO_VERDICT,
        impact: 'unknown',
        callSites: [],
        alsoResolves: [],
      });
    return {
      dependencies,
      surfaces,
      changes,
      tasks,
      notAffected,
      unmatched: [],
      costUsd: result.costUsd,
    };
  } catch (error) {
    const failure = `external match failed after retries: ${errorText(error)}`;
    state.errors.push(`${repo}: ${failure}`);
    log(`ERROR ${repo}: ${failure}`);
    return {
      ...empty,
      dependencies,
      surfaces,
      changes,
      unmatched: changes.map((change) => ({ change, failure })),
    };
  }
}

// An API change as an external change, so one report lists both.
export const asExternalChange = (change: ProviderChange): ExternalChange => ({
  ...change,
  dependencyKind: 'api',
  dependency: change.provider,
});

// An API usage as a dependency row for the report.
export const asDependency = (usage: ApiUsage): DependencyUsage => ({
  repo: usage.repo,
  kind: usage.via === 'sdk' ? 'sdk' : 'api',
  name: usage.provider,
  ecosystem: usage.sdk ? 'sdk' : usage.via,
  version: usage.pinnedVersion?.value ?? usage.sdk?.version,
  declaredIn: [
    ...(usage.pinnedVersion
      ? [
          {
            file: usage.pinnedVersion.file,
            line: usage.pinnedVersion.line,
            text: usage.pinnedVersion.value,
          },
        ]
      : []),
    ...(usage.sdk?.lockfile
      ? [{ file: usage.sdk.lockfile, text: `${usage.sdk.name}@${usage.sdk.version}` }]
      : []),
  ],
  callSites: usage.callSites,
});

// An API task as an ExternalTask, so scanRepo returns every task in one shape.
export const apiAsExternalTask = (task: MigrationTask): ExternalTask => ({
  ...task,
  change: asExternalChange(task.change),
  dependencies: task.usages.map(asDependency),
});

// The dependency a report row is about: the one named by the change, else the first the task moves.
function primary(change: ExternalChange, deps: DependencyUsage[]): DependencyUsage {
  return (
    deps.find((d) => baseName(d.name) === baseName(change.dependency)) ??
    deps[0] ?? { repo: '', kind: change.dependencyKind, name: change.dependency, declaredIn: [] }
  );
}

// What the API half of a scan found, as the report needs it.
export type ApiScan = {
  tasks: MatchedTask[];
  notAffected: { change: ProviderChange; reasoning: string }[];
  unmatched: { change: ProviderChange; failure: string }[];
};

// One row per change: open tasks first by rank, then merged changes, then the unmatched ones, then
// the not-affected verdicts with their reasons.
export function buildReport(
  repo: string,
  api: ApiScan,
  ext: ExternalScan,
  usages: ApiUsage[],
  costUsd: number,
  errors: string[],
  scannedAt = new Date().toISOString(),
): ScanItemReport {
  const fill = (dep: DependencyUsage): DependencyUsage => ({ ...dep, repo });
  const items: ScanItem[] = [];
  const open = [
    ...ext.tasks.map((t) => ({
      task: t as ExternalTask & {
        reasoning: string;
        alsoResolves: ExternalMatchedTask['alsoResolves'];
      },
      external: true,
    })),
    ...api.tasks.map((t) => ({
      task: { ...apiAsExternalTask(t), reasoning: t.reasoning, alsoResolves: [] },
      external: false,
    })),
  ].sort((a, b) => {
    const time = (t: ExternalTask) =>
      t.deadline ? Date.parse(t.deadline) : Number.POSITIVE_INFINITY;
    return (
      time(a.task) - time(b.task) ||
      (a.task.change.severity === 'security' ? -1 : 0) -
        (b.task.change.severity === 'security' ? -1 : 0)
    );
  });
  for (const { task } of open) {
    items.push({
      repo,
      dependency: fill(primary(task.change, task.dependencies)),
      change: task.change,
      deadline: task.deadline,
      status: 'open',
      taskId: task.id,
      reason: task.reasoning,
    });
    for (const also of task.alsoResolves) {
      const change = ext.changes.find((c) => c.id === also.changeId);
      if (!change) continue;
      items.push({
        repo,
        dependency: fill(primary(change, task.dependencies)),
        change,
        deadline: change.effectiveDate ?? task.deadline,
        status: 'open',
        taskId: task.id,
        reason: `resolved by the same change as ${task.change.id}`,
      });
    }
  }
  const apiDeps = usages.map(asDependency);
  for (const { change, failure } of [
    ...ext.unmatched,
    ...api.unmatched.map((u) => ({ change: asExternalChange(u.change), failure: u.failure })),
  ])
    items.push({
      repo,
      dependency: fill(primary(change, [...ext.dependencies, ...apiDeps])),
      change,
      deadline: change.effectiveDate,
      status: 'open',
      reason: `not attempted: ${failure}`,
    });
  for (const { change, reasoning } of [
    ...ext.notAffected,
    ...api.notAffected.map((n) => ({ change: asExternalChange(n.change), reasoning: n.reasoning })),
  ])
    items.push({
      repo,
      dependency: fill(primary(change, [...ext.dependencies, ...ext.surfaces, ...apiDeps])),
      change,
      deadline: change.effectiveDate,
      status: 'not-affected',
      reason: reasoning,
    });
  return { repo, scannedAt, items, costUsd, errors };
}

// Writes one audit step; a failing audit store never stops the run, it shows up in the errors.
export async function audit(
  deps: Pick<LoopDeps, 'recordAudit' | 'log'>,
  state: RunState,
  entry: Omit<AuditEntry, 'at' | 'actor'>,
): Promise<void> {
  if (!deps.recordAudit) return;
  try {
    await deps.recordAudit({
      at: new Date().toISOString(),
      actor: 'refit',
      // The Platforms and rules view finds a rule's entries through its obligation.
      ...(entry.changeId.startsWith(RULE_CHANGE_PREFIX) && {
        obligationId: entry.changeId.slice(RULE_CHANGE_PREFIX.length),
      }),
      ...entry,
    });
  } catch (error) {
    state.errors.push(`audit ${entry.action} ${entry.changeId} failed: ${errorText(error)}`);
  }
}

// A not-affected or not-attempted verdict for an external change, in the record's shape.
export const externalVerdictTask = (
  repo: string,
  change: ExternalChange,
  dependencies: DependencyUsage[],
): ExternalTask => ({
  id: `${repo}:${change.id}`,
  repo,
  change,
  dependencies,
  usages: [],
  priority: 0,
});

export type AnyTask = MigrationTask | ExternalTask;
export type { LoopRecord };
