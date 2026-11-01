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
    watchers: { stripe: async () => changes },
    watchAny: vi.fn(() => async () => []),
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
    deps.watchers.meta = async () => {
      throw new Error('changelog unreachable');
    };
    const summary = await runOrg(org, deps);
    expect(summary.counts.verified).toBe(1);
    expect(summary.errors).toEqual(['watcher meta failed: changelog unreachable']);
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

  it('records the folder watchers’ changes as failed when the inventory fails', async () => {
    const { deps } = fakeDeps(changes, runTask);
    deps.inventory = async () => {
      throw new Error('repo unreadable');
    };
    const summary = await runOrg(org, deps);
    expect(deps.runTask).not.toHaveBeenCalled();
    expect(deps.watchAny).not.toHaveBeenCalled();
    expect(summary.counts.failed).toBe(changes.length);
    expect(summary.records[0].note).toMatch(/not attempted: inventory failed after retries/);
  });
});

describe('watching what the inventory finds', () => {
  const runTask: LoopDeps['runTask'] = async (task) =>
    ok(task, 'verified', 'diff --git a/src/mail.ts b/src/mail.ts\n', 0.25);
  const resend: ApiUsage = {
    repo: 'acme/shop',
    provider: 'Resend',
    via: 'sdk',
    sdk: { name: 'resend', version: '3.2.0' },
    callSites: [{ file: 'src/mail.ts', line: 8, operation: 'emails.send' }],
    hints: { hosts: ['api.resend.com'], docsUrls: ['https://resend.com/changelog'] },
  };

  it('gives a provider with no folder its own watcher, and its change becomes a task', async () => {
    const { deps } = fakeDeps([], runTask);
    deps.inventory = async () => [...usages, resend];
    deps.watchAny = vi.fn((provider: string) => async () => [change('resend-v2-send', provider)]);
    const summary = await runOrg(org, deps);

    expect(deps.watchAny).toHaveBeenCalledExactlyOnceWith('resend', {
      packages: ['resend'],
      hosts: ['api.resend.com'],
      docsUrls: ['https://resend.com/changelog'],
    });
    const attempted = vi.mocked(deps.runTask).mock.calls.map(([task]) => task.change.id);
    expect(attempted).toEqual(['resend-v2-send']);
    expect(summary.records.map((r) => [r.taskId, r.outcome])).toEqual([
      ['acme/shop:resend-v2-send', 'verified'],
    ]);
  });

  it('runs the repos of an org at once and reads each provider once', async () => {
    const { deps } = fakeDeps([change('verified')], runTask);
    const folder = vi.fn(async () => [change('verified')]);
    deps.watchers = { stripe: folder };
    deps.watchAny = vi.fn(() => async () => []);
    let started = 0;
    let bothStarted!: () => void;
    const both = new Promise<void>((resolve) => (bothStarted = resolve));
    deps.inventory = async (_dir, repo) => {
      if (++started === 2) bothStarted();
      await Promise.race([
        both,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('repos ran one at a time')), 2000),
        ),
      ]);
      return [...usages, { ...resend, repo }];
    };
    const summary = await runOrg(
      {
        name: 'acme',
        repos: [
          { repo: 'acme/shop', dir: '/nonexistent/shop' },
          { repo: 'acme/admin', dir: '/nonexistent/admin' },
        ],
      },
      deps,
    );

    expect(summary.errors).toEqual([]);
    expect(folder).toHaveBeenCalledTimes(1);
    expect(deps.watchAny).toHaveBeenCalledTimes(1);
    expect(summary.records.map((r) => r.taskId)).toEqual([
      'acme/shop:verified',
      'acme/admin:verified',
    ]);
  });
});
