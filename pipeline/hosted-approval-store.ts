import type { Pool, PoolClient } from 'pg';
import type { GitHubWebhook } from './github-webhooks.ts';

// A worker that stopped while handling a command leaves it to be reclaimed after this long.
const COMMAND_RECLAIM_SECONDS = 600;
// An issue GitHub refused to open, for example without the Issues permission, is retried hourly.
const FAILED_RETRY_SECONDS = 3600;
const COMMAND = /^\/refit[ \t]+(approve|revoke)(?:[ \t]+(\S+))?$/i;

export type ApprovalIssueState =
  'review' | 'proposal' | 'invalid' | 'no-providers' | 'approved' | 'failed';

export interface ApprovalIssue {
  repository: string;
  installationId: number;
  base: string | null;
  issue: number | null;
  state: ApprovalIssueState;
  fingerprint: string | null;
  shown: string[];
}

export interface ApprovalCommand {
  id: number;
  installationId: number;
  repository: string;
  issue: number;
  author: string;
  edited: boolean;
  command: 'approve' | 'revoke';
  argument: string | null;
}

// Records a `/refit approve` or `/refit revoke` comment inside the delivery's transaction. The
// comment must contain only the command; anything else is ignored.
export async function recordApprovalCommand(
  client: PoolClient,
  change: Extract<GitHubWebhook, { kind: 'issue_comment' }>,
) {
  const command = COMMAND.exec(change.body.trim());
  if (!command) return 'ignored' as const;
  const { rowCount } = await client.query(
    `INSERT INTO refit_approval_commands
       (comment_id, edited, installation_id, repository, issue, author, command, argument, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending') ON CONFLICT DO NOTHING`,
    [
      change.comment,
      change.edited,
      change.installation,
      change.repository,
      change.issue,
      change.author,
      command[1].toLowerCase(),
      command[2] ?? null,
    ],
  );
  return rowCount ? ('queued' as const) : ('duplicate' as const);
}

const ISSUE_COLUMNS = `repository, installation_id AS "installationId", base, issue, state,
  fingerprint, shown`;

function issueRow<T extends { installationId: string }>(row: T) {
  return { ...row, installationId: Number(row.installationId) };
}

export function openApprovalStore(pool: Pool) {
  // Installed repositories of allowed, active installations that have no approval and no issue
  // yet, issues marked for refresh, and failed attempts due for a retry.
  const due = async () =>
    (
      await pool.query<{ repository: string; installationId: string }>(
        `SELECT r.repository, r.installation_id AS "installationId"
         FROM refit_installation_repositories r
         JOIN refit_installations i ON i.id = r.installation_id
         LEFT JOIN refit_approval_issues q ON q.repository = r.repository
         WHERE i.allowed AND i.status = 'active' AND (q.refresh OR (
           NOT EXISTS (SELECT 1 FROM refit_approvals a WHERE a.repository = r.repository)
           AND (q.repository IS NULL
             OR (q.state = 'failed' AND q.updated_at < now() - make_interval(secs => $1)))))
         ORDER BY r.repository`,
        [FAILED_RETRY_SECONDS],
      )
    ).rows.map((row) => ({
      repository: row.repository,
      installationId: Number(row.installationId),
    }));

  const issue = async (repository: string) => {
    const { rows } = await pool.query<
      Omit<ApprovalIssue, 'installationId'> & { installationId: string }
    >(`SELECT ${ISSUE_COLUMNS} FROM refit_approval_issues WHERE repository = $1`, [repository]);
    return rows[0] ? (issueRow(rows[0]) as ApprovalIssue) : null;
  };

  // Stores what the issue now shows. Every fingerprint it has shown is kept, so an older prefix
  // is refused as stale rather than wrong.
  const record = async (change: Omit<ApprovalIssue, 'shown'> & { message: string | null }) => {
    await pool.query(
      `INSERT INTO refit_approval_issues
         (repository, installation_id, base, issue, state, fingerprint, shown, message)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6::text IS NULL THEN '{}' ELSE ARRAY[$6::text] END, $7)
       ON CONFLICT (repository) DO UPDATE SET installation_id = $2, base = $3,
         issue = coalesce($4, refit_approval_issues.issue), state = $5, fingerprint = $6,
         shown = CASE WHEN $6::text IS NULL OR $6::text = ANY(refit_approval_issues.shown)
           THEN refit_approval_issues.shown ELSE refit_approval_issues.shown || $6::text END,
         message = $7, refresh = false, updated_at = now()`,
      [
        change.repository,
        change.installationId,
        change.base,
        change.issue,
        change.state,
        change.fingerprint,
        change.message,
      ],
    );
  };

  // A job found that the approved inputs changed: the issue shows the current configuration again.
  const changed = async (repository: string) => {
    await pool.query(
      `UPDATE refit_approval_issues SET refresh = true, updated_at = now() WHERE repository = $1`,
      [repository],
    );
  };

  const claim = async (): Promise<ApprovalCommand | null> => {
    const { rows } = await pool.query(
      `UPDATE refit_approval_commands SET status = 'processing', claimed_at = now()
       WHERE id = (
         SELECT id FROM refit_approval_commands
         WHERE status = 'pending'
           OR (status = 'processing' AND claimed_at < now() - make_interval(secs => $1))
         ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING id, installation_id AS "installationId", repository, issue, author, edited,
         command, argument`,
      [COMMAND_RECLAIM_SECONDS],
    );
    return rows[0]
      ? { ...rows[0], id: Number(rows[0].id), installationId: Number(rows[0].installationId) }
      : null;
  };

  const finish = async (id: number, outcome: string) => {
    await pool.query(
      `UPDATE refit_approval_commands SET status = 'done', outcome = $2 WHERE id = $1`,
      [id, outcome],
    );
  };

  // Whether the command's installation is allowed and active and still has the repository.
  const installed = async (installationId: number, repository: string) =>
    Boolean(
      (
        await pool.query(
          `SELECT 1 FROM refit_installation_repositories r
           JOIN refit_installations i ON i.id = r.installation_id
           WHERE r.installation_id = $1 AND r.repository = $2 AND i.allowed
             AND i.status = 'active'`,
          [installationId, repository],
        )
      ).rowCount,
    );

  const read = async () => {
    const [issues, commands] = await Promise.all([
      pool.query(
        `SELECT ${ISSUE_COLUMNS}, refresh, message, updated_at AS "updatedAt"
         FROM refit_approval_issues ORDER BY repository`,
      ),
      pool.query(
        `SELECT id::text, repository, issue, author, edited, command, argument, status, outcome,
           created_at AS "createdAt"
         FROM refit_approval_commands c ORDER BY c.id`,
      ),
    ]);
    return { issues: issues.rows.map(issueRow), commands: commands.rows };
  };

  return { due, issue, record, changed, claim, finish, installed, read };
}

export type ApprovalStore = ReturnType<typeof openApprovalStore>;
