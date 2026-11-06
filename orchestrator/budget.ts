import type Anthropic from '@anthropic-ai/sdk';
import { priceOf } from './models.ts';

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

// Prices come from the model layer (shared/models.ts once O3 lands), so no model defaults to another's price.
function price(model: string) {
  const p = priceOf(model);
  if (!p)
    throw new Error(
      `No price for model ${model}; add it to the model layer (shared/models.ts) before spending.`,
    );
  return { cacheWrite: p.input * 1.25, cacheRead: p.input * 0.1, ...p };
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
export function createBudget(capUsd = Number(process.env.REFIT_AI_BUDGET_USD)): Budget {
  if (!Number.isFinite(capUsd) || capUsd <= 0) {
    throw new Error(
      'Set REFIT_AI_BUDGET_USD (or pass a cap) to a positive dollar amount before running AI.',
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

  const refusal = (waiter: { label: string; minUsd: number }) =>
    new BudgetExceededError(
      `AI budget: $${(capUsd - spent).toFixed(2)} of the $${capUsd} cap left; ${waiter.label} needs $${waiter.minUsd.toFixed(2)}.`,
    );

  // Grants every waiter that fits, oldest first. Spent only grows, so a waiter whose minimum is more
  // than the unspent rest of the cap is refused at once. With no hold left open nothing can free up,
  // so every waiter that still does not fit is refused.
  function wake() {
    for (const waiter of [...waiting]) {
      const fits = free() >= waiter.minUsd;
      if (!fits && waiter.minUsd <= capUsd - spent + 1e-9) continue;
      waiting.splice(waiting.indexOf(waiter), 1);
      if (fits) waiter.resolve(grant(waiter.maxUsd));
      else waiter.reject(refusal(waiter));
    }
    if (open > 0) return;
    for (const waiter of waiting.splice(0)) waiter.reject(refusal(waiter));
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
