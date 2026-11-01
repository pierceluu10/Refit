import type { MigrationTask, RetrieveRecipes, RunRecord } from '../shared/types.ts';
import { defaultAi, type Embedder, type Model } from './ai.ts';
import { extractRecipe, succeeded } from './extract.ts';
import { createRetriever } from './retrieve.ts';
import { promoteSkills, recordSkillOutcome } from './skills.ts';
import { JsonMemoryStore, type MemoryStore } from './store.ts';
import type { HumanVerdict, MemoryRecipe, StoredRun } from './types.ts';

export * from './ai.ts';
export { extractRecipe, succeeded } from './extract.ts';
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

type Learned = {
  run: StoredRun;
  recipe?: MemoryRecipe;
  promoted: MemoryRecipe[];
  demoted: MemoryRecipe[];
  error?: string;
};

// Called by the orchestrator after every run. The run is stored first, so a failed AI pass loses nothing.
export async function learnFromRun(
  input: { task: MigrationTask; record: RunRecord; transcript?: string; usedRecipeIds?: string[] },
  deps: MemoryDeps = defaultMemory(),
): Promise<Learned> {
  const run = await deps.store.recordRun(input);
  return learn(run, await recordSkillOutcome(run, deps), deps);
}

// Called by the GitHub App when a PR is merged, closed or edited. A merge or edit can turn a
// needs-review run into a success, so it is distilled into a recipe unless it already was.
export async function recordVerdict(
  runIdOrPr: string,
  verdict: HumanVerdict,
  deps: MemoryDeps = defaultMemory(),
): Promise<Learned | undefined> {
  const run = await deps.store.recordVerdict(runIdOrPr, verdict);
  if (!run) return undefined;
  const demoted = await recordSkillOutcome(run, deps);
  const distilled = run.extraction?.status === 'done' && run.extraction.mode === 'recipe';
  if (!succeeded(run.record) || distilled) return { run, promoted: [], demoted };
  return learn(run, demoted, deps);
}

async function learn(run: StoredRun, demoted: MemoryRecipe[], deps: MemoryDeps): Promise<Learned> {
  try {
    // shortcut: without a model the run is stored but not distilled; re-extract stored runs once a key is set.
    const recipe = deps.model
      ? await extractRecipe(run, { ...deps, model: deps.model })
      : undefined;
    return { run, recipe, promoted: await promoteSkills(deps), demoted };
  } catch (error) {
    return { run, promoted: [], demoted, error: String(error) };
  }
}
