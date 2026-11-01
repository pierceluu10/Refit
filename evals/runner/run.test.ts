import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MigrationTask, ProviderChange, RunRecord } from '../../shared/types.ts';
import type { DevSet } from '../sets/index.ts';
import { BudgetExceededError, BudgetLedger } from './budget.ts';
import { planMatrix } from './cli.ts';
import { ConfigError, parseFlags, parseRunConfig } from './config.ts';
import { judgeAttempt, runSet } from './run.ts';
import type { Pipeline, PipelineFactory } from './types.ts';

const change: ProviderChange = {
  provider: 'stripe',
  id: 'c1',
  kind: 'api-version',
  title: 'example change',
  source: { url: 'https://example.com', quote: 'example' },
  affects: {},
};

const set: DevSet = {
  name: 'test-set',
  provider: 'stripe',
  kind: 'dev',
  source: { path: 'x', commit: 'y', blob: 'z' },
  repos: ['a/one', 'b/two', 'c/three'].map((repo) => ({ repo, commit: '0'.repeat(40) })),
};

const record = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  taskId: 't',
  outcome: 'verified',
  diff: '--- a/x\n+++ b/x\n-old\n+new',
  checks: [],
  costUsd: 0.5,
  transcriptPath: 'mem://t',
  ...overrides,
});

function factoryWith(overrides: Partial<Pipeline> = {}, taskCount = 1): PipelineFactory {
  return ({ entry }) => ({
    checkout: async () => ({ repoDir: '/nonexistent', cleanup: async () => undefined }),
    inventory: async () => [],
    watch: async () => [change],
    match: async () => ({
      reasoning: 'example',
      tasks: Array.from({ length: taskCount }, (_, index): MigrationTask => ({
        id: `${entry.repo}#${index}`,
        repo: entry.repo,
        change,
        usages: [],
        priority: index,
      })),
    }),
    runTask: async (task) => record({ taskId: task.id }),
    ...overrides,
  });
}

const tmp = () => mkdtempSync(join(tmpdir(), 'aptitude-run-test-'));

describe('run config', () => {
  it('refuses to start without an explicit dollar cap', () => {
    expect(() => parseRunConfig(parseFlags(['--set', 's', '--concurrency', '2']))).toThrow(
      /--budget-usd is required/,
    );
    for (const bad of ['0', '-1', 'abc', 'Infinity']) {
      expect(() =>
        parseRunConfig(parseFlags(['--set', 's', '--concurrency', '2', '--budget-usd', bad])),
      ).toThrow(ConfigError);
    }
  });

  it('refuses to start without explicit concurrency', () => {
    expect(() => parseRunConfig(parseFlags(['--set', 's', '--budget-usd', '5']))).toThrow(
      /--concurrency is required/,
    );
    expect(() =>
      parseRunConfig(parseFlags(['--set', 's', '--budget-usd', '5', '--concurrency', '1.5'])),
    ).toThrow(ConfigError);
  });

  it('parses a full config', () => {
    expect(
      parseRunConfig(
        parseFlags(['--set', 's', '--budget-usd=2.5', '--concurrency', '3', '--shard', '4']),
      ),
    ).toEqual({ set: 's', budgetUsd: 2.5, concurrency: 3, shard: 4, outDir: 'evals/results' });
  });

  it('splits a total cap across one shard per repo', () => {
    const plan = planMatrix('stripe-dev-30', 3);
    expect(plan.shards).toHaveLength(30);
    expect(plan.shardBudgetUsd).toBeCloseTo(0.1);
    expect(() => planMatrix('stripe-dev-30', Number.NaN)).toThrow(ConfigError);
  });
});

describe('budget ledger', () => {
  it('refuses a missing or zero cap', () => {
    expect(() => new BudgetLedger(0)).toThrow();
    expect(() => new BudgetLedger(Number.NaN)).toThrow();
  });

  it('throws once spend passes the cap', () => {
    const ledger = new BudgetLedger(1);
    ledger.charge(0.6, 'a');
    expect(() => ledger.charge(0.6, 'b')).toThrow(BudgetExceededError);
    expect(ledger.exhausted()).toBe(true);
  });
});

describe('judgeAttempt', () => {
  it('counts a diff or a not-affected verdict as an attempt', () => {
    expect(judgeAttempt(record()).attempted).toBe(true);
    expect(judgeAttempt(record({ outcome: 'needs-review' })).attempted).toBe(true);
    expect(judgeAttempt(record({ outcome: 'not-affected', diff: '' })).attempted).toBe(true);
  });

  it('flags an empty needs-review or failed as a bug', () => {
    expect(judgeAttempt(record({ outcome: 'needs-review', diff: '' }))).toEqual({
      attempted: false,
      reason: 'outcome needs-review with an empty diff',
    });
    expect(judgeAttempt(record({ outcome: 'failed', diff: '  ' })).attempted).toBe(false);
  });
});

describe('runSet', () => {
  it('runs every repo with the given concurrency and writes one file each', async () => {
    let running = 0;
    let peak = 0;
    const factory = factoryWith({
      runTask: async (task) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((done) => setTimeout(done, 5));
        running -= 1;
        return record({ taskId: task.id, costUsd: 0.1 });
      },
    });
    const { results, ledger } = await runSet(
      { set: set.name, budgetUsd: 10, concurrency: 2, outDir: tmp() },
      set,
      factory,
    );
    expect(results.map((result) => result.repo)).toEqual(['a/one', 'b/two', 'c/three']);
    expect(peak).toBe(2);
    expect(ledger.spentUsd).toBeCloseTo(0.3);
    expect(results.every((result) => result.costUsd > 0)).toBe(true);
  });

  it('runs only the requested shard', async () => {
    const { results } = await runSet(
      { set: set.name, budgetUsd: 10, concurrency: 4, shard: 1, outDir: tmp() },
      set,
      factoryWith(),
    );
    expect(results.map((result) => result.repo)).toEqual(['b/two']);
  });

  it('records a repo with no tasks as not-affected', async () => {
    const { results } = await runSet(
      { set: set.name, budgetUsd: 10, concurrency: 1, shard: 0, outDir: tmp() },
      set,
      factoryWith({ match: async () => ({ tasks: [], reasoning: 'nothing touches it' }) }),
    );
    expect(results[0]?.verdict).toBe('not-affected');
    expect(results[0]?.matchReasoning).toBe('nothing touches it');
  });

  it('records a throwing runTask as an unattempted task, not a silent stop', async () => {
    const { results } = await runSet(
      { set: set.name, budgetUsd: 10, concurrency: 1, shard: 0, outDir: tmp() },
      set,
      factoryWith(
        {
          runTask: async (task) => {
            if (task.id.endsWith('#1')) throw new Error('boom');
            return record({ taskId: task.id });
          },
        },
        2,
      ),
    );
    const tasks = results[0]?.tasks ?? [];
    expect(tasks).toHaveLength(2);
    expect(tasks.find((task) => task.taskId.endsWith('#1'))?.noAttemptReason).toMatch(/boom/);
    expect(tasks.find((task) => task.taskId.endsWith('#0'))?.attempted).toBe(true);
  });

  it('stops starting work at the cap and marks the rest unrun', async () => {
    const { results } = await runSet(
      { set: set.name, budgetUsd: 0.75, concurrency: 1, outDir: tmp() },
      set,
      factoryWith({}, 2),
    );
    const [first, second, third] = results;
    expect(first?.tasks.map((task) => task.unrun ?? 'ran')).toEqual(['ran', 'ran']);
    expect(first?.error).toMatch(/cap/);
    expect(second?.verdict).toBe('unrun');
    expect(third?.verdict).toBe('unrun');
  });

  it('keeps a reviewer failure out of the grade', async () => {
    const { results } = await runSet(
      { set: set.name, budgetUsd: 10, concurrency: 1, shard: 0, outDir: tmp() },
      set,
      factoryWith({
        review: async () => {
          throw new Error('model down');
        },
      }),
    );
    const task = results[0]?.tasks[0];
    expect(task?.record?.outcome).toBe('verified');
    expect(task?.review?.opinion).toBe('unavailable');
  });
});
