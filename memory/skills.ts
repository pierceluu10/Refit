import type { Model } from './ai.ts';
import { succeeded } from './extract.ts';
import type { RunRecord } from '../shared/types.ts';
import type { MemoryStore } from './store.ts';
import type { MemoryRecipe, StoredRun } from './types.ts';

export const PROMOTE_AT_REPOS = 3;
export const DEMOTE_AT_FAILURES = 2;

const SYSTEM = `You turn a migration recipe that worked on several repos into a reusable prompt block for a coding agent.
Write concise, generalised advice for a senior engineer: when it applies, the approach, what to watch for.
Write it as guidance the engineer adapts to the code in front of them, not as rules. Drop repo-specific names.`;

export async function promoteSkills({
  store,
  model,
  now = () => new Date(),
}: {
  store: MemoryStore;
  model?: Model;
  now?: () => Date;
}): Promise<MemoryRecipe[]> {
  const promoted: MemoryRecipe[] = [];
  // shortcut: a demoted skill keeps its `skill` field, so it is never re-promoted; revisit once demoted recipes keep verifying on new repos.
  for (const recipe of await store.listRecipes()) {
    if (recipe.verifiedRepos < PROMOTE_AT_REPOS || recipe.skill) continue;
    const skilled: MemoryRecipe = {
      ...recipe,
      skill: {
        status: 'active',
        prompt: await skillPrompt(recipe, model),
        promotedAt: now().toISOString(),
        failedRunIds: [],
      },
    };
    await store.saveRecipe(skilled);
    promoted.push(skilled);
  }
  return promoted;
}

async function skillPrompt(recipe: MemoryRecipe, model?: Model): Promise<string> {
  if (model) {
    try {
      const { prompt } = await model.json<{ prompt: string }>({
        system: SYSTEM,
        prompt: JSON.stringify({
          provider: recipe.provider,
          kind: recipe.kind,
          preconditions: recipe.preconditions,
          steps: recipe.steps,
          pitfalls: recipe.pitfalls,
          diffSketch: recipe.diffSketch,
          verifiedOnRepos: recipe.verifiedRepos,
        }),
        schema: {
          type: 'object',
          properties: { prompt: { type: 'string' } },
          required: ['prompt'],
          additionalProperties: false,
        },
        maxTokens: 8_000,
      });
      if (prompt.trim()) return prompt;
    } catch {
      // The template below is still useful guidance; promotion shouldn't wait on the model.
    }
  }
  return [
    `Guidance for ${recipe.provider} ${recipe.kind} migrations, verified on ${recipe.verifiedRepos} repos. Adapt it to the code in front of you.`,
    `When it applies: ${recipe.preconditions}`,
    `Approach:\n${recipe.steps}`,
    `Watch for: ${recipe.pitfalls}`,
    `Typical diff:\n${recipe.diffSketch}`,
  ].join('\n\n');
}

// Records what a run's outcome says about the recipes it touched. Idempotent per run: called when the
// run is recorded and again on every human verdict, so a later verdict (closed, then reopened and merged)
// moves the run's count with it. Returns the skills it demoted.
export async function recordRecipeOutcome(
  run: StoredRun,
  { store, now = () => new Date() }: { store: MemoryStore; now?: () => Date },
): Promise<MemoryRecipe[]> {
  const failed = failedWith(run.record);
  const demoted: MemoryRecipe[] = [];
  for (const id of new Set(run.usedRecipeIds)) {
    const recipe = await store.getRecipe(id);
    if (!recipe) continue;
    const failedRunIds = tally(recipe.failedRunIds ?? [], run.id, failed);
    let skill = recipe.skill;
    // A skill answers only for runs it was shown as a skill, not for runs from before its promotion.
    // shortcut: a demotion stays even if a later verdict takes back one of its failures; re-promote by hand.
    if (skill?.status === 'active' && Date.parse(skill.promotedAt) <= Date.parse(run.recordedAt)) {
      const skillFailures = tally(skill.failedRunIds, run.id, failed);
      skill =
        skillFailures.length >= DEMOTE_AT_FAILURES
          ? {
              ...skill,
              failedRunIds: skillFailures,
              status: 'demoted',
              demotedAt: now().toISOString(),
            }
          : { ...skill, failedRunIds: skillFailures };
    }
    const updated: MemoryRecipe = { ...recipe, skill };
    if (failedRunIds.length || recipe.failedRunIds) updated.failedRunIds = failedRunIds;
    if (JSON.stringify(updated) === JSON.stringify(recipe)) continue;
    await store.saveRecipe(updated);
    if (skill?.status === 'demoted' && recipe.skill?.status === 'active') demoted.push(updated);
  }
  const { extraction } = run;
  if (extraction?.status === 'done' && extraction.mode === 'recipe' && extraction.recipeId) {
    await recountRepo(extraction.recipeId, run, { store, now });
  }
  return demoted;
}

// What says the guidance a run was shown was wrong or stale: a person closing its PR, or a
// needs-review run on a repo whose checks all passed before the edit, so the environment is not what
// kept it from verifying. A harness 'failed' says nothing: nothing was attempted (the model was down,
// the budget ran out) or the PR couldn't be opened.
export function failedWith(record: RunRecord): boolean {
  if (record.humanVerdict) return record.humanVerdict === 'closed';
  const ran = record.checks.filter((check) => check.before !== 'not run');
  const green = ran.length > 0 && ran.every((check) => check.before === 'pass');
  return record.outcome === 'needs-review' && green;
}

function tally(ids: string[], id: string, failed: boolean): string[] {
  return failed ? [...new Set([...ids, id])] : ids.filter((other) => other !== id);
}

// The recipe a run was distilled into counts the run's repo only while some run from that repo,
// distilled into the same recipe, still counts as a success. So a human closing a verified PR takes
// its repo back off the recipe.
async function recountRepo(
  id: string,
  run: StoredRun,
  { store, now }: { store: MemoryStore; now: () => Date },
): Promise<void> {
  const recipe = await store.getRecipe(id);
  if (!recipe) return;
  const others = await Promise.all(
    recipe.sourceRuns.filter((source) => source !== run.id).map((source) => store.getRun(source)),
  );
  const verified = [run, ...others].some(
    (source) =>
      source?.task.repo === run.task.repo &&
      succeeded(source.record) &&
      source.extraction?.status === 'done' &&
      source.extraction.mode === 'recipe' &&
      source.extraction.recipeId === id,
  );
  const repos = verified
    ? [...new Set([...recipe.repos, run.task.repo])]
    : recipe.repos.filter((repo) => repo !== run.task.repo);
  // Only this run's repo can move, so an unchanged length means nothing changed.
  if (repos.length === recipe.repos.length) return;
  await store.saveRecipe({
    ...recipe,
    repos,
    verifiedRepos: repos.length,
    updatedAt: now().toISOString(),
  });
}
