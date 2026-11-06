// The orchestrator's side of the model layer. O3 puts createModel and MODEL_PRICES in shared/models.ts;
// until that lands, this local table stands in. Either way the orchestrator picks a model per step in
// one place, and the run budget prices every call from one table.
import { loadModule } from './upstream.ts';

export type Step = 'inventory' | 'watch' | 'match' | 'harness' | 'reviewer';

export type Price = { input: number; output: number; cacheWrite?: number; cacheRead?: number };

// Claude everywhere by default; the point is that a step's model can be swapped later.
const LOCAL_MODELS: Record<Step, string> = {
  inventory: 'claude-sonnet-5-5',
  watch: 'claude-sonnet-5-5',
  match: 'claude-opus-5-5',
  harness: 'claude-sonnet-5-5',
  reviewer: 'claude-opus-5-5',
};

// Dollars per million tokens. Source: Anthropic model pricing table (claude-api skill, cached 2026-10-06).
const LOCAL_PRICES: Record<string, Price> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
};

// shared/models.ts's exact shapes are O3's; read them loosely so either a string or { id | model } works.
const shared = await loadModule('../shared/models.ts');
const createModel =
  typeof shared?.createModel === 'function'
    ? (shared.createModel as (step: Step) => unknown)
    : undefined;
const sharedPrices = shared?.MODEL_PRICES as Record<string, unknown> | undefined;

const modelId = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const { id, model } = value as { id?: unknown; model?: unknown };
    if (typeof id === 'string') return id;
    if (typeof model === 'string') return model;
  }
  return undefined;
};

export function modelFor(step: Step): string {
  return modelId(createModel?.(step)) ?? LOCAL_MODELS[step];
}

const asPrice = (value: unknown): Price | undefined => {
  const p = value as Partial<Price> | undefined;
  return typeof p?.input === 'number' && typeof p.output === 'number' ? (p as Price) : undefined;
};

// The shared table wins once it lands; an unknown model has no price, so nothing is spent on it.
export function priceOf(model: string): Price | undefined {
  return asPrice(sharedPrices?.[model]) ?? LOCAL_PRICES[model];
}
