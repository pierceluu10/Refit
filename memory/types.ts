import type {
  DependencyKind,
  ExternalTask,
  MigrationKind,
  MigrationKindMvp,
  MigrationTask,
  Recipe,
  RunRecord,
  ScanReport,
} from '../shared/types.ts';

export type HumanVerdict = NonNullable<RunRecord['humanVerdict']>;

// Memory learns from API tasks and from external tasks (upgrades, retirements, rules) alike.
export type AnyTask = MigrationTask | ExternalTask;

export type ChangeKind = MigrationKind | MigrationKindMvp;

// What an upgrade recipe is keyed by besides provider and kind: the dependency and the version
// range it moved, e.g. "node 18 → 22", "next 13 → 15", "gpt-4o → gpt-4.1". A label for people and
// for the retrieval judge to read, never a filter.
export type UpgradeKey = {
  dependency: string;
  dependencyKind?: DependencyKind;
  ecosystem?: string;
  from?: string;
  to?: string;
  range: string;
};

// One recorded run: the task, the harness's RunRecord, the full transcript and which recipes it was shown.
export type StoredRun = {
  id: string;
  recordedAt: string;
  task: AnyTask;
  record: RunRecord;
  transcript: string;
  usedRecipeIds: string[];
  // The commit the run read, so the self-eval can rerun the task on the same code.
  commit?: string;
  // The PR's final diff after a human edited it, when the GitHub App sends it with the verdict.
  humanDiff?: string;
  // Set once extraction has been tried; a failed one can be re-extracted later.
  extraction?:
    | {
        status: 'done';
        mode: 'recipe' | 'pitfalls';
        recipeId?: string;
        at: string;
        // Set when the extraction read the human's final diff, so a new edit is read again.
        humanDiffSha?: string;
      }
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
  // Runs that were shown this recipe and whose PR a human closed. Retrieval shows the count.
  failedRunIds?: string[];
  // The change's own kind. Recipe.kind is the shared MigrationKind, so an upgrade kind such as
  // 'runtime-eol' is stored there as 'other' and kept here in full. Unset on API recipes from before.
  changeKind?: ChangeKind;
  // Set for recipes distilled from an external task: the dependency and version range it moved.
  upgrade?: UpgradeKey;
  // Every version range the recipe has been verified on, e.g. ["node 16 → 22", "node 18 → 22"].
  ranges?: string[];
};

// One saved scan, for the dashboard's history and the latest report per repo.
export type StoredScan = ScanReport & { id: string };

export type SelfEvalReport = {
  id: string;
  ranAt: string;
  taskIds: string[];
  results: {
    taskId: string;
    before: RunRecord['outcome'];
    after: RunRecord['outcome'] | 'error';
  }[];
  verifiedRateBefore: number;
  verifiedRateAfter: number;
  previousVerifiedRate?: number;
  costUsd: number;
  summary: string;
};
