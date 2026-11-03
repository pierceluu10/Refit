// The run-level dollar cap: one of Refit's four hard limits. Every AI dollar the runner
// knows about goes through charge(); past the cap it throws and no new work starts.
import type { Meter } from './types.ts';

export class BudgetExceededError extends Error {
  /**
   * True when nothing more can start in this run, so no new repo starts either. False when only
   * this part was unaffordable (a task needs more of the cap than is left) and cheaper parts of
   * later repos may still fit.
   */
  readonly runOver: boolean;

  constructor(message: string, options: { runOver?: boolean } = {}) {
    super(message);
    this.name = 'BudgetExceededError';
    this.runOver = options.runOver ?? true;
  }
}

/** The parts of a repo's run that spend, as the cost breakdown names them. */
export const PARTS = ['inventory', 'watch', 'match', 'harness', 'review'] as const;
export type Part = (typeof PARTS)[number] | 'other';

/** Which part a meter label belongs to: 'task <id>' is the harness, 'review <id>' the reviewer. */
export function partOf(label: string): Part {
  const word = label.trim().split(/\s+/)[0] ?? '';
  if (word === 'task') return 'harness';
  return (PARTS as readonly string[]).includes(word) ? (word as Part) : 'other';
}

export class BudgetLedger {
  readonly capUsd: number;
  private spent = 0;
  private stoppedBecause?: string;
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
    return this.spent >= this.capUsd || this.stoppedBecause !== undefined;
  }

  /** Why the run stopped starting work before its cap was spent, if it did. */
  get stopReason(): string | undefined {
    return this.stoppedBecause;
  }

  /** Ends the run early: the real budget refused a part that every later repo needs too. */
  stop(reason: string): void {
    this.stoppedBecause ??= reason;
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

  /** A meter for one repo: charges this ledger and keeps the repo's own total and parts. */
  meter(prefix: string): Meter & { totalUsd: () => number; byPart: () => Record<string, number> } {
    let total = 0;
    const parts: Record<string, number> = {};
    return {
      charge: (usd, label) => {
        total += usd;
        const part = partOf(label);
        parts[part] = (parts[part] ?? 0) + usd;
        this.charge(usd, `${prefix}: ${label}`);
      },
      totalUsd: () => total,
      byPart: () => ({ ...parts }),
    };
  }
}
