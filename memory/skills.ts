import type { Model } from './ai.ts';
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

// Idempotent per run: called at record time and again when the human verdict arrives.
export async function recordSkillOutcome(
  run: StoredRun,
  { store, now = () => new Date() }: { store: MemoryStore; now?: () => Date },
): Promise<MemoryRecipe[]> {
  if (run.record.outcome !== 'failed' && run.record.humanVerdict !== 'closed') return [];
  const demoted: MemoryRecipe[] = [];
  for (const id of new Set(run.usedRecipeIds)) {
    const recipe = await store.getRecipe(id);
    const skill = recipe?.skill;
    if (
      !recipe ||
      !skill ||
      skill.status !== 'active' ||
      Date.parse(skill.promotedAt) > Date.parse(run.recordedAt) ||
      skill.failedRunIds.includes(run.id)
    ) {
      continue;
    }
    const failedRunIds = [...skill.failedRunIds, run.id];
    const demote = failedRunIds.length >= DEMOTE_AT_FAILURES;
    const updated: MemoryRecipe = {
      ...recipe,
      skill: demote
        ? { ...skill, failedRunIds, status: 'demoted', demotedAt: now().toISOString() }
        : { ...skill, failedRunIds },
    };
    await store.saveRecipe(updated);
    if (demote) demoted.push(updated);
  }
  return demoted;
}
