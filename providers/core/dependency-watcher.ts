// watchDependency: what has changed, or is about to, for one thing a repository depends on. The
// agent reads the feeds and pages for its kind and writes ExternalChange[] with exact source quotes;
// code fetches, caches, checks quotes and output shape, and records what could not be read.

import { existsSync } from 'node:fs';
import type {
  DependencyUsage,
  ExternalChange,
  ProviderChange,
  ProviderHints,
  WatchPlatforms,
} from '../../shared/types.ts';
import {
  NOTHING_READ,
  runAnyWatch,
  type AnyWatchDeps,
  type AnyWatchReport,
} from './any-watcher.ts';
import {
  cachingFetcher,
  cachingJsonFetcher,
  httpFetcher,
  httpJsonFetcher,
  type FetchedPage,
  type JsonFetcher,
} from './fetch.ts';
import { GROUPS_BY_KIND, osvSource, readOsv, sourcesFor } from './dependency-sources.ts';
import { budgetFromEnv, type BudgetLedger } from './model.ts';
import { registriesFor, registryClient } from './packages.ts';
import type { PageReader } from './page-tools.ts';
import {
  DEPENDENCY_KINDS,
  MIGRATION_KINDS,
  anyWatchSystemPrompt,
  dependencyTask,
  dependencyWatchSystemPrompt,
  EXTERNAL_FIELDS,
  SOURCE_GUIDES,
} from './prompt.ts';
import type { WatchReport } from './types.ts';
import {
  CHANGE_SCHEMA,
  NO_SUBMISSION,
  WatchFailedError,
  normaliseChanges,
  slug,
  strings,
  type ChangeShape,
  type Normalised,
} from './watcher.ts';

const ALL_KINDS = [...MIGRATION_KINDS, ...DEPENDENCY_KINDS];
const SEVERITIES = ['deadline', 'security', 'breaking', 'notice'] as const;

const EXTERNAL_CHANGE_SCHEMA = {
  type: 'object',
  properties: {
    ...CHANGE_SCHEMA.properties,
    kind: { type: 'string', enum: ALL_KINDS },
    fromVersions: { type: 'array', items: { type: 'string' } },
    toVersion: { type: 'string' },
    severity: { type: 'string', enum: SEVERITIES },
  },
  required: [...CHANGE_SCHEMA.required, 'severity'],
};

/** A submission as ExternalChange[]. Like normaliseChanges, it hands problems back and drops nothing. */
export function normaliseExternal(
  dep: DependencyUsage,
  provider: string,
  raw: unknown,
  reader?: PageReader,
): Normalised<ExternalChange> {
  const base = normaliseChanges(provider, raw, reader, ALL_KINDS);
  const list: unknown[] = Array.isArray(raw) ? raw : [];
  const issues = [...base.issues];
  const changes = base.changes.map((change: ProviderChange, index): ExternalChange => {
    const entry = (list[index] ?? {}) as Record<string, unknown>;
    const external: ExternalChange = {
      ...change,
      dependencyKind: dep.kind,
      dependency: dep.name,
    };
    const fromVersions = strings(entry.fromVersions) ?? change.affects.versions;
    if (fromVersions) external.fromVersions = fromVersions;
    else issues.push({ changeId: change.id, message: 'missing fromVersions' });
    if (typeof entry.toVersion === 'string' && entry.toVersion.trim())
      external.toVersion = entry.toVersion.trim();
    if (SEVERITIES.includes(entry.severity as (typeof SEVERITIES)[number]))
      external.severity = entry.severity as ExternalChange['severity'];
    else
      issues.push({
        changeId: change.id,
        message: `severity "${String(entry.severity)}" is not one of ${SEVERITIES.join(', ')}`,
      });
    return external;
  });
  return { changes, issues, unverifiedQuotes: base.unverifiedQuotes };
}

export type DependencyWatchReport = Omit<AnyWatchReport<ExternalChange>, 'hints'> & {
  dependency: DependencyUsage;
  hints?: ProviderHints;
  /** The run never got to an answer, so an empty list proves nothing. */
  failed: boolean;
};

export type DependencyWatchDeps = Omit<AnyWatchDeps<ExternalChange>, 'extend' | 'onReport'> & {
  /** Hints the inventory has for this dependency, such as an API's docs URLs. */
  hints?: ProviderHints;
  /** F3's watcher; found in providers/platforms/index.ts when not given. */
  platforms?: WatchPlatforms;
  /** The JSON reader for advisory queries and the registries. */
  json?: JsonFetcher;
  /** OSV's answer, for replaying a saved run. */
  advisories?: (dep: DependencyUsage) => Promise<FetchedPage[]>;
  onReport?: (report: DependencyWatchReport) => void;
};

/** The id prefix and folder lookup: a model is watched under its provider's name. */
function providerFor(dep: DependencyUsage): string {
  return dep.kind === 'ai-model' && dep.ecosystem ? slug(dep.ecosystem) : slug(dep.name);
}

function hintsFor(dep: DependencyUsage, groups: string[], given: ProviderHints): ProviderHints {
  if (!groups.includes('packages')) return given;
  const ecosystem = dep.ecosystem?.toLowerCase();
  const pinned =
    ecosystem === 'npm' || ecosystem === 'pypi' ? `${ecosystem}:${dep.name}` : dep.name;
  return registriesFor(pinned).length
    ? { ...given, packages: [pinned, ...(given.packages ?? [])] }
    : given;
}

/** A report for a dependency no agent of ours read. */
function emptyReport(
  dep: DependencyUsage,
  errors: string[],
  extra: Partial<DependencyWatchReport> = {},
): DependencyWatchReport {
  return {
    provider: providerFor(dep),
    dependency: dep,
    changes: [],
    issues: [],
    unverifiedQuotes: [],
    sourcesRead: [],
    model: '',
    costUsd: 0,
    turns: 0,
    summary: errors.join('; '),
    log: [],
    name: dep.name,
    packages: [],
    startingPages: [],
    errors,
    failed: false,
    ...extra,
  };
}

const PLATFORMS_MODULE = new URL('../platforms/index.ts', import.meta.url);

// shortcut: looked up at run time because F3's module lands on another branch tonight; make it a
// static import once it is merged.
async function loadPlatforms(): Promise<WatchPlatforms | undefined> {
  if (!existsSync(PLATFORMS_MODULE)) return undefined;
  const loaded = (await import(/* @vite-ignore */ PLATFORMS_MODULE.href)) as {
    watchPlatforms?: WatchPlatforms;
  };
  return loaded.watchPlatforms;
}

async function watchPlatformDependency(
  dep: DependencyUsage,
  since: string | undefined,
  deps: DependencyWatchDeps,
  budget: BudgetLedger,
): Promise<DependencyWatchReport> {
  const watch = deps.platforms ?? (await loadPlatforms());
  if (!watch) {
    return emptyReport(dep, [
      `platforms not read for ${dep.name}: providers/platforms/index.ts does not export watchPlatforms yet`,
    ]);
  }
  const spentBefore = budget.spentUsd;
  try {
    // The third argument is beyond the contract, so a watcher that accepts it shares the run's cap.
    const changes = await (watch as (...args: unknown[]) => Promise<ExternalChange[]>)(dep, since, {
      budget,
    });
    return emptyReport(dep, [], { changes, costUsd: budget.spentUsd - spentBefore });
  } catch (error) {
    const message = `platforms not read for ${dep.name}: ${error instanceof Error ? error.message : String(error)}`;
    return emptyReport(dep, [message], {
      issues: [{ message }],
      costUsd: budget.spentUsd - spentBefore,
      failed: true,
    });
  }
}

// One ledger for every call in this process, so the cap is per run, not per dependency. A long-lived
// server passes deps.budget for each scan instead.
let processBudget: BudgetLedger | undefined;

/**
 * One read of one dependency, with everything it found and everything it could
 * not read. watchDependency is this without the report.
 */
export async function runDependencyWatch(
  dep: DependencyUsage,
  since?: string,
  deps: DependencyWatchDeps = {},
): Promise<DependencyWatchReport> {
  const budget = deps.budget ?? (processBudget ??= budgetFromEnv());
  if (dep.kind === 'platform' || dep.kind === 'infrastructure' || dep.kind === 'security-standard')
    return watchPlatformDependency(dep, since, deps, budget);
  if (dep.kind === 'regulated-surface')
    return emptyReport(dep, [
      `rules for ${dep.name} are not read here: compliance's watchRegulations and obligationsToChanges cover regulated surfaces`,
    ]);

  const json = deps.json ?? cachingJsonFetcher(httpJsonFetcher());
  const groups = GROUPS_BY_KIND[dep.kind] ?? [];
  const pages = groups.includes('advisories')
    ? await (deps.advisories ? deps.advisories(dep) : readOsv(dep, json))
    : [];
  const provider = providerFor(dep);
  const shape: ChangeShape<ExternalChange> = {
    schema: EXTERNAL_CHANGE_SCHEMA,
    normalise: (raw, reader) => normaliseExternal(dep, provider, raw, reader),
  };
  const apiPath = dep.kind === 'api' || dep.kind === 'sdk';
  const report = await runAnyWatch<ExternalChange>(
    provider,
    hintsFor(dep, groups, deps.hints ?? {}),
    since,
    {
      ...deps,
      budget,
      fetcher:
        deps.fetcher ??
        cachingFetcher(httpFetcher({ githubToken: process.env.GITHUB_TOKEN || undefined })),
      registry: deps.registry ?? registryClient({ json }),
      // A model's provider folder lists its SDKs, which say nothing about the model.
      maxPackages: dep.kind === 'ai-model' ? 0 : deps.maxPackages,
      extend: {
        // The API path keeps its tuned brief, with the same questions any dependency answers.
        system: apiPath
          ? (input) =>
              `${anyWatchSystemPrompt(input)}\n\n${groups.includes('advisories') ? `${SOURCE_GUIDES.advisories}\n\n` : ''}${EXTERNAL_FIELDS}`
          : (input) =>
              dependencyWatchSystemPrompt({
                dependency: dep,
                groups,
                prompt: input.prompt,
                webSearch: input.webSearch,
              }),
        task: dependencyTask(dep),
        sources: [...sourcesFor(dep, groups), ...pages.map((page) => osvSource(page, dep))],
        pages,
        shape,
      },
      onReport: undefined,
    },
  );
  return {
    ...report,
    dependency: dep,
    failed: report.issues.some(
      (issue) => issue.message === NO_SUBMISSION || issue.message === NOTHING_READ,
    ),
  };
}

/**
 * The entry point other folders use: F1's WatchDependency. Pass deps.onReport to
 * keep what could not be read (for ScanReport.errors), the cost and the log, and
 * deps.budget to draw on the run's ledger. A run that never got to an answer
 * throws WatchFailedError, so "no changes" is never a silent failure.
 */
export async function watchDependency(
  dep: DependencyUsage,
  since?: string,
  deps: DependencyWatchDeps = {},
): Promise<ExternalChange[]> {
  const report = await runDependencyWatch(dep, since, deps);
  if (deps.onReport) deps.onReport(report);
  else for (const error of report.errors) console.warn(`watchDependency: ${error}`);
  if (report.failed) throw new WatchFailedError(report as unknown as WatchReport);
  return report.changes;
}
