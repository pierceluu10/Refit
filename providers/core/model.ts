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

/**
 * A tool Anthropic runs on its side, such as web search
 * ({ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }). It is sent as is.
 */
export type ServerTool = { type: string; name: string; [key: string]: unknown };

export type ModelRequest = {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxTokens: number;
  serverTools?: ServerTool[];
};

export type Usage = {
  /** Input tokens billed at the full price (for the Messages API, the uncached part). */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens written to the prompt cache (billed at 1.25x input). */
  cacheWriteTokens?: number;
  /** Input tokens read from the prompt cache (billed at a fraction of input). */
  cacheReadTokens?: number;
  /** Server-side web searches, billed per search. */
  webSearches?: number;
};

export type ModelResponse = {
  content: ContentBlock[];
  stopReason: string;
  usage: Usage;
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

type Price = {
  /** Dollars per million input and output tokens. */
  input: number;
  output: number;
  /** A cache read as a fraction of the input price. */
  cacheRead: number;
  /** Above this many prompt tokens, the long-context price applies. */
  longAbove?: number;
  long?: { input: number; output: number };
};

// First-party API list prices, 2026-10. Cache writes (5-minute TTL) cost 1.25x input.
const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.05 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.1,
    longAbove: 100_000,
    long: { input: 0.5, output: 2.5 },
  },
};
// Unknown models are priced high, cache reads at the full input price, so the cap errs on the side
// of stopping spend.
const UNKNOWN_PRICE: Price = { input: 10, output: 50, cacheRead: 1 };
const CACHE_WRITE = 1.25;
/** Server-side web search: $10 per 1,000 searches. */
export const WEB_SEARCH_USD = 0.01;

export function costOf(model: string, usage: Usage): number {
  const price = PRICES[model] ?? UNKNOWN_PRICE;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const prompt = usage.inputTokens + cacheWrite + cacheRead;
  const rate = price.long && price.longAbove && prompt > price.longAbove ? price.long : price;
  const tokens =
    usage.inputTokens * rate.input +
    cacheWrite * rate.input * CACHE_WRITE +
    cacheRead * rate.input * price.cacheRead +
    usage.outputTokens * rate.output;
  return tokens / 1_000_000 + (usage.webSearches ?? 0) * WEB_SEARCH_USD;
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
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  webSearches?: number;
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
  charge(model: string, usage: Usage, label?: string): LedgerEntry {
    const entry: LedgerEntry = {
      at: new Date().toISOString(),
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: costOf(model, usage),
      label,
    };
    if (usage.cacheWriteTokens) entry.cacheWriteTokens = usage.cacheWriteTokens;
    if (usage.cacheReadTokens) entry.cacheReadTokens = usage.cacheReadTokens;
    if (usage.webSearches) entry.webSearches = usage.webSearches;
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
  tools: (ToolSpec | ServerTool)[];
  output_config?: { effort: Effort };
  /** Automatic prompt caching: the API caches up to the last cacheable block. */
  cache_control?: { type: 'ephemeral' };
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
    server_tool_use?: { web_search_requests?: number | null } | null;
  };
};

/**
 * A ModelClient over any function that sends a Messages API body and returns
 * the response JSON: the SDK, a spend guard, or a recorded transport.
 * `cache` turns on automatic prompt caching, so each turn of a tool loop reads
 * the conversation so far from the cache instead of paying for it again.
 */
export function messagesApiModel(options: {
  send: (body: MessagesApiBody) => Promise<MessagesApiResponse>;
  model?: string;
  effort?: Effort;
  cache?: boolean;
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
        tools: [...request.tools, ...(request.serverTools ?? [])],
      };
      if (options.effort) body.output_config = { effort: options.effort };
      if (options.cache) body.cache_control = { type: 'ephemeral' };
      const response = await options.send(body);
      const usage = response.usage ?? {};
      return {
        content: (response.content ?? []) as ContentBlock[],
        stopReason: response.stop_reason ?? 'end_turn',
        usage: {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          webSearches: usage.server_tool_use?.web_search_requests ?? 0,
        },
      };
    },
  };
}

/**
 * Claude through the official SDK, with automatic prompt caching on. The SDK
 * resolves credentials itself; nothing here reads or prints them.
 */
export function anthropicModel(
  options: { model?: string; client?: Anthropic; effort?: Effort; cache?: boolean } = {},
): ModelClient {
  let client = options.client;
  return messagesApiModel({
    model: options.model ?? process.env.APTITUDE_WATCH_MODEL ?? DEFAULT_WATCH_MODEL,
    effort: options.effort ?? 'medium',
    cache: options.cache ?? true,
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
