// watchPlatforms: what has changed, or is about to, for one platform, piece of infrastructure or
// security standard a repository depends on. The agent reads the official pages and writes
// ExternalChange[] with exact source quotes; code fetches, caches, checks quotes and output shape,
// and records what could not be read. It never drops a change.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DependencyUsage, ExternalChange, ProviderChange } from '../../shared/types.ts';
import { runToolLoop, type LoopResult, type LoopTool } from '../core/agent.ts';
import { DEFAULT_WEB_SEARCH, NOTHING_READ, type WebSearchOption } from '../core/any-watcher.ts';
import { httpFetcher, type FetchedPage, type Fetcher } from '../core/fetch.ts';
import {
  anthropicModel,
  budgetFromEnv,
  metered,
  type BudgetLedger,
  type ModelClient,
  type ServerTool,
} from '../core/model.ts';
import { PageReader, pageTools } from '../core/page-tools.ts';
import type { WatchIssue, WatchReport } from '../core/types.ts';
import { NO_SUBMISSION, WatchFailedError, normaliseChanges, slug } from '../core/watcher.ts';
import { PLATFORM_KINDS, platformWatchSystemPrompt, platformWatchUserPrompt } from './prompt.ts';
import { PLATFORM_SOURCES } from './sources.ts';

const SEVERITIES = ['deadline', 'security', 'breaking', 'notice'] as const;
const DEFAULT_MAX_TURNS = 20;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const CHANGE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: PLATFORM_KINDS },
    title: { type: 'string' },
    effectiveDate: { type: 'string', description: 'YYYY-MM-DD or YYYY-MM' },
    source: {
      type: 'object',
      properties: { url: { type: 'string' }, quote: { type: 'string' } },
      required: ['url', 'quote'],
    },
    affects: {
      type: 'object',
      properties: {
        operations: { type: 'array', items: { type: 'string' } },
        fields: { type: 'array', items: { type: 'string' } },
        versions: { type: 'array', items: { type: 'string' } },
        sdk: { type: 'string' },
      },
    },
    fromVersions: { type: 'array', items: { type: 'string' } },
    toVersion: { type: 'string' },
    severity: { type: 'string', enum: SEVERITIES },
  },
  required: ['id', 'kind', 'title', 'source', 'affects', 'severity'],
};

type Normalised = { changes: ExternalChange[]; issues: WatchIssue[]; unverifiedQuotes: string[] };

/** A submission as ExternalChange[]. Like normaliseChanges, it hands problems back and drops nothing. */
export function normalisePlatformChanges(
  dep: DependencyUsage,
  provider: string,
  raw: unknown,
  reader?: PageReader,
): Normalised {
  const list: unknown[] = Array.isArray(raw) ? raw : [];
  // normaliseChanges knows the API kinds, so it checks everything else and the kind is checked here.
  const base = normaliseChanges(
    provider,
    Array.isArray(raw)
      ? list.map((item) => ({ ...(item as Record<string, unknown>), kind: 'other' }))
      : raw,
    reader,
  );
  const issues = [...base.issues];
  const changes = base.changes.map((change: ProviderChange, index): ExternalChange => {
    const entry = (list[index] ?? {}) as Record<string, unknown>;
    const known = PLATFORM_KINDS.find((kind) => kind === entry.kind);
    if (!known)
      issues.push({
        changeId: change.id,
        message: `kind "${String(entry.kind)}" is not one of ${PLATFORM_KINDS.join(', ')}; stored as "other"`,
      });
    const external: ExternalChange = {
      ...change,
      kind: known ?? 'other',
      dependencyKind: dep.kind,
      dependency: dep.name,
    };
    const given = Array.isArray(entry.fromVersions)
      ? entry.fromVersions.filter(
          (version): version is string => typeof version === 'string' && version.trim() !== '',
        )
      : [];
    const fromVersions = given.length ? given : change.affects.versions;
    if (fromVersions) external.fromVersions = fromVersions;
    else issues.push({ changeId: change.id, message: 'missing fromVersions' });
    if (typeof entry.toVersion === 'string' && entry.toVersion.trim())
      external.toVersion = entry.toVersion.trim();
    const severity = SEVERITIES.find((value) => value === entry.severity);
    if (severity) external.severity = severity;
    else
      issues.push({
        changeId: change.id,
        message: `severity "${String(entry.severity)}" is not one of ${SEVERITIES.join(', ')}`,
      });
    return external;
  });
  return { changes, issues, unverifiedQuotes: base.unverifiedQuotes };
}

/**
 * Keeps each page that loaded for a day, so a scan of many repos reads a page once. Failures are
 * never kept, and a cache that cannot be read or written is only a slower fetch.
 */
// shortcut: same directory and keys as F1's cachingFetcher, which isn't on mvp yet; use it once F1 is merged.
export function dayCachingFetcher(
  inner: Fetcher,
  options: { dir?: string; ttlMs?: number; now?: () => number } = {},
): Fetcher {
  const dir =
    options.dir ?? process.env.REFIT_WATCH_CACHE_DIR ?? join(homedir(), '.cache', 'refit', 'watch');
  const ttl = options.ttlMs ?? ONE_DAY_MS;
  const now = options.now ?? Date.now;
  return {
    async fetch(url, format) {
      const key = `page ${format ?? ''} ${url}`;
      const file = join(dir, `${createHash('sha256').update(key).digest('hex')}.json`);
      try {
        if (now() - statSync(file).mtimeMs < ttl)
          return JSON.parse(readFileSync(file, 'utf8')) as FetchedPage;
      } catch {
        // Not cached, or unreadable: fetch it.
      }
      const page = await inner.fetch(url, format);
      if (page.ok) {
        try {
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          // Scans run in parallel, so a reader must never see a half-written file.
          const temp = `${file}.${process.pid}.tmp`;
          writeFileSync(temp, JSON.stringify(page));
          renameSync(temp, file);
        } catch {
          // Next read fetches again.
        }
      }
      return page;
    },
  };
}

export type PlatformWatchReport = Omit<WatchReport, 'changes'> & {
  dependency: DependencyUsage;
  changes: ExternalChange[];
  /** What could not be read, and a run that stopped early. For ScanReport.errors. */
  errors: string[];
  /** The run never got to an answer, so an empty list proves nothing. */
  failed: boolean;
};

export type PlatformWatchOptions = {
  /** The run's ledger, so its dollar cap covers platform reads. */
  budget?: BudgetLedger;
  model?: ModelClient;
  fetcher?: Fetcher;
  /** Override "today" for reproducible prompts in tests. */
  today?: string;
  maxTurns?: number;
  /** max_tokens for each model call. */
  maxTokens?: number;
  /** Anthropic's server-side web search. On unless false. */
  webSearch?: false | WebSearchOption;
  onReport?: (report: PlatformWatchReport) => void;
  /** Called with the pages the run read, so a caller can save them as fixtures. */
  onPages?: (reader: PageReader) => void;
};

// One ledger for every call in this process, so the cap is per run, not per dependency. A
// long-lived server passes options.budget for each scan instead.
let processBudget: BudgetLedger | undefined;

/** A first-call error that says the request's server tools are not allowed or not understood. */
const SERVER_TOOL_REFUSED = /web[_ ]search|server[_ ]tool|tool type|tools\.\d+/i;

/**
 * One read of one dependency, with everything it found and everything it could
 * not read. watchPlatforms is this without the report.
 */
export async function runPlatformWatch(
  dep: DependencyUsage,
  since?: string,
  options: PlatformWatchOptions = {},
): Promise<PlatformWatchReport> {
  const budget = options.budget ?? (processBudget ??= budgetFromEnv());
  const base = options.model ?? anthropicModel();
  const provider = slug(dep.name);
  const model = metered(base, budget, `watch-platform:${provider}`);
  const spentBefore = budget.spentUsd;
  const reader = new PageReader(
    options.fetcher ??
      dayCachingFetcher(httpFetcher({ githubToken: process.env.GITHUB_TOKEN || undefined })),
    PLATFORM_SOURCES,
  );

  let latest: Normalised | undefined;
  let notes = '';
  let clean = false;
  const submit: LoopTool = {
    name: 'submit_changes',
    description:
      'Submit every change you found. Each call replaces the previous submission. Returns problems to fix, or "accepted".',
    input_schema: {
      type: 'object',
      properties: {
        changes: { type: 'array', items: CHANGE_SCHEMA },
        notes: {
          type: 'string',
          description:
            'Optional: what you could not find or read, what you left out on purpose and why.',
        },
      },
      required: ['changes'],
    },
    async run(input) {
      latest = normalisePlatformChanges(dep, provider, input.changes, reader);
      if (typeof input.notes === 'string') notes = input.notes.trim();
      clean = latest.issues.length === 0;
      if (clean) return { content: `accepted ${latest.changes.length} changes` };
      return {
        content: `Saved ${latest.changes.length} changes with problems. Fix them and submit again, or explain in your reply why they stand:\n${latest.issues
          .map((issue) => `- ${issue.changeId ?? 'submission'}: ${issue.message}`)
          .join('\n')}`,
      };
    },
  };

  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const prompt = platformWatchUserPrompt({
    dependency: dep,
    since,
    today,
    budgetLeftUsd: budget.capUsd - budget.spentUsd,
  });
  const loopWith = (serverTools?: ServerTool[]): Promise<LoopResult> =>
    runToolLoop({
      model,
      system: platformWatchSystemPrompt({
        dependency: dep,
        webSearch: Boolean(serverTools?.length),
      }),
      prompt,
      tools: [...pageTools(reader), submit],
      serverTools,
      maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
      maxTokens: options.maxTokens,
      isDone: () => clean,
      nudge:
        'You have not called submit_changes yet. Call it now with every change you found (an empty list if none).',
      wrapUp: 'Call submit_changes in your next reply with every change you have found so far.',
      budget,
    });
  const search =
    options.webSearch === false ? undefined : { ...DEFAULT_WEB_SEARCH, ...options.webSearch };
  const serverTools: ServerTool[] | undefined = search
    ? [{ type: search.type, name: 'web_search', max_uses: search.maxUses }]
    : undefined;

  const issues: WatchIssue[] = [];
  let loop = await loopWith(serverTools);
  // An account that cannot use a server tool fails the very first call with a 400 about it.
  if (
    loop.ended === 'model-error' &&
    loop.turns === 0 &&
    serverTools &&
    SERVER_TOOL_REFUSED.test(loop.error ?? '')
  ) {
    issues.push({ message: `web search failed, so the run went on without it: ${loop.error}` });
    loop = await loopWith(undefined);
  }
  options.onPages?.(reader);

  issues.push(...(latest?.issues ?? []));
  if (!latest) issues.push({ message: NO_SUBMISSION });
  const stopped =
    loop.ended === 'done'
      ? []
      : [`run ended early: ${loop.ended}${loop.error ? ` (${loop.error})` : ''}`];
  issues.push(...stopped.map((message) => ({ message })));
  // An empty result is only "nothing changed" if something was read.
  if (latest && latest.changes.length === 0 && reader.readUrls.length === 0)
    issues.push({ message: NOTHING_READ });

  return {
    provider,
    dependency: dep,
    changes: latest?.changes ?? [],
    issues,
    unverifiedQuotes: latest?.unverifiedQuotes ?? [],
    sourcesRead: reader.readUrls,
    model: base.model,
    costUsd: budget.spentUsd - spentBefore,
    turns: loop.turns,
    summary: notes || loop.finalText,
    log: loop.log,
    // A 404 on a page guessed along the way is not a gap; on a starting page it is.
    errors: [
      ...[...reader.pages.values()]
        .filter(
          (page) =>
            !page.ok &&
            (page.status !== 404 || PLATFORM_SOURCES.some((source) => source.url === page.url)),
        )
        .map((page) => `${page.url}: ${page.error ?? `HTTP ${page.status}`}`),
      ...stopped,
    ],
    failed: issues.some(
      (issue) => issue.message === NO_SUBMISSION || issue.message === NOTHING_READ,
    ),
  };
}

/**
 * The entry point other folders use: F3's WatchPlatforms. Pass options.budget to draw on the run's
 * ledger and options.onReport to keep what could not be read, the cost and the log. A run that
 * never got to an answer throws WatchFailedError, so "no changes" is never a silent failure.
 */
export async function watchPlatforms(
  dep: DependencyUsage,
  since?: string,
  options: PlatformWatchOptions = {},
): Promise<ExternalChange[]> {
  const report = await runPlatformWatch(dep, since, options);
  if (options.onReport) options.onReport(report);
  else for (const error of report.errors) console.warn(`watchPlatforms: ${error}`);
  if (report.failed) throw new WatchFailedError(report as unknown as WatchReport);
  return report.changes;
}
