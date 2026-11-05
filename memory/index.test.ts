import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LocalEmbedder, type JsonRequest, type Model } from './ai.ts';
import { makeRecord, makeTask } from './fixtures/tasks.ts';
import {
  createRetriever,
  learnFromRun,
  recordEvidence,
  recordVerdict,
  renderMemoryForPrompt,
} from './index.ts';
import { JsonMemoryStore } from './store.ts';

// A needs-review run on a repo already failing its checks: only a human verdict says anything about
// the recipes it used.
const redBaseline = [{ name: 'tsc', before: 'fail (2)', after: 'fail (2)' }];

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
        {
          task: makeTask({ repo }),
          record: makeRecord({ humanVerdict: 'merged' }),
          transcript: 'ok',
        },
        deps,
      );
    }
    const [recipe] = await store.listRecipes();
    expect(recipe.verifiedRepos).toBe(3);
    expect(recipe.skill?.status).toBe('active');

    const retrieved = await createRetriever(deps)(makeTask({ repo: 'example-org/d' }));
    expect(retrieved.map((r) => r.id)).toEqual([recipe.id]);
    expect(renderMemoryForPrompt(retrieved)).toContain('Skill: move Stripe Charges');

    const used = { task: makeTask(), usedRecipeIds: [recipe.id], transcript: '' };
    const [first, second] = ['e', 'f'].map(
      (repo) => `https://github.com/example-org/${repo}/pull/1`,
    );
    await learnFromRun({ ...used, record: makeRecord({ outcome: 'failed' }) }, deps);
    for (const pr of [first, second]) {
      await learnFromRun(
        { ...used, record: makeRecord({ outcome: 'needs-review', checks: redBaseline, pr }) },
        deps,
      );
    }
    await recordVerdict(first, 'closed', deps);
    expect((await store.getRecipe(recipe.id))?.skill?.status).toBe('active');

    const verdict = await recordVerdict(second, 'closed', deps);
    expect(verdict?.demoted.map((r) => r.id)).toEqual([recipe.id]);
    expect(await store.getRecipe(recipe.id)).toBeDefined();
  });

  it('keeps every count when runs from parallel repos learn at once', async () => {
    const store = new JsonMemoryStore(await mkdtemp(join(tmpdir(), 'aptitude-memory-')));
    const deps = { store, embedder: new LocalEmbedder(), model: fakeModel(store) };

    await Promise.all(
      ['example-org/a', 'example-org/b', 'example-org/c'].map((repo) =>
        learnFromRun(
          {
            task: makeTask({ repo }),
            record: makeRecord({ humanVerdict: 'merged' }),
            transcript: 'ok',
          },
          deps,
        ),
      ),
    );

    const recipes = await store.listRecipes();
    expect(recipes).toHaveLength(1);
    expect(recipes[0].verifiedRepos).toBe(3);
    expect(recipes[0].skill?.status).toBe('active');
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
      {
        task: makeTask(),
        record: makeRecord({ outcome: 'needs-review', checks: redBaseline, pr }),
        transcript: '',
      },
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
      const record = makeRecord({ outcome: 'needs-review', checks: redBaseline, pr: prFor(repo) });
      await learnFromRun({ task: makeTask({ repo }), record, transcript: 'ok' }, deps);
      last = await recordVerdict(prFor(repo), 'merged', deps);
    }

    const [recipe] = await store.listRecipes();
    expect(recipe.repos).toEqual(['example-org/a', 'example-org/b', 'example-org/c']);
    expect(last?.promoted.map((r) => r.id)).toEqual([recipe.id]);
    expect(recipe.skill?.status).toBe('active');
  });

  it('does not count an edit as a success on its own; the merge after it does, and keeps the edit', async () => {
    const { deps } = await setup();
    const pr = prFor('example-org/shop');
    await learnFromRun(
      {
        task: makeTask(),
        record: makeRecord({ outcome: 'needs-review', checks: redBaseline, pr }),
        transcript: '',
      },
      deps,
    );

    const edited = await recordVerdict(pr, 'edited', deps);
    expect(edited?.recipe).toBeUndefined();

    const merged = await recordVerdict(pr, 'merged', deps);
    expect(merged?.run.evidence).toMatchObject({ edited: true, merged: {} });
    expect(merged?.recipe?.repos).toEqual(['example-org/shop']);
  });

  it('counts a revert against the fix: its repo leaves the recipe and its recipes hear of it', async () => {
    const { store, deps } = await setup();
    const repo = 'example-org/a';
    const record = makeRecord({ pr: prFor(repo), humanVerdict: 'merged' });
    await learnFromRun({ task: makeTask({ repo }), record, transcript: 'ok' }, deps);
    const [made] = await store.listRecipes();
    expect(made.verifiedRepos).toBe(1);

    const at = '2026-11-04T00:00:00.000Z';
    await recordEvidence(prFor(repo), { reverted: { at, via: 'rescan' } }, deps);

    const after = await store.getRecipe(made.id);
    expect(after).toMatchObject({ verifiedRepos: 0, confidence: 'low' });
  });

  it('sends what a person changed back to learning, and a redelivery changes nothing', async () => {
    const { store, deps } = await setup();
    const pr = prFor('example-org/shop');
    const record = makeRecord({ pr, humanVerdict: 'merged' });
    await learnFromRun({ task: makeTask(), record, transcript: 'ok' }, deps);
    const at = '2026-11-04T00:00:00.000Z';
    const evidence = { merged: { at, humanDiff: 'diff --git a/x b/x\n-a\n+b\n' } };

    const first = await recordEvidence(pr, evidence, deps);
    expect(first?.run.extraction).toBeUndefined();
    expect(first?.run.evidence?.merged?.humanDiff).toContain('+b');

    const later = { merged: { at: '2026-11-05T00:00:00.000Z', humanDiff: 'other' } };
    const redelivered = await recordEvidence(pr, later, deps);
    expect(redelivered?.run.evidence?.merged).toEqual(evidence.merged);
    expect(await store.listRuns()).toHaveLength(1);
  });

  it('counts a closed PR against the recipes its run used and takes its repo off the recipe it made', async () => {
    const { store, deps } = await setup();
    const verified = { outcome: 'verified' as const };
    for (const repo of ['example-org/a', 'example-org/b']) {
      const record = makeRecord({ ...verified, pr: prFor(repo), humanVerdict: 'merged' });
      await learnFromRun({ task: makeTask({ repo }), record, transcript: 'ok' }, deps);
    }
    const [made] = await store.listRecipes();
    expect(made.verifiedRepos).toBe(2);

    const usedPr = prFor('example-org/c');
    await learnFromRun(
      {
        task: makeTask({ repo: 'example-org/c' }),
        record: makeRecord({ outcome: 'needs-review', checks: redBaseline, pr: usedPr }),
        transcript: '',
        usedRecipeIds: [made.id],
      },
      deps,
    );
    await recordVerdict(usedPr, 'closed', deps);
    const at = '2026-11-04T00:00:00.000Z';
    await recordEvidence(prFor('example-org/b'), { reverted: { at, via: 'revert' } }, deps);

    const recipe = await store.getRecipe(made.id);
    expect(recipe?.failedRunIds).toHaveLength(1);
    expect(recipe?.repos).toEqual(['example-org/a']);
    expect(renderMemoryForPrompt([recipe!])).toContain(
      'verified on 1 repos; 1 later run that used it failed',
    );
  });

  it('demotes a skill once two PRs that used it are closed', async () => {
    const { store, deps } = await setup();
    for (const repo of ['example-org/a', 'example-org/b', 'example-org/c']) {
      await learnFromRun(
        {
          task: makeTask({ repo }),
          record: makeRecord({ humanVerdict: 'merged' }),
          transcript: 'ok',
        },
        deps,
      );
    }
    const [skill] = await store.listRecipes();
    expect(skill.skill?.status).toBe('active');

    const demoted = [];
    for (const repo of ['example-org/d', 'example-org/e']) {
      const pr = prFor(repo);
      const record = makeRecord({ outcome: 'needs-review', checks: redBaseline, pr });
      const task = makeTask({ repo });
      await learnFromRun({ task, record, transcript: '', usedRecipeIds: [skill.id] }, deps);
      demoted.push(...((await recordVerdict(pr, 'closed', deps))?.demoted ?? []));
    }

    expect(demoted.map((recipe) => recipe.id)).toEqual([skill.id]);
    expect((await store.getRecipe(skill.id))?.skill?.status).toBe('demoted');
  });

  it('keeps a close when a late push event says edited', async () => {
    const { store, deps } = await setup();
    const pr = prFor('example-org/shop');
    await learnFromRun(
      {
        task: makeTask(),
        record: makeRecord({ outcome: 'needs-review', checks: redBaseline, pr }),
        transcript: '',
      },
      deps,
    );

    await recordVerdict(pr, 'closed', deps);
    const late = await recordVerdict(pr, 'edited', deps);

    expect(late?.run.record.humanVerdict).toBe('closed');
    expect(late?.recipe).toBeUndefined();
    expect(await store.listRecipes()).toEqual([]);
  });

  it('writes a verdict at once, even while learning is busy', async () => {
    const { store, deps } = await setup();
    const pr = prFor('example-org/shop');
    const { run } = await learnFromRun(
      {
        task: makeTask(),
        record: makeRecord({ outcome: 'needs-review', checks: redBaseline, pr }),
        transcript: '',
      },
      { store, embedder: deps.embedder },
    );
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: Model = {
      async json<T>(request: JsonRequest) {
        await gate;
        return fakeModel(store).json<T>(request);
      },
    };
    const busy = learnFromRun(
      { task: makeTask({ repo: 'example-org/a' }), record: makeRecord(), transcript: 'ok' },
      { ...deps, model: slow },
    );

    const verdict = recordVerdict(pr, 'merged', deps);
    await vi.waitFor(async () =>
      expect((await store.getRun(run.id))?.record.humanVerdict).toBe('merged'),
    );

    release();
    await Promise.all([busy, verdict]);
  });

  it('returns undefined for a PR memory never stored', async () => {
    const { deps } = await setup();
    expect(await recordVerdict('https://github.com/example-org/x/pull/9', 'merged', deps)).toBe(
      undefined,
    );
  });
});
