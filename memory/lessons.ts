// What memory hands the scanner: every false alarm and miss a run showed, as a detection lesson. Each
// becomes a scanner rule and a permanent fixture (P5). No model: these are facts from the run.
import type { StoredRun } from './types.ts';

export type DetectionLesson = {
  kind: 'false-alarm' | 'miss' | 'sweep-miss' | 'rejected';
  entryId?: string;
  repo: string;
  commit?: string;
  file?: string;
  why: string;
  runId?: string;
};

type RepoFields = {
  findings?: { entryId: string; file: string }[];
  entries?: { id: string; lookFor: string[] }[];
};
type ReportFields = { report?: { falseAlarms?: { entryId: string; file: string; why: string }[] } };

// A dead name a person took out of a file the scan never flagged for that entry.
function missesIn(run: StoredRun, humanDiff: string): DetectionLesson[] {
  const { findings = [], entries = [] } = run.task as RepoFields;
  const lessons = new Map<string, DetectionLesson>();
  for (const section of humanDiff.split(/^(?=diff --git )/m)) {
    const file = /^diff --git a\/.+? b\/(.+)$/m.exec(section)?.[1];
    if (!file) continue;
    const removed = section.split('\n').filter((line) => /^-(?!--)/.test(line));
    for (const entry of entries) {
      const hit = entry.lookFor.some((name) => removed.some((line) => line.includes(name)));
      const flagged = findings.some((f) => f.entryId === entry.id && f.file === file);
      if (!hit || flagged) continue;
      lessons.set(`${entry.id}\n${file}`, {
        kind: 'miss',
        entryId: entry.id,
        repo: run.task.repo,
        ...(run.commit && { commit: run.commit }),
        file,
        why: 'A person removed this dead name; the scan had not flagged it in this file.',
        runId: run.id,
      });
    }
  }
  return [...lessons.values()];
}

export function lessonsFrom(run: StoredRun): DetectionLesson[] {
  const { falseAlarms = [] } = (run.record as ReportFields).report ?? {};
  const base = {
    repo: run.task.repo,
    ...(run.commit && { commit: run.commit }),
    runId: run.id,
  };
  const closed = run.evidence?.closed?.comment;
  return [
    ...falseAlarms.map((alarm) => ({ ...base, kind: 'false-alarm' as const, ...alarm })),
    ...(run.evidence?.merged?.humanDiff ? missesIn(run, run.evidence.merged.humanDiff) : []),
    ...(closed ? [{ ...base, kind: 'rejected' as const, why: closed }] : []),
  ];
}
