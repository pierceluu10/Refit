// Each list entry's level, from its evidence. Levels are replayed from the evidence in date order,
// so a redelivered or late event can't skew them, and the evidence stays whatever the level.
//   new: Claude fixes it from the entry.
//   recipe: a merged fix's steps and pitfalls go to Claude next time.
//   proven: at least 3 merged fixes on different repos, few edits, no reverts. A plain-code fix may run.
//   dropped: a close or revert moved it down a level from new.
// A locked-test pass stands in for a merge to test the mechanics. It only ever moves benchmarkLevel.
import type { StoredRun } from './types.ts';

export type Level = 'new' | 'recipe' | 'proven' | 'dropped';
export type LadderEvidence = {
  kind: 'merged' | 'edited' | 'closed' | 'reverted' | 'locked-test';
  repo: string;
  runId: string;
  at: string;
};
export type LadderEntry = {
  entryId: string;
  level: Level;
  benchmarkLevel: Level;
  evidence: LadderEvidence[];
  updatedAt: string;
};

export const PROVEN_AT_REPOS = 3;
// An edit in more than one merge of three is too many for a fix to run with no model.
const MOST_EDITED_SHARE = 1 / 3;
// Repos a proven fix may be waiting on at once: it rolls out to a few before the rest.
export const ROLLOUT_REPOS = 3;

const LEVELS: Level[] = ['dropped', 'new', 'recipe', 'proven'];

function replay(evidence: LadderEvidence[]): Level {
  let level = 1;
  const merged = new Set<string>();
  let edited = 0;
  let againstIt = 0;
  for (const item of [...evidence].sort((a, b) => a.at.localeCompare(b.at))) {
    if (item.kind === 'closed' || item.kind === 'reverted') {
      againstIt += 1;
      level = Math.max(level - 1, 0);
      continue;
    }
    if (level === 0) continue;
    merged.add(item.repo);
    if (item.kind === 'edited') edited += 1;
    level = Math.max(level, 2);
    const fewEdits = edited <= merged.size * MOST_EDITED_SHARE;
    if (merged.size >= PROVEN_AT_REPOS && fewEdits && againstIt === 0) level = 3;
  }
  return LEVELS[level] as Level;
}

export function evidenceOf(run: StoredRun): LadderEvidence[] {
  const { evidence = {}, record, recordedAt, id, task } = run;
  const base = { repo: task.repo, runId: id };
  const merged =
    evidence.merged ?? (record.humanVerdict === 'merged' ? { at: recordedAt } : undefined);
  const items: LadderEvidence[] = [];
  if (merged && evidence.rescanClean) {
    items.push({ ...base, kind: evidence.edited ? 'edited' : 'merged', at: merged.at });
  }
  if (evidence.lockedTest && evidence.rescanClean) {
    items.push({ ...base, kind: 'locked-test', at: recordedAt });
  }
  // Closed, reopened and merged ends up merged.
  if (evidence.closed && !merged) items.push({ ...base, kind: 'closed', at: evidence.closed.at });
  if (evidence.reverted) items.push({ ...base, kind: 'reverted', at: evidence.reverted.at });
  return items;
}

export const levelsOf = (
  evidence: LadderEvidence[],
): Pick<LadderEntry, 'level' | 'benchmarkLevel'> => ({
  level: replay(evidence.filter((item) => item.kind !== 'locked-test')),
  benchmarkLevel: replay(evidence),
});

const entryIds = (run: StoredRun) => {
  const { entries } = run.task as { entries?: { id: string }[] };
  return entries?.map((entry) => entry.id) ?? [];
};

// shortcut: replays from every stored run; keep a per-entry index once a store holds thousands.
export function ladderFrom(runs: StoredRun[], at: string): LadderEntry[] {
  const byEntry = new Map<string, LadderEvidence[]>();
  for (const run of runs) {
    const items = evidenceOf(run);
    if (items.length === 0) continue;
    const covered = run.evidence?.lockedEntries;
    for (const id of entryIds(run)) {
      const mine = items.filter(
        (item) => item.kind !== 'locked-test' || !covered || covered.includes(id),
      );
      byEntry.set(id, [...(byEntry.get(id) ?? []), ...mine]);
    }
  }
  return [...byEntry].map(([entryId, evidence]) => ({
    entryId,
    ...levelsOf(evidence),
    evidence,
    updatedAt: at,
  }));
}

// May a plain-code fix run for this entry on this repo? Only at proven, and at most ROLLOUT_REPOS
// repos at once may be waiting on a person. Benchmarks may use benchmarkLevel; customers never do.
export function provenAllowed(
  entry: LadderEntry | undefined,
  runs: StoredRun[],
  { benchmark = false }: { benchmark?: boolean } = {},
): boolean {
  if ((benchmark ? entry?.benchmarkLevel : entry?.level) !== 'proven') return false;
  const provenRuns = runs.filter(
    (run) =>
      entryIds(run).includes(entry?.entryId ?? '') &&
      (run.record as { provenFixes?: string[] }).provenFixes?.length,
  );
  const waiting = provenRuns.filter((run) => evidenceOf(run).length === 0).length;
  return benchmark || waiting < ROLLOUT_REPOS;
}
