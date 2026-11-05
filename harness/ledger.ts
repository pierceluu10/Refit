// Hard limit 2: a run-level dollar cap. Every model call is charged here.
import { MODEL_PRICES, WEB_SEARCH_USD, ratesFor } from '../shared/prices.ts';

export class BudgetExceededError extends Error {}

export type LedgerEntry = { model: string; costUsd: number; note: string };

// Called with every charge as it happens (HarnessDeps.chargeRun), so the run budget sees the spend
// even if the harness throws later. It must not throw: it runs inside the model stream, where a
// throw ends the query as an error. The harness's own ledger already enforces its cap.
export type ChargeRun = (usd: number, label: string) => void;

// The fields both a message_start usage and a message_delta usage carry; null means not reported.
export type TokenUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: { ephemeral_1h_input_tokens?: number | null } | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
};

export function usageCostUsd(model: string, usage: TokenUsage): number {
  // An unknown model is priced as Opus, so a live charge does not undercount; the SDK's total reconciles it.
  const id = Object.keys(MODEL_PRICES).find((known) => model.includes(known));
  const writes = usage.cache_creation_input_tokens ?? 0;
  const hourWrites = Math.min(writes, usage.cache_creation?.ephemeral_1h_input_tokens ?? 0);
  const reads = usage.cache_read_input_tokens ?? 0;
  const inputs = usage.input_tokens ?? 0;
  const rates = ratesFor(MODEL_PRICES[id ?? 'claude-opus-5-5'], inputs + writes + reads);
  const tokens =
    inputs * rates.input +
    (writes - hourWrites) * rates.cacheWrite +
    hourWrites * rates.cacheWriteHour +
    reads * rates.cacheRead +
    (usage.output_tokens ?? 0) * rates.output;
  return tokens / 1e6 + (usage.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD;
}

export class BudgetLedger {
  readonly entries: LedgerEntry[] = [];
  readonly capUsd: number;
  private readonly onCharge?: ChargeRun;
  private readonly cumulative = new Map<string, number>();

  constructor(capUsd: number, onCharge?: ChargeRun) {
    this.capUsd = capUsd;
    this.onCharge = onCharge;
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
      throw new BudgetExceededError(
        `AI budget of $${this.capUsd.toFixed(2)} used ($${this.spentUsd.toFixed(4)} spent)`,
      );
    }
  }
}

export function budgetFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.APTITUDE_AI_BUDGET_USD;
  const capUsd = Number(raw);
  if (!raw || !Number.isFinite(capUsd) || capUsd <= 0) {
    throw new Error('Set APTITUDE_AI_BUDGET_USD to a positive dollar cap for this run');
  }
  return capUsd;
}
