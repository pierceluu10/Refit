// The model seam. Every watcher talks to a ModelClient, so tests run on a fake
// and production runs on Claude. All calls go through a BudgetLedger: the
// run-level dollar cap is one of Refit's four hard limits.

import Anthropic from '@anthropic-ai/sdk';
import { createModel, MODEL_PRICES } from '../../shared/models.ts';

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

// Rates come from the model layer. Cache writes (5-minute TTL) cost 1.25x input.
const fromModelLayer = (model: string): Price => {
  const { input, output, cacheRead } = MODEL_PRICES[model];
  return { input, output, cacheRead: cacheRead / input };
};
const PRICES: Record<string, Price> = {
  'claude-opus-5-5': fromModelLayer('claude-opus-5-5'),
  'claude-sonnet-5-5': fromModelLayer('claude-sonnet-5-5'),
  'claude-haiku-5-5': {
    ...fromModelLayer('claude-haiku-5-5'),
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

/** Dollars for a call's usage. `longRate` prices it at the long-context rate whatever its size. */
export function costOf(model: string, usage: Usage, options: { longRate?: boolean } = {}): number {
  const price = PRICES[model] ?? UNKNOWN_PRICE;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const prompt = usage.inputTokens + cacheWrite + cacheRead;
  const long = options.longRate || (price.longAbove !== undefined && prompt > price.longAbove);
  const rate = price.long && long ? price.long : price;
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

/**
 * Prompt tokens per character for the worst-case estimate. Tool schemas and
 * JSON run near two characters a token (the recorded Sonnet runs billed one
 * token per 1.9 to 2.6 characters), so this errs high for prose.
 */
const TOKENS_PER_CHAR = 1 / 2;
/** Tokens the API adds that the request text does not show: the tool-use prompt, server tool definitions. */
export const HIDDEN_PROMPT_TOKENS = 1_000;
/** Input one server-side search can add inside a call (its results), at most. */
export const SEARCH_RESULT_TOKENS = 15_000;
/** The least output a call is sent with once the budget is nearly spent; below it, no call. */
export const MIN_OUTPUT_TOKENS = 1_024;

function requestChars(request: ModelRequest): number {
  return (
    request.system.length +
    JSON.stringify(request.messages).length +
    JSON.stringify(request.tools).length +
    JSON.stringify(request.serverTools ?? []).length
  );
}

/**
 * A call's worst-case cost as a function of its max_tokens: nothing cached
 * (every prompt token and search result written to the cache), every search
 * used. tokensPerChar may be raised from what earlier calls were billed.
 */
function worstCost(
  model: string,
  request: ModelRequest,
  tokensPerChar = TOKENS_PER_CHAR,
): (outputTokens: number) => number {
  const searches = (request.serverTools ?? []).reduce(
    (sum, tool) =>
      sum +
      (typeof tool.max_uses === 'number' ? tool.max_uses : tool.name === 'web_search' ? 10 : 0),
    0,
  );
  const promptTokens =
    Math.ceil(requestChars(request) * Math.max(tokensPerChar, TOKENS_PER_CHAR)) +
    HIDDEN_PROMPT_TOKENS;
  // An estimate can fall short of a long-context threshold the real prompt passes; take the dearer rate near it.
  const price = PRICES[model];
  const longRate = Boolean(price?.longAbove && promptTokens > price.longAbove * 0.75);
  const cacheWriteTokens = promptTokens + searches * SEARCH_RESULT_TOKENS;
  return (outputTokens) =>
    costOf(
      model,
      { inputTokens: 0, outputTokens, cacheWriteTokens, webSearches: searches },
      { longRate },
    );
}

/** The most one call can cost: no cache hits, every search used, every max_tokens token written. */
export function worstCaseUsd(model: string, request: ModelRequest): number {
  return worstCost(model, request)(request.maxTokens);
}

/**
 * Wraps a client so every call is checked against and charged to the ledger.
 * A call is sent only if its worst case fits what is left of the cap; near the
 * end, max_tokens shrinks to fit, and when not even MIN_OUTPUT_TOKENS fit the
 * call is refused. So spend never passes the cap, whatever one call costs. The
 * estimate learns from each response how many tokens a character was billed.
 */
export function metered(client: ModelClient, ledger: BudgetLedger, label?: string): ModelClient {
  let tokensPerChar = TOKENS_PER_CHAR;
  return {
    model: client.model,
    async complete(request) {
      ledger.assertRoom();
      let sent = request;
      const room = ledger.capUsd - ledger.spentUsd;
      const cost = worstCost(client.model, request, tokensPerChar);
      if (cost(request.maxTokens) > room) {
        // Output's price at this prompt size (long prompts can raise it), then as many tokens as fit.
        const fixed = cost(0);
        const perToken = (cost(1_000) - fixed) / 1_000;
        const fits = Math.floor((room - fixed) / perToken);
        if (fits < MIN_OUTPUT_TOKENS) throw new BudgetExceededError(ledger.capUsd, ledger.spentUsd);
        sent = { ...request, maxTokens: Math.min(request.maxTokens, fits) };
      }
      const response = await client.complete(sent);
      ledger.charge(client.model, response.usage, label);
      // Learn the real rate, leaving out the hidden prompt and any search results billed inside the call.
      const {
        inputTokens,
        cacheWriteTokens = 0,
        cacheReadTokens = 0,
        webSearches,
      } = response.usage;
      const chars = requestChars(sent);
      if (chars > 0 && !webSearches) {
        const billed = inputTokens + cacheWriteTokens + cacheReadTokens - HIDDEN_PROMPT_TOKENS;
        tokensPerChar = Math.max(tokensPerChar, (billed / chars) * 1.05);
      }
      return response;
    },
  };
}

export const DEFAULT_WATCH_MODEL = 'claude-sonnet-5-5';

/** The model a real read uses: REFIT_WATCH_MODEL, else the model layer's watch step. */
export const watchModelId = (): string => process.env.REFIT_WATCH_MODEL ?? createModel('watch').id;

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
    model: options.model ?? watchModelId(),
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

/**
 * The run's ledger from REFIT_AI_BUDGET_USD. With it unset, the cap is
 * fallbackUsd, which is $0 unless a caller (such as the CLI) chooses one: a
 * run without a cap refuses to spend.
 */
export function budgetFromEnv(fallbackUsd = 0): BudgetLedger {
  const raw = process.env.REFIT_AI_BUDGET_USD;
  const cap = raw === undefined || raw === '' ? fallbackUsd : Number(raw);
  return new BudgetLedger(cap);
}
