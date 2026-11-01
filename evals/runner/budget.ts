// The run-level dollar cap: one of Aptitude's four hard limits. Every AI dollar the runner
// knows about goes through charge(); past the cap it throws and no new work starts.
import type { Meter } from './types.ts';

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

export class BudgetLedger {
  readonly capUsd: number;
  private spent = 0;
  readonly entries: { label: string; usd: number }[] = [];

  constructor(capUsd: number) {
    if (!Number.isFinite(capUsd) || capUsd <= 0) {
      throw new Error(`a run needs an explicit dollar cap above zero (got ${capUsd})`);
    }
    this.capUsd = capUsd;
  }

  get spentUsd(): number {
    return this.spent;
  }

  remainingUsd(): number {
    return Math.max(0, this.capUsd - this.spent);
  }

  exhausted(): boolean {
    return this.spent >= this.capUsd;
  }

  charge(usd: number, label: string): void {
    if (!Number.isFinite(usd) || usd < 0) throw new Error(`invalid charge ${usd} for ${label}`);
    this.spent += usd;
    this.entries.push({ label, usd });
    if (this.spent > this.capUsd) {
      throw new BudgetExceededError(
        `dollar cap $${this.capUsd.toFixed(2)} exceeded at $${this.spent.toFixed(4)} (${label})`,
      );
    }
  }

  /** A meter for one repo: charges this ledger and keeps the repo's own total. */
  meter(prefix: string): Meter & { totalUsd: () => number } {
    let total = 0;
    return {
      charge: (usd, label) => {
        total += usd;
        this.charge(usd, `${prefix}: ${label}`);
      },
      totalUsd: () => total,
    };
  }
}
