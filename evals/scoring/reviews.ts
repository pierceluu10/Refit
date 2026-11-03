// The hand-check log, evals/reviews.json: one entry for every verified and needs-review PR. A
// person reads the diff and records whether the grade was right and whether they would merge it.
// Entries are only ever added, never removed.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdvisoryReview } from '../reviewer/reviewer.ts';
import type { RepoResult } from '../runner/types.ts';

export type HandCheck = {
  /** set/repo/taskId: stable across reruns of the same task in the same set. */
  key: string;
  set: string;
  repo: string;
  commit: string;
  taskId: string;
  changeId: string;
  pr?: string;
  /** The harness's grade. A hand-check agrees or disagrees with it. */
  grade: HandCheckedGrade;
  /** Files the diff touches, so the hand-checker knows where to look. */
  files?: string[];
  /** The AI reviewer's second opinion, copied for the hand-checker. Advisory only. */
  aiReview?: Pick<AdvisoryReview, 'opinion' | 'summary' | 'checkFirst'>;
  handCheck: {
    status: 'pending' | 'agree' | 'disagree';
    reviewer?: string;
    checkedAt?: string;
    /** Would the hand-checker merge the diff as it is, after edits, or not at all? */
    wouldMerge?: 'yes' | 'with-edits' | 'no';
    notes?: string;
  };
  firstSeen: string;
};

/** Grades that ship a PR, so a person checks every one. */
export type HandCheckedGrade = 'verified' | 'needs-review';
const HAND_CHECKED: ReadonlySet<string> = new Set<HandCheckedGrade>(['verified', 'needs-review']);

const isHandChecked = (outcome: string | undefined): outcome is HandCheckedGrade =>
  outcome !== undefined && HAND_CHECKED.has(outcome);

/** Files a unified diff touches, from its +++ lines. */
export function diffFiles(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split('\n')) {
    const match = /^\+\+\+ b\/(.+)$/.exec(line);
    if (match?.[1]) files.add(match[1].trim());
  }
  return [...files];
}

export const REVIEWS_PATH = join(import.meta.dirname, '..', 'reviews.json');

export function readReviews(path = REVIEWS_PATH): HandCheck[] {
  if (!existsSync(path)) return [];
  const data = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(data)) throw new Error(`${path} must hold a JSON array`);
  return data as HandCheck[];
}

/**
 * Adds a pending entry for every verified or needs-review PR not yet in the log. Never edits
 * existing ones.
 */
export function syncReviews(
  existing: HandCheck[],
  results: RepoResult[],
  now = new Date().toISOString(),
): { reviews: HandCheck[]; added: HandCheck[] } {
  const keys = new Set(existing.map((entry) => entry.key));
  const added: HandCheck[] = [];
  for (const repo of results) {
    for (const task of repo.tasks) {
      const grade = task.record?.outcome;
      if (!task.record || !isHandChecked(grade)) continue;
      const key = `${repo.set}/${repo.repo}/${task.taskId}`;
      if (keys.has(key)) continue;
      keys.add(key);
      added.push({
        key,
        set: repo.set,
        repo: repo.repo,
        commit: repo.commit,
        taskId: task.taskId,
        changeId: task.changeId,
        ...(task.record.pr ? { pr: task.record.pr } : {}),
        grade,
        files: diffFiles(task.record.diff),
        ...(task.review
          ? {
              aiReview: {
                opinion: task.review.opinion,
                summary: task.review.summary,
                ...(task.review.checkFirst ? { checkFirst: task.review.checkFirst } : {}),
              },
            }
          : {}),
        handCheck: { status: 'pending' },
        firstSeen: now,
      });
    }
  }
  return { reviews: [...existing, ...added], added };
}

/** Verified and needs-review PRs in these results with no hand-check entry. Should be empty. */
export function missingHandChecks(reviews: HandCheck[], results: RepoResult[]): string[] {
  const keys = new Set(reviews.map((entry) => entry.key));
  return results.flatMap((repo) =>
    repo.tasks
      .filter((task) => isHandChecked(task.record?.outcome))
      .map((task) => `${repo.set}/${repo.repo}/${task.taskId}`)
      .filter((key) => !keys.has(key)),
  );
}

export function writeReviews(reviews: HandCheck[], path = REVIEWS_PATH): void {
  writeFileSync(path, `${JSON.stringify(reviews, null, 2)}\n`);
}

/** Hand-check agreement so far, for reading a verified rate with its error bar in mind. */
export function handCheckSummary(reviews: HandCheck[]) {
  const by = (status: HandCheck['handCheck']['status']) =>
    reviews.filter((entry) => entry.handCheck.status === status).length;
  const agree = by('agree');
  const disagree = by('disagree');
  return {
    total: reviews.length,
    pending: by('pending'),
    agree,
    disagree,
    agreementRate: agree + disagree === 0 ? undefined : agree / (agree + disagree),
  };
}
