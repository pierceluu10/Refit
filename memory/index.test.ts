import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalEmbedder, type JsonRequest, type Model } from './ai.ts';
import { makeRecord, makeTask } from './fixtures/tasks.ts';
import { createRetriever, learnFromRun, recordVerdict, renderMemoryForPrompt } from './index.ts';
import { JsonMemoryStore } from './store.ts';

// Fake model: extraction merges into the first stored recipe; skill writing returns a fixed block.
function fakeModel(store: JsonMemoryStore): Model {
  return {
    async json<T>({ schema }: JsonRequest): Promise<T> {
      const properties = (schema as { properties: Record<string, unknown> }).properties;
      if ('sameAsRecipeId' in properties) {
        const [existing] = await store.listRecipes();
        return {
          sameAsRecipeId: existing?.id ?? null,
          preconditions: 'Calls stripe.charges.create.',
          steps: 'Move to stripe.paymentIntents.create with confirm: true.',
          pitfalls: 'Handle requires_action.',
          diffSketch: '- charges.create\n+ paymentIntents.create',
        } as T;
      }
      if ('picks' in properties) {
        const [existing] = await store.listRecipes();
        return { picks: [{ id: existing.id, why: 'same change' }] } as T;
      }
      return { prompt: 'Skill: move Stripe Charges to PaymentIntents.' } as T;
    },
  };
}

describe('learnFromRun end to end', () => {
  it('distils runs, promotes a skill at 3 repos, retrieves it, and demotes it after 2 failures', async () => {
    const store = new JsonMemoryStore(await mkdtemp(join(tmpdir(), 'aptitude-memory-')));
    const deps = { store, embedder: new LocalEmbedder(), model: fakeModel(store) };

    for (const repo of ['example-org/a', 'example-org/b', 'example-org/c']) {
      await learnFromRun(
        { task: makeTask({ repo }), record: makeRecord(), transcript: 'ok' },
        deps,
      );
    }
    const [recipe] = await store.listRecipes();
    expect(recipe.verifiedRepos).toBe(3);
    expect(recipe.skill?.status).toBe('active');

    const retrieved = await createRetriever(deps)(makeTask({ repo: 'example-org/d' }));
    expect(retrieved.map((r) => r.id)).toEqual([recipe.id]);
    expect(renderMemoryForPrompt(retrieved)).toContain('Skill: move Stripe Charges');

    const failed = { task: makeTask(), usedRecipeIds: [recipe.id], transcript: '' };
    await learnFromRun({ ...failed, record: makeRecord({ outcome: 'failed' }) }, deps);
    const pr = 'https://github.com/example-org/e/pull/1';
    await learnFromRun({ ...failed, record: makeRecord({ outcome: 'needs-review', pr }) }, deps);
    expect((await store.getRecipe(recipe.id))?.skill?.status).toBe('active');

    const verdict = await recordVerdict(pr, 'closed', deps);
    expect(verdict?.demoted.map((r) => r.id)).toEqual([recipe.id]);
    expect(await store.getRecipe(recipe.id)).toBeDefined();
  });

  it('stores the run even without a model', async () => {
    const store = new JsonMemoryStore(await mkdtemp(join(tmpdir(), 'aptitude-memory-')));
    const result = await learnFromRun(
      { task: makeTask(), record: makeRecord(), transcript: 'ok' },
      { store, embedder: new LocalEmbedder() },
    );
    expect(result.recipe).toBeUndefined();
    expect(await store.listRuns()).toHaveLength(1);
  });
});
