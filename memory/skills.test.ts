import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunRecord } from '../shared/types.ts';
import type { Model } from './ai.ts';
import { makeRecipe, makeRecord, makeTask } from './fixtures/tasks.ts';
import { promoteSkills, recordRecipeOutcome } from './skills.ts';
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

const closed: Partial<RunRecord> = { outcome: 'needs-review', humanVerdict: 'closed' };

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

describe('recordRecipeOutcome', () => {
  it('demotes after two distinct closed PRs and keeps the recipe as guidance', async () => {
    const store = await storeWithSkill();

    expect(await recordRecipeOutcome(makeRun('run-a', closed), { store, now })).toEqual([]);
    const demoted = await recordRecipeOutcome(makeRun('run-b', closed), { store, now });

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
    const run = makeRun('run-a', closed);

    await recordRecipeOutcome(run, { store, now });
    await recordRecipeOutcome(run, { store, now });

    expect((await store.getRecipe('recipe-stripe-charges'))?.skill).toMatchObject({
      status: 'active',
      failedRunIds: ['run-a'],
    });
  });

  it('ignores a run recorded before the skill was promoted', async () => {
    const store = await storeWithSkill();
    await recordRecipeOutcome(makeRun('old', closed, '2026-11-01T00:00:00.000Z'), { store, now });

    expect((await store.getRecipe('recipe-stripe-charges'))?.skill?.failedRunIds).toEqual([]);
  });

  it('counts a closed PR as a failure and a verified run as not', async () => {
    const store = await storeWithSkill();
    await recordRecipeOutcome(makeRun('ok', { outcome: 'verified', humanVerdict: 'merged' }), {
      store,
      now,
    });
    await recordRecipeOutcome(makeRun('closed', { outcome: 'verified', humanVerdict: 'closed' }), {
      store,
      now,
    });

    expect((await store.getRecipe('recipe-stripe-charges'))?.skill?.failedRunIds).toEqual([
      'closed',
    ]);
  });

  it('never counts a harness failure, which means nothing was attempted', async () => {
    const store = await storeWithSkill();
    await recordRecipeOutcome(makeRun('model-down', { outcome: 'failed', diff: '' }), {
      store,
      now,
    });

    const recipe = await store.getRecipe('recipe-stripe-charges');
    expect(recipe?.failedRunIds).toBeUndefined();
    expect(recipe?.skill?.failedRunIds).toEqual([]);
  });

  it('counts a closed PR against every recipe its run used, skill or not', async () => {
    const store = await tempStore();
    await store.saveRecipe(makeRecipe());
    await store.saveRecipe(makeRecipe({ id: 'other' }));
    const run = makeRun('closed', { outcome: 'needs-review', humanVerdict: 'closed' });

    await recordRecipeOutcome(
      { ...run, usedRecipeIds: ['recipe-stripe-charges', 'other'] },
      {
        store,
        now,
      },
    );
    await recordRecipeOutcome(makeRun('fine', { outcome: 'verified' }), { store, now });

    expect((await store.getRecipe('recipe-stripe-charges'))?.failedRunIds).toEqual(['closed']);
    expect((await store.getRecipe('other'))?.failedRunIds).toEqual(['closed']);
  });

  it('counts a run that could not verify on a green baseline, but not one on a red baseline', async () => {
    const store = await tempStore();
    await store.saveRecipe(makeRecipe());
    const green = makeRun('green', { outcome: 'needs-review' });
    const red = makeRun('red', {
      outcome: 'needs-review',
      checks: [{ name: 'tsc', before: 'fail (6)', after: 'fail (6)' }],
    });
    // The agent's proof test fails on the untouched baseline because it is new; the repo is green.
    const tested = makeRun('tested', {
      outcome: 'needs-review',
      checks: [
        { name: 'tsc', before: 'pass', after: 'pass' },
        { name: 'proof', before: 'fail (1)', after: 'fail (1)' },
      ],
    });
    tested.record = { ...tested.record, agentChecks: [{ name: 'proof' }] } as RunRecord;
    await recordRecipeOutcome(green, { store, now });
    await recordRecipeOutcome(red, { store, now });
    await recordRecipeOutcome(tested, { store, now });
    expect((await store.getRecipe('recipe-stripe-charges'))?.failedRunIds).toEqual([
      'green',
      'tested',
    ]);

    // A human merging that PR after all takes the failure back.
    await recordRecipeOutcome(
      { ...green, record: { ...green.record, humanVerdict: 'merged' } },
      { store, now },
    );
    expect((await store.getRecipe('recipe-stripe-charges'))?.failedRunIds).toEqual(['tested']);
  });

  it('takes a failure back when a later verdict reverses it', async () => {
    const store = await storeWithSkill();
    const closed = makeRun('reopened', { outcome: 'needs-review', humanVerdict: 'closed' });
    await recordRecipeOutcome(closed, { store, now });
    expect((await store.getRecipe('recipe-stripe-charges'))?.skill?.failedRunIds).toEqual([
      'reopened',
    ]);

    await recordRecipeOutcome(
      { ...closed, record: { ...closed.record, humanVerdict: 'merged' } },
      { store, now },
    );

    const recipe = await store.getRecipe('recipe-stripe-charges');
    expect(recipe?.failedRunIds).toEqual([]);
    expect(recipe?.skill).toMatchObject({ status: 'active', failedRunIds: [] });
  });

  it('writes nothing for a run that changes no count', async () => {
    const store = await tempStore();
    await store.saveRecipe(makeRecipe());
    const save = vi.spyOn(store, 'saveRecipe');

    await recordRecipeOutcome(makeRun('fine', { outcome: 'verified' }), { store, now });

    expect(save).not.toHaveBeenCalled();
  });
});

describe('recordRecipeOutcome on the recipe a run was distilled into', () => {
  // Illustrative: a verified run from example-org/c that became one of the recipe's three repos.
  async function storeWithSource(otherFromSameRepo?: Partial<RunRecord>, distilledInto?: string) {
    const store = await tempStore();
    const sourceRuns = ['run-a', 'run-b', 'run-c'];
    const repos = ['example-org/a', 'example-org/b', 'example-org/c'];
    await store.saveRecipe(makeRecipe({ sourceRuns, repos, verifiedRepos: 3 }));
    if (otherFromSameRepo) {
      await store.saveRun({
        ...makeRun('run-b', otherFromSameRepo),
        task: makeTask({ repo: 'example-org/c' }),
        ...(distilledInto && {
          extraction: {
            status: 'done',
            mode: 'recipe',
            recipeId: distilledInto,
            at: '2026-11-03T00:00:00.000Z',
          },
        }),
      });
    }
    const run: StoredRun = {
      ...makeRun('run-c', { outcome: 'verified', humanVerdict: 'closed' }),
      task: makeTask({ repo: 'example-org/c' }),
      usedRecipeIds: [],
      extraction: {
        status: 'done',
        mode: 'recipe',
        recipeId: 'recipe-stripe-charges',
        at: '2026-11-03T00:00:00.000Z',
      },
    };
    return { store, run };
  }

  it('takes the repo of a closed verified PR off the recipe, and puts it back on a later merge', async () => {
    const { store, run } = await storeWithSource();

    await recordRecipeOutcome(run, { store, now });
    expect(await store.getRecipe('recipe-stripe-charges')).toMatchObject({
      repos: ['example-org/a', 'example-org/b'],
      verifiedRepos: 2,
    });

    await recordRecipeOutcome(
      { ...run, record: { ...run.record, humanVerdict: 'merged' } },
      { store, now },
    );
    expect(await store.getRecipe('recipe-stripe-charges')).toMatchObject({
      repos: ['example-org/a', 'example-org/b', 'example-org/c'],
      verifiedRepos: 3,
    });
  });

  it('keeps the repo while another successful run from it still backs the recipe', async () => {
    const { store, run } = await storeWithSource({ outcome: 'verified' }, 'recipe-stripe-charges');

    await recordRecipeOutcome(run, { store, now });

    expect((await store.getRecipe('recipe-stripe-charges'))?.verifiedRepos).toBe(3);
  });

  it('does not let a run distilled into another recipe back this one', async () => {
    const { store, run } = await storeWithSource({ outcome: 'verified' }, 'some-other-recipe');

    await recordRecipeOutcome(run, { store, now });

    expect((await store.getRecipe('recipe-stripe-charges'))?.verifiedRepos).toBe(2);
  });
});
