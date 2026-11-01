// The model seam. Every watcher talks to a ModelClient, so tests run on a fake
// and production runs on Claude. All calls go through a BudgetLedger: the
// run-level dollar cap is one of Aptitude's four hard limits.

import Anthropic from '@anthropic-ai/sdk';

export type TextBlock = { type: 'text'; text: string };
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown };
export type ToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};
// Thinking and other blocks the model returns are passed back unchanged.
export type OpaqueBlock = { type: string; [key: string]: unknown };
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | OpaqueBlock;

export type Message = { role: 'user' | 'assistant'; content: ContentBlock[] };

export type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type ModelRequest = {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxTokens: number;
};

export type ModelResponse = {
  content: ContentBlock[];
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
};

export interface ModelClient {
  /** Model id, used for pricing and for the report. */
  readonly model: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export function isToolUse(block: ContentBlock): block is ToolUseBlock {
  return block.type === 'tool_use';
}

export function isText(block: ContentBlock): block is TextBlock {
  return block.type === 'text' && typeof (block as TextBlock).text === 'string';
}

// Dollars per million tokens (first-party API list prices, 2026-10).
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};
// Unknown models are priced high so the cap errs on the side of stopping spend.
const UNKNOWN_PRICE = { input: 10, output: 50 };

export function costOf(model: string, usage: ModelResponse['usage']): number {
  const price = PRICES[model] ?? UNKNOWN_PRICE;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
}

export class BudgetExceededError extends Error {
  readonly capUsd: number;
  readonly spentUsd: number;
  constructor(capUsd: number, spentUsd: number) {
    super(`AI budget of $${capUsd.toFixed(2)} used ($${spentUsd.toFixed(4)} spent)`);
    this.capUsd = capUsd;
    this.spentUsd = spentUsd;
    this.name = 'BudgetExceededError';
  }
}

export type LedgerEntry = {
  at: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  label?: string;
};

export class BudgetLedger {
  readonly entries: LedgerEntry[] = [];
  readonly capUsd: number;
  constructor(capUsd: number) {
    this.capUsd = capUsd;
    if (!Number.isFinite(capUsd) || capUsd < 0) throw new Error('budget cap must be a number >= 0');
  }
  get spentUsd(): number {
    return this.entries.reduce((sum, entry) => sum + entry.costUsd, 0);
  }
  /** Throws before a call if the cap is already reached. */
  assertRoom(): void {
    if (this.spentUsd >= this.capUsd) throw new BudgetExceededError(this.capUsd, this.spentUsd);
  }
  charge(model: string, usage: ModelResponse['usage'], label?: string): LedgerEntry {
    const entry: LedgerEntry = {
      at: new Date().toISOString(),
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: costOf(model, usage),
      label,
    };
    this.entries.push(entry);
    return entry;
  }
}

/** Wraps a client so every call is checked against and charged to the ledger. */
export function metered(client: ModelClient, ledger: BudgetLedger, label?: string): ModelClient {
  return {
    model: client.model,
    async complete(request) {
      ledger.assertRoom();
      const response = await client.complete(request);
      ledger.charge(client.model, response.usage, label);
      return response;
    },
  };
}

export const DEFAULT_WATCH_MODEL = 'claude-sonnet-5-5';

export type Effort = 'low' | 'medium' | 'high';

/** A Messages API request body, as built from a ModelRequest. */
export type MessagesApiBody = {
  model: string;
  max_tokens: number;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  output_config?: { effort: Effort };
};

/** The parts of a Messages API response the watcher reads. */
export type MessagesApiResponse = {
  content: unknown[];
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
};

/**
 * A ModelClient over any function that sends a Messages API body and returns
 * the response JSON: the SDK, a spend guard, or a recorded transport.
 */
export function messagesApiModel(options: {
  send: (body: MessagesApiBody) => Promise<MessagesApiResponse>;
  model?: string;
  effort?: Effort;
}): ModelClient {
  const model = options.model ?? DEFAULT_WATCH_MODEL;
  return {
    model,
    async complete(request) {
      const body: MessagesApiBody = {
        model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: request.messages,
        tools: request.tools,
      };
      if (options.effort) body.output_config = { effort: options.effort };
      const response = await options.send(body);
      const usage = response.usage ?? {};
      return {
        content: (response.content ?? []) as ContentBlock[],
        stopReason: response.stop_reason ?? 'end_turn',
        usage: {
          inputTokens:
            (usage.input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0),
          outputTokens: usage.output_tokens ?? 0,
        },
      };
    },
  };
}

/**
 * Claude through the official SDK. The SDK resolves credentials itself;
 * nothing here reads or prints them.
 */
export function anthropicModel(
  options: { model?: string; client?: Anthropic; effort?: Effort } = {},
): ModelClient {
  let client = options.client;
  return messagesApiModel({
    model: options.model ?? process.env.APTITUDE_WATCH_MODEL ?? DEFAULT_WATCH_MODEL,
    effort: options.effort ?? 'medium',
    async send(body) {
      // No silent SDK retries: a retry must be a fresh call that goes through the budget check.
      client ??= new Anthropic({ maxRetries: 0 });
      const response = await client.messages.create(
        body as unknown as Anthropic.MessageCreateParamsNonStreaming,
      );
      return response as unknown as MessagesApiResponse;
    },
  });
}

export function budgetFromEnv(fallbackUsd = 1): BudgetLedger {
  const raw = process.env.APTITUDE_AI_BUDGET_USD;
  const cap = raw === undefined || raw === '' ? fallbackUsd : Number(raw);
  return new BudgetLedger(cap);
}
