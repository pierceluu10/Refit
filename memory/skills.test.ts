import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunRecord } from '../shared/types.ts';
import type { Model } from './ai.ts';
import { makeRecipe, makeRecord, makeTask } from './fixtures/tasks.ts';
import { promoteSkills, recordSkillOutcome } from './skills.ts';
import { JsonMemoryStore } from './store.ts';
import type { StoredRun } from './types.ts';

const PROMOTED_AT = new Date('2026-11-02T00:00:00.000Z');
const now = () => PROMOTED_AT;

async function tempStore() {
  return new JsonMemoryStore(await mkdtemp(join(tmpdir(), 'aptitude-skills-')));
}

function fakeModel(json: Model['json']): Model {
  return { json: vi.fn(json) as Model['json'] };
}

// Illustrative run, built directly so recordedAt can sit before or after promotion.
function makeRun(id: string, record: Partial<RunRecord>, recordedAt = '2026-11-03T00:00:00.000Z') {
  const run: StoredRun = {
    id,
    recordedAt,
    task: makeTask(),
    record: makeRecord(record),
    transcript: '',
    usedRecipeIds: ['recipe-stripe-charges'],
  };
  return run;
}

async function storeWithSkill() {
  const store = await tempStore();
  await store.saveRecipe(makeRecipe({ verifiedRepos: 3 }));
  await promoteSkills({ store, now });
  return store;
}

describe('promoteSkills', () => {
  it('promotes a recipe at 3 verified repos but not at 2', async () => {
    const store = await tempStore();
    await store.saveRecipe(makeRecipe({ id: 'two', verifiedRepos: 2 }));
    await store.saveRecipe(makeRecipe({ id: 'three', verifiedRepos: 3 }));

    const promoted = await promoteSkills({ store, now });

    expect(promoted.map((recipe) => recipe.id)).toEqual(['three']);
    expect((await store.getRecipe('three'))?.skill).toMatchObject({
      status: 'active',
      promotedAt: PROMOTED_AT.toISOString(),
      failedRunIds: [],
    });
    expect((await store.getRecipe('two'))?.skill).toBeUndefined();
  });

  it('uses the model prompt when a model is given', async () => {
    const store = await tempStore();
    await store.saveRecipe(makeRecipe({ verifiedRepos: 3 }));
    const model = fakeModel(async <T>() => ({ prompt: 'Prefer PaymentIntents.' }) as T);

    const [recipe] = await promoteSkills({ store, model, now });

    expect(recipe.skill?.prompt).toBe('Prefer PaymentIntents.');
    expect(model.json).toHaveBeenCalledTimes(1);
  });

  it('falls back to the template without a model or when the model throws', async () => {
    const store = await tempStore();
    await store.saveRecipe(makeRecipe({ id: 'a', verifiedRepos: 3 }));
    const [templated] = await promoteSkills({ store, now });

    await store.saveRecipe(makeRecipe({ id: 'b', verifiedRepos: 3 }));
    const model = fakeModel(async () => {
      throw new Error('model down');
    });
    const [fallback] = await promoteSkills({ store, model, now });

    expect(templated.skill?.prompt).toContain('verified on 3 repos');
    expect(templated.skill?.prompt).toContain('paymentIntents.create');
    expect(fallback.id).toBe('b');
    expect(fallback.skill?.prompt).toBe(templated.skill?.prompt);
  });

  it('does not re-promote a recipe that already has a skill', async () => {
    const store = await storeWithSkill();
    expect(await promoteSkills({ store, now })).toEqual([]);
  });
});

describe('recordSkillOutcome', () => {
  it('demotes after two distinct failed runs and keeps the recipe as guidance', async () => {
    const store = await storeWithSkill();

    expect(
      await recordSkillOutcome(makeRun('run-a', { outcome: 'failed' }), { store, now }),
    ).toEqual([]);
    const demoted = await recordSkillOutcome(makeRun('run-b', { outcome: 'failed' }), {
      store,
      now,
    });

    expect(demoted.map((recipe) => recipe.id)).toEqual(['recipe-stripe-charges']);
    const recipe = await store.getRecipe('recipe-stripe-charges');
    expect(recipe?.skill).toMatchObject({
      status: 'demoted',
      failedRunIds: ['run-a', 'run-b'],
      demotedAt: PROMOTED_AT.toISOString(),
    });
    expect((await store.listRecipes()).map((r) => r.id)).toEqual(['recipe-stripe-charges']);
    expect(await promoteSkills({ store, now })).toEqual([]);
  });

  it('counts the same run once across two calls', async () => {
    const store = await storeWithSkill();
    const run = makeRun('run-a', { outcome: 'failed' });

    await recordSkillOutcome(run, { store, now });
    await recordSkillOutcome(
      { ...run, record: { ...run.record, humanVerdict: 'closed' } },
      { store, now },
    );

    expect((await store.getRecipe('recipe-stripe-charges'))?.skill).toMatchObject({
      status: 'active',
      failedRunIds: ['run-a'],
    });
  });

  it('ignores a run recorded before the skill was promoted', async () => {
    const store = await storeWithSkill();
    await recordSkillOutcome(makeRun('old', { outcome: 'failed' }, '2026-11-01T00:00:00.000Z'), {
      store,
      now,
    });

    expect((await store.getRecipe('recipe-stripe-charges'))?.skill?.failedRunIds).toEqual([]);
  });

  it('counts a closed PR as a failure and a verified run as not', async () => {
    const store = await storeWithSkill();
    await recordSkillOutcome(makeRun('ok', { outcome: 'verified', humanVerdict: 'merged' }), {
      store,
      now,
    });
    await recordSkillOutcome(makeRun('closed', { outcome: 'verified', humanVerdict: 'closed' }), {
      store,
      now,
    });

    expect((await store.getRecipe('recipe-stripe-charges'))?.skill?.failedRunIds).toEqual([
      'closed',
    ]);
  });
});
