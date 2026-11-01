import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RetrieveRecipes } from '../shared/types.ts';
import { LocalEmbedder, type JsonRequest, type Model } from './ai.ts';
import { makeRecipe, makeTask } from './fixtures/tasks.ts';
import { createRetriever, renderMemoryForPrompt } from './retrieve.ts';
import { JsonMemoryStore } from './store.ts';

// Illustrative recipes: one related to the Stripe charges fixture task, two unrelated.
const shopify = makeRecipe({
  id: 'recipe-shopify-graphql',
  provider: 'shopify',
  kind: 'rest-to-graphql',
  preconditions: 'Code calls the Shopify Admin REST products endpoint.',
  steps: '1. Rewrite GET /admin/api/products.json as a GraphQL products query.',
  pitfalls: 'GraphQL ids are gid:// strings, not numbers.',
  diffSketch:
    "- shopify.rest.Product.all()\n+ shopify.graphql('{ products(first: 50) { nodes { id } } }')",
});
const openai = makeRecipe({
  id: 'recipe-openai-model',
  provider: 'openai',
  kind: 'model-retirement',
  preconditions: 'Code pins a retired chat completion model name.',
  steps: '1. Swap the model name for its documented successor.',
  pitfalls: 'Token limits and output formatting can differ.',
  diffSketch: "- model: 'gpt-old'\n+ model: 'gpt-new'",
});
const stripe = makeRecipe();

async function storeWith(...recipes: ReturnType<typeof makeRecipe>[]) {
  const store = new JsonMemoryStore(await mkdtemp(join(tmpdir(), 'aptitude-retrieve-')));
  for (const recipe of recipes) await store.saveRecipe(recipe);
  return store;
}

function fakeModel(picks: { id: string; why: string }[]) {
  const requests: JsonRequest[] = [];
  const model: Model = {
    async json<T>(request: JsonRequest) {
      requests.push(request);
      return { picks } as T;
    },
  };
  return { model, requests };
}

describe('createRetriever', () => {
  it('returns nothing from an empty store', async () => {
    const retrieve: RetrieveRecipes = createRetriever({
      store: await storeWith(),
      embedder: new LocalEmbedder(),
    });
    expect(await retrieve(makeTask())).toEqual([]);
  });

  it('ranks the related recipe first by embedding when there is no model', async () => {
    const retrieve = createRetriever({
      store: await storeWith(shopify, openai, stripe),
      embedder: new LocalEmbedder(),
    });
    const ids = (await retrieve(makeTask())).map((recipe) => recipe.id);
    expect(ids[0]).toBe('recipe-stripe-charges');
    expect(ids).toHaveLength(3);
  });

  it('caches recipe embeddings on the recipe', async () => {
    const local = new LocalEmbedder();
    const embedder = { name: local.name, embed: vi.fn((texts: string[]) => local.embed(texts)) };
    const store = await storeWith(shopify, openai, stripe);
    const retrieve = createRetriever({ store, embedder });

    await retrieve(makeTask());
    await retrieve(makeTask());

    expect(embedder.embed.mock.calls.map(([texts]) => texts.length)).toEqual([4, 1]);
    expect((await store.getRecipe(stripe.id))?.embedding?.model).toBe(local.name);
  });

  it("follows the model's picks and order, drops unknown ids and respects the limit", async () => {
    const { model, requests } = fakeModel([
      { id: 'recipe-openai-model', why: 'same migration shape' },
      { id: 'recipe-made-up', why: 'not a candidate' },
      { id: 'recipe-openai-model', why: 'duplicate' },
      { id: 'recipe-shopify-graphql', why: 'second' },
      { id: 'recipe-stripe-charges', why: 'over the limit' },
    ]);
    const retrieve = createRetriever({
      store: await storeWith(shopify, openai, stripe),
      embedder: new LocalEmbedder(),
      model,
      limit: 2,
    });

    const ids = (await retrieve(makeTask())).map((recipe) => recipe.id);

    expect(ids).toEqual(['recipe-openai-model', 'recipe-shopify-graphql']);
    expect(requests).toHaveLength(1);
    for (const id of ['recipe-stripe-charges', 'recipe-shopify-graphql', 'recipe-openai-model']) {
      expect(requests[0].prompt).toContain(id);
    }
    expect(requests[0].schema).toMatchObject({ additionalProperties: false });
  });

  it('shows the judge how many PRs that used a recipe were closed, without filtering it out', async () => {
    const struggling = makeRecipe({ failedRunIds: ['run-x', 'run-y'] });
    const { model, requests } = fakeModel([{ id: struggling.id, why: 'still the closest match' }]);
    const retrieve = createRetriever({
      store: await storeWith(struggling),
      embedder: new LocalEmbedder(),
      model,
    });

    expect((await retrieve(makeTask())).map((recipe) => recipe.id)).toEqual([struggling.id]);
    expect(requests[0].prompt).toContain(
      'verified on 1 repos; 2 later PRs that used it closed by a human without merging',
    );
  });

  it('shows the model every recipe while the store is small, and a shortlist once it is not', async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      makeRecipe({ id: `recipe-unrelated-${i}`, provider: 'twilio', steps: `step ${i}` }),
    );
    const store = await storeWith(...many);
    const small = fakeModel([]);
    await createRetriever({ store, embedder: new LocalEmbedder(), model: small.model })(makeTask());
    for (const recipe of many) expect(small.requests[0].prompt).toContain(recipe.id);

    const big = fakeModel([]);
    await createRetriever({
      store,
      embedder: new LocalEmbedder(),
      model: big.model,
      judgeAllUpTo: 10,
      candidates: 4,
    })(makeTask());
    const shown = many.filter((recipe) => big.requests[0].prompt.includes(`### ${recipe.id}\n`));
    expect(shown).toHaveLength(4);
  });

  it('falls back to embedding order when the model throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const model: Model = { json: () => Promise.reject(new Error('model down')) };
    const retrieve = createRetriever({
      store: await storeWith(shopify, openai, stripe),
      embedder: new LocalEmbedder(),
      model,
      limit: 1,
    });

    expect((await retrieve(makeTask())).map((recipe) => recipe.id)).toEqual([
      'recipe-stripe-charges',
    ]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns nothing instead of throwing when the embedder fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const retrieve = createRetriever({
      store: await storeWith(stripe),
      embedder: { name: 'broken', embed: () => Promise.reject(new Error('offline')) },
    });

    expect(await retrieve(makeTask())).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('renderMemoryForPrompt', () => {
  it('returns an empty string for no recipes', () => {
    expect(renderMemoryForPrompt([])).toBe('');
  });

  it('puts active skills before plain recipes', () => {
    const skill = makeRecipe({
      id: 'recipe-skill',
      verifiedRepos: 4,
      skill: {
        status: 'active',
        prompt: 'Move every charges.create to paymentIntents.create.',
        promotedAt: '2026-11-01T00:00:00.000Z',
        failedRunIds: [],
      },
    });

    const text = renderMemoryForPrompt([shopify, skill]);

    expect(text.startsWith('## Memory from past runs')).toBe(true);
    expect(text.indexOf('### Proven skill (verified on 4 repos)')).toBeLessThan(
      text.indexOf('### Recipe: shopify rest-to-graphql (verified on 1 repos)'),
    );
    expect(text).toContain('Move every charges.create to paymentIntents.create.');
    expect(text).toContain('```diff\n- shopify.rest.Product.all()');
  });
});
