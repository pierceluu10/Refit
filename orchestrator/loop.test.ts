import { describe, expect, it, vi } from 'vitest';
import type { ApiUsage, MigrationTask, ProviderChange, RunRecord } from '../shared/types.ts';
import { runOrg, type LoopDeps } from './loop.ts';
import { createMemoryQueue } from './queue.ts';
import { stubMatch } from './stubs.ts';

// Illustrative in-test data, not real provider changes.
const change = (id: string, provider = 'stripe'): ProviderChange => ({
  provider,
  id,
  kind: 'field-removed',
  title: id,
  source: { url: 'https://example.com/changelog', quote: '(illustrative)' },
  affects: {},
});

const usages: ApiUsage[] = [
  {
    repo: 'placeholder',
    provider: 'stripe',
    via: 'sdk',
    callSites: [{ file: 'src/pay.ts', line: 3, operation: 'charges.create' }],
  },
];

const ok = (task: MigrationTask, outcome: RunRecord['outcome'], diff: string, costUsd = 0) => ({
  taskId: task.id,
  outcome,
  diff,
  checks: [],
  costUsd,
  transcriptPath: '',
});

function fakeDeps(changes: ProviderChange[], runTask: LoopDeps['runTask']) {
  const recorded: RunRecord[] = [];
  const opened: string[] = [];
  const deps: LoopDeps = {
    inventory: async () => usages,
    watchers: [async () => changes],
    match: stubMatch,
    runTask: vi.fn(runTask),
    openPullRequest: async (task) => {
      opened.push(task.id);
      return `stub://pr/${task.id}`;
    },
    recordRun: async (_task, record) => {
      recorded.push(record);
    },
    queue: createMemoryQueue({ concurrency: 2, retries: 1, backoffMs: 1 }),
  };
  return { deps, recorded, opened };
}

const org = { name: 'acme', repos: [{ repo: 'acme/shop', dir: '/nonexistent/shop' }] };

describe('runOrg', () => {
  const changes = [
    change('verified'),
    change('throws'),
    change('no-diff'),
    change('meta-only', 'meta-graph'),
  ];
  const runTask: LoopDeps['runTask'] = async (task) => {
    if (task.change.id === 'throws') throw new Error('harness crashed');
    if (task.change.id === 'no-diff') return ok(task, 'needs-review', '');
    return ok(task, 'verified', 'diff --git a/src/pay.ts b/src/pay.ts\n', 0.25);
  };

  it('attempts every task, opens PRs for diffs, and records every outcome', async () => {
    const { deps, recorded, opened } = fakeDeps(changes, runTask);
    const summary = await runOrg(org, deps);

    // Every stripe change is attempted, including the one whose harness throws (retried once).
    expect(deps.runTask).toHaveBeenCalledTimes(4);
    expect(opened).toEqual(['acme/shop:verified']);
    expect(summary.prs).toEqual(['stub://pr/acme/shop:verified']);
    expect(summary.counts).toEqual({
      verified: 1,
      'needs-review': 1,
      'not-affected': 1,
      failed: 1,
    });
    expect(summary.costUsd).toBe(0.25);

    const byId = Object.fromEntries(summary.records.map((r) => [r.taskId, r]));
    expect(byId['acme/shop:throws']).toMatchObject({
      outcome: 'failed',
      note: expect.stringContaining('harness crashed'),
    });
    expect(byId['acme/shop:meta-only']).toMatchObject({
      outcome: 'not-affected',
      diff: '',
      note: expect.stringContaining('no meta-graph usage'),
    });
    expect(recorded).toHaveLength(4);
  });

  it('dry run opens no PRs but still records every run', async () => {
    const { deps, recorded, opened } = fakeDeps(changes, runTask);
    const summary = await runOrg(org, deps, { dryRun: true });
    expect(opened).toEqual([]);
    expect(summary.prs).toEqual([]);
    expect(recorded).toHaveLength(4);
    const verified = recorded.find((r) => r.taskId === 'acme/shop:verified');
    expect(verified?.outcome).toBe('verified');
    expect(verified?.pr).toBeUndefined();
  });

  it('stops scheduling at the run cap and records each unscheduled task as failed', async () => {
    const many = ['a', 'b', 'c'].map((id) => change(id));
    const { deps, recorded } = fakeDeps(many, async (task) => ok(task, 'verified', 'diff', 1));
    deps.queue = createMemoryQueue({ concurrency: 1, retries: 0 });
    const summary = await runOrg(org, deps, { capUsd: 1 });

    expect(deps.runTask).toHaveBeenCalledTimes(1);
    expect(summary.counts).toMatchObject({ verified: 1, failed: 2 });
    const unscheduled = recorded.filter((r) => r.outcome === 'failed');
    for (const r of unscheduled) {
      expect(r).toMatchObject({
        note: expect.stringContaining('run budget reached before this task'),
      });
    }
  });

  it('keeps going when one watcher fails, and reports it', async () => {
    const { deps } = fakeDeps([change('verified')], runTask);
    deps.watchers.push(async () => {
      throw new Error('changelog unreachable');
    });
    const summary = await runOrg(org, deps);
    expect(summary.counts.verified).toBe(1);
    expect(summary.errors).toEqual([expect.stringContaining('changelog unreachable')]);
  });

  it('reports every change as failed, without running tasks, when the repo cannot be matched', async () => {
    const { deps } = fakeDeps(changes, runTask);
    deps.match = async () => {
      throw new Error('model unavailable');
    };
    const summary = await runOrg(org, deps);
    expect(deps.runTask).not.toHaveBeenCalled();
    expect(summary.counts.failed).toBe(changes.length);
    expect(summary.records.every((r) => /not attempted: match failed/.test(r.note ?? ''))).toBe(
      true,
    );
    expect(summary.errors).toEqual([expect.stringMatching(/match failed after retries/)]);
  });

  it('attempts a change the matcher gave no verdict for', async () => {
    const { deps } = fakeDeps(changes, runTask);
    deps.match = async () => ({ tasks: [], notAffected: [], costUsd: 0 });
    await runOrg(org, deps);
    const attempted = vi.mocked(deps.runTask).mock.calls.map(([task]) => task.change.id);
    expect(new Set(attempted)).toEqual(new Set(changes.map((c) => c.id)));
  });
});
