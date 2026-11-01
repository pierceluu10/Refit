import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { BudgetExceededError, createBudget } from './budget.ts';

const usage = (input: number, output: number) =>
  ({ input_tokens: input, output_tokens: output }) as Anthropic.Usage;

describe('createBudget', () => {
  it('refuses to exist without a cap', () => {
    vi.stubEnv('APTITUDE_AI_BUDGET_USD', '');
    expect(() => createBudget()).toThrow(/APTITUDE_AI_BUDGET_USD/);
  });

  it('reads the cap from the environment', () => {
    vi.stubEnv('APTITUDE_AI_BUDGET_USD', '2');
    expect(createBudget().capUsd).toBe(2);
  });

  it('charges actual usage at the model price', () => {
    const budget = createBudget(2);
    // 100k input at $4/M = $0.40, 10k output at $20/M = $0.20.
    expect(budget.charge('claude-opus-5-5', usage(100_000, 10_000))).toBeCloseTo(0.6);
    expect(budget.spentUsd()).toBeCloseTo(0.6);
  });

  it('blocks a call whose worst case would cross the cap', () => {
    const budget = createBudget(1);
    budget.charge('claude-opus-5-5', usage(100_000, 10_000));
    // $0.60 spent; $0.10 input + $0.20 output fits, $0.10 + $0.40 does not.
    expect(() => budget.reserve('claude-opus-5-5', 25_000, 10_000)).not.toThrow();
    expect(() => budget.reserve('claude-opus-5-5', 25_000, 20_000)).toThrow(BudgetExceededError);
  });

  it('refuses to price an unknown model', () => {
    expect(() => createBudget(1).reserve('mystery-model', 1, 1)).toThrow(/No price/);
  });
});
