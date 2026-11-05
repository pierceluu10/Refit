// The one price table: every ledger in the repo reads it. Dollars per million tokens.
// Source: https://platform.claude.com/docs/en/about-claude/pricing, read 2026-11-05.
export type TokenRates = {
  input: number;
  output: number;
  cacheWrite: number; // 5-minute TTL
  cacheWriteHour: number; // 1-hour TTL
  cacheRead: number;
};

// A model priced by prompt length pays `long` once a request's prompt passes longAbove tokens.
// The prompt counts every input token, cache reads and writes included.
export type ModelPrice = TokenRates & { longAbove?: number; long?: TokenRates };

export const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheWriteHour: 8, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheWriteHour: 4, cacheRead: 0.1 },
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    cacheWrite: 0.125,
    cacheWriteHour: 0.2,
    cacheRead: 0.01,
    longAbove: 100_000,
    long: { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheWriteHour: 1, cacheRead: 0.05 },
  },
};

// Server-side web search: $10 per 1,000 searches.
export const WEB_SEARCH_USD = 0.01;
// The Batch API halves every token rate, cache reads and writes included.
export const BATCH_DISCOUNT = 0.5;

export function ratesFor(price: ModelPrice, promptTokens: number): TokenRates {
  return price.long && price.longAbove !== undefined && promptTokens > price.longAbove
    ? price.long
    : price;
}
