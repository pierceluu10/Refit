// The numbers that say whether learning works: tracked from stored runs, in plain code.
import { evidenceOf } from './ladder.ts';
import type { DetectionLesson } from './lessons.ts';
import type { StoredRun } from './types.ts';

export type LearningMetrics = {
  fixes: number; // runs with a change
  noModelShare: number; // of those, the share a proven fix finished with no model
  merged: number;
  mergedWithoutEdits: number;
  reverts: number;
  scannerMisses: number; // what people and the sweep found that the scan didn't
  sweepMisses: number;
};

export function learningMetrics(runs: StoredRun[], lessons: DetectionLesson[]): LearningMetrics {
  const fixes = runs.filter((run) => run.record.diff.trim() !== '');
  const noModel = fixes.filter((run) => {
    const { models = [] } = run.record as { models?: string[] };
    return models.length === 0 && (run.record as { provenFixes?: string[] }).provenFixes?.length;
  });
  const evidence = runs.flatMap(evidenceOf);
  const merged = evidence.filter((item) => item.kind === 'merged').length;
  const edited = evidence.filter((item) => item.kind === 'edited').length;
  return {
    fixes: fixes.length,
    noModelShare: fixes.length ? noModel.length / fixes.length : 0,
    merged: merged + edited,
    mergedWithoutEdits: merged,
    reverts: evidence.filter((item) => item.kind === 'reverted').length,
    scannerMisses: lessons.filter(
      (lesson) => lesson.kind !== 'false-alarm' && lesson.kind !== 'rejected',
    ).length,
    sweepMisses: lessons.filter((lesson) => lesson.kind === 'sweep-miss').length,
  };
}
