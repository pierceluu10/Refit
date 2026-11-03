// The watcher agent: reads a provider's published changes and writes
// ProviderChange[]. The model classifies; code only checks the output's shape
// and quotes, and hands every problem back to the model to fix.

import type { MigrationKind, ProviderChange, WatchProvider } from '../../shared/types.ts';
import { runToolLoop, type LoopTool } from './agent.ts';
import { httpFetcher, type Fetcher } from './fetch.ts';
import {
  anthropicModel,
  budgetFromEnv,
  metered,
  type BudgetLedger,
  type ModelClient,
  type ServerTool,
} from './model.ts';
import { PageReader, pageTools } from './page-tools.ts';
import { MIGRATION_KINDS, watchSystemPrompt, watchUserPrompt } from './prompt.ts';
import type { LoadedProvider, WatchIssue, WatchReport } from './types.ts';

export type WatchDeps = {
  model?: ModelClient;
  fetcher?: Fetcher;
  budget?: BudgetLedger;
  /** Override "today" for reproducible prompts in tests. */
  today?: string;
  maxTurns?: number;
  /** max_tokens for each model call. */
  maxTokens?: number;
};

const CHANGE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: MIGRATION_KINDS },
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
  },
  required: ['id', 'kind', 'title', 'source', 'affects'],
};

export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'change'
  );
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    .map((s) => s.trim());
  return out.length ? out : undefined;
}

/**
 * Turns the model's submission into ProviderChange[] and lists problems. It
 * never drops a change the model made: a bad kind becomes 'other', a missing
 * quote stays as an issue, and the model sees every issue.
 */
export function normaliseChanges(
  provider: string,
  raw: unknown,
  reader?: PageReader,
): { changes: ProviderChange[]; issues: WatchIssue[]; unverifiedQuotes: string[] } {
  const issues: WatchIssue[] = [];
  const unverifiedQuotes: string[] = [];
  const list = Array.isArray(raw) ? raw : [];
  if (!Array.isArray(raw)) issues.push({ message: 'changes must be an array' });
  const seen = new Map<string, number>();
  const changes: ProviderChange[] = [];

  list.forEach((item, index) => {
    const entry = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const title = typeof entry.title === 'string' ? entry.title.trim() : '';
    let base = slug(
      typeof entry.id === 'string' && entry.id ? entry.id : title || `change-${index + 1}`,
    );
    if (base.startsWith(`${provider}-`)) base = base.slice(provider.length + 1);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const id = `${provider}:${count > 1 ? `${base}-${count}` : base}`;

    let kind = entry.kind as MigrationKind;
    if (!MIGRATION_KINDS.includes(kind)) {
      issues.push({
        changeId: id,
        message: `kind "${String(entry.kind)}" is not a MigrationKind; stored as "other"`,
      });
      kind = 'other';
    }
    if (!title) issues.push({ changeId: id, message: 'missing title' });

    const source = (entry.source && typeof entry.source === 'object' ? entry.source : {}) as Record<
      string,
      unknown
    >;
    const url = typeof source.url === 'string' ? source.url.trim() : '';
    const quote = typeof source.quote === 'string' ? source.quote.trim() : '';
    if (!url) issues.push({ changeId: id, message: 'missing source.url' });
    if (!quote) issues.push({ changeId: id, message: 'missing source.quote' });
    if (quote && reader) {
      const hits = reader.findQuote(quote);
      const cited = url ? reader.pageFor(url) : undefined;
      if (hits.length === 0) {
        unverifiedQuotes.push(id);
        issues.push({ changeId: id, message: 'quote not found word for word in any page read' });
      } else if (cited && !hits.includes(cited)) {
        issues.push({
          changeId: id,
          message: `quote is on ${hits[0]}, not on ${url}: set source.url to the page it is on`,
        });
      }
    }

    let effectiveDate =
      typeof entry.effectiveDate === 'string' ? entry.effectiveDate.trim() : undefined;
    if (effectiveDate === '') effectiveDate = undefined;
    if (effectiveDate && !/^\d{4}-\d{2}(-\d{2})?$/.test(effectiveDate)) {
      issues.push({
        changeId: id,
        message: `effectiveDate "${effectiveDate}" is not YYYY-MM-DD or YYYY-MM`,
      });
    }

    const affectsRaw = (
      entry.affects && typeof entry.affects === 'object' ? entry.affects : {}
    ) as Record<string, unknown>;
    const affects: ProviderChange['affects'] = {};
    const operations = strings(affectsRaw.operations);
    const fields = strings(affectsRaw.fields);
    const versions = strings(affectsRaw.versions);
    if (operations) affects.operations = operations;
    if (fields) affects.fields = fields;
    if (versions) affects.versions = versions;
    if (typeof affectsRaw.sdk === 'string' && affectsRaw.sdk.trim())
      affects.sdk = affectsRaw.sdk.trim();

    const change: ProviderChange = { provider, id, kind, title, source: { url, quote }, affects };
    if (effectiveDate) change.effectiveDate = effectiveDate;
    changes.push(change);
  });
  return { changes, issues, unverifiedQuotes };
}

export async function runWatch(
  provider: LoadedProvider,
  since?: string,
  deps: WatchDeps = {},
): Promise<WatchReport> {
  const today = deps.today ?? new Date().toISOString().slice(0, 10);
  return runWatchAgent(
    {
      provider: provider.id,
      label: `watch:${provider.id}`,
      reader: new PageReader(deps.fetcher ?? httpFetcher(), provider.sources),
      system: watchSystemPrompt(provider),
      prompt: watchUserPrompt(provider, since, today),
    },
    deps,
  );
}

/** One watcher agent run: what it is told, what it may read, and which tools it has besides the page tools. */
export type WatchAgentRun = {
  /** ProviderChange.provider for every change, and the prefix of their ids. */
  provider: string;
  /** Ledger label for its model calls. */
  label: string;
  reader: PageReader;
  system: string;
  prompt: string;
  tools?: LoopTool[];
  /** Tools Anthropic runs, such as web search. Optional: a run they break is retried without them. */
  serverTools?: ServerTool[];
};

/**
 * The shared watcher loop. The model reads and submits; code checks the
 * submission's shape and quotes and hands every problem back. It never drops a change.
 */
export async function runWatchAgent(
  run: WatchAgentRun,
  deps: WatchDeps = {},
): Promise<WatchReport> {
  const budget = deps.budget ?? budgetFromEnv();
  const base = deps.model ?? anthropicModel();
  const model = metered(base, budget, run.label);
  const spentBefore = budget.spentUsd;
  const { reader } = run;

  let latest: ReturnType<typeof normaliseChanges> | undefined;
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
      latest = normaliseChanges(run.provider, input.changes, reader);
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

  const loopWith = (serverTools?: ServerTool[]) =>
    runToolLoop({
      model,
      system: run.system,
      prompt: run.prompt,
      tools: [...pageTools(reader), ...(run.tools ?? []), submit],
      serverTools,
      maxTurns: deps.maxTurns ?? 16,
      maxTokens: deps.maxTokens,
      isDone: () => clean,
      nudge:
        'You have not called submit_changes yet. Call it now with every change you found (an empty list if none).',
      wrapUp: 'Call submit_changes in your next reply with every change you have found so far.',
      budget,
    });
  let loop = await loopWith(run.serverTools);
  const issues: WatchIssue[] = [];
  // A server tool the account cannot use fails the very first call; the read goes on without it.
  if (loop.ended === 'model-error' && loop.turns === 0 && run.serverTools?.length) {
    issues.push({
      message: `server tools (${run.serverTools.map((tool) => tool.name).join(', ')}) failed, so the run went on without them: ${loop.error}`,
    });
    loop = await loopWith(undefined);
  }

  issues.push(...(latest?.issues ?? []));
  if (!latest) issues.push({ message: NO_SUBMISSION });
  if (loop.ended !== 'done')
    issues.push({
      message: `run ended early: ${loop.ended}${loop.error ? ` (${loop.error})` : ''}`,
    });

  return {
    provider: run.provider,
    changes: latest?.changes ?? [],
    issues,
    unverifiedQuotes: latest?.unverifiedQuotes ?? [],
    sourcesRead: reader.readUrls,
    model: base.model,
    costUsd: budget.spentUsd - spentBefore,
    turns: loop.turns,
    // The loop ends at the first clean submission, so its notes, when given, are the last word.
    summary: notes || loop.finalText,
    log: loop.log,
  };
}

/** The entry point other folders use: a WatchProvider bound to one provider. */
export const NO_SUBMISSION = 'the agent ended without submitting changes';

/** Thrown when a run never got to a submission, so "no changes" is never a silent failure. */
export class WatchFailedError extends Error {
  readonly report: WatchReport;
  constructor(report: WatchReport) {
    super(
      `${report.provider} watch failed: ${report.issues.map((issue) => issue.message).join('; ')}`,
    );
    this.name = 'WatchFailedError';
    this.report = report;
  }
}

/**
 * The entry point other folders use: a WatchProvider bound to one provider.
 * WatchProvider returns only changes, so pass onReport to keep the issues,
 * cost and log; a run that never submitted throws WatchFailedError.
 */
export function createWatcher(
  load: () => LoadedProvider,
  deps: WatchDeps & { onReport?: (report: WatchReport) => void } = {},
): WatchProvider {
  return async (since?: string) => {
    const report = await runWatch(load(), since, deps);
    deps.onReport?.(report);
    if (report.issues.some((issue) => issue.message === NO_SUBMISSION)) {
      throw new WatchFailedError(report);
    }
    return report.changes;
  };
}
