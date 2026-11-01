import type Anthropic from '@anthropic-ai/sdk';

// Dollars per million tokens. Source: Anthropic model pricing table (claude-api skill, cached 2026-10-06).
const PRICES: Record<
  string,
  { input: number; output: number; cacheWrite: number; cacheRead: number }
> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
};

export class BudgetExceededError extends Error {}

export type Budget = {
  readonly capUsd: number;
  spentUsd(): number;
  // Throws before a call whose worst case would cross the cap.
  reserve(model: string, inputTokens: number, maxOutputTokens: number): void;
  // Records what a call actually cost and returns it.
  charge(model: string, usage: Anthropic.Usage): number;
  // Records a cost already priced elsewhere (the Agent SDK's total_cost_usd).
  chargeUsd(costUsd: number): number;
};

function price(model: string) {
  const p = PRICES[model];
  if (!p)
    throw new Error(
      `No price for model ${model}; add it to orchestrator/budget.ts before spending.`,
    );
  return p;
}

// The run-level dollar cap is a hard limit: refuse to build a budget without one.
export function createBudget(capUsd = Number(process.env.APTITUDE_AI_BUDGET_USD)): Budget {
  if (!Number.isFinite(capUsd) || capUsd <= 0) {
    throw new Error(
      'Set APTITUDE_AI_BUDGET_USD (or pass a cap) to a positive dollar amount before running AI.',
    );
  }
  let spent = 0;
  return {
    capUsd,
    spentUsd: () => spent,
    reserve(model, inputTokens, maxOutputTokens) {
      const p = price(model);
      const worst = (inputTokens * p.input + maxOutputTokens * p.output) / 1e6;
      if (spent + worst > capUsd) {
        throw new BudgetExceededError(
          `AI budget: $${spent.toFixed(4)} spent of $${capUsd}; the next call could cost up to $${worst.toFixed(4)}.`,
        );
      }
    },
    charge(model, usage) {
      const p = price(model);
      const cost =
        (usage.input_tokens * p.input +
          usage.output_tokens * p.output +
          (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite +
          (usage.cache_read_input_tokens ?? 0) * p.cacheRead) /
        1e6;
      spent += cost;
      return cost;
    },
    chargeUsd(costUsd) {
      spent += costUsd;
      return costUsd;
    },
  };
}
