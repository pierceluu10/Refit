// Hard limit 2: a run-level dollar cap. Every model call is charged here.

export class BudgetExceededError extends Error {}

export type LedgerEntry = { model: string; costUsd: number; note: string };

export class BudgetLedger {
  readonly entries: LedgerEntry[] = [];
  readonly capUsd: number;
  private readonly cumulative = new Map<string, number>();

  constructor(capUsd: number) {
    this.capUsd = capUsd;
    if (!Number.isFinite(capUsd) || capUsd <= 0) {
      throw new Error(`Budget cap must be a positive number of dollars, got ${capUsd}`);
    }
  }

  get spentUsd(): number {
    return this.entries.reduce((sum, entry) => sum + entry.costUsd, 0);
  }

  get remainingUsd(): number {
    return Math.max(0, this.capUsd - this.spentUsd);
  }

  get exhausted(): boolean {
    return this.spentUsd >= this.capUsd;
  }

  charge(entry: LedgerEntry): void {
    this.entries.push(entry);
  }

  // For sources that report a running total (Agent SDK results): charges only the increase.
  chargeCumulative(key: string, totalUsd: number, entry: Omit<LedgerEntry, 'costUsd'>): void {
    const previous = this.cumulative.get(key) ?? 0;
    const delta = totalUsd >= previous ? totalUsd - previous : totalUsd;
    this.cumulative.set(key, totalUsd);
    if (delta > 0) this.charge({ ...entry, costUsd: delta });
  }

  // Call before every model call.
  assertCanSpend(): void {
    if (this.exhausted) {
      throw new BudgetExceededError(
        `AI budget of $${this.capUsd.toFixed(2)} used ($${this.spentUsd.toFixed(4)} spent)`,
      );
    }
  }
}

export function budgetFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.APTITUDE_AI_BUDGET_USD;
  if (!raw) throw new Error('Set APTITUDE_AI_BUDGET_USD to the dollar cap for this run');
  return Number(raw);
}
