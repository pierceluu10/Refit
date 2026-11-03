import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiUsage, MigrationTask, ProviderChange, RunRecord } from '../shared/types.ts';
import { AgentSdkModel, AnthropicModel, Budget, LocalEmbedder } from './ai.ts';
import { extractRecipe } from './extract.ts';
import { makeRecipe } from './fixtures/tasks.ts';
import { createRetriever, renderMemoryForPrompt } from './retrieve.ts';
import { JsonMemoryStore } from './store.ts';

// A recipe from one repo's fix, handed to the next repo with the same change, with the real model.
// Runs only with REFIT_REAL_AI=1, under one cap from REFIT_AI_BUDGET_USD.
const budget = Budget.fromEnv();
const json = async (path: string) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));

describe.skipIf(process.env.REFIT_REAL_AI !== '1')('a recipe handed to the next repo', () => {
  // An API key when present, else the logged-in Claude Code credentials through the Agent SDK.
  const model = process.env.ANTHROPIC_API_KEY
    ? new AnthropicModel(budget)
    : new AgentSdkModel(budget);

  afterAll(() => {
    console.log(`handoff.real.test.ts spent $${budget.spentUsd.toFixed(4)}`);
  });

  it("turns jiro's stripe-node 23 upgrade into a recipe that financehb's upgrade retrieves first", async () => {
    // The 2026-11-03 benchmark's jiro upgrade run, as recorded. It ended needs-review on a red
    // baseline; the hand-check said it would merge, so it is marked merged here, the way a human
    // merge turns a needs-review run into a recipe.
    const result = await json('../evals/reports/2026-11-03/stripe-dev-30/000-4lbatr0s__jiro.json');
    const recorded = result.tasks.find(
      (t: { changeId: string }) => t.changeId === 'stripe:node-v23-0-0',
    ).record as RunRecord & { summary: string };
    // Usage maps rebuilt from that run's match reasoning (orchestrator/fixtures/round-3.json).
    const round3 = await json('../orchestrator/fixtures/round-3.json');
    const stripe: ProviderChange[] = round3.changes.stripe;
    const upgrade = stripe.find((c) => c.id === 'stripe:node-v23-0-0')!;
    const usagesOf = (repo: string): ApiUsage[] =>
      round3.repos.find((r: { repo: string }) => r.repo === repo).usages;

    const store = new JsonMemoryStore(await mkdtemp(join(tmpdir(), 'refit-handoff-')));
    const decoys = [
      makeRecipe(),
      makeRecipe({
        id: 'recipe-openai-model',
        provider: 'openai',
        kind: 'model-retirement',
        preconditions: 'Calls chat.completions.create with a retired model id.',
        steps: 'Swap the model id for the named replacement.',
        pitfalls: 'Reasoning models reject temperature.',
        diffSketch: "- model: 'gpt-4'\n+ model: 'gpt-5.6-sol'",
      }),
    ];
    for (const recipe of decoys) await store.saveRecipe(recipe);
    const run = await store.recordRun({
      task: {
        id: recorded.taskId,
        repo: '4lbatr0s/jiro',
        change: upgrade,
        usages: usagesOf('4lbatr0s/jiro'),
        priority: 1,
      },
      record: { ...recorded, humanVerdict: 'merged' },
      transcript: recorded.summary,
    });

    const recipe = await extractRecipe(run, { store, model });
    expect(recipe?.changeIds).toEqual(['stripe:node-v23-0-0']);
    console.log(`Recipe ${recipe?.id}:\n${JSON.stringify(recipe, null, 2)}`);

    const next: MigrationTask & { alsoResolves: { change: ProviderChange; why: string }[] } = {
      id: 'adamhitzger/financehb:stripe:node-v23-0-0',
      repo: 'adamhitzger/financehb',
      change: upgrade,
      usages: usagesOf('adamhitzger/financehb'),
      priority: 1,
      alsoResolves: [
        {
          change: stripe.find((c) => c.id === 'stripe:2026-09-30-endive-api-version')!,
          why: 'v23 pins Endive',
        },
      ],
    };
    const picked = await createRetriever({ store, embedder: new LocalEmbedder(), model })(next);
    console.log(`Retrieved for financehb: ${picked.map((r) => r.id).join(', ')}`);
    expect(picked[0]?.id).toBe(recipe?.id);
    expect(renderMemoryForPrompt(picked)).toContain(recipe!.steps);
  }, 600_000);
});
