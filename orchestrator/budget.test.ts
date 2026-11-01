import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { BudgetExceededError, costOf, createBudget, worstCaseUsd, type Hold } from './budget.ts';

const usage = (input: number, output: number) =>
  ({ input_tokens: input, output_tokens: output }) as Anthropic.Usage;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createBudget', () => {
  it('refuses to exist without a cap', () => {
    vi.stubEnv('APTITUDE_AI_BUDGET_USD', '');
    expect(() => createBudget()).toThrow(/APTITUDE_AI_BUDGET_USD/);
  });

  it('reads the cap from the environment', () => {
    vi.stubEnv('APTITUDE_AI_BUDGET_USD', '2');
    expect(createBudget().capUsd).toBe(2);
  });

  it('holds a part’s share while it runs and settles to what it spent', async () => {
    const budget = createBudget(5);
    const hold = await budget.reserve('a part', 3);
    expect(hold.usd).toBe(3);
    expect(budget.heldUsd()).toBe(3);
    expect(hold.settle(1.25)).toBe(1.25);
    expect(budget.spentUsd()).toBe(1.25);
    expect(budget.heldUsd()).toBe(0);
    // A second settle changes nothing.
    expect(hold.settle(3)).toBe(0);
    expect(budget.spentUsd()).toBe(1.25);
  });

  it('grants what is free, down to the minimum', async () => {
    const budget = createBudget(5);
    await budget.reserve('first', 4);
    expect((await budget.reserve('second', 3, 0.5)).usd).toBeCloseTo(1, 10);
  });

  it('waits while an open hold could free the minimum, then grants it', async () => {
    const budget = createBudget(5);
    const first = await budget.reserve('first', 4);
    let second: Hold | undefined;
    void budget.reserve('second', 3, 2).then((hold) => (second = hold));
    await tick();
    expect(second).toBeUndefined();

    first.settle(1);
    await tick();
    expect(second?.usd).toBe(3);
    expect(budget.spentUsd() + budget.heldUsd()).toBe(4);
  });

  it('refuses when no open hold could free the minimum', async () => {
    const budget = createBudget(5);
    (await budget.reserve('first', 4)).settle(4);
    await expect(budget.reserve('a task', 5, 2)).rejects.toThrow(
      /\$1\.00 of the \$5 cap left; a task needs \$2\.00/,
    );
  });

  it('refuses a waiter once the last open hold settles without freeing enough', async () => {
    const budget = createBudget(5);
    const first = await budget.reserve('first', 4);
    const waiting = budget.reserve('a task', 3, 2);
    first.settle(3.5);
    await expect(waiting).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('refuses at once a minimum more than the unspent rest of the cap, even with holds open', async () => {
    const budget = createBudget(5);
    (await budget.reserve('first', 2)).settle(2);
    await budget.reserve('still running', 1);
    // $3 is unspent and spending only grows, so $3.50 can never be free.
    await expect(budget.reserve('a task', 5, 3.5)).rejects.toThrow(/a task needs \$3\.50/);
  });

  it('lets a smaller part through while a larger one waits', async () => {
    const budget = createBudget(5);
    const first = await budget.reserve('first', 4);
    const large = budget.reserve('large', 3);
    expect((await budget.reserve('small', 1)).usd).toBeCloseTo(1, 10);
    first.settle(0);
    expect((await large).usd).toBe(3);
  });

  it('counts the whole hold when a part reports no usable cost', async () => {
    const budget = createBudget(5);
    (await budget.reserve('a part', 2)).settle(Number.NaN);
    expect(budget.spentUsd()).toBe(2);
  });

  it('never lets spend plus holds pass the cap with concurrent parts', async () => {
    const cap = 10;
    const budget = createBudget(cap);
    // Seeded, so a failure replays the same way.
    let seed = 7;
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    let worst = 0;
    let open = 0;
    let peak = 0;
    const check = () => {
      worst = Math.max(worst, budget.spentUsd() + budget.heldUsd());
      peak = Math.max(peak, open);
    };

    const part = async (i: number) => {
      const maxUsd = 0.5 + random() * 4;
      const hold = await budget.reserve(`part ${i}`, maxUsd, maxUsd * random());
      open++;
      check();
      await new Promise((resolve) => setTimeout(resolve, random() * 5));
      open--;
      // A part spends at most its hold; many spend far less.
      hold.settle(hold.usd * random());
      check();
      return 'ran';
    };
    const outcomes = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        part(i).catch((error: unknown) => {
          expect(error).toBeInstanceOf(BudgetExceededError);
          return 'refused';
        }),
      ),
    );

    expect(worst).toBeLessThanOrEqual(cap + 1e-9);
    expect(budget.spentUsd()).toBeLessThanOrEqual(cap + 1e-9);
    expect(budget.heldUsd()).toBe(0);
    expect(peak).toBeGreaterThan(1);
    expect(outcomes).toContain('ran');
    expect(outcomes).toContain('refused');
  });
});

describe('pricing', () => {
  it('prices actual usage at the model price', () => {
    // 100k input at $4/M = $0.40, 10k output at $20/M = $0.20.
    expect(costOf('claude-opus-5-5', usage(100_000, 10_000))).toBeCloseTo(0.6);
  });

  it('prices the worst case as every input token plus a full max_tokens of output', () => {
    expect(worstCaseUsd('claude-opus-5-5', 25_000, 10_000)).toBeCloseTo(0.3);
  });

  it('refuses to price an unknown model', () => {
    expect(() => worstCaseUsd('mystery-model', 1, 1)).toThrow(/No price/);
    expect(() => costOf('mystery-model', usage(1, 1))).toThrow(/No price/);
  });
});
