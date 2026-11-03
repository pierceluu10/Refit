// The reviewer's model client is injected, so tests and the smoke run use a fake and spend $0.
// The real one calls the Messages API and holds every call's worst case against the run budget
// (orchestrator/budget.ts), the same hard cap the inventory, watchers, match and harness hold
// against, so a review can never spend past it.
import Anthropic from '@anthropic-ai/sdk';
import { costOf, worstCaseUsd, type Budget } from '../../orchestrator/budget.ts';

export type ModelRequest = {
  system: string;
  prompt: string;
  maxTokens: number;
  /** When given, the reply is constrained to JSON matching this schema (structured outputs). */
  jsonSchema?: Record<string, unknown>;
};
export type ModelResponse = { text: string; costUsd: number; model: string };

export type ModelClient = { complete: (request: ModelRequest) => Promise<ModelResponse> };

type Reply = string | ((request: ModelRequest) => string);

/** A scripted client: returns the given replies in order (or one reply forever). No network. */
export class FakeModelClient implements ModelClient {
  readonly requests: ModelRequest[] = [];
  private readonly replies: Reply[];
  private readonly costUsd: number;

  constructor(replies: Reply | Reply[], costUsd = 0) {
    this.replies = Array.isArray(replies) ? replies : [replies];
    this.costUsd = costUsd;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const index = Math.min(this.requests.length - 1, this.replies.length - 1);
    const reply = this.replies[index];
    if (reply === undefined) throw new Error('FakeModelClient has no replies');
    const text = typeof reply === 'function' ? reply(request) : reply;
    return { text, costUsd: this.costUsd, model: 'fake' };
  }
}

/** The reviewer's model: the same one the match agent uses. */
export const REVIEWER_MODEL = 'claude-opus-5-5';
// A second opinion is advisory and read next to a hand-check, so medium effort (Opus 5.5's default,
// set explicitly) keeps each review to a few cents.
const REVIEWER_EFFORT = 'medium';
// Code and diffs run nearer 3 characters per token than 4, so this overestimates on purpose: the
// estimate sizes the hold, and a hold that is too small could let a call spend past the cap.
const CHARS_PER_TOKEN = 3;

/**
 * A ModelClient on the Anthropic Messages API, charged to the run budget. Each call holds its
 * worst case (every input token plus a full maxTokens of output) before it starts and settles the
 * hold to what the API reports, so a call the run can't afford is refused before any request.
 */
export function anthropicModelClient(opts: {
  budget: Budget;
  model?: string;
  client?: Pick<Anthropic, 'messages'>;
}): ModelClient {
  const model = opts.model ?? REVIEWER_MODEL;
  return {
    complete: async ({ system, prompt, maxTokens, jsonSchema }) => {
      const inputTokens = Math.ceil((system.length + prompt.length) / CHARS_PER_TOKEN);
      const hold = await opts.budget.reserve(
        'an advisory review',
        worstCaseUsd(model, inputTokens, maxTokens),
      );
      // No silent SDK retries: each try is one request against one hold.
      const client = opts.client ?? new Anthropic({ maxRetries: 0 });
      // Unknown until the API answers: an error with a status was not billed, but a dropped
      // connection may have been, so it counts the whole hold.
      let costUsd = Number.NaN;
      let response: Anthropic.Message;
      try {
        response = await client.messages.create({
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: prompt }],
          output_config: {
            effort: REVIEWER_EFFORT,
            ...(jsonSchema ? { format: { type: 'json_schema', schema: jsonSchema } } : {}),
          },
        });
        costUsd = costOf(model, response.usage);
      } catch (error) {
        if (typeof (error as { status?: unknown } | undefined)?.status === 'number') costUsd = 0;
        throw error;
      } finally {
        costUsd = hold.settle(costUsd);
      }
      const text = response.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('');
      if (response.stop_reason === 'refusal') {
        // Kept as the reviewer's words: the review reads as unsure, and the grade is untouched.
        const category = response.stop_details?.category;
        return {
          text: `The reviewer model declined to review this PR (stop_reason refusal${category ? `, category ${category}` : ''}).`,
          costUsd,
          model: response.model,
        };
      }
      return { text, costUsd, model: response.model };
    },
  };
}
