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
// (gpt-5.4-mini verified 2026-10-12, gpt-5.6-luna 2026-10-15, gpt-5.6-terra and gpt-5.6-sol 2026-10-21 at
// https://developers.openai.com/api/docs/pricing). OpenAI bills cache writes as input.
const MODEL_PRICES: Record<string, AiPrices> = {
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, cacheWrite: 0.75, output: 4.5 },
  'gpt-5.6-luna': { input: 0.2, cachedInput: 0.02, cacheWrite: 0.2, output: 1.2 },
  'gpt-5.6-terra': { input: 2, cachedInput: 0.2, cacheWrite: 2, output: 12 },
  'gpt-5.6-sol': { input: 4, cachedInput: 0.4, cacheWrite: 4, output: 20 },
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
  apiKey: string;
  model: string;
  budget?: AiBudget;
}

export function aiBudgetConfiguration(environment: Record<string, string | undefined>): AiBudget {
  const limitUsd = Number(environment.REFIT_AI_BUDGET_USD ?? DEFAULT_BUDGET_USD);
  if (!Number.isFinite(limitUsd) || limitUsd <= 0 || limitUsd > MAX_BUDGET_USD)
    throw new PipelineInputError(
      `REFIT_AI_BUDGET_USD must be greater than zero and at most ${MAX_BUDGET_USD}.`,
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

export async function reserveAiBudget(
  budget: AiBudget,
  model: string,
  inputTokens: number,
  maximumOutputTokens: number,
) {
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
    if (
      value.formatVersion !== 1 ||
      value.limitNano !== limitNano ||
      !Number.isSafeInteger(value.spentNano) ||
      Number(value.spentNano) < 0 ||
      !isObject(value.reservations) ||
      !Object.values(value.reservations).every(
        (amount) => Number.isSafeInteger(amount) && Number(amount) >= 0,
      )
    )
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
  return async (usage: AiUsage | null, responseModel: string) => {
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
}
