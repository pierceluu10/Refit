// The model seam for compliance/. Every agent here talks to a ModelClient, so tests run on a fake
// and real runs on Claude, and every real call is charged to a run-level dollar cap (a hard limit).
import { createModel, MODEL_PRICES, type ModelStep } from '../shared/models.ts';

export type TextBlock = { type: 'text'; text: string };
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown };
export type ToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;
export type Message = { role: 'user' | 'assistant'; content: ContentBlock[] };
export type ToolSpec = { name: string; description: string; input_schema: Record<string, unknown> };

export type ModelRequest = {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxTokens: number;
};
export type Usage = { inputTokens: number; outputTokens: number };
export type ModelResponse = { content: ContentBlock[]; stopReason: string; usage: Usage };

export interface ModelClient {
  readonly model: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

// Unknown models are priced high so the cap errs on the side of stopping spend.
const UNKNOWN_PRICE = { input: 10, output: 50 };

export const DEFAULT_MODEL = 'claude-sonnet-5-5';

export function costOf(model: string, usage: Usage): number {
  const price = MODEL_PRICES[model] ?? UNKNOWN_PRICE;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
}

export class BudgetExceededError extends Error {
  constructor(capUsd: number, spentUsd: number) {
    super(`AI budget of $${capUsd.toFixed(2)} used ($${spentUsd.toFixed(4)} spent)`);
    this.name = 'BudgetExceededError';
  }
}

export class Budget {
  readonly capUsd: number;
  private spent = 0;
  constructor(capUsd: number) {
    if (!Number.isFinite(capUsd) || capUsd <= 0) {
      throw new Error(
        'Set REFIT_AI_BUDGET_USD (or pass a cap) to a positive dollar amount before running AI.',
      );
    }
    this.capUsd = capUsd;
  }
  static fromEnv(env: NodeJS.ProcessEnv = process.env): Budget {
    return new Budget(Number(env.REFIT_AI_BUDGET_USD));
  }
  get spentUsd(): number {
    return this.spent;
  }
  get leftUsd(): number {
    return Math.max(this.capUsd - this.spent, 0);
  }
  charge(costUsd: number): void {
    this.spent += costUsd;
  }
}

// Rough worst case for one call: two characters a token for the prompt, every max_tokens token output.
export function worstCaseUsd(model: string, request: ModelRequest): number {
  const chars =
    request.system.length +
    JSON.stringify(request.messages).length +
    JSON.stringify(request.tools).length;
  return costOf(model, {
    inputTokens: Math.ceil(chars / 2) + 1_000,
    outputTokens: request.maxTokens,
  });
}

// Wraps a client so no call is sent unless its worst case fits what is left of the cap.
export function metered(client: ModelClient, budget: Budget): ModelClient & { budget: Budget } {
  return {
    model: client.model,
    budget,
    async complete(request) {
      if (worstCaseUsd(client.model, request) > budget.leftUsd) {
        throw new BudgetExceededError(budget.capUsd, budget.spentUsd);
      }
      const response = await client.complete(request);
      budget.charge(costOf(client.model, response.usage));
      return response;
    },
  };
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

// The Messages API over fetch, so compliance/ needs no SDK dependency. The key is read here and
// never logged or returned.
export function anthropicClient(options: {
  apiKey: string;
  model?: string;
  fetch?: FetchLike;
}): ModelClient {
  const model = options.model ?? DEFAULT_MODEL;
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  return {
    model,
    async complete(request) {
      const response = await doFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': options.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: request.messages,
          tools: request.tools,
        }),
      });
      if (!response.ok) {
        const text = (await response.text()).slice(0, 500);
        throw new Error(`Anthropic API ${response.status}: ${text}`);
      }
      const json = (await response.json()) as {
        content: ContentBlock[];
        stop_reason: string;
        usage: { input_tokens: number; output_tokens: number };
      };
      return {
        content: json.content,
        stopReason: json.stop_reason,
        usage: { inputTokens: json.usage.input_tokens, outputTokens: json.usage.output_tokens },
      };
    },
  };
}

// Reading the rules is its own step ('rules'); matching them to code runs on the watch model.
export function complianceModelId(
  env: NodeJS.ProcessEnv = process.env,
  step: ModelStep = 'watch',
): string {
  return env.REFIT_COMPLIANCE_MODEL ?? createModel(step, { env }).id;
}

// The real model for a compliance run, metered against the budget given (the run's share of the cap)
// or REFIT_AI_BUDGET_USD. Throws, with a plain reason, when the key or the cap is missing: a run
// without a cap refuses to spend.
export function createComplianceModel(
  env: NodeJS.ProcessEnv = process.env,
  given?: Budget,
  step: ModelStep = 'watch',
): ModelClient & { budget: Budget } {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set, so no model is available.');
  const budget = given ?? Budget.fromEnv(env);
  return metered(anthropicClient({ apiKey, model: complianceModelId(env, step) }), budget);
}

// A fake model for tests: each turn calls the handler with the request and the turn number.
export type FakeTurn = { text?: string; tools?: { name: string; input: unknown }[] };
export function fakeModel(
  handler: (request: ModelRequest, turn: number) => FakeTurn,
  model = 'fake-model',
): ModelClient & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    model,
    requests,
    async complete(request) {
      requests.push(structuredClone(request));
      const turn = handler(request, requests.length - 1);
      const content: ContentBlock[] = [];
      if (turn.text) content.push({ type: 'text', text: turn.text });
      (turn.tools ?? []).forEach((tool, index) =>
        content.push({
          type: 'tool_use',
          id: `call_${requests.length}_${index}`,
          name: tool.name,
          input: tool.input,
        }),
      );
      return {
        content,
        stopReason: turn.tools?.length ? 'tool_use' : 'end_turn',
        usage: { inputTokens: 1_000, outputTokens: 200 },
      };
    },
  };
}

// A fake that plays a fixed script of turns, then ends.
export function scriptedModel(turns: FakeTurn[]) {
  return fakeModel((_request, turn) => turns[turn] ?? { text: 'done' });
}
