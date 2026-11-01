// The hand-check log, evals/reviews.json: one entry for every verified PR. A person reads the
// PR and records whether "verified" was right. Entries are only ever added, never removed.
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
  grade: 'verified';
  /** The AI reviewer's second opinion, copied for the hand-checker. Advisory only. */
  aiReview?: Pick<AdvisoryReview, 'opinion' | 'summary' | 'checkFirst'>;
  handCheck: {
    status: 'pending' | 'agree' | 'disagree';
    reviewer?: string;
    checkedAt?: string;
    notes?: string;
  };
  firstSeen: string;
};

export const REVIEWS_PATH = join(import.meta.dirname, '..', 'reviews.json');

export function readReviews(path = REVIEWS_PATH): HandCheck[] {
  if (!existsSync(path)) return [];
  const data = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(data)) throw new Error(`${path} must hold a JSON array`);
  return data as HandCheck[];
}

/** Adds a pending entry for every verified PR not yet in the log. Never edits existing ones. */
export function syncReviews(
  existing: HandCheck[],
  results: RepoResult[],
  now = new Date().toISOString(),
): { reviews: HandCheck[]; added: HandCheck[] } {
  const keys = new Set(existing.map((entry) => entry.key));
  const added: HandCheck[] = [];
  for (const repo of results) {
    for (const task of repo.tasks) {
      if (task.record?.outcome !== 'verified') continue;
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
        grade: 'verified',
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

/** Verified PRs in these results that have no hand-check entry. Should always be empty. */
export function missingHandChecks(reviews: HandCheck[], results: RepoResult[]): string[] {
  const keys = new Set(reviews.map((entry) => entry.key));
  return results.flatMap((repo) =>
    repo.tasks
      .filter((task) => task.record?.outcome === 'verified')
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
