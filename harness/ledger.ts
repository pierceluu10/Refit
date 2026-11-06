// Hard limit 2: a run-level dollar cap. Every model call is charged here.

import {
  BudgetExceededError,
  budgetCapFromEnv,
  usageCostUsd as priceUsage,
  type SpendCap,
  type TokenUsage,
} from '../shared/models.ts';

// One error class across the harness and the model layer, so a cap hit anywhere reads the same.
export { BudgetExceededError };
export type { TokenUsage };

export type LedgerEntry = { model: string; costUsd: number; note: string };

// Called with every charge as it happens (HarnessDeps.chargeRun), so the run budget sees the spend
// even if the harness throws later. It must not throw: it runs inside the model stream, where a
// throw ends the query as an error. The harness's own ledger already enforces its cap.
export type ChargeRun = (usd: number, label: string) => void;

// Prices come from the model layer (shared/models.ts), the one table every ledger reads. An unknown
// model throws there rather than being guessed at, so add new models to that table first.
export function usageCostUsd(model: string, usage: TokenUsage): number {
  return priceUsage(model, usage);
}

export class BudgetLedger {
  readonly entries: LedgerEntry[] = [];
  readonly capUsd: number;
  private readonly onCharge?: ChargeRun;
  private readonly run?: SpendCap;
  private readonly cumulative = new Map<string, number>();

  // `run` is the run-level budget this ledger draws on (shared/models.ts SpendCap). With it, a
  // charge counts against both caps and the ledger refuses to spend once either is used. Pass the
  // run budget here or forward charges to it through onCharge, not both, or spend counts twice.
  constructor(capUsd: number, onCharge?: ChargeRun, run?: SpendCap) {
    this.capUsd = capUsd;
    this.onCharge = onCharge;
    this.run = run;
    if (!Number.isFinite(capUsd) || capUsd <= 0) {
      throw new Error(`Budget cap must be a positive number of dollars, got ${capUsd}`);
    }
  }

  get spentUsd(): number {
    return this.entries.reduce((sum, entry) => sum + entry.costUsd, 0);
  }

  get remainingUsd(): number {
    const own = Math.max(0, this.capUsd - this.spentUsd);
    return this.run ? Math.min(own, Math.max(0, this.run.capUsd - this.run.spentUsd())) : own;
  }

  get exhausted(): boolean {
    return this.remainingUsd <= 0;
  }

  charge(entry: LedgerEntry): void {
    this.entries.push(entry);
    this.run?.chargeUsd(entry.costUsd, `harness ${entry.model}: ${entry.note}`);
    this.onCharge?.(entry.costUsd, `harness ${entry.model}: ${entry.note}`);
  }

  // For sources that report a running total (Agent SDK results): charges only the increase, minus
  // `liveUsd`, the part of it already charged call by call. A live estimate above the total stays charged.
  chargeCumulative(
    key: string,
    totalUsd: number,
    entry: Omit<LedgerEntry, 'costUsd'>,
    liveUsd = 0,
  ): void {
    const previous = this.cumulative.get(key) ?? 0;
    const delta = (totalUsd >= previous ? totalUsd - previous : totalUsd) - liveUsd;
    this.cumulative.set(key, totalUsd);
    if (delta > 0) this.charge({ ...entry, costUsd: delta });
  }

  // Call before every model call.
  assertCanSpend(): void {
    if (this.exhausted) {
      const run =
        this.run && this.run.spentUsd() >= this.run.capUsd
          ? `; the run's budget of $${this.run.capUsd.toFixed(2)} is used`
          : '';
      throw new BudgetExceededError(
        `AI budget of $${this.capUsd.toFixed(2)} used ($${this.spentUsd.toFixed(4)} spent)${run}`,
      );
    }
  }
}

// The cap for a run, from REFIT_AI_BUDGET_USD. Without it the run refuses to spend.
export function budgetFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return budgetCapFromEnv(env);
}
