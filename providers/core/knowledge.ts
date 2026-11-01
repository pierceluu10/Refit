// knowledge.json: what a migration agent should know about a provider. The
// agent drafts it from the docs; every entry carries its source and date.

import { runToolLoop, type LoopTool } from './agent.ts';
import { httpFetcher, type Fetcher } from './fetch.ts';
import {
  anthropicModel,
  budgetFromEnv,
  metered,
  type BudgetLedger,
  type ModelClient,
} from './model.ts';
import { PageReader, pageTools } from './page-tools.ts';
import { KNOWLEDGE_PROMPT_VERSION, MIGRATION_KINDS, knowledgeSystemPrompt } from './prompt.ts';
import type { LoadedProvider, ProviderKnowledge, SourceRef } from './types.ts';

const DATE = /^\d{4}-\d{2}(-\d{2})?$/;

/**
 * Checks a knowledge file's shape and that every entry is sourced and dated.
 * Returns problems as text; it is a check for the drafter and for tests, not a gate.
 */
export function knowledgeProblems(knowledge: unknown): string[] {
  const problems: string[] = [];
  if (!knowledge || typeof knowledge !== 'object') return ['knowledge must be an object'];
  const k = knowledge as Partial<ProviderKnowledge>;
  if (typeof k.provider !== 'string' || !k.provider) problems.push('provider is missing');
  if (typeof k.updatedAt !== 'string' || !DATE.test(k.updatedAt))
    problems.push('updatedAt must be YYYY-MM-DD');
  if (typeof k.draftedBy !== 'string' || !k.draftedBy) problems.push('draftedBy is missing');

  const checkSource = (where: string, source: SourceRef | undefined) => {
    if (!source || typeof source !== 'object') return problems.push(`${where}: missing source`);
    if (typeof source.url !== 'string' || !/^https:\/\//.test(source.url))
      problems.push(`${where}: source.url must be https`);
    if (typeof source.retrievedAt !== 'string' || !DATE.test(source.retrievedAt)) {
      problems.push(`${where}: source.retrievedAt must be YYYY-MM-DD`);
    }
    return 0;
  };
  const checkDate = (where: string, value: unknown) => {
    if (value !== undefined && (typeof value !== 'string' || !DATE.test(value))) {
      problems.push(`${where}: "${String(value)}" is not YYYY-MM-DD or YYYY-MM`);
    }
  };

  if (!k.versioning || typeof k.versioning.scheme !== 'string')
    problems.push('versioning.scheme is missing');
  else checkSource('versioning', k.versioning.source);

  for (const key of ['versions', 'retirements', 'docs', 'sdks'] as const) {
    if (!Array.isArray(k[key])) problems.push(`${key} must be an array`);
  }
  (k.versions ?? []).forEach((version, i) => {
    const where = `versions[${i}] ${version?.value ?? ''}`.trim();
    if (!version?.value) problems.push(`${where}: value is missing`);
    if (!['preview', 'current', 'supported', 'deprecated', 'retired'].includes(version?.status)) {
      problems.push(`${where}: bad status "${String(version?.status)}"`);
    }
    checkDate(`${where}.releasedAt`, version?.releasedAt);
    checkDate(`${where}.retiresAt`, version?.retiresAt);
    checkSource(where, version?.source);
  });
  (k.retirements ?? []).forEach((item, i) => {
    const where = `retirements[${i}] ${item?.subject ?? ''}`.trim();
    if (!item?.subject) problems.push(`${where}: subject is missing`);
    if (!MIGRATION_KINDS.includes(item?.kind))
      problems.push(`${where}: bad kind "${String(item?.kind)}"`);
    checkDate(`${where}.date`, item?.date);
    checkSource(where, item?.source);
  });
  (k.docs ?? []).forEach((doc, i) => {
    const where = `docs[${i}] ${doc?.label ?? ''}`.trim();
    if (!doc?.label || typeof doc?.url !== 'string' || !/^https:\/\//.test(doc.url))
      problems.push(`${where}: needs label and https url`);
    checkSource(where, doc?.source);
  });
  (k.sdks ?? []).forEach((sdk, i) => {
    const where = `sdks[${i}] ${sdk?.package ?? ''}`.trim();
    if (!sdk?.ecosystem || !sdk?.package) problems.push(`${where}: needs ecosystem and package`);
    checkSource(where, sdk?.source);
  });
  return problems;
}

export type DraftDeps = {
  model?: ModelClient;
  fetcher?: Fetcher;
  budget?: BudgetLedger;
  today?: string;
  maxTurns?: number;
  /** max_tokens for each model call. */
  maxTokens?: number;
};

/** Has the agent draft knowledge.json from the docs. The caller decides whether to save it. */
export async function draftKnowledge(
  provider: LoadedProvider,
  extraUrls: string[] = [],
  deps: DraftDeps = {},
): Promise<{ knowledge?: ProviderKnowledge; problems: string[]; costUsd: number }> {
  const budget = deps.budget ?? budgetFromEnv();
  const model = metered(deps.model ?? anthropicModel(), budget, `knowledge:${provider.id}`);
  const before = budget.spentUsd;
  const reader = new PageReader(deps.fetcher ?? httpFetcher(), provider.sources);
  const today = deps.today ?? new Date().toISOString().slice(0, 10);
  let knowledge: ProviderKnowledge | undefined;
  let problems: string[] = ['the agent ended without submitting knowledge'];

  const submit: LoopTool = {
    name: 'submit_knowledge',
    description: 'Submit the knowledge.json object. Returns problems to fix, or "accepted".',
    input_schema: {
      type: 'object',
      properties: { knowledge: { type: 'object' } },
      required: ['knowledge'],
    },
    async run(input) {
      const draft = input.knowledge as ProviderKnowledge;
      if (draft && typeof draft === 'object') draft.provider = provider.id;
      problems = knowledgeProblems(draft);
      const quoteProblems: string[] = [];
      const entries =
        draft && typeof draft === 'object'
          ? [
              draft.versioning,
              ...(draft.versions ?? []),
              ...(draft.retirements ?? []),
              ...(draft.docs ?? []),
              ...(draft.sdks ?? []),
            ]
          : [];
      for (const entry of entries) {
        const quote = entry?.source?.quote;
        if (quote && reader.findQuote(quote).length === 0)
          quoteProblems.push(`quote not found in pages read: "${quote.slice(0, 80)}"`);
      }
      problems = [...problems, ...quoteProblems];
      knowledge = draft;
      return problems.length
        ? {
            content: `Saved with problems; fix and submit again:\n${problems.map((p) => `- ${p}`).join('\n')}`,
          }
        : { content: 'accepted' };
    },
  };

  const loop = await runToolLoop({
    model,
    system: knowledgeSystemPrompt(provider),
    prompt: `Today is ${today}. Draft knowledge.json for ${provider.name} (prompt ${KNOWLEDGE_PROMPT_VERSION}).${
      extraUrls.length ? ` Also read: ${extraUrls.join(', ')}` : ''
    }`,
    tools: [...pageTools(reader), submit],
    maxTurns: deps.maxTurns ?? 16,
    maxTokens: deps.maxTokens,
    isDone: () => knowledge !== undefined && problems.length === 0,
    nudge: 'Call submit_knowledge now with what you have.',
    wrapUp: 'Call submit_knowledge in your next reply with what you have.',
  });
  if (loop.ended !== 'done')
    problems.push(`run ended early: ${loop.ended}${loop.error ? ` (${loop.error})` : ''}`);
  return { knowledge, problems, costUsd: budget.spentUsd - before };
}
