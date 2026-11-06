import type {
  ExternalTask,
  MigrationTask,
  RetrieveExternalRecipes,
  RetrieveRecipes,
  RunRecord,
  RunView,
  ScanReport,
} from '../shared/types.ts';
import { defaultAi, type Embedder, type Model } from './ai.ts';
import { extractRecipe, sha, succeeded } from './extract.ts';
import { createRetriever } from './retrieve.ts';
import { promoteSkills, recordRecipeOutcome } from './skills.ts';
import { JsonMemoryStore, type MemoryStore } from './store.ts';
import type { AnyTask, HumanVerdict, MemoryRecipe, StoredRun } from './types.ts';
import { toRunView } from './views.ts';

export * from './ai.ts';
export { extractRecipe, succeeded } from './extract.ts';
export { createRetriever, renderMemoryForPrompt } from './retrieve.ts';
export { runSelfEval } from './selfeval.ts';
export { promoteSkills, recordRecipeOutcome } from './skills.ts';
export { JsonMemoryStore, type MemoryStore } from './store.ts';
export type * from './types.ts';
export { toRunView } from './views.ts';
export { isExternalTask, recipeLabel, upgradeKey, versionLabel } from './upgrade.ts';

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

// The RetrieveExternalRecipes entry point (O4) for upgrades and every other external change: the
// same retriever, so embeddings shortlist and the model judges which recipes help. Upgrade recipes
// are keyed by dependency and version range, and API recipes stay readable to the same judge.
export const retrieveExternalRecipes: RetrieveExternalRecipes = (task: ExternalTask) =>
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

// Called by the orchestrator after every run. The run is stored first, so a failed AI pass loses nothing.
// `commit` is the commit the run read; the self-eval reruns the task on it.
export async function learnFromRun(
  input: {
    task: AnyTask;
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
    return learn(run, await recordRecipeOutcome(run, deps), deps);
  });
}

// Called by the GitHub App for what a person did with an Refit PR; memory/README.md lists exactly
// which pull_request events send which verdict. A merge or edit turns a needs-review run into a
// success, distilled into a recipe unless it already was. A close counts against the recipes and
// skills the run used, and takes its repo back off the recipe it was distilled into.
// `options.finalDiff` is the PR's diff after a human's edits. When it is new, the run is distilled
// again with it, so the recipe follows what the human actually merged.
export async function recordVerdict(
  runIdOrPr: string,
  verdict: HumanVerdict,
  deps: MemoryDeps = defaultMemory(),
  options: { finalDiff?: string } = {},
): Promise<Learned | undefined> {
  const recorded = await deps.store.recordVerdict(runIdOrPr, verdict, options.finalDiff);
  if (!recorded) return undefined;
  return oneAtATime(async () => {
    const run = (await deps.store.getRun(recorded.id)) ?? recorded;
    const demoted = await recordRecipeOutcome(run, deps);
    const { extraction } = run;
    const distilled = extraction?.status === 'done' && extraction.mode === 'recipe';
    // A PR merged as it was says nothing the first distilling didn't hear.
    const humanDiffIsNew =
      run.humanDiff !== undefined &&
      run.humanDiff.trim() !== run.record.diff.trim() &&
      !(extraction?.status === 'done' && extraction.humanDiffSha === sha(run.humanDiff));
    return learn(run, demoted, deps, succeeded(run.record) && (!distilled || humanDiffIsNew));
  });
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

// Saves one scan's report, for the dashboard's history. The orchestrator calls it after scanRepo.
export async function recordScanReport(
  report: ScanReport,
  store: MemoryStore = defaultMemory().store,
): Promise<void> {
  await store.saveScan(report);
}

// Scan reports newest first, optionally for one repo, for the dashboard's history.
export async function listScanReports(
  filter: { repo?: string; limit?: number } = {},
  store: MemoryStore = defaultMemory().store,
): Promise<ScanReport[]> {
  const scans = (await store.listScans())
    .filter((scan) => filter.repo === undefined || scan.repo === filter.repo)
    .sort((a, b) => b.scannedAt.localeCompare(a.scannedAt));
  return scans.slice(0, filter.limit ?? scans.length).map(({ id: _id, ...report }) => report);
}

// The latest report for each repo, newest first: what the "What's behind" page shows.
export async function latestScanReports(
  filter: { repos?: string[] } = {},
  store: MemoryStore = defaultMemory().store,
): Promise<ScanReport[]> {
  const latest = new Map<string, ScanReport>();
  for (const report of await listScanReports({}, store)) {
    if (filter.repos && !filter.repos.includes(report.repo)) continue;
    if (!latest.has(report.repo)) latest.set(report.repo, report);
  }
  return [...latest.values()];
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
