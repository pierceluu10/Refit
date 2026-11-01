import type { MigrationTask, Recipe, RunRecord } from '../shared/types.ts';

export type HumanVerdict = NonNullable<RunRecord['humanVerdict']>;

// One recorded run: the task, the harness's RunRecord, the full transcript and which recipes it was shown.
export type StoredRun = {
  id: string;
  recordedAt: string;
  task: MigrationTask;
  record: RunRecord;
  transcript: string;
  usedRecipeIds: string[];
};

// A recipe verified on enough repos becomes a skill: a reusable prompt block the harness injects.
export type Skill = {
  status: 'active' | 'demoted';
  prompt: string;
  promotedAt: string;
  // Runs that used the active skill and failed; ids so a later verdict on the same run isn't counted twice.
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
};

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
