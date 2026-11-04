import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBudget } from '../../orchestrator/budget.ts';
import type { RunTask } from '../../shared/types.ts';
import { makeRecord, makeTask } from '../fixtures/tasks.ts';
import { JsonMemoryStore } from '../store.ts';
import { main, type SelfEvalParts } from './selfeval.ts';

// Illustrative stored history: two harness runs, one with its commit recorded.
async function parts(capUsd = 10, costUsd = 1) {
  const store = new JsonMemoryStore(await mkdtemp(join(tmpdir(), 'aptitude-selfeval-cli-')));
  for (const [id, commit] of [
    ['task-a', 'abc1234'],
    ['task-b', undefined],
  ] as const) {
    await store.recordRun({
      task: makeTask({ id, repo: `example-org/${id}` }),
      record: makeRecord({ taskId: id, outcome: 'failed' }),
      transcript: 'harness transcript',
      commit,
    });
  }
  const budget = createBudget(capUsd);
  // Fake harness through the run budget: it spends, then verifies.
  const runTask = vi.fn<RunTask>(async (task) => {
    budget.chargeUsd(costUsd);
    return makeRecord({ taskId: task.id, outcome: 'verified', costUsd: 0 });
  });
  const cleanup = vi.fn(async () => {});
  const checkout = vi.fn(async () => ({ repoDir: '/tmp/copy', cleanup }));
  const made: SelfEvalParts = { store, budget, runTask, checkout };
  return { made, runTask, checkout, cleanup };
}

describe('selfeval command', () => {
  let print: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-not-real');
    print = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reruns stored tasks at their commits and prints whether the verified rate moved', async () => {
    const { made, checkout, cleanup } = await parts();

    expect(await main([], () => made)).toBe(0);

    expect(checkout.mock.calls).toEqual([
      [{ repo: 'example-org/task-a', commit: 'abc1234' }],
      [{ repo: 'example-org/task-b', commit: 'HEAD' }],
    ]);
    expect(cleanup).toHaveBeenCalledTimes(2);
    const output = print.mock.calls.flat().join('\n');
    expect(output).toContain('Verified rate moved from 0% to 100% (+100 pts) on 2 past tasks.');
    expect(output).toContain("1 rerun used today's code");
    expect(output).toContain('task-a: failed -> verified');
    expect(output).toContain('AI spent: $2.0000 of the $10 cap');
    const [report] = await made.store.listSelfEvals();
    expect(report.costUsd).toBe(2);
  });

  it('stops rerunning once less than a task needs is left of the cap', async () => {
    const { made, runTask } = await parts(3, 2.25);

    expect(await main([], () => made)).toBe(0);

    expect(runTask).toHaveBeenCalledTimes(1);
    expect(print.mock.calls.flat().join('\n')).toContain(
      'Stopped before 1 of 2 tasks: $0.75 of the $3 cap is left, below the $1 overshoot reserve a task needs',
    );
  });

  it('stops the reruns when a harness throws, since what it spent is unknown', async () => {
    const { made, runTask } = await parts();
    runTask.mockRejectedValueOnce(new Error('sandbox crashed'));

    expect(await main([], () => made)).toBe(0);

    expect(runTask).toHaveBeenCalledTimes(1);
    expect(print.mock.calls.flat().join('\n')).toContain(
      'Stopped before 2 of 2 tasks: the rerun of task-a threw, so what it spent is unknown: sandbox crashed',
    );
  });

  it('forces the Docker sandbox for the real parts', async () => {
    vi.stubEnv('APTITUDE_SANDBOX', 'local');
    vi.stubEnv('APTITUDE_AI_BUDGET_USD', '');

    expect(await main([])).toBe(2);
    expect(process.env.APTITUDE_SANDBOX).toBe('docker');
  });

  it('refuses to measure anything without a model', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const make = vi.fn();

    expect(await main([], make)).toBe(2);
    expect(make).not.toHaveBeenCalled();
  });

  it('refuses to spend without APTITUDE_AI_BUDGET_USD', async () => {
    vi.stubEnv('APTITUDE_SANDBOX', '');
    vi.stubEnv('APTITUDE_AI_BUDGET_USD', '');
    expect(await main([])).toBe(2);
  });

  it('rejects a bad --size', async () => {
    expect(await main(['--size', 'lots'], vi.fn())).toBe(2);
  });
});
