import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetExceededError as RunBudgetRefusal, type Budget } from '../../orchestrator/budget.ts';
import type { ApiUsage, MigrationTask, ProviderHints, RunRecord } from '../../shared/types.ts';
import type { RepoEntry } from '../sets/index.ts';
import { BudgetExceededError } from './budget.ts';
import {
  hintsFor,
  loadRealPipeline,
  providerFolder,
  REVIEW_RESERVE_USD,
  unaffordableNote,
} from './real.ts';

// What the mocked parts do, per test.
const parts = vi.hoisted(() => ({
  inventoryUsd: 0.25,
  refuseInventory: false,
  runTask: undefined as undefined | ((budget: Budget) => Promise<RunRecord>),
  matchCalls: [] as number[],
  recorded: 0,
}));

// Each fake part spends a fixed amount from the run budget, as the real ones do.
vi.mock('../../orchestrator/deps.ts', () => ({
  WATCH_USD: 1.5,
  defaultWatchCache: '/unused',
  cachedChanges: (_dir: string, _key: string, call: () => Promise<unknown>) => call(),
  createDeps: ({ budget }: { budget: Budget }) => ({
    recordRun: async () => {
      parts.recorded += 1;
    },
    inventory: async () => {
      if (parts.refuseInventory) throw new RunBudgetRefusal('AI budget: $0.40 of the $5 cap left');
      budget.chargeUsd(parts.inventoryUsd);
      return [];
    },
    match: async ({ repo, changes }: { repo: string; changes: unknown[] }) => {
      parts.matchCalls.push(changes.length);
      budget.chargeUsd(0.0625);
      return {
        tasks: [],
        notAffected: [{ changeId: 'c1', reasoning: `${repo} never calls it` }],
        costUsd: 0.0625,
      };
    },
    runTask: async (): Promise<RunRecord> =>
      parts.runTask
        ? parts.runTask(budget)
        : {
            taskId: 't',
            outcome: 'needs-review',
            diff: '+x',
            checks: [],
            costUsd: 1,
            transcriptPath: 'x',
          },
  }),
  providerWatcher: (_id: string, budget: Budget) => async () => {
    budget.chargeUsd(0.125);
    return [];
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  parts.inventoryUsd = 0.25;
  parts.refuseInventory = false;
  parts.runTask = undefined;
  parts.matchCalls = [];
});

function repoFor(provider: string) {
  const charges: [number, string][] = [];
  const meter = { charge: (usd: number, label: string) => void charges.push([usd, label]) };
  return { charges, context: { entry: { repo: 'acme/shop' } as RepoEntry, provider, meter } };
}

const task = { id: 'acme/shop:c1', repo: 'acme/shop', priority: 1 } as MigrationTask;
const usage = (provider: string, hints?: ProviderHints): ApiUsage => ({
  repo: 'acme/shop',
  provider,
  via: 'http',
  callSites: [],
  ...(hints ? { hints } : {}),
});

describe('loadRealPipeline', () => {
  it('refuses to start without ANTHROPIC_API_KEY', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    await expect(loadRealPipeline(5)).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it('charges each repo for what its calls spent and keeps the match reasoning', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-not-a-real-key');
    const { charges, context } = repoFor('stripe');
    const { factory, spentUsd } = await loadRealPipeline(5);
    const pipeline = factory(context);

    await pipeline.inventory('/unused', 'acme/shop');
    await pipeline.watch([]);
    const matched = await pipeline.match([{ id: 'c1' } as never], []);

    expect(matched).toEqual({ tasks: [], reasoning: 'c1: not affected: acme/shop never calls it' });
    expect(charges).toEqual([
      [0.25, 'inventory'],
      [0.125, 'watch'],
      [0.0625, 'match'],
    ]);
    expect(spentUsd()).toBeCloseTo(0.4375);
  });

  it('matches in batches of at most 50 changes, as the loop does', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-not-a-real-key');
    const { context } = repoFor('stripe');
    const pipeline = (await loadRealPipeline(5)).factory(context);
    const changes = Array.from({ length: 120 }, (_, index) => ({ id: `c${index}` }) as never);
    await pipeline.match(changes, []);
    expect(parts.matchCalls).toEqual([50, 50, 20]);
  });

  it('stops a provider nothing can watch before it spends', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-not-a-real-key');
    const { charges, context } = repoFor('anthropic');
    const pipeline = (await loadRealPipeline(5)).factory(context);

    await expect(pipeline.inventory('/unused', 'acme/shop')).rejects.toThrow(
      /no changelog watcher for anthropic/,
    );
    expect(charges).toEqual([]);
  });

  it('watches a provider with no folder through the injected watcher, with the inventory hints', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-not-a-real-key');
    const seen: { provider: string; hints: ProviderHints; cap?: number }[] = [];
    const { charges, context } = repoFor('anthropic');
    const { factory } = await loadRealPipeline(5, {
      watchAny: (provider, hints, deps) => async () => {
        seen.push({ provider, hints, cap: deps?.budget?.capUsd });
        return [
          {
            provider,
            id: 'claude-3-retired',
            kind: 'model-retirement',
            title: 'example',
            source: { url: 'https://example.com', quote: 'example' },
            affects: {},
          },
        ];
      },
    });
    const pipeline = factory(context);

    await pipeline.inventory('/unused', 'acme/shop');
    const changes = await pipeline.watch([
      usage('Anthropic', { packages: ['@anthropic-ai/sdk'], hosts: ['api.anthropic.com'] }),
      usage('stripe', { packages: ['stripe'] }),
    ]);

    expect(changes.map((change) => change.id)).toEqual(['claude-3-retired']);
    expect(seen).toEqual([
      {
        provider: 'anthropic',
        hints: { packages: ['@anthropic-ai/sdk'], hosts: ['api.anthropic.com'], docsUrls: [] },
        cap: 1,
      },
    ]);
    expect(charges.map(([, label]) => label)).toEqual(['inventory', 'watch']);
  });

  it('turns a run-budget refusal into the cap being reached, not a pipeline error', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-not-a-real-key');
    parts.refuseInventory = true;
    const { context } = repoFor('stripe');
    const pipeline = (await loadRealPipeline(5)).factory(context);
    const refusal = await pipeline.inventory('/unused', 'acme/shop').catch((error) => error);
    expect(refusal).toBeInstanceOf(BudgetExceededError);
    expect(refusal.runOver).toBe(true);
  });

  it('starts a task with less than $2 of the run free (no per-task floor)', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-not-a-real-key');
    parts.inventoryUsd = 3.5;
    let started = false;
    parts.runTask = async () => {
      started = true;
      return {
        taskId: 't',
        outcome: 'needs-review',
        diff: '+x',
        checks: [],
        costUsd: 1,
        transcriptPath: 'x',
      };
    };
    const { context } = repoFor('stripe');
    const pipeline = (await loadRealPipeline(5)).factory(context);
    await pipeline.inventory('/unused', 'acme/shop');

    await pipeline.runTask(task, '/unused');
    expect(started).toBe(true);
    // Memory learns from every attempt, so recipes carry across iterations.
    expect(parts.recorded).toBeGreaterThan(0);
  });

  it('reads the orchestrator’s not-attempted record as unaffordable too', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-not-a-real-key');
    parts.runTask = async () =>
      ({
        taskId: 't',
        outcome: 'failed',
        diff: '',
        checks: [],
        costUsd: 0,
        transcriptPath: '',
        note: 'not attempted: $0.50 of the run cap left, below the $1 overshoot reserve a task needs',
      }) as RunRecord;
    const { context } = repoFor('stripe');
    const pipeline = (await loadRealPipeline(5)).factory(context);
    await expect(pipeline.runTask(task, '/unused')).rejects.toThrow(/not attempted: \$0\.50/);
  });
});

describe('the review reserve', () => {
  it('sets the review’s worst case aside while the harness runs, then hands it back', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-not-a-real-key');
    let heldDuringTask = -1;
    parts.runTask = async (budget) => {
      heldDuringTask = budget.heldUsd();
      return {
        taskId: 't',
        outcome: 'needs-review',
        diff: '+x',
        checks: [],
        costUsd: 1,
        transcriptPath: 'x',
      };
    };
    const { context } = repoFor('stripe');
    const pipeline = (await loadRealPipeline(5)).factory(context);
    await pipeline.runTask(task, '/unused');
    expect(heldDuringTask).toBeCloseTo(REVIEW_RESERVE_USD);
  });

  it('never makes a task unaffordable to keep the reserve', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-not-a-real-key');
    parts.inventoryUsd = 3.9;
    let heldDuringTask = -1;
    parts.runTask = async (budget) => {
      heldDuringTask = budget.heldUsd();
      return {
        taskId: 't',
        outcome: 'needs-review',
        diff: '+x',
        checks: [],
        costUsd: 1,
        transcriptPath: 'x',
      };
    };
    const { context } = repoFor('stripe');
    const pipeline = (await loadRealPipeline(5)).factory(context);
    await pipeline.inventory('/unused', 'acme/shop');
    await pipeline.runTask(task, '/unused');
    expect(heldDuringTask).toBe(0);
  });
});

describe('real pipeline helpers', () => {
  it('finds a set provider’s folder by name', () => {
    expect(providerFolder('stripe', ['meta', 'stripe'])).toBe('stripe');
    expect(providerFolder('Meta', ['meta', 'stripe'])).toBe('meta');
    expect(providerFolder('anthropic', ['meta', 'stripe'])).toBeUndefined();
  });

  it('collects hints from usages the inventory named a little differently', () => {
    expect(
      hintsFor('openweathermap', [
        usage('OpenWeather', { hosts: ['api.openweathermap.org'] }),
        { ...usage('openweathermap'), sdk: { name: 'openweather-api-node', version: '3.1.0' } },
        usage('twilio', { packages: ['twilio'] }),
      ]),
    ).toEqual({
      packages: ['openweather-api-node'],
      hosts: ['api.openweathermap.org'],
      docsUrls: [],
    });
  });

  it('only reads a failed, empty, unspent record with the orchestrator’s note as unaffordable', () => {
    const record = (overrides: Partial<RunRecord & { note: string }>) =>
      ({
        taskId: 't',
        outcome: 'failed',
        diff: '',
        checks: [],
        costUsd: 0,
        transcriptPath: '',
        note: 'not attempted: $1.00 of the run cap left',
        ...overrides,
      }) as RunRecord;
    expect(unaffordableNote(record({}))).toMatch(/not attempted/);
    expect(unaffordableNote(record({ costUsd: 0.5 }))).toBeUndefined();
    expect(unaffordableNote(record({ note: 'runTask failed: boom' }))).toBeUndefined();
    expect(unaffordableNote(record({ outcome: 'needs-review', diff: '+x' }))).toBeUndefined();
  });
});
