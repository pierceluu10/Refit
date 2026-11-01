import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listProviderIds } from '../providers/core/registry.ts';
import type { MigrationTask, RunRecord } from '../shared/types.ts';
import { createBudget } from './budget.ts';
import { anyWatcher, cachedChanges, createDeps, MIN_TASK_USD, TASK_USD } from './deps.ts';
import { stubRunTask } from './stubs.ts';

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

// No recipes and no model call: these tests are about the budget, not memory.
vi.mock('../memory/index.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../memory/index.ts')>()),
  createRetriever: () => async () => [],
}));

afterEach(() => {
  vi.unstubAllEnvs();
  harness.caps = [];
  harness.run = undefined;
});

const task = (id: string) => ({ id: `acme/shop:${id}` }) as MigrationTask;

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

  it('counts a harness that throws as having spent its whole share', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-not-a-real-key');
    const budget = createBudget(8);
    const deps = createDeps({ budget, log: () => {} });
    harness.run = async () => {
      throw new Error('harness crashed');
    };
    await expect(deps.runTask(task('c'), '/unused')).rejects.toThrow('harness crashed');
    expect(budget.spentUsd()).toBe(TASK_USD);
    expect(budget.heldUsd()).toBe(0);
  });
});

describe('anyWatcher', () => {
  it('reports a provider with no folder as unwatched until the any-provider watcher lands', async () => {
    const budget = createBudget(3);
    const cache = await mkdtemp(join(tmpdir(), 'aptitude-watch-test-'));
    const watch = anyWatcher('resend', { packages: ['resend'] }, budget, cache);
    await expect(watch()).rejects.toThrow(/no changelog watcher for resend yet/);
    expect(budget.spentUsd()).toBe(0);
    expect(budget.heldUsd()).toBe(0);
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
