import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DegradedOutputError, type JsonRequest, type Model } from './ai.ts';
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
  overrides: {
    transcript?: string;
    repo?: string;
    outcome?: 'needs-review' | 'failed' | 'verified' | 'waiting-budget';
    humanVerdict?: 'merged' | 'closed' | 'edited';
  } = {},
) {
  const store = new JsonMemoryStore(await mkdtemp(join(tmpdir(), 'refit-extract-')));
  const run = await store.recordRun({
    task: makeTask({ repo: overrides.repo ?? 'example-org/shop' }),
    record: makeRecord({
      outcome: overrides.outcome ?? 'verified',
      humanVerdict: overrides.humanVerdict,
    }),
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

  it('calls no model for a task that never ran, even with a recipe to attach a lesson to', async () => {
    const { store, run } = await setup({ outcome: 'waiting-budget' });
    await store.saveRecipe(makeRecipe());
    const { model } = fakeModel();

    expect(await extractRecipe(run, { store, model })).toBeUndefined();
    expect(model.json).not.toHaveBeenCalled();
  });

  it('retries once when the answer is degraded and marks the run done', async () => {
    const { store, run } = await setup();
    const { model: good } = fakeModel();
    const json = vi
      .fn()
      .mockRejectedValueOnce(new DegradedOutputError('stopped by a safety classifier'))
      .mockImplementation(good.json);

    const recipe = await extractRecipe(run, { store, model: { json }, now: () => NOW });

    expect(json).toHaveBeenCalledTimes(2);
    expect(await store.listRecipes()).toEqual([recipe]);
    expect((await store.getRun(run.id))?.extraction).toEqual({
      status: 'done',
      mode: 'recipe',
      recipeId: recipe!.id,
      at: NOW.toISOString(),
    });
  });

  it('saves no recipe and records why when the retry is degraded too', async () => {
    const { store, run } = await setup();
    await store.saveRecipe(makeRecipe());
    const placeholder = { sameAsRecipeId: 'recipe-stripe-charges', preconditions: 'x', steps: ' ' };
    const json = vi.fn().mockResolvedValue({ ...placeholder, pitfalls: 'x', diffSketch: '' });

    await expect(
      extractRecipe(run, { store, model: { json }, now: () => NOW }),
    ).rejects.toBeInstanceOf(DegradedOutputError);

    expect(json).toHaveBeenCalledTimes(2);
    expect(await store.listRecipes()).toEqual([makeRecipe()]);
    expect((await store.getRun(run.id))?.extraction).toEqual({
      status: 'failed',
      reason: 'Error: Extraction left steps, diffSketch blank',
      at: NOW.toISOString(),
    });
  });

  it('does not retry other errors but still records them on the run', async () => {
    const { store, run } = await setup();
    const json = vi.fn().mockRejectedValue(new Error('network down'));

    await expect(extractRecipe(run, { store, model: { json } })).rejects.toThrow('network down');

    expect(json).toHaveBeenCalledTimes(1);
    expect((await store.getRun(run.id))?.extraction?.status).toBe('failed');
  });

  it('distils a needs-review run a human merged into a full recipe', async () => {
    const { store, run } = await setup({ outcome: 'needs-review', humanVerdict: 'merged' });
    const { model, requests } = fakeModel();

    const recipe = await extractRecipe(run, { store, model });

    expect(recipe?.verifiedRepos).toBe(1);
    expect(requests[0].schema).toMatchObject({ required: expect.arrayContaining(['steps']) });
    expect(requests[0].prompt).toContain('Human verdict on the PR: merged');
    expect((await store.getRun(run.id))?.extraction).toMatchObject({ mode: 'recipe' });
  });

  it('lets a failed run add pitfalls only to the recipe the model names', async () => {
    const { store, run } = await setup({ outcome: 'failed' });
    await store.saveRecipe(makeRecipe({ embedding: { model: 'local', vector: [1] } }));
    const json = vi.fn().mockResolvedValue({
      sameAsRecipeId: 'recipe-stripe-charges',
      pitfalls: 'From a failed run: confirm: true needs a payment_method.',
      steps: 'ignored: a lesson may not rewrite steps',
    });

    const recipe = await extractRecipe(run, { store, model: { json } });

    expect(json.mock.calls[0][0].schema.required).toEqual(['sameAsRecipeId', 'pitfalls']);
    expect(recipe).toMatchObject({
      pitfalls: 'From a failed run: confirm: true needs a payment_method.',
      steps: makeRecipe().steps,
      repos: ['example-org/shop'],
      verifiedRepos: 1,
      sourceRuns: ['run-1', run.id],
    });
    expect(recipe).not.toHaveProperty('embedding');
    expect(await store.listRecipes()).toHaveLength(1);
  });

  it('never creates a recipe from an unsuccessful run', async () => {
    const { store, run } = await setup({ outcome: 'verified', humanVerdict: 'closed' });
    await store.saveRecipe(makeRecipe());
    const json = vi.fn().mockResolvedValue({ sameAsRecipeId: null, pitfalls: '' });

    expect(await extractRecipe(run, { store, model: { json } })).toBeUndefined();
    expect(await store.listRecipes()).toEqual([makeRecipe()]);
    expect((await store.getRun(run.id))?.extraction).toMatchObject({
      status: 'done',
      mode: 'pitfalls',
    });
  });
});
