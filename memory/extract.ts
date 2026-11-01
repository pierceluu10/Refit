import { randomBytes } from 'node:crypto';
import type { Model } from './ai.ts';
import type { MemoryStore } from './store.ts';
import type { MemoryRecipe, StoredRun } from './types.ts';

type Extraction = {
  sameAsRecipeId: string | null;
  preconditions: string;
  steps: string;
  pitfalls: string;
  diffSketch: string;
};

const text = { type: 'string' };
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sameAsRecipeId', 'preconditions', 'steps', 'pitfalls', 'diffSketch'],
  properties: {
    sameAsRecipeId: { type: ['string', 'null'] },
    preconditions: text,
    steps: text,
    pitfalls: text,
    diffSketch: text,
  },
};

const SYSTEM = `You distil a successful API migration run into a recipe: advice a future engineer reads before migrating a DIFFERENT repository for a similar change. It is guidance, not a rule; they will adapt it to their code.

You get the task, the verified diff, the checks and the agent's transcript. Write:
- preconditions: what the code looks like when this recipe applies (SDK, version, call shapes).
- steps: what to do, in order. Generalise away repository-specific names (files, variables, business logic) but keep exact provider API names, parameters, versions and model ids.
- pitfalls: what went wrong or nearly did, including every dead end the agent hit in the transcript and how it got out.
- diffSketch: a short generic before/after diff of the core change.

You also get the recipes memory already holds for this provider. If this run applies the same technique as one of them, set sameAsRecipeId to its id and return merged, improved text for that recipe that keeps what was already true and adds what this run taught. Otherwise set sameAsRecipeId to null.`;

const MAX_TRANSCRIPT_CHARS = 600_000;

// Distil a verified run into a new or merged recipe. Other outcomes return undefined; this never blocks a run.
export async function extractRecipe(
  run: StoredRun,
  deps: { store: MemoryStore; model: Model; now?: () => Date },
): Promise<MemoryRecipe | undefined> {
  if (run.record.outcome !== 'verified') return undefined;
  const { provider, kind } = run.task.change;
  const existing = (await deps.store.listRecipes()).filter(
    (recipe) => recipe.provider === provider,
  );

  const result = await deps.model.json<Extraction>({
    system: SYSTEM,
    prompt: buildPrompt(run, existing),
    schema: SCHEMA,
  });
  const { sameAsRecipeId, ...guidance } = result;
  const now = (deps.now?.() ?? new Date()).toISOString();
  const same = existing.find((recipe) => recipe.id === sameAsRecipeId);

  let recipe: MemoryRecipe;
  if (same) {
    const { embedding: _staleEmbedding, ...kept } = same;
    const repos = [...new Set([...same.repos, run.task.repo])];
    recipe = {
      ...kept,
      ...guidance,
      sourceRuns: [...new Set([...same.sourceRuns, run.id])],
      repos,
      verifiedRepos: repos.length,
      updatedAt: now,
    };
  } else {
    recipe = {
      id: `recipe-${provider}-${kind}-${randomBytes(4).toString('hex')}`,
      provider,
      kind,
      ...guidance,
      sourceRuns: [run.id],
      repos: [run.task.repo],
      verifiedRepos: 1,
      createdAt: now,
      updatedAt: now,
    };
  }
  await deps.store.saveRecipe(recipe);
  return recipe;
}

function buildPrompt(run: StoredRun, existing: MemoryRecipe[]): string {
  const { change, usages } = run.task;
  const task = {
    provider: change.provider,
    kind: change.kind,
    title: change.title,
    source: change.source,
    affects: change.affects,
    usages,
  };
  const recipes = existing.map(({ id, kind, preconditions, steps, pitfalls }) => ({
    id,
    kind,
    preconditions,
    steps,
    pitfalls,
  }));
  return [
    `## Task\n${JSON.stringify(task, null, 2)}`,
    `## Verified diff\n${run.record.diff}`,
    `## Checks (before -> after)\n${JSON.stringify(run.record.checks, null, 2)}`,
    `## Transcript\n${transcriptForPrompt(run.transcript)}`,
    `## Existing recipes for ${change.provider}\n${recipes.length ? JSON.stringify(recipes, null, 2) : 'None yet.'}`,
  ].join('\n\n');
}

// shortcut: keeps the head and tail of a huge transcript and drops the middle; summarise the middle with a cheap model pass if dead ends there get lost.
function transcriptForPrompt(transcript: string): string {
  if (transcript.length <= MAX_TRANSCRIPT_CHARS) return transcript;
  const half = MAX_TRANSCRIPT_CHARS / 2;
  const elided = transcript.length - MAX_TRANSCRIPT_CHARS;
  return `${transcript.slice(0, half)}\n\n[... ${elided} characters elided from the middle of this transcript; only its start and end are shown ...]\n\n${transcript.slice(-half)}`;
}
