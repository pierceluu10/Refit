// The model layer: which model each step uses, what every model costs, and the run-level dollar cap.
// Every part (inventory, watchers, match, harness, reviewer) asks createModel(step) for its model and
// charges what it spends to one run budget, so the cap holds across the whole run. Claude is the
// default everywhere; a step's model can be swapped with REFIT_MODEL_<STEP> (a priced model only).

export type ModelStep = 'inventory' | 'watch' | 'match' | 'harness' | 'reviewer';

export const MODEL_STEPS: readonly ModelStep[] = [
  'inventory',
  'watch',
  'match',
  'harness',
  'reviewer',
];

// Dollars per million tokens. cacheWrite5m and cacheWrite1h are 1.25x and 2x input.
export type ModelPrice = {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
};

const price = (input: number, output: number, cacheRead = input / 10): ModelPrice => ({
  input,
  output,
  cacheWrite5m: input * 1.25,
  cacheWrite1h: input * 2,
  cacheRead,
});

// Source: Anthropic first-party API pricing (claude-api skill, models table cached 2026-10-06).
// Where that table gives no cache-read rate, cache reads are priced at 0.1x input.
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-fable-5-1': price(10, 50, 0.25),
  'claude-fable-5': price(10, 50),
  'claude-opus-5-5': price(4, 20, 0.2),
  'claude-opus-5': price(5, 25),
  'claude-opus-4-8': price(5, 25),
  'claude-opus-4-7': price(5, 25),
  'claude-opus-4-6': price(5, 25),
  'claude-sonnet-5-5': price(2, 10, 0.2),
  'claude-sonnet-5': price(2, 10),
  'claude-sonnet-4-6': price(3, 15),
  'claude-haiku-5-5': price(0.1, 0.5, 0.01),
  'claude-haiku-4-5': price(1, 5),
};

// Server-side web search: $10 per 1,000 searches.
export const WEB_SEARCH_USD = 0.01;

export type StepModel = { model: string; escalation?: string };

// One table for every step. The harness starts on Sonnet and escalates to Opus when stuck.
export const MODEL_TABLE: Readonly<Record<ModelStep, StepModel>> = {
  inventory: { model: 'claude-sonnet-5-5' },
  watch: { model: 'claude-sonnet-5-5' },
  match: { model: 'claude-opus-5-5' },
  harness: { model: 'claude-sonnet-5-5', escalation: 'claude-opus-5-5' },
  reviewer: { model: 'claude-opus-5-5' },
};

export class UnknownModelError extends Error {}
export class BudgetExceededError extends Error {
  override name = 'BudgetExceededError';
}

// The table id a reported model resolves to: the exact id, or the longest table id it starts with,
// so a dated snapshot or a context suffix ('claude-opus-5-5[1m]') prices as its family.
export function resolveModelId(model: string): string | undefined {
  if (MODEL_PRICES[model]) return model;
  const bare = model.replace(/^(?:anthropic\.|us\.anthropic\.|eu\.anthropic\.)/, '');
  const suffix = /^(?:[-@]\d{8})?(?:\[[^\]]*\])?$/;
  return Object.keys(MODEL_PRICES)
    .filter((id) => bare.startsWith(id) && suffix.test(bare.slice(id.length)))
    .sort((a, b) => b.length - a.length)[0];
}

// Never defaults: a model without a price would make the cap meaningless, so it throws.
export function priceOf(model: string): ModelPrice {
  const id = resolveModelId(model);
  if (!id) {
    throw new UnknownModelError(
      `No price for model "${model}". Add it to MODEL_PRICES in shared/models.ts before spending.`,
    );
  }
  return MODEL_PRICES[id];
}

// The usage fields both the Messages API and the Agent SDK report; null means not reported.
export type TokenUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: { ephemeral_1h_input_tokens?: number | null } | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
};

export function usageCostUsd(model: string, usage: TokenUsage): number {
  const p = priceOf(model);
  const writes = usage.cache_creation_input_tokens ?? 0;
  const hourWrites = Math.min(writes, usage.cache_creation?.ephemeral_1h_input_tokens ?? 0);
  const tokens =
    (usage.input_tokens ?? 0) * p.input +
    (writes - hourWrites) * p.cacheWrite5m +
    hourWrites * p.cacheWrite1h +
    (usage.cache_read_input_tokens ?? 0) * p.cacheRead +
    (usage.output_tokens ?? 0) * p.output;
  return tokens / 1e6 + (usage.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD;
}

// The most one call can cost: every input token uncached plus a full max_tokens of output.
export function worstCaseUsd(model: string, inputTokens: number, maxOutputTokens: number): number {
  const p = priceOf(model);
  return (inputTokens * p.input + maxOutputTokens * p.output) / 1e6;
}

// The run-level dollar cap (hard limit 2). The orchestrator's Budget fits this shape, so a part can
// charge it directly; without one, parts share the process-wide budget from REFIT_AI_BUDGET_USD.
export type SpendCap = {
  readonly capUsd: number;
  spentUsd(): number;
  chargeUsd(costUsd: number, label?: string): number;
};

export function budgetCapFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env.REFIT_AI_BUDGET_USD;
  const capUsd = Number(raw);
  if (!raw || !Number.isFinite(capUsd) || capUsd <= 0) {
    throw new Error('Set REFIT_AI_BUDGET_USD to a positive dollar cap before spending on AI.');
  }
  return capUsd;
}

export type RunBudget = SpendCap & {
  remainingUsd(): number;
  entries: readonly { usd: number; label: string }[];
};

export function createRunBudget(capUsd: number): RunBudget {
  if (!Number.isFinite(capUsd) || capUsd <= 0) {
    throw new Error(`The run budget must be a positive number of dollars, got ${capUsd}`);
  }
  const entries: { usd: number; label: string }[] = [];
  let spent = 0;
  return {
    capUsd,
    entries,
    spentUsd: () => spent,
    remainingUsd: () => Math.max(0, capUsd - spent),
    chargeUsd(costUsd, label = 'model call') {
      if (!Number.isFinite(costUsd) || costUsd < 0) return spent;
      spent += costUsd;
      entries.push({ usd: costUsd, label });
      return spent;
    },
  };
}

let processBudget: { cap: number; budget: RunBudget } | undefined;

// One budget per process, read from REFIT_AI_BUDGET_USD the first time something spends. Throws
// when the variable is missing, so nothing can spend without a cap.
export function runBudget(env: Record<string, string | undefined> = process.env): RunBudget {
  const cap = budgetCapFromEnv(env);
  if (!processBudget || processBudget.cap !== cap) {
    processBudget = { cap, budget: createRunBudget(cap) };
  }
  return processBudget.budget;
}

// Tests only: forget the process-wide budget.
export function resetRunBudget(): void {
  processBudget = undefined;
}

export type Model = {
  step: ModelStep;
  id: string;
  escalation?: string;
  price: ModelPrice;
  costOf(usage: TokenUsage, model?: string): number;
  worstCaseUsd(inputTokens: number, maxOutputTokens: number): number;
  // Call before every model call. Throws BudgetExceededError when the run's cap is used, or when
  // `estimateUsd` would pass it.
  assertCanSpend(estimateUsd?: number): void;
  // Charges a call's usage to the run budget and returns its cost. `model` defaults to this step's.
  charge(usage: TokenUsage, note?: string, model?: string): number;
  chargeUsd(usd: number, note?: string): number;
};

export type CreateModelOptions = {
  budget?: SpendCap;
  env?: Record<string, string | undefined>;
};

const envName = (step: ModelStep) => `REFIT_MODEL_${step.toUpperCase()}`;

export function createModel(step: ModelStep, options: CreateModelOptions = {}): Model {
  const env = options.env ?? process.env;
  const row = MODEL_TABLE[step];
  if (!row) throw new Error(`Unknown model step "${step}"`);
  const override = env[envName(step)]?.trim();
  const id = override || row.model;
  const p = priceOf(id); // an override must be a priced model
  // Resolved lazily, so building a model never needs the cap; spending does.
  const budget = () => options.budget ?? runBudget(env);
  const assertCanSpend = (estimateUsd = 0) => {
    const b = budget();
    const spent = b.spentUsd();
    if (spent >= b.capUsd || spent + estimateUsd > b.capUsd) {
      throw new BudgetExceededError(
        `AI budget of $${b.capUsd.toFixed(2)} used ($${spent.toFixed(4)} spent) at step ${step}`,
      );
    }
  };
  return {
    step,
    id,
    escalation: override ? undefined : row.escalation,
    price: p,
    costOf: (usage, model = id) => usageCostUsd(model, usage),
    worstCaseUsd: (inputTokens, maxOutputTokens) => worstCaseUsd(id, inputTokens, maxOutputTokens),
    assertCanSpend,
    charge(usage, note = 'model call', model = id) {
      const usd = usageCostUsd(model, usage);
      budget().chargeUsd(usd, `${step} ${model}: ${note}`);
      return usd;
    },
    chargeUsd(usd, note = 'model call') {
      budget().chargeUsd(usd, `${step} ${id}: ${note}`);
      return usd;
    },
  };
}
