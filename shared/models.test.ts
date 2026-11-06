import { afterEach, describe, expect, it } from 'vitest';
import {
  BudgetExceededError,
  MODEL_PRICES,
  MODEL_STEPS,
  MODEL_TABLE,
  UnknownModelError,
  createModel,
  createRunBudget,
  priceOf,
  resetRunBudget,
  resolveModelId,
  runBudget,
  usageCostUsd,
  worstCaseUsd,
} from './models.ts';

afterEach(() => resetRunBudget());

describe('the model table', () => {
  it('gives every step a priced Claude model', () => {
    for (const step of MODEL_STEPS) {
      const row = MODEL_TABLE[step];
      expect(row.model, step).toMatch(/^claude-/);
      expect(MODEL_PRICES[row.model], step).toBeDefined();
      if (row.escalation) expect(MODEL_PRICES[row.escalation], step).toBeDefined();
    }
  });

  it('resolves snapshots, context suffixes and platform prefixes to their family', () => {
    expect(resolveModelId('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(resolveModelId('claude-opus-5-5[1m]')).toBe('claude-opus-5-5');
    expect(resolveModelId('claude-opus-5-20260101')).toBe('claude-opus-5');
    expect(resolveModelId('anthropic.claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
    expect(resolveModelId('claude-opus-5-5x')).toBeUndefined();
    expect(resolveModelId('gpt-4o')).toBeUndefined();
  });

  it('throws on an unknown model instead of defaulting to some price', () => {
    expect(() => priceOf('gpt-4o')).toThrow(UnknownModelError);
  });

  it('prices tokens, cache and web search', () => {
    // Opus 5.5: $4 in, $20 out, $0.20 cache read per million.
    const usd = usageCostUsd('claude-opus-5-5', {
      input_tokens: 1_000_000,
      output_tokens: 100_000,
      cache_read_input_tokens: 1_000_000,
      server_tool_use: { web_search_requests: 3 },
    });
    expect(usd).toBeCloseTo(4 + 2 + 0.2 + 0.03);
    expect(worstCaseUsd('claude-sonnet-5-5', 10_000, 1_000)).toBeCloseTo(0.03);
  });
});

describe('createModel', () => {
  it('returns the step model from the table with its escalation', () => {
    const harness = createModel('harness', { env: {} });
    expect(harness.id).toBe('claude-sonnet-5-5');
    expect(harness.escalation).toBe('claude-opus-5-5');
    expect(createModel('match', { env: {} }).id).toBe('claude-opus-5-5');
  });

  it('lets a step be swapped to another priced model, and only a priced one', () => {
    expect(createModel('watch', { env: { REFIT_MODEL_WATCH: 'claude-haiku-5-5' } }).id).toBe(
      'claude-haiku-5-5',
    );
    expect(() => createModel('watch', { env: { REFIT_MODEL_WATCH: 'mystery-model' } })).toThrow(
      UnknownModelError,
    );
  });

  it('refuses to spend when REFIT_AI_BUDGET_USD is missing', () => {
    const model = createModel('inventory', { env: {} });
    expect(() => model.assertCanSpend()).toThrow(/REFIT_AI_BUDGET_USD/);
    expect(() => model.charge({ input_tokens: 1 })).toThrow(/REFIT_AI_BUDGET_USD/);
  });

  it('charges every step to one process-wide budget, so the cap holds across parts', () => {
    const env = { REFIT_AI_BUDGET_USD: '1' };
    const inventory = createModel('inventory', { env });
    const match = createModel('match', { env });
    inventory.charge({ input_tokens: 200_000 }); // Sonnet: $0.40
    match.charge({ output_tokens: 25_000 }); // Opus: $0.50
    expect(runBudget(env).spentUsd()).toBeCloseTo(0.9);
    expect(() => match.assertCanSpend(0.2)).toThrow(BudgetExceededError);
    match.assertCanSpend(0.05);
    inventory.chargeUsd(0.2, 'web search');
    expect(() => inventory.assertCanSpend()).toThrow(/at step inventory/);
  });

  it('charges an explicit budget, such as the orchestrator run budget', () => {
    const budget = createRunBudget(2);
    const reviewer = createModel('reviewer', { budget, env: {} });
    const usd = reviewer.charge({ input_tokens: 100_000 }, 'review', 'claude-sonnet-5-5');
    expect(usd).toBeCloseTo(0.2);
    expect(budget.entries).toEqual([
      { usd: expect.closeTo(0.2), label: 'reviewer claude-sonnet-5-5: review' },
    ]);
  });
});
