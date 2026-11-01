import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Budget } from '../../orchestrator/budget.ts';
import type { RepoEntry } from '../sets/index.ts';
import { loadRealPipeline } from './real.ts';

// Each fake part spends a fixed amount from the run budget, as the real ones do.
vi.mock('../../orchestrator/deps.ts', () => ({
  createDeps: ({ budget }: { budget: Budget }) => ({
    inventory: async () => {
      budget.chargeUsd(0.25);
      return [];
    },
    match: async ({ repo }: { repo: string }) => {
      budget.chargeUsd(0.0625);
      return {
        tasks: [],
        notAffected: [{ changeId: 'c1', reasoning: `${repo} never calls it` }],
        costUsd: 0.0625,
      };
    },
  }),
  providerWatcher: (_id: string, budget: Budget) => async () => {
    budget.chargeUsd(0.125);
    return [];
  },
}));

afterEach(() => vi.unstubAllEnvs());

function repoFor(provider: string) {
  const charges: [number, string][] = [];
  const meter = { charge: (usd: number, label: string) => void charges.push([usd, label]) };
  return { charges, context: { entry: { repo: 'acme/shop' } as RepoEntry, provider, meter } };
}

describe('loadRealPipeline', () => {
  it('refuses to start without ANTHROPIC_API_KEY', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    await expect(loadRealPipeline(5)).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it('charges each repo for what its calls spent and keeps the match reasoning', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-not-a-real-key');
    const { charges, context } = repoFor('stripe');
    const pipeline = (await loadRealPipeline(5))(context);

    await pipeline.inventory('/unused', 'acme/shop');
    await pipeline.watch();
    const matched = await pipeline.match([], []);

    expect(matched).toEqual({ tasks: [], reasoning: 'c1: not affected: acme/shop never calls it' });
    expect(charges).toEqual([
      [0.25, 'inventory'],
      [0.125, 'watch'],
      [0.0625, 'match'],
    ]);
  });

  it('stops a provider with no changelog watcher before it spends', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-not-a-real-key');
    const { charges, context } = repoFor('anthropic');
    const pipeline = (await loadRealPipeline(5))(context);

    await expect(pipeline.inventory('/unused', 'acme/shop')).rejects.toThrow(
      /no changelog watcher for anthropic/,
    );
    expect(charges).toEqual([]);
  });
});
