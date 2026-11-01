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

// Part of the run's cap set aside for one part (a watcher, an inventory, a task) while it runs.
export type Hold = {
  readonly usd: number;
  // Records what the part spent and returns the rest of the hold to the run. Later calls are ignored.
  settle(spentUsd: number): number;
};

export type Budget = {
  readonly capUsd: number;
  spentUsd(): number;
  // Set aside by holds that have not settled yet.
  heldUsd(): number;
  // Holds up to maxUsd once minUsd is free. While other holds could still free enough it waits;
  // when none could, it rejects with BudgetExceededError. Spent plus held never passes the cap.
  reserve(label: string, maxUsd: number, minUsd?: number): Promise<Hold>;
  // Records a cost that no hold covered.
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

// What a Messages API call cost.
export function costOf(model: string, usage: Anthropic.Usage): number {
  const p = price(model);
  return (
    (usage.input_tokens * p.input +
      usage.output_tokens * p.output +
      (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite +
      (usage.cache_read_input_tokens ?? 0) * p.cacheRead) /
    1e6
  );
}

// The most a call can cost: every input token plus a full max_tokens of output.
export function worstCaseUsd(model: string, inputTokens: number, maxOutputTokens: number): number {
  const p = price(model);
  return (inputTokens * p.input + maxOutputTokens * p.output) / 1e6;
}

// The run-level dollar cap is a hard limit: refuse to build a budget without one.
export function createBudget(capUsd = Number(process.env.APTITUDE_AI_BUDGET_USD)): Budget {
  if (!Number.isFinite(capUsd) || capUsd <= 0) {
    throw new Error(
      'Set APTITUDE_AI_BUDGET_USD (or pass a cap) to a positive dollar amount before running AI.',
    );
  }
  let spent = 0;
  let held = 0;
  let open = 0;
  const waiting: {
    label: string;
    maxUsd: number;
    minUsd: number;
    resolve: (hold: Hold) => void;
    reject: (error: Error) => void;
  }[] = [];
  // Float sums of holds drift by ~1e-16; this keeps a hold of exactly what is left grantable.
  const free = () => Math.max(capUsd - spent - held, 0) + 1e-9;

  function grant(maxUsd: number): Hold {
    const usd = Math.max(Math.min(free() - 1e-9, maxUsd), 0);
    held += usd;
    open++;
    let settled = false;
    return {
      usd,
      settle(spentUsd) {
        if (settled) return 0;
        settled = true;
        // A cost that is not a number is unknown, so the whole hold counts as spent.
        const cost = Number.isFinite(spentUsd) && spentUsd >= 0 ? spentUsd : usd;
        held = --open === 0 ? 0 : held - usd;
        spent += cost;
        wake();
        return cost;
      },
    };
  }

  // Grants every waiter that fits, oldest first. With no hold left open, nothing can free up, so the
  // waiters that still do not fit are refused.
  function wake() {
    for (const waiter of [...waiting]) {
      if (free() < waiter.minUsd) continue;
      waiting.splice(waiting.indexOf(waiter), 1);
      waiter.resolve(grant(waiter.maxUsd));
    }
    if (open > 0) return;
    for (const waiter of waiting.splice(0)) {
      waiter.reject(
        new BudgetExceededError(
          `AI budget: $${(capUsd - spent).toFixed(2)} of the $${capUsd} cap left; ${waiter.label} needs $${waiter.minUsd.toFixed(2)}.`,
        ),
      );
    }
  }

  return {
    capUsd,
    spentUsd: () => spent,
    heldUsd: () => held,
    reserve(label, maxUsd, minUsd = maxUsd) {
      return new Promise((resolve, reject) => {
        waiting.push({ label, maxUsd, minUsd, resolve, reject });
        wake();
      });
    },
    chargeUsd(costUsd) {
      spent += costUsd;
      return costUsd;
    },
  };
}
