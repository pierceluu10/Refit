import type { MigrationTask, RetrieveRecipes, RunRecord } from '../shared/types.ts';
import { defaultAi, type Embedder, type Model } from './ai.ts';
import { extractRecipe } from './extract.ts';
import { createRetriever } from './retrieve.ts';
import { promoteSkills, recordSkillOutcome } from './skills.ts';
import { JsonMemoryStore, type MemoryStore } from './store.ts';
import type { HumanVerdict, MemoryRecipe, StoredRun } from './types.ts';

export * from './ai.ts';
export { extractRecipe } from './extract.ts';
export { createRetriever, renderMemoryForPrompt } from './retrieve.ts';
export { runSelfEval } from './selfeval.ts';
export { promoteSkills, recordSkillOutcome } from './skills.ts';
export { JsonMemoryStore, type MemoryStore } from './store.ts';
export type * from './types.ts';

export type MemoryDeps = { store: MemoryStore; embedder: Embedder; model?: Model };

let defaults: MemoryDeps | undefined;

// Built on first use so importing memory/ never reads the environment.
export function defaultMemory(): MemoryDeps {
  defaults ??= { store: JsonMemoryStore.fromEnv(), ...defaultAi() };
  return defaults;
}

// The RetrieveRecipes entry point from shared/types.ts; harness/prompt.ts injects what it returns.
export const retrieveRecipes: RetrieveRecipes = (task: MigrationTask) =>
  createRetriever(defaultMemory())(task);

// Called by the orchestrator after every run. The run is stored first, so a failed AI pass loses nothing.
export async function learnFromRun(
  input: { task: MigrationTask; record: RunRecord; transcript?: string; usedRecipeIds?: string[] },
  deps: MemoryDeps = defaultMemory(),
): Promise<{
  run: StoredRun;
  recipe?: MemoryRecipe;
  promoted: MemoryRecipe[];
  demoted: MemoryRecipe[];
  error?: string;
}> {
  const run = await deps.store.recordRun(input);
  const demoted = await recordSkillOutcome(run, deps);
  try {
    // shortcut: without ANTHROPIC_API_KEY the run is stored but not distilled; re-extract stored runs once a key is set.
    const recipe = deps.model
      ? await extractRecipe(run, { ...deps, model: deps.model })
      : undefined;
    return { run, recipe, promoted: await promoteSkills(deps), demoted };
  } catch (error) {
    return { run, promoted: [], demoted, error: String(error) };
  }
}

// Called by the GitHub App when a PR is merged, closed or edited.
export async function recordVerdict(
  runIdOrPr: string,
  verdict: HumanVerdict,
  deps: MemoryDeps = defaultMemory(),
): Promise<{ run: StoredRun; demoted: MemoryRecipe[] } | undefined> {
  const run = await deps.store.recordVerdict(runIdOrPr, verdict);
  return run && { run, demoted: await recordSkillOutcome(run, deps) };
}
