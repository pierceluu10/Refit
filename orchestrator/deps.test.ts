import { afterEach, describe, expect, it, vi } from 'vitest';
import { listProviderIds } from '../providers/core/registry.ts';
import type { MigrationTask, RunRecord } from '../shared/types.ts';
import { createBudget } from './budget.ts';
import { createDeps } from './deps.ts';
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
    const budget = createBudget(2);
    const deps = createDeps({ budget, log: () => {} });
    const task = { id: 'acme/shop:change' } as MigrationTask;

    await deps.runTask(task, '/unused');
    await deps.runTask(task, '/unused');

    expect(deps.watchers).toHaveLength(listProviderIds().length);
    expect(harnessCaps).toEqual([2, 1.25]);
    expect(budget.spentUsd()).toBe(1.5);
  });
});
