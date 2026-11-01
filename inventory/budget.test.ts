import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BUDGET_ENV,
  BudgetConfigError,
  BudgetExceededError,
  BudgetLedger,
  SPEND_LOG_ENV,
} from './budget.ts';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'budget-test-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('BudgetLedger', () => {
  it('refuses to spend when no cap is configured', async () => {
    await expect(BudgetLedger.fromEnv({})).rejects.toBeInstanceOf(BudgetConfigError);
    await expect(BudgetLedger.fromEnv({ [BUDGET_ENV]: ' ' })).rejects.toBeInstanceOf(
      BudgetConfigError,
    );
    await expect(BudgetLedger.fromEnv({ [BUDGET_ENV]: 'lots' })).rejects.toBeInstanceOf(
      BudgetConfigError,
    );
  });

  it('fails closed when the next call would cross the cap', () => {
    const ledger = new BudgetLedger({ capUsd: 1, spentUsd: 0.96 });
    expect(() => ledger.assertCanSpend(0.04)).not.toThrow();
    expect(() => ledger.assertCanSpend(0.05)).toThrow(BudgetExceededError);
  });

  it('appends each spend with a running total and resumes from the log', async () => {
    const logPath = path.join(directory, 'nested', 'spend.jsonl');
    const ledger = await BudgetLedger.fromEnv({ [BUDGET_ENV]: '6', [SPEND_LOG_ENV]: logPath });
    await ledger.record({ repo: 'a/b', model: 'claude-sonnet-5-5', costUsd: 0.25 });
    await ledger.record({ repo: 'a/b', model: 'claude-haiku-5-5', costUsd: 0.05 });
    const lines = (await readFile(logPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    console.log(lines);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ repo: 'a/b', model: 'claude-haiku-5-5', costUsd: 0.05 });
    expect(lines[1].cumulativeUsd).toBeCloseTo(0.3);
    expect(typeof lines[0].ts).toBe('string');

    const other = await BudgetLedger.open({ capUsd: 6, logPath });
    await ledger.record({ repo: 'c/d', model: 'claude-sonnet-5-5', costUsd: 0 });
    expect(other.spentUsd).toBeCloseTo(0.3);
    await other.record({ repo: 'c/d', model: 'claude-sonnet-5-5', costUsd: 0.1 });
    await ledger.record({ repo: 'a/b', model: 'claude-sonnet-5-5', costUsd: 0 });
    expect(ledger.spentUsd).toBeCloseTo(0.4);
    await writeFile(
      logPath,
      (await readFile(logPath, 'utf8')).split('\n').slice(0, 2).join('\n') + '\n',
    );

    const resumed = await BudgetLedger.open({ capUsd: 0.4, logPath });
    expect(resumed.spentUsd).toBeCloseTo(0.3);
    expect(() => resumed.assertCanSpend(0.11)).toThrow(BudgetExceededError);
  });

  it('starts from zero when the log does not exist yet and rejects a corrupt log', async () => {
    expect(
      (await BudgetLedger.open({ capUsd: 1, logPath: path.join(directory, 'none') })).spentUsd,
    ).toBe(0);
    const corrupt = path.join(directory, 'corrupt.jsonl');
    await writeFile(corrupt, 'not json\n');
    await expect(BudgetLedger.open({ capUsd: 1, logPath: corrupt })).rejects.toThrow(SyntaxError);
  });
});
