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

  it('distils a needs-review run into a recipe once a human merges its PR', async () => {
    const store = new JsonMemoryStore(await mkdtemp(join(tmpdir(), 'aptitude-memory-')));
    const deps = { store, embedder: new LocalEmbedder(), model: fakeModel(store) };
    const pr = 'https://github.com/example-org/shop/pull/9';

    const first = await learnFromRun(
      { task: makeTask(), record: makeRecord({ outcome: 'needs-review', pr }), transcript: '' },
      deps,
    );
    expect(first.recipe).toBeUndefined();

    const merged = await recordVerdict(pr, 'merged', deps);
    expect(merged?.recipe?.sourceRuns).toEqual([first.run.id]);

    const again = await recordVerdict(pr, 'edited', deps);
    expect(again?.recipe).toBeUndefined();
    expect(await store.listRecipes()).toHaveLength(1);
  });
});

describe('recordVerdict', () => {
  async function setup() {
    const store = new JsonMemoryStore(await mkdtemp(join(tmpdir(), 'aptitude-memory-')));
    return { store, deps: { store, embedder: new LocalEmbedder(), model: fakeModel(store) } };
  }
  const prFor = (repo: string) => `https://github.com/${repo}/pull/1`;

  it('distils merged needs-review runs into one recipe and promotes it at 3 repos', async () => {
    const { store, deps } = await setup();
    let last;
    for (const repo of ['example-org/a', 'example-org/b', 'example-org/c']) {
      const record = makeRecord({ outcome: 'needs-review', pr: prFor(repo) });
      await learnFromRun({ task: makeTask({ repo }), record, transcript: 'ok' }, deps);
      last = await recordVerdict(prFor(repo), 'merged', deps);
    }

    const [recipe] = await store.listRecipes();
    expect(recipe.repos).toEqual(['example-org/a', 'example-org/b', 'example-org/c']);
    expect(last?.promoted.map((r) => r.id)).toEqual([recipe.id]);
    expect(recipe.skill?.status).toBe('active');
  });

  it('counts a PR a human edited as a success and distils it', async () => {
    const { deps } = await setup();
    const pr = prFor('example-org/shop');
    await learnFromRun(
      { task: makeTask(), record: makeRecord({ outcome: 'needs-review', pr }), transcript: '' },
      deps,
    );

    const edited = await recordVerdict(pr, 'edited', deps);

    expect(edited?.run.record.humanVerdict).toBe('edited');
    expect(edited?.recipe?.repos).toEqual(['example-org/shop']);
  });

  it('counts a closed PR against the recipes its run used and takes its repo off the recipe it made', async () => {
    const { store, deps } = await setup();
    const verified = { outcome: 'verified' as const };
    for (const repo of ['example-org/a', 'example-org/b']) {
      const record = makeRecord({ ...verified, pr: prFor(repo) });
      await learnFromRun({ task: makeTask({ repo }), record, transcript: 'ok' }, deps);
    }
    const [made] = await store.listRecipes();
    expect(made.verifiedRepos).toBe(2);

    const usedPr = prFor('example-org/c');
    await learnFromRun(
      {
        task: makeTask({ repo: 'example-org/c' }),
        record: makeRecord({ outcome: 'needs-review', pr: usedPr }),
        transcript: '',
        usedRecipeIds: [made.id],
      },
      deps,
    );
    await recordVerdict(usedPr, 'closed', deps);
    await recordVerdict(prFor('example-org/b'), 'closed', deps);

    const recipe = await store.getRecipe(made.id);
    expect(recipe?.failedRunIds).toHaveLength(1);
    expect(recipe?.repos).toEqual(['example-org/a']);
    expect(renderMemoryForPrompt([recipe!])).toContain(
      'verified on 1 repos; 1 later run that used it failed or had the PR closed by a human',
    );
  });

  it('keeps a close when a late push event says edited', async () => {
    const { store, deps } = await setup();
    const pr = prFor('example-org/shop');
    await learnFromRun(
      { task: makeTask(), record: makeRecord({ outcome: 'needs-review', pr }), transcript: '' },
      deps,
    );

    await recordVerdict(pr, 'closed', deps);
    const late = await recordVerdict(pr, 'edited', deps);

    expect(late?.run.record.humanVerdict).toBe('closed');
    expect(late?.recipe).toBeUndefined();
    expect(await store.listRecipes()).toEqual([]);
  });

  it('returns undefined for a PR memory never stored', async () => {
    const { deps } = await setup();
    expect(await recordVerdict('https://github.com/example-org/x/pull/9', 'merged', deps)).toBe(
      undefined,
    );
  });
});
