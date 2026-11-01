import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonRequest, Model } from './ai.ts';
import { extractRecipe } from './extract.ts';
import { makeRecipe, makeRecord, makeTask } from './fixtures/tasks.ts';
import { JsonMemoryStore } from './store.ts';

const NOW = new Date('2026-11-02T00:00:00.000Z');

function fakeModel(sameAsRecipeId: string | null = null) {
  const requests: JsonRequest[] = [];
  const model: Model = {
    json: vi.fn(async (request: JsonRequest) => {
      requests.push(request);
      return {
        sameAsRecipeId,
        preconditions: 'Code calls charges.create with a card source.',
        steps: 'Move to paymentIntents.create with payment_method and confirm: true.',
        pitfalls: 'PaymentIntents rejects source; store the PaymentIntent id.',
        diffSketch: '- charges.create({ source })\n+ paymentIntents.create({ payment_method })',
      } as never;
    }),
  };
  return { model, requests };
}

async function setup(
  overrides: { transcript?: string; repo?: string; outcome?: 'needs-review' } = {},
) {
  const store = new JsonMemoryStore(await mkdtemp(join(tmpdir(), 'aptitude-extract-')));
  const run = await store.recordRun({
    task: makeTask({ repo: overrides.repo ?? 'example-org/shop' }),
    record: makeRecord({ outcome: overrides.outcome ?? 'verified' }),
    transcript: overrides.transcript ?? '[agent] tried source on paymentIntents; typecheck failed.',
  });
  return { store, run };
}

describe('extractRecipe', () => {
  it('skips runs that were not verified without calling the model', async () => {
    const { store, run } = await setup({ outcome: 'needs-review' });
    const { model } = fakeModel();

    expect(await extractRecipe(run, { store, model })).toBeUndefined();
    expect(model.json).not.toHaveBeenCalled();
    expect(await store.listRecipes()).toEqual([]);
  });

  it('creates a new recipe linked to its run from one strict-schema model pass', async () => {
    const { store, run } = await setup();
    await store.saveRecipe(makeRecipe({ id: 'recipe-shopify', provider: 'shopify' }));
    const { model, requests } = fakeModel();

    const recipe = await extractRecipe(run, { store, model, now: () => NOW });

    expect(recipe).toMatchObject({
      provider: 'stripe',
      kind: 'endpoint-removed',
      sourceRuns: [run.id],
      repos: ['example-org/shop'],
      verifiedRepos: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      steps: 'Move to paymentIntents.create with payment_method and confirm: true.',
    });
    expect(recipe?.id).toMatch(/^recipe-stripe-endpoint-removed-[0-9a-f]{8}$/);
    expect(recipe).not.toHaveProperty('sameAsRecipeId');
    expect(await store.getRecipe(recipe!.id)).toEqual(recipe);

    expect(requests).toHaveLength(1);
    const { prompt, schema } = requests[0];
    expect(schema).toMatchObject({ additionalProperties: false });
    expect(prompt).toContain('charges.create');
    expect(prompt).toContain(run.record.diff);
    expect(prompt).toContain('typecheck failed');
    expect(prompt).not.toContain('recipe-shopify');
  });

  it('merges into the recipe the model names, deduping repos and dropping the stale embedding', async () => {
    const { store, run } = await setup();
    const skill = {
      status: 'active' as const,
      prompt: 'skill',
      promotedAt: '2026-11-01T00:00:00.000Z',
      failedRunIds: [],
    };
    await store.saveRecipe(makeRecipe({ embedding: { model: 'local', vector: [1, 0] }, skill }));
    const { model, requests } = fakeModel('recipe-stripe-charges');

    const sameRepo = await extractRecipe(run, { store, model, now: () => NOW });

    expect(requests[0].prompt).toContain('recipe-stripe-charges');
    expect(sameRepo).toMatchObject({
      id: 'recipe-stripe-charges',
      sourceRuns: ['run-1', run.id],
      repos: ['example-org/shop'],
      verifiedRepos: 1,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: NOW.toISOString(),
      pitfalls: 'PaymentIntents rejects source; store the PaymentIntent id.',
      skill,
    });
    expect(sameRepo).not.toHaveProperty('embedding');

    const other = await setup({ repo: 'example-org/billing' });
    await other.store.saveRecipe(sameRepo!);
    const newRepo = await extractRecipe(other.run, { store: other.store, model, now: () => NOW });

    expect(newRepo?.repos).toEqual(['example-org/shop', 'example-org/billing']);
    expect(newRepo?.verifiedRepos).toBe(2);
    expect(await other.store.listRecipes()).toHaveLength(1);
  });

  it('creates a new recipe when the model names an unknown recipe id', async () => {
    const { store, run } = await setup();
    await store.saveRecipe(makeRecipe());
    const { model } = fakeModel('recipe-that-does-not-exist');

    const recipe = await extractRecipe(run, { store, model, now: () => NOW });

    expect(recipe?.id).toMatch(/^recipe-stripe-endpoint-removed-/);
    expect(recipe?.sourceRuns).toEqual([run.id]);
    expect(await store.getRecipe('recipe-stripe-charges')).toEqual(makeRecipe());
    expect(await store.listRecipes()).toHaveLength(2);
  });

  it('keeps the head and tail of a huge transcript and tells the model what was elided', async () => {
    const transcript = `HEAD-MARKER${'x'.repeat(700_000)}TAIL-MARKER`;
    const { store, run } = await setup({ transcript });
    const { model, requests } = fakeModel();

    await extractRecipe(run, { store, model });

    const { prompt } = requests[0];
    expect(prompt).toContain('HEAD-MARKER');
    expect(prompt).toContain('TAIL-MARKER');
    expect(prompt).toContain(`${transcript.length - 600_000} characters elided`);
    expect(prompt.length).toBeLessThan(610_000);
  });
});
