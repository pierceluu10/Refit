import { afterEach, describe, expect, it, vi } from 'vitest';
import { listProviderIds } from '../providers/core/registry.ts';
import type { MigrationTask, RunRecord } from '../shared/types.ts';
import { createBudget } from './budget.ts';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachedChanges, createDeps, MIN_TASK_USD } from './deps.ts';
import { stubRunTask } from './stubs.ts';

const harnessCaps = vi.hoisted(() => [] as (number | undefined)[]);

vi.mock('../harness/index.ts', () => ({
  runTask: async (task: MigrationTask, _dir: string, deps: { budgetUsd?: number }) => {
    harnessCaps.push(deps.budgetUsd);
    const record: RunRecord = {
      taskId: task.id,
      outcome: 'needs-review',
      diff: '',
      checks: [],
      costUsd: 0.75,
      transcriptPath: '',
    };
    return record;
  },
}));

// No recipes and no model call: these tests are about the budget, not memory.
vi.mock('../memory/index.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../memory/index.ts')>()),
  createRetriever: () => async () => [],
}));

afterEach(() => vi.unstubAllEnvs());

describe('createDeps', () => {
  it('runs offline on stubs without ANTHROPIC_API_KEY', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    expect(createDeps({ log: () => {} }).runTask).toBe(stubRunTask);
  });

  it('wires every provider watcher and gives each task what is left of one run budget', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-not-a-real-key');
    const budget = createBudget(3);
    const deps = createDeps({ budget, log: () => {} });
    const task = { id: 'acme/shop:change' } as MigrationTask;

    await deps.runTask(task, '/unused');
    await deps.runTask(task, '/unused');
    const skipped = await deps.runTask(task, '/unused');

    expect(deps.watchers).toHaveLength(listProviderIds().length);
    expect(harnessCaps).toEqual([3, 2.25]);
    expect(budget.spentUsd()).toBe(1.5);
    // $1.50 left is below MIN_TASK_USD, so the third task never reaches the harness.
    expect(MIN_TASK_USD).toBeGreaterThan(1.5);
    expect(skipped).toMatchObject({ outcome: 'failed', costUsd: 0 });
    expect((skipped as { note?: string }).note).toMatch(
      /not attempted: \$1\.50 of the run cap left/,
    );
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
