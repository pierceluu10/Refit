import { describe, expect, it } from 'vitest';
import { budgetFromEnv, usageCostUsd } from './ledger.ts';

describe('budgetFromEnv', () => {
  it('takes only a positive, finite dollar cap', () => {
    expect(budgetFromEnv({ APTITUDE_AI_BUDGET_USD: '6' })).toBe(6);
    for (const raw of [undefined, '', '0', '-1', 'Infinity', 'six']) {
      expect(() => budgetFromEnv({ APTITUDE_AI_BUDGET_USD: raw }), String(raw)).toThrow(
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
    // An unknown model is priced as Opus 5.5 ($4/M input), so a live charge never undercounts.
    expect(usageCostUsd('some-new-model', { input_tokens: 1_000_000 })).toBeCloseTo(4);
  });
});
