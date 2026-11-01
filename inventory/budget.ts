// The run-level dollar cap, one of Aptitude's four hard limits. Every real model run asks the
// ledger first and reports its cost back; the ledger refuses a run that could cross the cap.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const BUDGET_ENV = 'APTITUDE_AI_BUDGET_USD';
export const SPEND_LOG_ENV = 'APTITUDE_SPEND_LOG';

export class BudgetExceededError extends Error {
  constructor(requestedUsd: number, remainingUsd: number) {
    super(
      `AI budget exhausted: a run needs up to $${requestedUsd.toFixed(4)} but only ` +
        `$${remainingUsd.toFixed(4)} remains under ${BUDGET_ENV}`,
    );
    this.name = 'BudgetExceededError';
  }
}

export class BudgetConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetConfigError';
  }
}

export type SpendEntry = {
  ts: string;
  repo: string;
  model: string;
  costUsd: number;
  cumulativeUsd: number;
};

export class BudgetLedger {
  readonly capUsd: number;
  readonly logPath: string | undefined;
  spentUsd: number;

  constructor(options: { capUsd: number; spentUsd?: number; logPath?: string }) {
    if (!Number.isFinite(options.capUsd) || options.capUsd < 0) {
      throw new BudgetConfigError(
        `Budget cap must be a non-negative number, got ${options.capUsd}`,
      );
    }
    this.capUsd = options.capUsd;
    this.spentUsd = options.spentUsd ?? 0;
    this.logPath = options.logPath;
  }

  // Resumes from an existing spend log so the cap holds across separate processes.
  static async open(options: { capUsd: number; logPath?: string }): Promise<BudgetLedger> {
    const spentUsd = options.logPath ? await readCumulative(options.logPath) : 0;
    return new BudgetLedger({ ...options, spentUsd });
  }

  // Fails closed: with no explicit cap there is no spending.
  static async fromEnv(env: NodeJS.ProcessEnv = process.env): Promise<BudgetLedger> {
    const raw = env[BUDGET_ENV];
    if (raw === undefined || raw.trim() === '') {
      throw new BudgetConfigError(`${BUDGET_ENV} is not set; refusing to spend without a cap`);
    }
    return BudgetLedger.open({ capUsd: Number(raw), logPath: env[SPEND_LOG_ENV] });
  }

  get remainingUsd(): number {
    return Math.max(0, this.capUsd - this.spentUsd);
  }

  assertCanSpend(requestedUsd: number): void {
    if (this.spentUsd + requestedUsd > this.capUsd) {
      throw new BudgetExceededError(requestedUsd, this.remainingUsd);
    }
  }

  async record(spend: { repo: string; model: string; costUsd: number }): Promise<SpendEntry> {
    this.spentUsd += spend.costUsd;
    const entry: SpendEntry = {
      ts: new Date().toISOString(),
      ...spend,
      cumulativeUsd: this.spentUsd,
    };
    if (this.logPath) {
      await mkdir(path.dirname(this.logPath), { recursive: true });
      await appendFile(this.logPath, `${JSON.stringify(entry)}\n`);
    }
    return entry;
  }
}

async function readCumulative(logPath: string): Promise<number> {
  let text: string;
  try {
    text = await readFile(logPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .reduce((total, line) => total + (JSON.parse(line) as SpendEntry).costUsd, 0);
}
