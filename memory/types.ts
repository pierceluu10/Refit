import type { MigrationTask, Recipe, RunRecord } from '../shared/types.ts';

export type HumanVerdict = NonNullable<RunRecord['humanVerdict']>;

// What really happened to a fix. The harness gives the rescan, a benchmark gives a locked test, and
// the GitHub App gives the rest (P7).
export type FixEvidence = {
  rescanClean?: boolean;
  lockedTest?: boolean; // benchmarks only: a stand-in for a merge, never counted for customers
  edited?: boolean; // a person's commits changed our PR
  merged?: { at: string; humanDiff?: string }; // humanDiff: our PR against what was merged
  closed?: { at: string; comment?: string };
  reverted?: { at: string; via: 'revert' | 'rescan' }; // 'rescan': the dead thing came back
};

// One recorded run: the task, the harness's RunRecord, the full transcript and which recipes it was shown.
export type StoredRun = {
  id: string;
  recordedAt: string;
  task: MigrationTask;
  record: RunRecord;
  transcript: string;
  usedRecipeIds: string[];
  evidence?: FixEvidence;
  // The commit the run read, so the self-eval can rerun the task on the same code.
  commit?: string;
  // Set once extraction has been tried; a failed one can be re-extracted later.
  extraction?:
    | { status: 'done'; mode: 'recipe' | 'pitfalls'; recipeId?: string; at: string }
    | { status: 'failed'; reason: string; at: string };
};

// A recipe verified on enough repos becomes a skill: a reusable prompt block the harness injects.
export type Skill = {
  status: 'active' | 'demoted';
  prompt: string;
  promotedAt: string;
  // Runs that used the active skill and whose PR a human closed; ids, so no run is counted twice.
  failedRunIds: string[];
  demotedAt?: string;
};

// Recipe from shared/types.ts plus what memory needs to keep it useful. Still assignable to Recipe.
export type MemoryRecipe = Recipe & {
  diffSketch: string;
  repos: string[];
  createdAt: string;
  updatedAt: string;
  embedding?: { model: string; vector: number[] };
  skill?: Skill;
  // Runs that were shown this recipe and failed (see failedWith). Retrieval shows the count.
  failedRunIds?: string[];
  // The provider changes its runs migrated, so the next repo with the same change finds it first.
  changeIds?: string[];
  // Low until a real merge backs it. benchmarkOnly: all it has is locked tests, so it never counts
  // for customers. `verifiedRepos` counts merged repos only.
  confidence?: 'low' | 'merged';
  benchmarkOnly?: boolean;
};
