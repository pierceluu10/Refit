// How each Refit pull request ended, recorded through the App from the first beta customer
// (founder decision, 2026-10-28): merged without edits, merged with edits, closed unmerged or
// reverted, with the customer's last comment as the reason. A merge counts as without edits only
// when the merged head is the commit Refit pushed (`<!-- refit-pushed: <sha> -->`); a draft with
// no record counts as edited, so the merge rate is never overstated.

import type { Pool, PoolClient } from 'pg';
import { isObject } from './specifications.ts';

export type PullOutcome =
  'merged-without-edits' | 'merged-with-edits' | 'closed-unmerged' | 'reverted';

export interface ClosedPullRequest {
  kind: 'pull_request_closed';
  installation: number;
  repository: string;
  number: number;
  head: string;
  merged: boolean;
  mergeCommit: string | null;
  pushed: string | null;
  closedAt: string;
}

const PUSHED = /<!-- refit-pushed: ([a-f0-9]{40}) -->/;
const REVERTS = /This reverts commit ([a-f0-9]{40})/g;
const REASON_CHARACTERS = 1000;

export function pushedCommit(body: unknown) {
  return typeof body === 'string' ? (PUSHED.exec(body)?.[1] ?? null) : null;
}

export function pullOutcome(
  change: Pick<ClosedPullRequest, 'merged' | 'head' | 'pushed'>,
): PullOutcome {
  if (!change.merged) return 'closed-unmerged';
  return change.pushed === change.head ? 'merged-without-edits' : 'merged-with-edits';
}

// The commits a push reverts, from the messages `git revert` writes.
export function revertedCommits(commits: unknown) {
  if (!Array.isArray(commits)) return [];
  return [
    ...new Set(
      commits.flatMap((commit) =>
        isObject(commit) && typeof commit.message === 'string'
          ? [...commit.message.matchAll(REVERTS)].map((match) => match[1])
          : [],
      ),
    ),
  ];
}

// The customer's reason: their newest comment on the pull request, never a bot's.
export function customerReason(comments: unknown) {
  if (!Array.isArray(comments)) return null;
  const human = comments
    .filter(
      (comment) =>
        isObject(comment) &&
        isObject(comment.user) &&
        comment.user.type !== 'Bot' &&
        typeof comment.body === 'string' &&
        comment.body.trim(),
    )
    .at(-1);
  return isObject(human) ? String(human.body).trim().slice(0, REASON_CHARACTERS) : null;
}

export const PULL_OUTCOMES_TABLE = `
CREATE TABLE IF NOT EXISTS refit_pull_outcomes (
  installation_id bigint NOT NULL,
  repository text NOT NULL,
  number integer NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('merged-without-edits', 'merged-with-edits', 'closed-unmerged', 'reverted')),
  head text NOT NULL,
  merge_commit text,
  pushed text,
  reason text,
  reason_checked boolean NOT NULL DEFAULT false,
  closed_at timestamptz NOT NULL,
  reverted_at timestamptz,
  PRIMARY KEY (repository, number)
);
ALTER TABLE refit_pull_outcomes ENABLE ROW LEVEL SECURITY;
`;

// Called inside the webhook's delivery transaction, so a redelivery records nothing twice. A
// reopened and closed again pull request keeps its newest close.
export async function recordPullOutcome(client: PoolClient, change: ClosedPullRequest) {
  await client.query(
    `INSERT INTO refit_pull_outcomes
       (installation_id, repository, number, outcome, head, merge_commit, pushed, closed_at)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8
     FROM refit_installation_repositories r JOIN refit_installations i ON i.id = r.installation_id
     -- Only repositories of an allowed installation, as for every other hosted record.
     WHERE r.installation_id = $1 AND lower(r.repository) = $2 AND i.allowed
     ON CONFLICT (repository, number) DO UPDATE SET
       outcome = EXCLUDED.outcome, head = EXCLUDED.head, merge_commit = EXCLUDED.merge_commit,
       pushed = EXCLUDED.pushed, closed_at = EXCLUDED.closed_at, reason_checked = false`,
    [
      change.installation,
      change.repository,
      change.number,
      pullOutcome(change),
      change.head,
      change.mergeCommit,
      change.pushed,
      change.closedAt,
    ],
  );
  return 'accepted' as const;
}

export async function recordReverts(client: PoolClient, repository: string, commits: string[]) {
  if (!commits.length) return 0;
  const { rowCount } = await client.query(
    `UPDATE refit_pull_outcomes SET outcome = 'reverted', reverted_at = now()
     WHERE repository = $1 AND merge_commit = ANY($2) AND outcome <> 'reverted'`,
    [repository, commits],
  );
  return rowCount ?? 0;
}

export function openPullOutcomeStore(pool: Pool) {
  return {
    // Closed pull requests whose comments were not read yet.
    unchecked: async (limit = 20) =>
      (
        await pool.query<{ installationId: number; repository: string; number: number }>(
          `SELECT installation_id AS "installationId", repository, number FROM refit_pull_outcomes
           WHERE NOT reason_checked ORDER BY closed_at LIMIT $1`,
          [limit],
        )
      ).rows,
    setReason: (repository: string, number: number, reason: string | null) =>
      pool.query(
        'UPDATE refit_pull_outcomes SET reason = $3, reason_checked = true WHERE repository = $1 AND number = $2',
        [repository, number, reason],
      ),
    summary: async () =>
      outcomeRates(
        (
          await pool.query<{ outcome: PullOutcome; count: string }>(
            'SELECT outcome, count(*) AS count FROM refit_pull_outcomes GROUP BY outcome',
          )
        ).rows.map((row) => ({ outcome: row.outcome, count: Number(row.count) })),
      ),
  };
}

// Merge rate: merged (with or without edits, reverted included) over every closed pull request.
// Wrong-fix rate: merged pull requests the customer had to edit or later reverted.
export function outcomeRates(rows: { outcome: PullOutcome; count: number }[]) {
  const count = (outcome: PullOutcome) =>
    rows.filter((row) => row.outcome === outcome).reduce((sum, row) => sum + row.count, 0);
  const counts = {
    'merged-without-edits': count('merged-without-edits'),
    'merged-with-edits': count('merged-with-edits'),
    'closed-unmerged': count('closed-unmerged'),
    reverted: count('reverted'),
  };
  const merged = counts['merged-without-edits'] + counts['merged-with-edits'] + counts.reverted;
  const closed = merged + counts['closed-unmerged'];
  return {
    counts,
    mergeRate: closed ? merged / closed : null,
    wrongFixRate: merged ? (counts['merged-with-edits'] + counts.reverted) / merged : null,
  };
}
