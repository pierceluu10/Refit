import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RUN_CAP_USD } from '../inventory/agent.ts';
import { listProviderIds } from '../providers/core/registry.ts';
import type { MigrationTask, RunRecord } from '../shared/types.ts';
import { BudgetExceededError, createBudget } from './budget.ts';
import {
  anyWatcher,
  cachedChanges,
  createDeps,
  MEMORY_USD,
  MIN_TASK_USD,
  TASK_USD,
} from './deps.ts';
import { stubRunTask } from './stubs.ts';

// The any-provider watcher, offline: it spends $0.30 of the ledger it is given and finds one change.
// Its report says the read finished, unless a test sets `endedEarly`.
const watched = vi.hoisted(() => ({
  calls: [] as { provider: string; hints: unknown }[],
  endedEarly: false,
}));
vi.mock('../providers/core/any-watcher.ts', () => ({
  anyProviderWatcher:
    (
      provider: string,
      hints: unknown,
      {
        budget,
        onReport,
      }: {
        budget: { charge: (model: string, usage: object) => void };
        onReport?: (report: object) => void;
      },
    ) =>
    async () => {
      watched.calls.push({ provider, hints });
      // 100k input and 10k output tokens on Sonnet: $0.30.
      budget.charge('claude-sonnet-5-5', { inputTokens: 100_000, outputTokens: 10_000 });
      onReport?.({
        model: 'claude-sonnet-5-5',
        turns: 3,
        issues: watched.endedEarly ? [{ message: 'run ended early: budget' }] : [],
      });
      return [
        {
          provider,
          id: `${provider}:example-change`,
          kind: 'other',
          title: 'An illustrative change',
          source: { url: 'https://example.com/changelog', quote: '(illustrative)' },
          affects: {},
        },
      ];
    },
}));

// Each test may replace `run`; by default a harness run spends $0.75 and needs review.
const harness = vi.hoisted(() => ({
  caps: [] as (number | undefined)[],
  run: undefined as undefined | ((task: MigrationTask, budgetUsd: number) => Promise<RunRecord>),
}));

const ran = (task: MigrationTask, costUsd: number): RunRecord => ({
  taskId: task.id,
  outcome: 'needs-review',
  diff: '',
  checks: [],
  costUsd,
  transcriptPath: '',
});

vi.mock('../harness/index.ts', () => ({
  runTask: async (task: MigrationTask, _dir: string, deps: { budgetUsd: number }) => {
    harness.caps.push(deps.budgetUsd);
    return harness.run ? harness.run(task, deps.budgetUsd) : ran(task, 0.75);
  },
}));

// Each test may set `run`; an inventory charges its ledger as the real one does once the SDK returns.
const inventory = vi.hoisted(() => ({
  run: undefined as
    undefined | ((ledger: { record: (spend: object) => Promise<unknown> }) => Promise<void>),
}));
vi.mock('../inventory/index.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../inventory/index.ts')>()),
  runInventory: async (
    _dir: string,
    _repo: string,
    { ledger }: { ledger: { record: (spend: object) => Promise<unknown> } },
  ) => {
    await inventory.run?.(ledger);
    return { usages: [] };
  },
}));

// No recipes, no model call and no store on disk: these tests are about the budget, not memory.
const memory = vi.hoisted(() => ({ caps: [] as number[], commits: [] as (string | undefined)[] }));
vi.mock('../memory/index.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../memory/index.ts')>()),
  createRetriever: () => async () => [],
  learnFromRun: async (input: { commit?: string }, deps: { budget: { capUsd: number } }) => {
    memory.caps.push(deps.budget.capUsd);
    memory.commits.push(input.commit);
    return { run: {}, promoted: [], demoted: [] };
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  harness.caps = [];
  harness.run = undefined;
  inventory.run = undefined;
  memory.caps = [];
  memory.commits = [];
});

const task = (id: string) =>
  ({
    id: `acme/shop:${id}`,
    repo: 'acme/shop',
    change: { id, provider: 'stripe' },
  }) as MigrationTask;

describe('createDeps', () => {
  it('runs offline on stubs without ANTHROPIC_API_KEY', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    expect(createDeps({ log: () => {} }).runTask).toBe(stubRunTask);
  });

  it('wires every provider folder watcher and gives each task its share of one run budget', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-not-a-real-key');
    const budget = createBudget(3);
    const deps = createDeps({ budget, log: () => {} });

    await deps.runTask(task('change'), '/unused');
    await deps.runTask(task('change'), '/unused');
    const skipped = await deps.runTask(task('change'), '/unused');

    expect(Object.keys(deps.watchers)).toEqual(listProviderIds());
    expect(harness.caps).toEqual([3, 2.25]);
    expect(budget.spentUsd()).toBe(1.5);
    // $1.50 left is below MIN_TASK_USD, so the third task never reaches the harness.
    expect(MIN_TASK_USD).toBeGreaterThan(1.5);
    expect(skipped).toMatchObject({ outcome: 'failed', costUsd: 0 });
    expect((skipped as { note?: string }).note).toMatch(
      /not attempted: \$1\.50 of the run cap left/,
    );
  });

  it('runs tasks at once and never lets spend plus holds pass the cap', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-not-a-real-key');
    const cap = 13;
    const budget = createBudget(cap);
    const deps = createDeps({ budget, log: () => {} });
    let running = 0;
    let peak = 0;
    let worst = 0;
    harness.run = async (t, budgetUsd) => {
      peak = Math.max(peak, ++running);
      worst = Math.max(worst, budget.spentUsd() + budget.heldUsd());
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      // Each fake harness spends most of what it was given.
      return ran(t, budgetUsd * 0.9);
    };

    const records = await Promise.all(
      Array.from({ length: 6 }, (_, i) => deps.runTask(task(`c${i}`), '/unused')),
    );

    expect(peak).toBeGreaterThan(1);
    expect(Math.max(...harness.caps.map(Number))).toBeLessThanOrEqual(TASK_USD);
    expect(Math.min(...harness.caps.map(Number))).toBeGreaterThanOrEqual(MIN_TASK_USD - 1e-9);
    expect(worst).toBeLessThanOrEqual(cap + 1e-9);
    expect(budget.spentUsd()).toBeLessThanOrEqual(cap + 1e-9);
    expect(budget.heldUsd()).toBe(0);
    // Every task ran or was recorded as not attempted; none was dropped.
    expect(records).toHaveLength(6);
    expect(records.some((r) => r.outcome === 'failed')).toBe(true);
  });

  it('records a harness that throws as failed, counting its whole share once', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-not-a-real-key');
    const budget = createBudget(8);
    const deps = createDeps({ budget, log: () => {} });
    let calls = 0;
    harness.run = async () => {
      calls++;
      throw new Error('harness crashed');
    };
    // Through the queue, as the loop runs it: the failure comes back as a record, so no retry.
    const record = await deps.queue.add('task', () => deps.runTask(task('c'), '/unused'));
    expect(record).toMatchObject({ outcome: 'failed', costUsd: TASK_USD });
    expect((record as { note?: string }).note).toMatch(
      /runTask failed: harness crashed; its spend is unknown/,
    );
    expect(calls).toBe(1);
    expect(budget.spentUsd()).toBe(TASK_USD);
    expect(budget.heldUsd()).toBe(0);
  });

  it('lets a task in a big run hold a fair share of what is free', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-not-a-real-key');
    const deps = createDeps({ budget: createBudget(100), log: () => {} });
    await deps.runTask(task('c'), '/unused');
    // A quarter of the free $100, since four parts run at once.
    expect(harness.caps).toEqual([25]);
  });

  it('counts an inventory that throws without a result as having spent its whole hold', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-not-a-real-key');
    const budget = createBudget(3);
    const deps = createDeps({ budget, log: () => {} });
    inventory.run = async () => {
      throw new Error('the Agent SDK exited');
    };
    await expect(deps.inventory('/unused', 'acme/shop')).rejects.toThrow('the Agent SDK exited');
    expect(budget.spentUsd()).toBe(DEFAULT_RUN_CAP_USD);

    inventory.run = async (ledger) => {
      await ledger.record({ repo: 'acme/shop', model: 'claude-sonnet-5-5', costUsd: 0.25 });
    };
    await deps.inventory('/unused', 'acme/shop');
    expect(budget.spentUsd()).toBeCloseTo(DEFAULT_RUN_CAP_USD + 0.25, 10);
    expect(budget.heldUsd()).toBe(0);
  });

  it('does not retry a refusal from the run budget', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-not-a-real-key');
    const deps = createDeps({ budget: createBudget(1), log: () => {} });
    let calls = 0;
    await expect(
      deps.queue.add('refused', async () => {
        calls++;
        throw new BudgetExceededError('the run cannot free enough');
      }),
    ).rejects.toThrow('the run cannot free enough');
    expect(calls).toBe(1);
  });
});

describe('recordRun', () => {
  it('stores a record that was never attempted without holding any of the run', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-not-a-real-key');
    const budget = createBudget(3);
    const out = join(await mkdtemp(join(tmpdir(), 'aptitude-deps-')), 'runs.jsonl');
    const deps = createDeps({ budget, out, log: () => {} });
    // Every dollar of the run is held by a running task.
    const running = await budget.reserve('a task', 3);

    await deps.recordRun(
      task('c'),
      { ...ran(task('c'), 0), outcome: 'not-affected' },
      '/nonexistent/checkout',
    );
    expect(memory.caps).toEqual([0]);
    // Not a git checkout, so memory gets no commit.
    expect(memory.commits).toEqual([undefined]);
    running.settle(0);
  });

  it('holds its share of the run to learn from an attempt', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-not-a-real-key');
    const budget = createBudget(3);
    const out = join(await mkdtemp(join(tmpdir(), 'aptitude-deps-')), 'runs.jsonl');
    const deps = createDeps({ budget, out, log: () => {} });
    const attempt = { ...ran(task('c'), 1), transcriptPath: '/nonexistent/transcript.jsonl' };
    const checkout = await mkdtemp(join(tmpdir(), 'aptitude-checkout-'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--no-verify',
      '-q',
      '--allow-empty',
      '-m',
      'x',
    );

    await deps.recordRun(task('c'), attempt, checkout);
    expect(memory.caps).toEqual([MEMORY_USD]);
    expect(budget.heldUsd()).toBe(0);
    // The commit the run read, for memory's self-eval.
    expect(memory.commits).toEqual([git('rev-parse', 'HEAD')]);

    // A folder inside the checkout is not a checkout of its own, so it gives no commit.
    const inside = join(checkout, 'packages');
    await mkdir(inside);
    await deps.recordRun(task('c'), attempt, inside);
    expect(memory.commits[1]).toBeUndefined();
  });
});

describe('anyWatcher', () => {
  it('watches a provider with no folder from its hints, settles to what it spent, and reads once a day', async () => {
    const budget = createBudget(3);
    const cache = await mkdtemp(join(tmpdir(), 'aptitude-watch-test-'));
    const watch = anyWatcher('resend', { packages: ['resend'] }, budget, cache);
    const changes = await watch();
    expect(changes.map((change) => change.id)).toEqual(['resend:example-change']);
    expect(watched.calls).toEqual([{ provider: 'resend', hints: { packages: ['resend'] } }]);
    expect(budget.spentUsd()).toBeCloseTo(0.3);
    expect(budget.heldUsd()).toBe(0);
    await watch();
    expect(watched.calls).toHaveLength(1);
    expect(budget.spentUsd()).toBeCloseTo(0.3);
    // Another run, in another process, with the same cache folder: still one read.
    await anyWatcher('resend', { packages: ['resend'] }, createBudget(3), cache)();
    expect(watched.calls).toHaveLength(1);
  });

  it('never caches a read that ended early, so the next caller reads again', async () => {
    watched.calls = [];
    watched.endedEarly = true;
    const budget = createBudget(3);
    const cache = await mkdtemp(join(tmpdir(), 'aptitude-watch-test-'));
    const watch = anyWatcher('notion', {}, budget, cache);
    // The early read's changes still go to its caller.
    expect(await watch()).toHaveLength(1);
    watched.endedEarly = false;
    await watch();
    await watch();
    expect(watched.calls).toHaveLength(2);
    expect(budget.spentUsd()).toBeCloseTo(0.6);
  });
});

describe('cachedChanges', () => {
  it('runs the watcher once and serves later reads from the cache', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aptitude-watch-test-'));
    const change = { provider: 'stripe', id: 'c1' } as never;
    const watch = vi.fn(async () => [change]);

    expect(await cachedChanges(dir, 'stripe-latest-2026-11-01', watch)).toEqual([change]);
    expect(await cachedChanges(dir, 'stripe-latest-2026-11-01', watch)).toEqual([change]);
    expect(watch).toHaveBeenCalledTimes(1);
  });

  it('shares one read between calls that start together', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aptitude-watch-test-'));
    const watch = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [];
    });
    await Promise.all([1, 2, 3].map(() => cachedChanges(dir, 'stripe', watch)));
    expect(watch).toHaveBeenCalledTimes(1);
  });

  it('caches nothing when the watcher fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aptitude-watch-test-'));
    const failing = vi.fn(async () => {
      throw new Error('changelog unreachable');
    });
    await expect(cachedChanges(dir, 'meta', failing)).rejects.toThrow('changelog unreachable');
    const watch = vi.fn(async () => []);
    await cachedChanges(dir, 'meta', watch);
    expect(watch).toHaveBeenCalledTimes(1);
  });
});
