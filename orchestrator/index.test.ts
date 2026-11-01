import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ApiUsage,
  MigrationTask,
  OpenPullRequest,
  ProviderChange,
  RunRecord,
} from '../shared/types.ts';
import { createDeps } from './deps.ts';
import { createRunRepoJob } from './index.ts';
import type { LoopDeps } from './loop.ts';
import { createMemoryQueue } from './queue.ts';
import { stubMatch } from './stubs.ts';

// Illustrative in-test data, not real provider changes or repos.
const change = (id: string, provider: string): ProviderChange => ({
  provider,
  id,
  kind: 'other',
  title: id,
  source: { url: 'https://example.com/changelog', quote: '(illustrative)' },
  affects: {},
});

const usage = (provider: string, file: string): ApiUsage => ({
  repo: 'acme/shop',
  provider,
  via: 'sdk',
  sdk: { name: provider, version: '1.0.0' },
  callSites: [{ file, line: 3, operation: 'send' }],
});

const outcomes: Record<string, Pick<RunRecord, 'outcome' | 'diff'>> = {
  'stripe-verified': { outcome: 'verified', diff: 'diff --git a/src/pay.ts b/src/pay.ts\n' },
  'stripe-unproven': { outcome: 'needs-review', diff: 'diff --git a/src/pay.ts b/src/pay.ts\n' },
  'stripe-no-edit': { outcome: 'needs-review', diff: '' },
  'mail-verified': { outcome: 'verified', diff: 'diff --git a/src/mail.ts b/src/mail.ts\n' },
};

function fakeDeps() {
  const recorded: RunRecord[] = [];
  const deps: Omit<LoopDeps, 'openPullRequest'> = {
    inventory: async () => [usage('stripe', 'src/pay.ts'), usage('mailco', 'src/mail.ts')],
    watchers: {
      stripe: async () => [
        ...['stripe-verified', 'stripe-unproven', 'stripe-no-edit', 'stripe-crash'].map((id) =>
          change(id, 'stripe'),
        ),
        change('meta-only', 'meta'),
      ],
    },
    // mailco has no folder in providers/, so it is watched from the inventory's usage map.
    watchAny: (provider) => async () => [change('mail-verified', provider)],
    match: stubMatch,
    runTask: vi.fn(async (task: MigrationTask) => {
      if (task.change.id === 'stripe-crash') throw new Error('harness crashed');
      return {
        taskId: task.id,
        ...outcomes[task.change.id],
        checks: [],
        costUsd: 0.5,
        transcriptPath: '',
      };
    }),
    recordRun: async (_task, record) => void recorded.push(record),
    queue: createMemoryQueue({ concurrency: 3, retries: 1, backoffMs: 1 }),
  };
  return { deps, recorded };
}

const opener = () =>
  vi.fn<OpenPullRequest>(async (task) => `https://github.com/acme/shop/pull/${task.change.id}`);

describe('runRepoJob', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('runs the loop on one repo and gives the PR opener every shippable task', async () => {
    const { deps, recorded } = fakeDeps();
    const openPullRequest = opener();
    const records = await createRunRepoJob(deps)({
      repo: 'acme/shop',
      dir: '/checkout/acme-shop',
      openPullRequest,
    });

    const opened = openPullRequest.mock.calls.map(([task, record, dir]) => {
      expect(record.diff).not.toBe('');
      expect(dir).toBe('/checkout/acme-shop');
      return task.change.id;
    });
    expect(opened.sort()).toEqual(['mail-verified', 'stripe-unproven', 'stripe-verified']);

    const byChange = Object.fromEntries(records.map((r) => [r.taskId.split(':')[1], r]));
    expect(byChange['stripe-verified']).toMatchObject({
      outcome: 'verified',
      pr: 'https://github.com/acme/shop/pull/stripe-verified',
    });
    expect(byChange['stripe-unproven'].pr).toBe(
      'https://github.com/acme/shop/pull/stripe-unproven',
    );
    expect(byChange['mail-verified'].pr).toBe('https://github.com/acme/shop/pull/mail-verified');
    expect(byChange['stripe-no-edit'].outcome).toBe('needs-review');
    expect(byChange['stripe-no-edit'].pr).toBeUndefined();
    expect(byChange['stripe-crash'].outcome).toBe('failed');
    expect(byChange['meta-only'].outcome).toBe('not-affected');
    expect(recorded).toHaveLength(records.length);
  });

  it('opens no PRs on a dry run and still records every run', async () => {
    const { deps, recorded } = fakeDeps();
    const openPullRequest = opener();
    const records = await createRunRepoJob(deps)({
      repo: 'acme/shop',
      dir: '/checkout/acme-shop',
      openPullRequest,
      dryRun: true,
    });
    expect(openPullRequest).not.toHaveBeenCalled();
    expect(records.every((r) => r.pr === undefined)).toBe(true);
    expect(recorded).toHaveLength(6);
  });

  it('runs offline end to end on the stubs', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const dir = await mkdtemp(join(tmpdir(), 'aptitude-job-'));
    const out = join(dir, 'runs.jsonl');
    const openPullRequest = opener();
    try {
      const records = await createRunRepoJob(createDeps({ out, log: () => {} }))({
        repo: 'acme/shop',
        dir,
        openPullRequest,
      });
      expect(openPullRequest.mock.calls.length).toBeGreaterThan(0);
      expect(records.filter((r) => r.pr).length).toBe(openPullRequest.mock.calls.length);
      const stored = (await readFile(out, 'utf8')).trim().split('\n');
      expect(stored).toHaveLength(records.length);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('builds one run budget for the process and shares it across jobs', async () => {
    vi.resetModules();
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-not-a-real-key');
    vi.stubEnv('APTITUDE_AI_BUDGET_USD', '8');
    const budgets: unknown[] = [];
    vi.doMock('./deps.ts', () => ({
      createDeps: ({ budget }: { budget: unknown }) => {
        budgets.push(budget);
        return fakeDeps().deps;
      },
    }));
    try {
      const { runRepoJob } = await import('./index.ts');
      await Promise.all(
        ['acme/shop', 'acme/admin'].map((repo) =>
          runRepoJob({ repo, dir: `/checkout/${repo}`, openPullRequest: opener(), dryRun: true }),
        ),
      );
      expect(budgets).toHaveLength(1);
      expect(budgets[0]).toMatchObject({ capUsd: 8 });
    } finally {
      vi.doUnmock('./deps.ts');
    }
  });
});
