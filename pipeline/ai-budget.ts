import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import { readState, withStateLock, writeState } from './state-files.ts';

const NANO_USD_PER_USD = 1_000_000_000;
const TOKENS_PER_MILLION = 1_000_000;
const DEFAULT_BUDGET_USD = 1;
const MAX_BUDGET_USD = 1000;
// Standard short-context text-token prices per million, from official OpenAI documentation
// (gpt-5.4-mini verified 2026-10-12, gpt-5.6-luna 2026-10-15, gpt-5.6-terra and gpt-5.6-sol 2026-10-21, gpt-6.1-sol 2026-10-24 at
// https://developers.openai.com/api/docs/pricing). OpenAI bills cache writes as input.
const MODEL_PRICES: Record<string, AiPrices> = {
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, cacheWrite: 0.75, output: 4.5 },
  'gpt-5.6-luna': { input: 0.2, cachedInput: 0.02, cacheWrite: 0.2, output: 1.2 },
  'gpt-5.6-terra': { input: 2, cachedInput: 0.2, cacheWrite: 2, output: 12 },
  'gpt-5.6-sol': { input: 4, cachedInput: 0.4, cacheWrite: 4, output: 20 },
  'gpt-6.1-sol': { input: 2, cachedInput: 0.1, cacheWrite: 2, output: 10 },
  // Claude prices from Anthropic's pricing page (platform.claude.com/docs/en/about-claude/pricing,
  // as cached 2026-10-06); a five-minute cache write costs 1.25 times input.
  'claude-sonnet-5-5': { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 },
  'claude-opus-5-5': { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 20 },
};
// Responses report a dated snapshot of the configured model, such as gpt-5.4-mini-2026-03-17.
const SNAPSHOT = /-\d{4}-\d{2}-\d{2}$/;

function builtInPrices(model: string): AiPrices | undefined {
  return MODEL_PRICES[model.replace(SNAPSHOT, '')];
}

interface AiPrices {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
}

export interface AiUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}
// Stores ledger state with exclusive access: `change` receives the current state, and its result
// is saved atomically. A thrown error saves nothing.
export interface AiLedger {
  update(
    change: (state: Record<string, unknown> | undefined) => Record<string, unknown>,
  ): Promise<void>;
}
export interface AiBudget {
  directory: string;
  limitUsd: number;
  prices?: AiPrices;
  // Replaces budget.json under directory, for example with one PostgreSQL row per installation.
  ledger?: AiLedger;
  // A second allowance every request also reserves and settles against, such as the hosted
  // worker's cap across all installations.
  parent?: AiBudget;
}

function fileLedger(directory: string): AiLedger {
  const path = join(directory, 'budget.json');
  return {
    update: (change) =>
      withStateLock(directory, 'budget', async () =>
        writeState(path, change(await readState(path))),
      ),
  };
}
export interface AiOptions {
  // openai unless set; anthropic sends the same request to the Claude Messages API.
  provider?: 'openai' | 'anthropic';
  apiKey: string;
  model: string;
  budget?: AiBudget;
  // Responses API reasoning effort; the model's default (medium for gpt-6.1-sol) when unset.
  reasoningEffort?: string;
  // The stronger step a patch request retries once with when its first answer proposes no edit.
  escalation?: { model: string; reasoningEffort?: string };
}

export function aiBudgetLimit(value: string | undefined, name: string, fallback?: number) {
  const limitUsd = Number(value ?? fallback);
  if (!Number.isFinite(limitUsd) || limitUsd <= 0 || limitUsd > MAX_BUDGET_USD)
    throw new PipelineInputError(
      `${name} must be greater than zero and at most ${MAX_BUDGET_USD}.`,
    );
  return limitUsd;
}

export function aiBudgetConfiguration(environment: Record<string, string | undefined>): AiBudget {
  const limitUsd = aiBudgetLimit(
    environment.REFIT_AI_BUDGET_USD,
    'REFIT_AI_BUDGET_USD',
    DEFAULT_BUDGET_USD,
  );
  const values = [
    environment.REFIT_AI_INPUT_USD_PER_MILLION,
    environment.REFIT_AI_CACHED_INPUT_USD_PER_MILLION,
    environment.REFIT_AI_OUTPUT_USD_PER_MILLION,
    environment.REFIT_AI_CACHE_WRITE_USD_PER_MILLION,
  ];
  let prices: AiBudget['prices'];
  if (values.some((value) => value !== undefined)) {
    if (
      values.some(
        (value) =>
          value === undefined ||
          !value.trim() ||
          !Number.isFinite(Number(value)) ||
          Number(value) < 0,
      )
    )
      throw new PipelineInputError('Configure all four nonnegative AI token prices together.');
    prices = {
      input: Number(values[0]),
      cachedInput: Number(values[1]),
      output: Number(values[2]),
      cacheWrite: Number(values[3]),
    };
    if (prices.input <= 0 || prices.output <= 0 || prices.cachedInput > prices.input)
      throw new PipelineInputError(
        'AI input/output prices must be positive; cached input must not exceed input pricing.',
      );
  }
  return {
    directory: resolve(
      environment.REFIT_AI_BUDGET_DIRECTORY?.trim() || join(homedir(), '.refit', 'ai-budget'),
    ),
    limitUsd,
    ...(prices ? { prices } : {}),
  };
}

export function responseUsage(value: unknown): AiUsage | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) throw new PipelineInputError('OpenAI returned invalid usage accounting.');
  const inputTokens = value.input_tokens;
  const outputTokens = value.output_tokens;
  const cachedInputTokens = isObject(value.input_tokens_details)
    ? (value.input_tokens_details.cached_tokens ?? 0)
    : 0;
  const reasoningTokens = isObject(value.output_tokens_details)
    ? (value.output_tokens_details.reasoning_tokens ?? 0)
    : 0;
  const cacheWriteInputTokens = isObject(value.input_tokens_details)
    ? (value.input_tokens_details.cache_write_tokens ?? 0)
    : 0;
  if (
    ![inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens, reasoningTokens].every(
      (count) => Number.isSafeInteger(count) && Number(count) >= 0,
    ) ||
    Number(cachedInputTokens) + Number(cacheWriteInputTokens) > Number(inputTokens) ||
    Number(reasoningTokens) > Number(outputTokens)
  )
    throw new PipelineInputError('OpenAI returned inconsistent usage accounting.');
  return {
    inputTokens: Number(inputTokens),
    outputTokens: Number(outputTokens),
    cachedInputTokens: Number(cachedInputTokens),
    cacheWriteInputTokens: Number(cacheWriteInputTokens),
    reasoningTokens: Number(reasoningTokens),
  };
}

function usageCostNano(usage: AiUsage, prices: AiPrices) {
  return Math.ceil(
    (((usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens) * prices.input +
      usage.cachedInputTokens * prices.cachedInput +
      usage.cacheWriteInputTokens * prices.cacheWrite +
      usage.outputTokens * prices.output) *
      NANO_USD_PER_USD) /
      TOKENS_PER_MILLION,
  );
}

// The cost of usage reported outside Refit's own requests, such as a coding agent's run.
export function usageCostUsd(model: string, usage: AiUsage) {
  const prices = builtInPrices(model);
  if (!prices) throw new PipelineInputError(`No verified token prices for ${model}.`);
  return usageCostNano(usage, prices) / NANO_USD_PER_USD;
}

function pricesFor(model: string, budget: AiBudget) {
  const prices = budget.prices ?? builtInPrices(model);
  if (!prices)
    throw new PipelineInputError(
      'This model needs explicit token prices before a budgeted request.',
    );
  return prices;
}

// A stored ledger whose limit, spend and reservations are well formed, whatever its limit.
function intactLedger(value: Record<string, unknown>) {
  return (
    value.formatVersion === 1 &&
    Number.isSafeInteger(value.limitNano) &&
    Number(value.limitNano) > 0 &&
    Number.isSafeInteger(value.spentNano) &&
    Number(value.spentNano) >= 0 &&
    isObject(value.reservations) &&
    Object.values(value.reservations).every(
      (amount) => Number.isSafeInteger(amount) && Number(amount) >= 0,
    )
  );
}

export interface AiLedgerSummary {
  limitUsd: number;
  spentUsd: number;
  // Requests that reserved their maximum cost and have not settled, including ones that failed.
  reservedUsd: number;
  reservations: number;
}

// What a stored ledger has recorded.
export function summarizeAiLedger(value: Record<string, unknown>): AiLedgerSummary {
  if (!intactLedger(value))
    throw new PipelineInputError(
      'AI budget state is invalid. Inspect the ledger before starting a new budget.',
    );
  const reservations = Object.values(value.reservations as Record<string, number>);
  return {
    limitUsd: Number(value.limitNano) / NANO_USD_PER_USD,
    spentUsd: Number(value.spentNano) / NANO_USD_PER_USD,
    reservedUsd: reservations.reduce((sum, amount) => sum + amount, 0) / NANO_USD_PER_USD,
    reservations: reservations.length,
  };
}

// Moves a ledger to a new limit and keeps its recorded spend and open reservations, so raising or
// lowering a configured limit never forgets money already spent. A ledger nothing has used yet
// starts at the new limit.
export async function changeAiBudgetLimit(ledger: AiLedger, limitUsd: number) {
  let summary: AiLedgerSummary | undefined;
  await ledger.update((stored) => {
    if (stored) summarizeAiLedger(stored);
    const state = {
      formatVersion: 1,
      spentNano: 0,
      reservations: {},
      ...stored,
      limitNano: Math.floor(limitUsd * NANO_USD_PER_USD),
    };
    summary = summarizeAiLedger(state);
    return state;
  });
  return summary as AiLedgerSummary;
}

type AiSettlement = (
  usage: AiUsage | null,
  responseModel: string,
) => Promise<{ costUsd: number; spentUsd: number; limitUsd: number }>;

export async function reserveAiBudget(
  budget: AiBudget,
  model: string,
  inputTokens: number,
  maximumOutputTokens: number,
): Promise<AiSettlement> {
  const prices = pricesFor(model, budget);
  const limitNano = Math.floor(budget.limitUsd * NANO_USD_PER_USD);
  const maximumNano = Math.ceil(
    ((inputTokens * Math.max(prices.input, prices.cacheWrite) +
      maximumOutputTokens * prices.output) *
      NANO_USD_PER_USD) /
      TOKENS_PER_MILLION,
  );
  const ledger = budget.ledger ?? fileLedger(budget.directory);
  const id = randomUUID();
  const load = (
    value: Record<string, unknown> = {
      formatVersion: 1,
      limitNano,
      spentNano: 0,
      reservations: {},
    },
  ) => {
    if (!intactLedger(value) || value.limitNano !== limitNano)
      throw new PipelineInputError(
        'AI budget state is invalid or its configured limit changed. Inspect the ledger before starting a new budget.',
      );
    return {
      formatVersion: 1,
      limitNano,
      spentNano: Number(value.spentNano),
      reservations: value.reservations as Record<string, number>,
    };
  };
  await ledger.update((stored) => {
    const state = load(stored);
    const reserved = Object.values(state.reservations).reduce((sum, amount) => sum + amount, 0);
    if (state.spentNano + reserved + maximumNano > limitNano)
      throw new PipelineInputError(
        'AI budget exhausted: this request and its maximum output would exceed the remaining allowance.',
      );
    state.reservations[id] = maximumNano;
    return state;
  });
  let settleParent: AiSettlement | undefined;
  if (budget.parent)
    try {
      settleParent = await reserveAiBudget(budget.parent, model, inputTokens, maximumOutputTokens);
    } catch (error) {
      await ledger.update((stored) => {
        const state = load(stored);
        delete state.reservations[id];
        return state;
      });
      throw error;
    }
  const settle: AiSettlement = async (usage, responseModel) => {
    if (!usage)
      throw new PipelineInputError(
        'OpenAI usage is unavailable; the maximum request reservation remains charged against the budget.',
      );
    if (!budget.prices && builtInPrices(responseModel) !== prices)
      throw new PipelineInputError(
        'OpenAI returned an unpriced model or one priced differently from the configured model; the request reservation remains in the budget.',
      );
    const costNano = usageCostNano(usage, prices);
    let spentNano = 0;
    await ledger.update((stored) => {
      const state = load(stored);
      if (state.reservations[id] !== maximumNano)
        throw new PipelineInputError('AI budget reservation is missing or already settled.');
      delete state.reservations[id];
      state.spentNano += costNano;
      spentNano = state.spentNano;
      return state;
    });
    // Checked after saving, so overspend stays recorded.
    if (costNano > maximumNano || spentNano > limitNano)
      throw new PipelineInputError(
        'OpenAI usage exceeded the reserved allowance; recorded usage requires review before further requests.',
      );
    return {
      costUsd: costNano / NANO_USD_PER_USD,
      spentUsd: spentNano / NANO_USD_PER_USD,
      limitUsd: budget.limitUsd,
    };
  };
  return async (usage, responseModel) => {
    // Both ledgers record the usage even when one of them refuses it.
    const [own, parent] = await Promise.allSettled([
      settle(usage, responseModel),
      settleParent?.(usage, responseModel),
    ]);
    if (own.status === 'rejected') throw own.reason;
    if (parent.status === 'rejected') throw parent.reason;
    return own.value;
  };
}
