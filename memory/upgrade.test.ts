import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalEmbedder, type JsonRequest, type Model } from './ai.ts';
import { makeRecipe, makeRecord, makeTask } from './fixtures/tasks.ts';
import { makeExternalTask, makeModelTask, makeScanReport } from './fixtures/upgrades.ts';
import {
  createRetriever,
  latestScanReports,
  learnFromRun,
  listRunViews,
  listScanReports,
  recordScanReport,
  recordVerdict,
  renderMemoryForPrompt,
  runSelfEval,
} from './index.ts';
import { JsonMemoryStore } from './store.ts';
import { upgradeKey, versionLabel } from './upgrade.ts';

const newStore = async () => new JsonMemoryStore(await mkdtemp(join(tmpdir(), 'refit-memory-')));

// Fake model: extraction merges into the first recipe the prompt lists, the judge picks every
// recipe it is shown, skill writing returns a fixed block. Every request is kept for assertions.
function fakeModel(): Model & { requests: JsonRequest[] } {
  const requests: JsonRequest[] = [];
  return {
    requests,
    async json<T>(request: JsonRequest): Promise<T> {
      requests.push(request);
      const properties = (request.schema as { properties: Record<string, unknown> }).properties;
      const ids = [...request.prompt.matchAll(/"id": "(recipe-[^"]+)"/g)].map((m) => m[1]);
      if ('diffSketch' in properties) {
        return {
          sameAsRecipeId: ids[0] ?? null,
          preconditions: 'Node pinned to an end-of-life major in engines, .nvmrc and Dockerfile.',
          steps: '1. Move every declared version together.\n2. Regenerate the lockfile.',
          pitfalls: request.prompt.includes("## Human's final diff")
            ? 'The human also bumped the CI matrix.'
            : 'Native modules need a rebuild.',
          diffSketch: '- FROM node:18\n+ FROM node:22',
        } as T;
      }
      if ('picks' in properties) {
        const shown = [...request.prompt.matchAll(/^### (\S+)$/gm)].map((m) => m[1]);
        return { picks: shown.map((id) => ({ id, why: 'same shape' })) } as T;
      }
      if ('sameAsRecipeId' in properties) return { sameAsRecipeId: null, pitfalls: '' } as T;
      return { prompt: 'Skill: upgrade Node across every declared place.' } as T;
    },
  };
}

describe('upgrade keys', () => {
  it('labels versions the way people say them', () => {
    expect(versionLabel('^18.2.0')).toBe('18');
    expect(versionLabel('>=16 <17')).toBe('16');
    expect(versionLabel('3.9.18')).toBe('3.9');
    expect(versionLabel('20.x')).toBe('20');
    expect(versionLabel('gpt-4o')).toBe('gpt-4o');
    expect(versionLabel('')).toBeUndefined();
  });

  it('keys an upgrade by dependency and version range, and an API task not at all', () => {
    expect(upgradeKey(makeExternalTask())).toMatchObject({
      dependency: 'node',
      dependencyKind: 'runtime',
      from: '18',
      to: '22',
      range: 'node 18 → 22',
    });
    expect(upgradeKey(makeModelTask())?.range).toBe('gpt-4o → replacement');
    expect(upgradeKey(makeTask())).toBeUndefined();
  });
});

describe('upgrade recipes', () => {
  it('distils a verified upgrade, merges a second range into it and promotes it at 3 repos', async () => {
    const store = await newStore();
    const model = fakeModel();
    const deps = { store, embedder: new LocalEmbedder(), model };

    const first = await learnFromRun(
      { task: makeExternalTask(), record: makeRecord({ taskId: 't1' }), transcript: 'ok' },
      deps,
    );
    expect(first.recipe).toMatchObject({
      provider: 'nodejs',
      kind: 'other',
      changeKind: 'runtime-eol',
      upgrade: { dependency: 'node', range: 'node 18 → 22' },
      ranges: ['node 18 → 22'],
      sourceRuns: [first.run.id],
    });
    expect(first.recipe?.id).toMatch(/^recipe-node-runtime-eol-/);
    const prompt = model.requests[0].prompt;
    expect(prompt).toContain('"upgrade": "node 18 → 22"');
    expect(prompt).toContain('FROM node:18-bookworm');

    for (const [repo, version] of [
      ['example-org/b', '16'],
      ['example-org/c', '18'],
    ]) {
      await learnFromRun(
        {
          task: makeExternalTask({ repo, version }),
          record: makeRecord({ taskId: `t-${repo}` }),
          transcript: 'ok',
        },
        deps,
      );
    }
    const recipes = await store.listRecipes();
    expect(recipes).toHaveLength(1);
    expect(recipes[0].ranges).toEqual(['node 18 → 22', 'node 16 → 22']);
    expect(recipes[0].verifiedRepos).toBe(3);
    expect(recipes[0].skill?.status).toBe('active');
  });

  it('demotes an upgrade skill after two closed PRs that used it', async () => {
    const store = await newStore();
    const deps = { store, embedder: new LocalEmbedder(), model: fakeModel() };
    for (const repo of ['example-org/a', 'example-org/b', 'example-org/c']) {
      await learnFromRun(
        { task: makeExternalTask({ repo }), record: makeRecord(), transcript: 'ok' },
        deps,
      );
    }
    const [recipe] = await store.listRecipes();
    for (const n of [1, 2]) {
      const pr = `https://github.com/example-org/z/pull/${n}`;
      await learnFromRun(
        {
          task: makeExternalTask({ repo: 'example-org/z' }),
          record: makeRecord({ outcome: 'needs-review', pr }),
          usedRecipeIds: [recipe.id],
          transcript: '',
        },
        deps,
      );
    }
    await recordVerdict('https://github.com/example-org/z/pull/1', 'closed', deps);
    const verdict = await recordVerdict('https://github.com/example-org/z/pull/2', 'closed', deps);
    expect(verdict?.demoted.map((r) => r.id)).toEqual([recipe.id]);
  });

  it("updates the recipe from an edited PR's final diff, once per diff", async () => {
    const store = await newStore();
    const model = fakeModel();
    const deps = { store, embedder: new LocalEmbedder(), model };
    const pr = 'https://github.com/example-org/api/pull/7';
    const { run, recipe } = await learnFromRun(
      { task: makeExternalTask(), record: makeRecord({ pr }), transcript: 'ok' },
      deps,
    );
    expect(recipe?.pitfalls).toBe('Native modules need a rebuild.');
    const calls = model.requests.length;

    const finalDiff = '- node-version: 18\n+ node-version: 22';
    const edited = await recordVerdict(pr, 'edited', deps, { finalDiff });
    expect(edited?.recipe?.id).toBe(recipe?.id);
    expect(edited?.recipe?.pitfalls).toBe('The human also bumped the CI matrix.');
    const asked = model.requests[calls].prompt;
    expect(asked).toContain("## Human's final diff\n- node-version: 18");
    expect(asked).toContain(`already distilled into ${recipe?.id}`);
    const stored = await store.getRun(run.id);
    expect(stored?.humanDiff).toBe(finalDiff);
    expect(stored?.extraction).toMatchObject({ status: 'done', humanDiffSha: expect.any(String) });
    expect(await store.listRecipes()).toHaveLength(1);

    // A redelivery with the same diff learns nothing new.
    const extractions = () =>
      model.requests.filter((r) => r.prompt.includes("## Human's final diff")).length;
    const seen = extractions();
    await recordVerdict(pr, 'edited', deps, { finalDiff });
    expect(extractions()).toBe(seen);
  });

  it('never keeps a diff from a close', async () => {
    const store = await newStore();
    const deps = { store, embedder: new LocalEmbedder() };
    const pr = 'https://github.com/example-org/api/pull/8';
    const { run } = await learnFromRun(
      { task: makeExternalTask(), record: makeRecord({ pr }), transcript: 'ok' },
      deps,
    );
    await recordVerdict(pr, 'closed', deps, { finalDiff: '+x' });
    expect((await store.getRun(run.id))?.humanDiff).toBeUndefined();
  });
});

describe('retrieving recipes for external tasks', () => {
  it('lets the judge read upgrade and old API recipes alike, and renders the range', async () => {
    const store = await newStore();
    await store.saveRecipe(makeRecipe());
    await store.saveRecipe(
      makeRecipe({
        id: 'recipe-node-runtime-eol-1',
        provider: 'nodejs',
        kind: 'other',
        changeKind: 'runtime-eol',
        upgrade: { dependency: 'node', from: '16', to: '20', range: 'node 16 → 20' },
        ranges: ['node 16 → 20'],
        preconditions: 'Node 16 in engines and .nvmrc.',
      }),
    );
    const model = fakeModel();
    const retrieve = createRetriever({ store, embedder: new LocalEmbedder(), model });

    const picked = await retrieve(makeExternalTask());
    expect(picked.map((r) => r.id).sort()).toEqual(
      ['recipe-node-runtime-eol-1', 'recipe-stripe-charges'].sort(),
    );
    const prompt = model.requests[0].prompt;
    expect(prompt).toContain('Upgrade: node 18 → 22');
    expect(prompt).toContain('declared in Dockerfile: FROM node:18-bookworm');
    expect(prompt).toContain('Upgrades: node 16 → 20');
    expect(prompt).toContain('kind: endpoint-removed');
    expect(renderMemoryForPrompt(picked)).toContain('### Recipe: node 16 → 20 (runtime-eol)');
  });

  it('falls back to embedding order without a model', async () => {
    const store = await newStore();
    await store.saveRecipe(
      makeRecipe({
        id: 'recipe-node',
        provider: 'nodejs',
        upgrade: { dependency: 'node', range: 'node 16 → 20' },
      }),
    );
    const picked = await createRetriever({ store, embedder: new LocalEmbedder() })(makeModelTask());
    expect(picked.map((r) => r.id)).toEqual(['recipe-node']);
  });
});

describe('dashboard history', () => {
  it('lists external runs as RunViews', async () => {
    const store = await newStore();
    await learnFromRun(
      { task: makeExternalTask(), record: makeRecord({ taskId: 'task-node' }), transcript: '' },
      { store, embedder: new LocalEmbedder() },
    );
    const [view] = await listRunViews({}, store);
    expect(view).toMatchObject({
      provider: 'nodejs',
      changeId: 'node-18-eol',
      outcome: 'verified',
    });
  });

  it('keeps every scan report and serves the latest per repo', async () => {
    const store = await newStore();
    await recordScanReport(makeScanReport('example-org/a', '2026-11-05T10:00:00.000Z'), store);
    await recordScanReport(makeScanReport('example-org/a', '2026-11-06T10:00:00.000Z'), store);
    await recordScanReport(makeScanReport('example-org/b', '2026-11-04T10:00:00.000Z'), store);

    const latest = await latestScanReports({}, store);
    expect(latest.map((r) => [r.repo, r.scannedAt])).toEqual([
      ['example-org/a', '2026-11-06T10:00:00.000Z'],
      ['example-org/b', '2026-11-04T10:00:00.000Z'],
    ]);
    expect(latest[0]).not.toHaveProperty('id');
    expect(await listScanReports({ repo: 'example-org/a' }, store)).toHaveLength(2);
    expect(await latestScanReports({ repos: ['example-org/b'] }, store)).toHaveLength(1);
  });
});

describe('self-eval with external tasks', () => {
  it('reruns external tasks through runExternalTask, and says when it could not', async () => {
    const store = await newStore();
    await learnFromRun(
      { task: makeExternalTask(), record: makeRecord({ taskId: 'x' }), transcript: 'ran' },
      { store, embedder: new LocalEmbedder() },
    );
    const base = {
      store,
      runTask: async () => makeRecord({ outcome: 'failed' }),
      prepareRepo: async () => '/tmp/nowhere',
    };
    const skipped = await runSelfEval(base);
    expect(skipped.results).toEqual([]);
    expect(skipped.summary).toContain('no runExternalTask was given');

    const rerun = await runSelfEval({
      ...base,
      runExternalTask: async () => makeRecord({ outcome: 'verified' }),
    });
    expect(rerun.results).toEqual([
      { taskId: makeExternalTask().id, before: 'verified', after: 'verified' },
    ]);
  });
});
