import { describe, expect, it } from 'vitest';
import { createRunBudget } from '../shared/models.ts';
import { BudgetExceededError, BudgetLedger, budgetFromEnv, usageCostUsd } from './ledger.ts';

describe('budgetFromEnv', () => {
  it('takes only a positive, finite dollar cap', () => {
    expect(budgetFromEnv({ REFIT_AI_BUDGET_USD: '6' })).toBe(6);
    for (const raw of [undefined, '', '0', '-1', 'Infinity', 'six']) {
      expect(() => budgetFromEnv({ REFIT_AI_BUDGET_USD: raw }), String(raw)).toThrow(
        /positive dollar cap/,
      );
    }
  });
});

describe('usageCostUsd', () => {
  it('prices 5-minute cache writes at 1.25x input and 1-hour ones at 2x', () => {
    // Sonnet 5.5: $2/M input, so 1M 5-minute writes cost $2.50 and 1M 1-hour writes $4.
    const usage = (hour: number) => ({
      cache_creation_input_tokens: 1_000_000,
      cache_creation: { ephemeral_1h_input_tokens: hour },
    });
    expect(usageCostUsd('claude-sonnet-5-5', usage(0))).toBeCloseTo(2.5);
    expect(usageCostUsd('claude-sonnet-5-5', usage(1_000_000))).toBeCloseTo(4);
  });

  it('reads prices from the model layer and never guesses at an unknown model', () => {
    expect(usageCostUsd('claude-haiku-5-5', { input_tokens: 1_000_000 })).toBeCloseTo(0.1);
    expect(() => usageCostUsd('some-new-model', { input_tokens: 1 })).toThrow(/shared\/models.ts/);
  });
});

describe('BudgetLedger with a run budget', () => {
  it('charges the run and refuses once the run cap is used, even with its own cap left', () => {
    const run = createRunBudget(1);
    const first = new BudgetLedger(5, undefined, run);
    first.charge({ model: 'claude-sonnet-5-5', costUsd: 0.75, note: 'task 1' });
    const second = new BudgetLedger(5, undefined, run);
    expect(second.remainingUsd).toBeCloseTo(0.25);
    second.charge({ model: 'claude-sonnet-5-5', costUsd: 0.3, note: 'task 2' });
    expect(run.spentUsd()).toBeCloseTo(1.05);
    expect(() => second.assertCanSpend()).toThrow(BudgetExceededError);
    expect(() => first.assertCanSpend()).toThrow(/run's budget/);
  });
});
