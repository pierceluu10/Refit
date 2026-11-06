// The real-mode wiring of createDeps end to end, with fakes only at the edges: inventory, the
// provider watchers, the Messages API, the harness and memory. Each fake spends from its own ledger
// as the real part does. Illustrative data only.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MigrationTask } from '../shared/types.ts';
import { createBudget } from './budget.ts';
import { createDeps } from './deps.ts';
import { runOrg } from './loop.ts';

const seen = vi.hoisted(() => {
  let release = () => {};
  const together = new Promise<void>((resolve) => (release = resolve));
  return { worst: 0, running: 0, peak: 0, learned: 0, check: () => {}, together, release };
});
const pause = () => new Promise((resolve) => setTimeout(resolve, 2));

vi.mock('../inventory/index.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../inventory/index.ts')>()),
  runInventory: async (
    _dir: string,
    repo: string,
    { ledger }: { ledger: { record: (spend: object) => Promise<unknown> } },
  ) => {
    await pause();
    await ledger.record({ repo, model: 'claude-sonnet-5-5', costUsd: 0.3 });
    return {
      usages: [
        {
          repo,
          provider: 'stripe',
          via: 'sdk',
          callSites: [{ file: 'a.ts', line: 1, operation: 'x' }],
        },
        {
          repo,
          provider: 'sentry',
          via: 'sdk',
          callSites: [{ file: 'b.ts', line: 1, operation: 'y' }],
        },
      ],
    };
  },
}));

vi.mock('../providers/core/registry.ts', () => ({
  listProviderIds: () => ['openai', 'stripe'],
  folderWatcher:
    (id: string, { budget }: { budget: { charge: (model: string, usage: object) => void } }) =>
    async () => {
      await pause();
      // 100k input and 5k output tokens on Sonnet: $0.25.
      budget.charge('claude-sonnet-5-5', { inputTokens: 100_000, outputTokens: 5_000 });
      return [1, 2, 3].map((n) => ({
        provider: id,
        id: `${id}:change-${n}`,
        kind: 'other',
        title: `${id} change ${n}`,
        source: { url: 'https://example.com/changelog', quote: '(illustrative)' },
        affects: {},
      }));
    },
}));

// The any-provider watcher for providers with no folder (sentry here): it reads and finds nothing.
vi.mock('../providers/core/any-watcher.ts', () => ({
  anyProviderWatcher: () => async () => [],
}));

// The match agent's Messages API: every Stripe change is a task, every other change is not.
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: async (params: { messages: { content: string }[] }) => {
        await pause();
        const ids = [...params.messages[0].content.matchAll(/"id": "([^"]+)"/g)].map((m) => m[1]);
        const output = {
          tasks: ids
            .filter((id) => id.startsWith('stripe:'))
            .map((changeId) => ({
              changeId,
              usageIndexes: [0],
              callSites: [],
              reasoning: 'calls it',
              urgency: 'high',
              deadline: '',
            })),
          notAffected: ids
            .filter((id) => !id.startsWith('stripe:'))
            .map((changeId) => ({ changeId, reasoning: 'never calls OpenAI' })),
        };
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify(output) }],
          usage: { input_tokens: 20_000, output_tokens: 2_000 },
        };
      },
    };
  },
}));

// Each harness run spends 80% of what it was given.
vi.mock('../harness/index.ts', () => ({
  runTask: async (task: MigrationTask, _dir: string, { budgetUsd }: { budgetUsd: number }) => {
    seen.peak = Math.max(seen.peak, ++seen.running);
    seen.check();
    // The first run waits a while for a second to start beside it; runs one at a time would not.
    if (seen.running === 2) seen.release();
    await Promise.race([seen.together, new Promise((resolve) => setTimeout(resolve, 500))]);
    seen.running--;
    return {
      taskId: task.id,
      outcome: 'verified',
      diff: 'diff --git a/a.ts b/a.ts\n',
      checks: [],
      costUsd: budgetUsd * 0.8,
      transcriptPath: '/nonexistent/transcript.jsonl',
    };
  },
}));

vi.mock('../memory/index.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../memory/index.ts')>()),
  createRetriever: () => async () => [],
  learnFromRun: async () => {
    seen.learned++;
    return { run: {}, promoted: [], demoted: [] };
  },
}));

afterEach(() => vi.unstubAllEnvs());

describe('an org run on the real wiring', () => {
  it('runs repos and tasks at once, keeps spend plus holds under the cap, and records every change', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-not-a-real-key');
    const cap = 12;
    const budget = createBudget(cap);
    seen.check = () => (seen.worst = Math.max(seen.worst, budget.spentUsd() + budget.heldUsd()));
    const dir = await mkdtemp(join(tmpdir(), 'refit-org-run-'));
    const deps = createDeps({
      budget,
      out: join(dir, 'runs.jsonl'),
      watchCache: join(dir, 'watch'),
      log: () => {},
    });
    const repos = ['acme/shop', 'acme/admin', 'acme/api'].map((repo) => ({
      repo,
      dir: `/nonexistent/${repo}`,
    }));

    const summary = await runOrg({ name: 'acme', repos }, deps, {
      dryRun: true,
      capUsd: budget.capUsd,
    });

    // 3 repos × (3 Stripe + 3 OpenAI changes), each with a record.
    expect(summary.records).toHaveLength(18);
    expect(summary.counts['not-affected']).toBe(9);
    expect(summary.counts.verified).toBeGreaterThan(0);
    expect(summary.counts.verified + summary.counts.failed).toBe(9);
    for (const r of summary.records.filter((r) => r.outcome === 'failed'))
      expect(r.note).toMatch(/not attempted: \$\d+\.\d\d of the run cap left/);
    expect(seen.learned).toBe(18);
    expect(seen.peak).toBeGreaterThan(1);
    expect(seen.worst).toBeLessThanOrEqual(cap + 1e-9);
    expect(budget.spentUsd()).toBeLessThanOrEqual(cap + 1e-9);
    expect(budget.heldUsd()).toBe(0);
    // Sentry has no folder in providers/; the any-provider watcher read it and found nothing.
    expect(summary.errors).toEqual([]);
  });
});
