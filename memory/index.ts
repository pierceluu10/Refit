import type { MigrationTask, RetrieveRecipes, RunRecord, RunView } from '../shared/types.ts';
import { defaultAi, type Embedder, type Model } from './ai.ts';
import { extractRecipe, succeeded } from './extract.ts';
import { mergeHabits } from './habits.ts';
import { createRetriever } from './retrieve.ts';
import { promoteSkills, recordRecipeOutcome } from './skills.ts';
import { JsonMemoryStore, type MemoryStore } from './store.ts';
import type { FixEvidence, HumanVerdict, MemoryRecipe, StoredRun } from './types.ts';
import { toRunView } from './views.ts';

export * from './ai.ts';
export { extractRecipe, succeeded } from './extract.ts';
export { habitNotes, knownPlan, type RepoHabits } from './habits.ts';
export { lessonsFrom, type DetectionLesson } from './lessons.ts';
export { createRetriever, recipesForEntries, renderMemoryForPrompt } from './retrieve.ts';
export { runSelfEval } from './selfeval.ts';
export { promoteSkills, recordRecipeOutcome } from './skills.ts';
export { JsonMemoryStore, type MemoryStore } from './store.ts';
export type * from './types.ts';
export { toRunView } from './views.ts';

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

// Learning reads recipes, may ask the model, then writes them back, while runs and verdicts arrive at
// once (parallel tasks, org runs, webhook deliveries). One at a time, so no write loses another's count.
// Runs and verdicts themselves are written before they queue, so a restart loses neither.
// shortcut: per process only; give the store row locks (Postgres) before two processes share it.
let learning: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  const result = learning.then(task);
  learning = result.catch(() => undefined);
  return result;
}

const keepHabits = async (run: StoredRun, store: MemoryStore) =>
  store.saveHabits(
    mergeHabits(await store.getHabits(run.task.repo), run, new Date().toISOString()),
  );

// Called by the orchestrator after every run. The run is stored first, so a failed AI pass loses nothing.
// `commit` is the commit the run read; the self-eval reruns the task on it.
export async function learnFromRun(
  input: {
    task: MigrationTask;
    record: RunRecord;
    transcript?: string;
    usedRecipeIds?: string[];
    commit?: string;
  },
  deps: MemoryDeps = defaultMemory(),
): Promise<Learned> {
  // Stored before it waits its turn, so a restart while it waits loses nothing.
  const recorded = await deps.store.recordRun(input);
  return oneAtATime(async () => {
    // Read again: a verdict may have reached the run while it waited.
    const run = (await deps.store.getRun(recorded.id)) ?? recorded;
    await keepHabits(run, deps.store);
    return learn(run, await recordRecipeOutcome(run, deps), deps);
  });
}

// Called by the GitHub App for what a person did with an Aptitude PR; memory/README.md lists exactly
// which pull_request events send which verdict. A merge or edit turns a needs-review run into a
// success, distilled into a recipe unless it already was. A close counts against the recipes and
// skills the run used, and takes its repo back off the recipe it was distilled into.
export async function recordVerdict(
  runIdOrPr: string,
  verdict: HumanVerdict,
  deps: MemoryDeps = defaultMemory(),
): Promise<Learned | undefined> {
  const recorded = await deps.store.recordVerdict(runIdOrPr, verdict);
  if (!recorded) return undefined;
  return oneAtATime(async () => {
    const run = (await deps.store.getRun(recorded.id)) ?? recorded;
    const demoted = await recordRecipeOutcome(run, deps);
    const distilled = run.extraction?.status === 'done' && run.extraction.mode === 'recipe';
    return learn(run, demoted, deps, succeeded(run) && !distilled);
  });
}

// What really happened to a PR, from the GitHub App. Stored at once. A person's edits or closing
// comment reach the recipe the next time learning runs; a revert counts against it now.
export async function recordEvidence(
  runIdOrPr: string,
  evidence: FixEvidence,
  deps: MemoryDeps = defaultMemory(),
): Promise<Learned | undefined> {
  const recorded = await deps.store.addEvidence(runIdOrPr, evidence);
  if (!recorded) return undefined;
  return oneAtATime(async () => {
    const stored = (await deps.store.getRun(recorded.id)) ?? recorded;
    const teaches = evidence.merged?.humanDiff || evidence.closed?.comment;
    const { extraction: _learned, ...unlearned } = stored;
    const run = teaches ? unlearned : stored;
    if (teaches) await deps.store.saveRun(run);
    await keepHabits(run, deps.store);
    const demoted = await recordRecipeOutcome(run, deps);
    return { run, promoted: await promoteSkills(deps), demoted };
  });
}

// Reads stored runs that haven't taught anything yet, in batches, on memory's own budget. Passes go
// one run per provider, so each sees the recipes the last one wrote, and a run that fails is left for
// the next call. A pass runs at once on purpose: a batch model answers its calls together.
export async function learnPending(
  deps: MemoryDeps & { model: Model },
  { limit = 50 }: { limit?: number } = {},
): Promise<{ learned: number; failed: number }> {
  const stored = (await deps.store.listRuns())
    .filter((run) => run.extraction?.status !== 'done' && run.record.outcome !== 'not-affected')
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
    .slice(0, limit);
  let pending = stored;
  let learned = 0;
  let failed = 0;
  while (pending.length > 0) {
    const pass = [...new Map(pending.map((run) => [run.task.change.provider, run])).values()];
    pending = pending.filter((run) => !pass.includes(run));
    const results = await Promise.all(pass.map((run) => learn(run, [], deps)));
    for (const result of results) {
      if (result.error) failed += 1;
      else learned += 1;
    }
  }
  return { learned, failed };
}

// The runs the dashboard shows, newest first. The app serves them at GET /api/runs.
// shortcut: reads every stored run, transcripts included, on each call; add an index or move to
// Postgres once the store holds thousands of runs.
export async function listRunViews(
  filter: { repo?: string; limit?: number } = {},
  store: MemoryStore = defaultMemory().store,
): Promise<RunView[]> {
  const runs = (await store.listRuns())
    .filter((run) => filter.repo === undefined || run.task.repo === filter.repo)
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id));
  return runs.slice(0, filter.limit ?? runs.length).map(toRunView);
}

// Promotion runs after every run and verdict, since either can change how many repos a recipe is verified on.
async function learn(
  run: StoredRun,
  demoted: MemoryRecipe[],
  deps: MemoryDeps,
  extract = true,
): Promise<Learned> {
  try {
    // shortcut: without a model the run is stored but not distilled; re-extract stored runs once a key is set.
    const recipe =
      extract && deps.model ? await extractRecipe(run, { ...deps, model: deps.model }) : undefined;
    return { run, recipe, promoted: await promoteSkills(deps), demoted };
  } catch (error) {
    return { run, promoted: [], demoted, error: String(error) };
  }
}
