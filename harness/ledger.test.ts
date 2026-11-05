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
    // Reads: $0.10/M on Sonnet 5.5, $0.20/M on Opus 5.5.
    const reads = { cache_read_input_tokens: 1_000_000 };
    expect(usageCostUsd('claude-sonnet-5-5', reads)).toBeCloseTo(0.1);
    expect(usageCostUsd('claude-opus-5-5', reads)).toBeCloseTo(0.2);
    // Haiku 5.5 pays the long rate once the prompt, cache reads included, passes 100k tokens.
    expect(usageCostUsd('claude-haiku-5-5', { input_tokens: 90_000 })).toBeCloseTo(0.009);
    expect(
      usageCostUsd('claude-haiku-5-5', { input_tokens: 90_000, cache_read_input_tokens: 20_000 }),
    ).toBeCloseTo(0.046);
    // An unknown model is priced as Opus 5.5 ($4/M input), so a live charge never undercounts.
    expect(usageCostUsd('some-new-model', { input_tokens: 1_000_000 })).toBeCloseTo(4);
  });
});
