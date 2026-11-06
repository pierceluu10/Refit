import Anthropic from '@anthropic-ai/sdk';
import type { ApiUsage, MigrationTask, ProviderChange } from '../shared/types.ts';
import { costOf, worstCaseUsd, type Budget } from './budget.ts';
import { createModel } from '../shared/models.ts';

// A task plus the agent's reasoning: which call sites, why, and how urgent.
export type MatchedTask = MigrationTask & {
  reasoning: string;
  urgency: string;
  callSites: { file: string; line: number; why: string }[];
};

// Every change the agent judged gets a verdict: tasks, or "not affected" with a reason. Never a silent drop.
export type MatchResult = {
  tasks: MatchedTask[];
  notAffected: { changeId: string; reasoning: string }[];
  costUsd: number;
};

export type MatchChanges = (input: {
  repo: string;
  changes: ProviderChange[];
  usages: ApiUsage[];
  // The repo checkout, for transports that let the agent read code. Read-only; nothing in it is executed.
  repoDir?: string;
}) => Promise<MatchResult>;

const MAX_TOKENS = 16000;
// The least output a match call is sent with once the run's cap is close.
const MIN_MATCH_TOKENS = 6000;
// Changes per match call: 50 verdicts fit well inside MAX_TOKENS, and 160 in one call may not.
export const MATCH_BATCH = 50;

export const SYSTEM_PROMPT = `You are Refit's match agent. Refit keeps codebases working as the external APIs they call change.

You receive a list of provider changes (each with a quote from its source) and the repository's API usage map: every external API the repo calls, how (SDK, HTTP, GraphQL, webhook), pinned versions, and every call site with the operation and fields it uses.

For EVERY change, read it against EVERY usage and call site, then decide:
- Affected: the change touches at least one call site, pinned version or SDK in this repo. Create one task for the change. Name the usages (by their index) and each affected call site with why it is affected. Explain your reasoning, and rate urgency from the deadline and the impact (what breaks, how visibly, how soon).
- Not affected: explain specifically why no usage in this repo is touched, in one or two sentences.

Rules:
- Every change must come back exactly once: either as a task or in notAffected. Never leave one out.
- When you are unsure whether a change applies, create the task anyway and say in the reasoning what is uncertain and what the migration agent should check. Unsure means attempt, not skip.
- Think about indirect effects too: SDK defaults, pinned API versions, renamed models, webhook payloads, response shapes the code reads.
- Provider names are labels, not proof: a change from "meta" applies to a usage recorded as "facebook" or "instagram". Two watchers may report the same change under different names; give it one task and mark the copy not affected, naming the change it repeats.
- The prompt may include overlap hints computed by simple string matching. They can be wrong in both directions. Do not rely on them; your own reading decides.
- Order the tasks from most to least urgent, ranking by deadline first and then impact. The first task is priority 1.
- deadline: the change's effective date if it has one, otherwise a date you can justify from the source, otherwise an empty string. Use YYYY-MM-DD.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tasks', 'notAffected'],
  properties: {
    tasks: {
      type: 'array',
      description: 'Affected changes, most urgent first.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['changeId', 'usageIndexes', 'callSites', 'reasoning', 'urgency', 'deadline'],
        properties: {
          changeId: { type: 'string' },
          usageIndexes: { type: 'array', items: { type: 'integer' } },
          callSites: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['file', 'line', 'why'],
              properties: {
                file: { type: 'string' },
                line: { type: 'integer' },
                why: { type: 'string' },
              },
            },
          },
          reasoning: { type: 'string' },
          urgency: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          deadline: { type: 'string' },
        },
      },
    },
    notAffected: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['changeId', 'reasoning'],
        properties: { changeId: { type: 'string' }, reasoning: { type: 'string' } },
      },
    },
  },
};

type AgentOutput = {
  tasks: {
    changeId: string;
    usageIndexes: number[];
    callSites: { file: string; line: number; why: string }[];
    reasoning: string;
    urgency: string;
    deadline: string;
  }[];
  notAffected: { changeId: string; reasoning: string }[];
};

// String overlap between a change and each usage. Prompt context only: it never filters or decides anything.
export function overlapHints(changes: ProviderChange[], usages: ApiUsage[]): string[] {
  const lower = (xs: string[] = []) => xs.map((x) => x.toLowerCase());
  return changes.map((change) => {
    const ops = lower(change.affects.operations);
    const fields = lower(change.affects.fields);
    const hits = usages.flatMap((usage, i) => {
      if (usage.provider.toLowerCase() !== change.provider.toLowerCase()) return [];
      const siteOps = lower(usage.callSites.map((s) => s.operation));
      const siteFields = lower(usage.callSites.flatMap((s) => s.fields ?? []));
      const opHits = ops.filter((o) => siteOps.includes(o));
      const fieldHits = fields.filter((f) => siteFields.includes(f));
      return [
        `usage ${i} (same provider${opHits.length ? `; operations: ${opHits.join(', ')}` : ''}${fieldHits.length ? `; fields: ${fieldHits.join(', ')}` : ''})`,
      ];
    });
    return `- ${change.id}: ${hits.length ? hits.join('; ') : 'no string overlap found'}`;
  });
}

export function buildPrompt(repo: string, changes: ProviderChange[], usages: ApiUsage[]): string {
  return [
    `Repository: ${repo}`,
    `Provider changes (${changes.length}):\n${JSON.stringify(changes, null, 2)}`,
    `API usages, by index:\n${JSON.stringify(
      usages.map((usage, index) => ({ index, ...usage })),
      null,
      2,
    )}`,
    `HINTS (string overlap only, may be wrong; read every usage against every change regardless):\n${overlapHints(changes, usages).join('\n')}`,
    'Return a verdict for every change: a task or a notAffected entry.',
  ].join('\n\n');
}

// One structured model call: the system prompt, the user prompt and the JSON schema in; parsed JSON and its cost out.
export type AskModel = (req: {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  repoDir?: string;
}) => Promise<{ output: unknown; costUsd: number }>;

// The production transport: the Messages API, priced from token usage against the run budget.
export function messagesApi(opts: {
  client?: Pick<Anthropic, 'messages'>;
  budget: Budget;
  model?: string;
}): AskModel {
  const model = opts.model ?? createModel('match').id;
  return async ({ system, prompt, schema }) => {
    // No silent SDK retries: each try is one request against one hold, and the queue retries.
    const client = opts.client ?? new Anthropic({ maxRetries: 0 });
    // shortcut: chars/3.5 token estimate, switch to messages.countTokens if the cap gets tight
    const inputTokens = Math.ceil((system.length + prompt.length) / 3.5);
    // The call holds its worst case, so matches running at once cannot each spend the same remainder.
    // Near the cap the answer gets less room instead of the call being refused; spend still can't pass the hold.
    const inputUsd = worstCaseUsd(model, inputTokens, 0);
    const hold = await opts.budget.reserve(
      'a match call',
      worstCaseUsd(model, inputTokens, MAX_TOKENS),
      worstCaseUsd(model, inputTokens, MIN_MATCH_TOKENS),
    );
    const maxTokens = Math.min(
      MAX_TOKENS,
      Math.floor((hold.usd - inputUsd) / worstCaseUsd(model, 0, 1)),
    );
    let response: Anthropic.Message;
    // Unknown until the API says: an error the API answered with was not billed, but a dropped
    // connection or a response without usage may have been, so those count the whole hold.
    let costUsd = Number.NaN;
    try {
      response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: prompt }],
        output_config: { effort: 'high', format: { type: 'json_schema', schema } },
      });
      costUsd = costOf(model, response.usage);
    } catch (error) {
      if (typeof (error as { status?: unknown } | undefined)?.status === 'number') costUsd = 0;
      throw error;
    } finally {
      costUsd = hold.settle(costUsd);
    }

    if (response.stop_reason === 'refusal') throw new Error('Match agent refused the request.');
    if (response.stop_reason === 'max_tokens') {
      throw new Error(`Match agent hit max_tokens (${maxTokens}); its JSON is incomplete.`);
    }
    const text = response.content.find((b) => b.type === 'text');
    if (!text || text.type !== 'text') throw new Error('Match agent returned no text block.');
    return { output: JSON.parse(text.text), costUsd };
  };
}

export function createMatchAgent(opts: {
  ask?: AskModel;
  client?: Pick<Anthropic, 'messages'>;
  budget: Budget;
  model?: string;
}): MatchChanges {
  const ask = opts.ask ?? messagesApi(opts);
  return async ({ repo, changes, usages, repoDir }) => {
    if (changes.length === 0) return { tasks: [], notAffected: [], costUsd: 0 };
    const prompt = buildPrompt(repo, changes, usages);
    const answer = await ask({ system: SYSTEM_PROMPT, prompt, schema: SCHEMA, repoDir });
    const output = answer.output as AgentOutput;
    const costUsd = answer.costUsd;

    const byId = new Map(changes.map((c) => [c.id, c]));
    const ids = new Set<string>();
    const tasks: MatchedTask[] = [];
    // Unknown change ids are model slips; the real change is still attempted below.
    for (const t of output.tasks.filter((t) => byId.has(t.changeId))) {
      const change = byId.get(t.changeId)!;
      let id = `${repo}:${change.id}`;
      for (let n = 2; ids.has(id); n++) id = `${repo}:${change.id}:${n}`;
      ids.add(id);
      tasks.push({
        id,
        repo,
        change,
        usages: t.usageIndexes.flatMap((i) => (usages[i] ? [usages[i]] : [])),
        deadline: change.effectiveDate ?? (t.deadline || undefined),
        priority: tasks.length + 1,
        notes: t.reasoning,
        reasoning: t.reasoning,
        urgency: t.urgency,
        callSites: t.callSites,
      });
    }

    // A change judged both ways keeps its task: unsure means attempt.
    const judged = new Set(tasks.map((t) => t.change.id));
    const notAffected: MatchResult['notAffected'] = [];
    for (const n of output.notAffected) {
      if (!byId.has(n.changeId) || judged.has(n.changeId)) continue;
      judged.add(n.changeId);
      notAffected.push({ changeId: n.changeId, reasoning: n.reasoning });
    }
    // No verdict is not a "not affected": hand the change to the harness to judge with the code in front of it.
    for (const change of changes.filter((c) => !judged.has(c.id))) {
      const reasoning =
        'The match agent returned no verdict for this change. Check the repo for any use of it, then migrate or conclude not affected.';
      tasks.push({
        id: `${repo}:${change.id}`,
        repo,
        change,
        usages,
        deadline: change.effectiveDate,
        priority: tasks.length + 1,
        notes: reasoning,
        reasoning,
        urgency: 'unknown',
        callSites: [],
      });
    }
    return { tasks, notAffected, costUsd };
  };
}
