import { randomBytes } from 'node:crypto';
import { DegradedOutputError, type JsonRequest, type Model } from './ai.ts';
import { taskChanges } from './retrieve.ts';
import type { MemoryStore } from './store.ts';
import type { MemoryRecipe, StoredRun } from './types.ts';
import type { RunRecord } from '../shared/types.ts';

type Lesson = { sameAsRecipeId: string | null; pitfalls: string };

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

const LESSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sameAsRecipeId', 'pitfalls'],
  properties: { sameAsRecipeId: { type: ['string', 'null'] }, pitfalls: text },
};

const SYSTEM = `You distil a successful API migration run into a recipe: advice a future engineer reads before migrating a DIFFERENT repository for a similar change. It is guidance, not a rule; they will adapt it to their code. A run succeeded if its checks verified it or a human merged or edited its PR.

You get the task, the agent's diff, the checks, the run's outcome and the agent's transcript. Write:
- preconditions: what the code looks like when this recipe applies (SDK, version, call shapes).
- steps: what to do, in order. Generalise away repository-specific names (files, variables, business logic) but keep exact provider API names, parameters, versions and model ids. Cover the whole path to a verified fix: which kinds of files and code patterns it touched (for example "the webhook handler that reads subscription.current_period_end"), any codegen or setup it had to run before the checks could pass (prisma generate and the like), which checks it ran, and the test it wrote to prove the change: what the test asserts and where such a test lives.
- pitfalls: what went wrong or nearly did, including every dead end the agent hit in the transcript and how it got out.
- diffSketch: a short generic before/after diff of the core change.

You also get the recipes memory already holds for this provider. If this run applies the same technique as one of them, set sameAsRecipeId to its id and return merged, improved text for that recipe that keeps what was already true and adds what this run taught. Otherwise set sameAsRecipeId to null.`;

const LESSON_SYSTEM = `You read an API migration run that did not succeed: it failed, needed review, or a human closed its PR. You never write a new recipe from it. You decide whether it teaches a pitfall for one of the recipes memory already holds for this provider.

If the run hit a dead end, a wrong assumption or a missed check that an engineer following one of those recipes should know about, set sameAsRecipeId to that recipe's id. Return that recipe's pitfalls with this run's lesson added, keeping what was already there, and say the lesson comes from a run that did not succeed. Otherwise set sameAsRecipeId to null and pitfalls to an empty string.`;

const MAX_TRANSCRIPT_CHARS = 600_000;

// A human merging or editing the PR is the strongest success signal; closing it outweighs passing checks.
export function succeeded({ outcome, humanVerdict }: RunRecord): boolean {
  if (humanVerdict === 'merged' || humanVerdict === 'edited') return true;
  return outcome === 'verified' && humanVerdict !== 'closed';
}

// A successful run becomes a new or merged recipe. Any other attempt can only add pitfalls to a recipe the
// model names. Returns the recipe it saved, if any; this never blocks a run.
export async function extractRecipe(
  run: StoredRun,
  deps: { store: MemoryStore; model: Model; now?: () => Date },
): Promise<MemoryRecipe | undefined> {
  const success = succeeded(run.record);
  if (!success && run.record.outcome === 'not-affected') return undefined;
  const { provider, kind } = run.task.change;
  const existing = (await deps.store.listRecipes()).filter(
    (recipe) => recipe.provider === provider,
  );
  // A lesson from an unsuccessful run needs a recipe to attach to.
  if (!success && existing.length === 0) return undefined;

  const now = (deps.now?.() ?? new Date()).toISOString();
  const prompt = buildPrompt(run, existing);
  // Onto a fresh read of the run: a verdict can arrive while the model works.
  // shortcut: one landing between this read and write is still lost; a store with row locks closes it.
  const mark = async (extraction: StoredRun['extraction']) =>
    deps.store.saveRun({ ...((await deps.store.getRun(run.id)) ?? run), extraction });

  let result: Extraction | Lesson;
  try {
    result = success
      ? await ask<Extraction>(deps.model, { system: SYSTEM, prompt, schema: SCHEMA }, (r) =>
          (['preconditions', 'steps', 'pitfalls', 'diffSketch'] as const).filter(
            (field) => !r[field]?.trim(),
          ),
        )
      : await ask<Lesson>(
          deps.model,
          { system: LESSON_SYSTEM, prompt, schema: LESSON_SCHEMA },
          (r) => (r.sameAsRecipeId && !r.pitfalls?.trim() ? ['pitfalls'] : []),
        );
  } catch (error) {
    // Save nothing that could mislead later prompts; mark the run so it can be re-extracted.
    await mark({ status: 'failed', reason: String(error), at: now });
    throw error;
  }
  const { sameAsRecipeId, ...rest } = result;
  // A lesson may only change pitfalls, whatever else the model sends back.
  const guidance = success ? rest : { pitfalls: result.pitfalls };
  const same = existing.find((recipe) => recipe.id === sameAsRecipeId);

  let recipe: MemoryRecipe | undefined;
  if (same) {
    const { embedding: _staleEmbedding, ...kept } = same;
    // Only a successful run counts as another repo the recipe was verified on.
    const repos = success ? [...new Set([...same.repos, run.task.repo])] : same.repos;
    recipe = {
      ...kept,
      ...guidance,
      ...(success && { changeIds: [...new Set([...(same.changeIds ?? []), ...changeIds(run)])] }),
      sourceRuns: [...new Set([...same.sourceRuns, run.id])],
      repos,
      verifiedRepos: repos.length,
      updatedAt: now,
    };
  } else if (success) {
    recipe = {
      id: `recipe-${provider}-${kind}-${randomBytes(4).toString('hex')}`,
      provider,
      kind,
      ...(guidance as Omit<Extraction, 'sameAsRecipeId'>),
      changeIds: changeIds(run),
      sourceRuns: [run.id],
      repos: [run.task.repo],
      verifiedRepos: 1,
      createdAt: now,
      updatedAt: now,
    };
  }
  if (recipe) await deps.store.saveRecipe(recipe);
  await mark({
    status: 'done',
    mode: success ? 'recipe' : 'pitfalls',
    ...(recipe && { recipeId: recipe.id }),
    at: now,
  });
  return recipe;
}

const changeIds = (run: StoredRun) => taskChanges(run.task).map((change) => change.id);

// What the harness's record carries beyond shared RunRecord, read here so a recipe can name the
// codegen, checks and proof test that got the fix verified. Each is absent on older records.
type HarnessFields = {
  preparation?: { steps?: { command: string; why: string; code: number }[] };
  agentChecks?: { name: string; command: string }[];
  prBody?: string;
};

function whatTheRunDid(run: StoredRun): string {
  const { diff } = run.record;
  const { preparation, agentChecks = [], prBody } = run.record as RunRecord & HarnessFields;
  const files = [...diff.matchAll(/^diff --git a\/(\S+) b\//gm)].map((match) => match[1]);
  const steps = preparation?.steps ?? [];
  return [
    `Files changed: ${files.join(', ') || 'none'}`,
    `Codegen and setup run before the baseline: ${steps.length ? '' : 'none recorded'}`,
    ...steps.map((step) => `- \`${step.command}\` (exit ${step.code}): ${step.why}`),
    `Checks the agent added, its proof test among them: ${agentChecks.length ? '' : 'none recorded'}`,
    ...agentChecks.map((check) => `- ${check.name}: \`${check.command}\``),
    prBody ? `The PR body it wrote:\n${prBody}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// One retry when the answer comes back degraded; any other error goes straight up.
async function ask<T>(
  model: Model,
  request: JsonRequest,
  blankFields: (result: T) => string[],
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await model.json<T>(request);
      const blank = blankFields(result);
      if (blank.length) throw new DegradedOutputError(`Extraction left ${blank.join(', ')} blank`);
      return result;
    } catch (error) {
      if (!(error instanceof DegradedOutputError) || attempt === 2) throw error;
    }
  }
}

function buildPrompt(run: StoredRun, existing: MemoryRecipe[]): string {
  const { change, usages } = run.task;
  const task = {
    provider: change.provider,
    kind: change.kind,
    title: change.title,
    source: change.source,
    affects: change.affects,
    alsoResolves: taskChanges(run.task)
      .slice(1)
      .map(({ id, title }) => ({ id, title })),
    usages,
  };
  const { outcome: harnessOutcome, humanVerdict } = run.record;
  const outcome = `Harness outcome: ${harnessOutcome}. Human verdict on the PR: ${humanVerdict ?? 'none yet'}. If a human edited the PR, only the agent's diff is shown, not theirs.`;
  const recipes = existing.map(({ id, kind, preconditions, steps, pitfalls }) => ({
    id,
    kind,
    preconditions,
    steps,
    pitfalls,
  }));
  return [
    `## Task\n${JSON.stringify(task, null, 2)}`,
    `## Outcome\n${outcome}`,
    // shortcut: a human's final diff isn't recorded yet; pass it here once the GitHub App sends it.
    `## Agent's diff\n${run.record.diff}`,
    `## Checks (before -> after)\n${JSON.stringify(run.record.checks, null, 2)}`,
    `## What the run did\n${whatTheRunDid(run)}`,
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
