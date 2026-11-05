import { describe, expect, it } from 'vitest';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Budget, BudgetExceededError, LocalEmbedder, cosine } from './ai.ts';
import { makeRecipe, makeRecord, makeTask } from './fixtures/tasks.ts';
import { JsonMemoryStore } from './store.ts';

async function tempStore() {
  return new JsonMemoryStore(await mkdtemp(join(tmpdir(), 'aptitude-memory-')));
}

describe('JsonMemoryStore', () => {
  it('records a run with its transcript and lists it back', async () => {
    const store = await tempStore();
    const transcriptPath = join(store.dir, 'transcript.txt');
    await writeFile(transcriptPath, 'agent: edited src/checkout.ts');
    const run = await store.recordRun({
      task: makeTask(),
      record: makeRecord({ transcriptPath }),
      usedRecipeIds: ['recipe-stripe-charges'],
    });

    expect(run.transcript).toBe('agent: edited src/checkout.ts');
    expect(await store.getRun(run.id)).toEqual(run);
    expect(await store.listRuns()).toEqual([run]);
  });

  it('records a human verdict by PR URL', async () => {
    const store = await tempStore();
    const pr = 'https://github.com/example-org/shop/pull/7';
    const run = await store.recordRun({ task: makeTask(), record: makeRecord({ pr }) });

    await store.recordVerdict(pr, 'merged');

    expect((await store.getRun(run.id))?.record.humanVerdict).toBe('merged');
    expect(await store.recordVerdict('https://example.invalid/none', 'closed')).toBeUndefined();
  });

  it('keeps the commit a run read', async () => {
    const store = await tempStore();
    const run = await store.recordRun({
      task: makeTask(),
      record: makeRecord(),
      commit: 'abc1234',
    });

    expect((await store.getRun(run.id))?.commit).toBe('abc1234');
  });

  it('keeps merged final and never lets a late edited replace a close', async () => {
    const store = await tempStore();
    const pr = 'https://github.com/example-org/shop/pull/8';
    const run = await store.recordRun({ task: makeTask(), record: makeRecord({ pr }) });
    const verdictAfter = async (verdict: 'merged' | 'closed' | 'edited') =>
      (await store.recordVerdict(pr, verdict))?.record.humanVerdict;

    expect(await verdictAfter('edited')).toBe('edited');
    expect(await verdictAfter('closed')).toBe('closed');
    expect(await verdictAfter('edited')).toBe('closed');
    expect(await verdictAfter('merged')).toBe('merged');
    // A redelivered close from before the reopen and merge.
    expect(await verdictAfter('closed')).toBe('merged');
    expect((await store.getRun(run.id))?.record.humanVerdict).toBe('merged');
  });

  it('keeps ids with path characters inside the store folder', async () => {
    const store = await tempStore();
    await store.saveRecipe(makeRecipe({ id: '../../escape/me' }));

    expect(await readdir(join(store.dir, 'recipes'))).toHaveLength(1);
    expect((await store.getRecipe('../../escape/me'))?.id).toBe('../../escape/me');
  });

  it('returns empty lists before anything is stored', async () => {
    const store = await tempStore();
    expect(await store.listRuns()).toEqual([]);
    expect(await store.listRecipes()).toEqual([]);
  });
});

describe('Budget', () => {
  it('refuses a call whose worst case crosses the cap', () => {
    const budget = new Budget(3);
    budget.charge(2.9);
    expect(() => budget.reserve(0.2)).toThrow(BudgetExceededError);
    expect(() => budget.reserve(0.05)).not.toThrow();
  });

  it('reads the cap from APTITUDE_AI_BUDGET_USD', () => {
    expect(Budget.fromEnv({ APTITUDE_AI_BUDGET_USD: '1.5' }).capUsd).toBe(1.5);
    expect(Budget.fromEnv({}).capUsd).toBe(0);
    expect(() => Budget.fromEnv({}).reserve(0.01)).toThrow(BudgetExceededError);
    expect(() => Budget.fromEnv({ APTITUDE_AI_BUDGET_USD: 'lots' })).toThrow();
  });
});

describe('LocalEmbedder', () => {
  it('puts related code closer than unrelated code', async () => {
    const [charges, intents, graphql] = await new LocalEmbedder().embed([
      'stripe.charges.create({ amount, source })',
      'stripe charges create amount source paymentIntents',
      'shopify admin graphql productUpdate mutation',
    ]);
    expect(cosine(charges, intents)).toBeGreaterThan(cosine(charges, graphql));
  });
});
