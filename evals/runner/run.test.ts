import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MigrationTask, ProviderChange, RunRecord } from '../../shared/types.ts';
import type { DevSet } from '../sets/index.ts';
import { BudgetExceededError, BudgetLedger, partOf } from './budget.ts';
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

  it('keeps one watcher read per provider for the watch job and splits the rest across shards', () => {
    const plan = planMatrix('stripe-dev-30', 106.5);
    expect(plan.shards).toHaveLength(30);
    expect(plan.watchBudgetUsd).toBeCloseTo(1.5);
    expect(plan.shardBudgetUsd).toBeCloseTo(3.5);
    expect(planMatrix('longtail-dev-20', 100).watchBudgetUsd).toBeCloseTo(1.5 * 15);
    expect(() => planMatrix('stripe-dev-30', Number.NaN)).toThrow(ConfigError);
  });

  it('refuses a plan whose shards could never afford a task', () => {
    expect(() => planMatrix('stripe-dev-30', 30)).toThrow(
      /leaves \$0\.95 for each of 30 shards, below the \$1 overshoot reserve a task needs free/,
    );
  });

  it('reads the watch cache flag for shards', () => {
    expect(
      parseRunConfig(
        parseFlags([
          '--set',
          's',
          '--budget-usd',
          '3',
          '--concurrency',
          '1',
          '--watch-cache',
          'wc',
        ]),
      ).watchCache,
    ).toBe('wc');
  });
});

describe('budget ledger', () => {
  it('refuses a missing or zero cap', () => {
    expect(() => new BudgetLedger(0)).toThrow();
    expect(() => new BudgetLedger(Number.NaN)).toThrow();
  });

  it('names the part each meter label belongs to', () => {
    expect(
      ['inventory', 'watch', 'match', 'task o/r:c1', 'review o/r:c1', 'misc'].map(partOf),
    ).toEqual(['inventory', 'watch', 'match', 'harness', 'review', 'other']);
  });

  it('stops early when told to, keeping the first reason', () => {
    const ledger = new BudgetLedger(5);
    ledger.stop('first');
    ledger.stop('second');
    expect(ledger.exhausted()).toBe(true);
    expect(ledger.stopReason).toBe('first');
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

  it('counts a task the run cannot afford as unrun, not as an attempt bug, and goes on', async () => {
    const started: string[] = [];
    const { results } = await runSet(
      { set: set.name, budgetUsd: 10, concurrency: 1, outDir: tmp() },
      set,
      factoryWith(
        {
          runTask: async (task) => {
            started.push(task.id);
            if (task.repo === 'a/one' && task.id.endsWith('#0')) return record({ taskId: task.id });
            throw new BudgetExceededError(
              '$1.00 of the $4 run cap left, below the $2 a task needs',
              {
                runOver: false,
              },
            );
          },
        },
        2,
      ),
    );
    const [first, second] = results;
    expect(first?.tasks.map((task) => task.unrun ?? 'ran')).toEqual(['ran', 'budget']);
    expect(first?.tasks[1]?.unrunReason).toMatch(/below the \$2 a task needs/);
    expect(first?.tasks[1]?.noAttemptReason).toBeUndefined();
    // The next repo still starts: its inventory and match may fit where a task did not.
    expect(second?.verdict).toBe('tasks');
    expect(second?.tasks.map((task) => task.unrun)).toEqual(['budget', 'budget']);
    // A repo's tasks start at once, so each one the cap can't afford is tried and reported unrun.
    expect([...started].sort()).toEqual([
      'a/one#0',
      'a/one#1',
      'b/two#0',
      'b/two#1',
      'c/three#0',
      'c/three#1',
    ]);
  });

  it('stops starting repos once the run budget refuses a part every repo needs', async () => {
    let checkouts = 0;
    const { results, ledger } = await runSet(
      { set: set.name, budgetUsd: 10, concurrency: 1, outDir: tmp() },
      set,
      factoryWith({
        checkout: async () => {
          checkouts += 1;
          return { repoDir: '/nonexistent', cleanup: async () => undefined };
        },
        inventory: async () => {
          throw new BudgetExceededError(
            'AI budget: $0.40 of the $4 cap left; the inventory needs $0.60',
          );
        },
      }),
    );
    expect(results.map((result) => result.verdict)).toEqual(['unrun', 'unrun', 'unrun']);
    expect(results[1]?.error).toMatch(/before this repo started: AI budget/);
    expect(checkouts).toBe(1);
    expect(ledger.stopReason).toMatch(/inventory needs/);
  });

  it('runs the most urgent task (priority 1) first', async () => {
    const order: number[] = [];
    await runSet(
      { set: set.name, budgetUsd: 10, concurrency: 1, shard: 0, outDir: tmp() },
      set,
      factoryWith({
        match: async () => ({
          reasoning: 'example',
          tasks: [3, 1, 2].map((priority) => ({
            id: `a/one#${priority}`,
            repo: 'a/one',
            change,
            usages: [],
            priority,
          })),
        }),
        runTask: async (task) => {
          order.push(task.priority);
          return record({ taskId: task.id });
        },
      }),
    );
    expect(order).toEqual([1, 2, 3]);
  });

  it('keeps each task’s change, the match agent’s reasoning and its call sites', async () => {
    const { results } = await runSet(
      { set: set.name, budgetUsd: 10, concurrency: 1, shard: 0, outDir: tmp() },
      set,
      factoryWith({
        match: async () => ({
          reasoning: 'example',
          tasks: [
            {
              id: 'a/one#0',
              repo: 'a/one',
              change,
              usages: [],
              priority: 1,
              notes: 'calls the removed field',
              callSites: [{ file: 'src/pay.ts', line: 12, why: 'sends old_name' }],
            } as MigrationTask,
          ],
        }),
      }),
    );
    expect(results[0]?.tasks[0]).toMatchObject({
      change,
      reasoning: 'calls the removed field',
      callSites: [{ file: 'src/pay.ts', line: 12, why: 'sends old_name' }],
    });
  });

  it('passes the inventory’s usages to the watcher', async () => {
    const usage = { repo: 'a/one', provider: 'stripe', via: 'sdk' as const, callSites: [] };
    let seen: unknown;
    await runSet(
      { set: set.name, budgetUsd: 10, concurrency: 1, shard: 0, outDir: tmp() },
      set,
      factoryWith({
        inventory: async () => [usage],
        watch: async (usages) => {
          seen = usages;
          return [change];
        },
      }),
    );
    expect(seen).toEqual([usage]);
  });

  it('splits each repo’s cost by part from the meter labels', async () => {
    const { results } = await runSet(
      { set: set.name, budgetUsd: 10, concurrency: 1, shard: 0, outDir: tmp() },
      set,
      (context) => ({
        ...factoryWith({ runTask: async (task) => record({ taskId: task.id, costUsd: 0.5 }) })(
          context,
        ),
        inventory: async () => {
          context.meter.charge(0.25, 'inventory');
          return [];
        },
        review: async ({ task, meter }) => {
          meter.charge(0.125, `review ${task.id}`);
          return {
            opinion: 'looks-right',
            summary: 'ok',
            concerns: [],
            costUsd: 0.125,
            model: 'fake',
          };
        },
      }),
    );
    expect(results[0]?.costByPart).toEqual({ inventory: 0.25, harness: 0.5, review: 0.125 });
    expect(results[0]?.costUsd).toBeCloseTo(0.875);
  });

  it('asks for no second opinion on an empty diff', async () => {
    let reviews = 0;
    const { results } = await runSet(
      { set: set.name, budgetUsd: 10, concurrency: 1, shard: 0, outDir: tmp() },
      set,
      factoryWith({
        runTask: async (task) => record({ taskId: task.id, outcome: 'not-affected', diff: '' }),
        review: async () => {
          reviews += 1;
          return { opinion: 'looks-right', summary: '', concerns: [], costUsd: 0, model: 'fake' };
        },
      }),
    );
    expect(reviews).toBe(0);
    expect(results[0]?.tasks[0]?.record?.outcome).toBe('not-affected');
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
