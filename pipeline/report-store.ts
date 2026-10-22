import type { Pool } from 'pg';
import type { Inventory } from './inventory.ts';

export interface ReportedRepository {
  installationId: number;
  repository: string;
  revision: string | null;
  inventory: Inventory;
  report: {
    issue: number | null;
    digest: string;
    status: 'sending' | 'opened' | 'updated' | 'failed';
    message: string | null;
    updatedAt: Date;
  } | null;
}

// Owner decision (2026-10-22): report issues go only to repositories with a stored approval.
const APPROVED = `EXISTS (SELECT 1 FROM refit_approvals a WHERE lower(a.repository) = t.repository)`;

// Reads and writes the report table, which hosted migration 7 creates when the hosted store opens.
export function openReportStore(pool: Pool) {
  // The last complete inventory of every approved repository of an allowed, active installation,
  // kept through a stopped re-scan, with its report issue.
  const repositories = async (): Promise<ReportedRepository[]> => {
    const { rows } = await pool.query<{
      installation_id: string;
      repository: string;
      revision: string | null;
      inventory: Inventory;
      issue: number | null;
      digest: string | null;
      status: 'sending' | 'opened' | 'updated' | 'failed' | null;
      message: string | null;
      updated_at: Date | null;
    }>(
      `SELECT t.installation_id, t.repository, t.inventory_revision AS revision, t.inventory,
         r.issue, r.digest, r.status, r.message, r.updated_at
       FROM refit_inventories t
       JOIN refit_installations i ON i.id = t.installation_id
       LEFT JOIN refit_reports r
         ON r.installation_id = t.installation_id AND r.repository = t.repository
       WHERE i.status = 'active' AND i.allowed AND t.inventory IS NOT NULL AND ${APPROVED}
       ORDER BY t.installation_id, t.repository`,
    );
    return rows.map((row) => ({
      installationId: Number(row.installation_id),
      repository: row.repository,
      revision: row.revision,
      inventory: row.inventory,
      report:
        row.digest === null
          ? null
          : {
              issue: row.issue,
              digest: row.digest,
              status: row.status!,
              message: row.message,
              updatedAt: row.updated_at!,
            },
    }));
  };

  // Takes the write of a report with this digest before anything is sent, so concurrent workers
  // and restarts write each change once. A write that failed or never finished is taken again
  // after `retryHours`. Returns the issue to update (null opens or finds one), or null when this
  // digest is already written or the repository is no longer installed by an allowed account or
  // approved.
  const claim = async (
    installationId: number,
    repository: string,
    digest: string,
    now: Date,
    retryHours: number,
  ) => {
    const { rows } = await pool.query<{ issue: number | null }>(
      `INSERT INTO refit_reports (installation_id, repository, digest, status, updated_at)
       SELECT t.installation_id, t.repository, $3, 'sending', $4
       FROM refit_installation_repositories t
       JOIN refit_installations i ON i.id = t.installation_id
       WHERE i.status = 'active' AND i.allowed AND t.installation_id = $1 AND t.repository = $2
         AND ${APPROVED}
       ON CONFLICT (installation_id, repository) DO UPDATE
         SET digest = EXCLUDED.digest, status = 'sending', message = NULL,
           updated_at = EXCLUDED.updated_at
         WHERE refit_reports.digest <> EXCLUDED.digest
           OR (refit_reports.status IN ('sending', 'failed')
             AND refit_reports.updated_at <= EXCLUDED.updated_at - make_interval(hours => $5))
       RETURNING issue`,
      [installationId, repository, digest, now, retryHours],
    );
    return rows[0] ? { issue: rows[0].issue } : null;
  };

  const record = async (
    installationId: number,
    repository: string,
    digest: string,
    outcome: {
      issue: number | null;
      status: 'opened' | 'updated' | 'failed';
      message: string | null;
    },
  ) => {
    await pool.query(
      `UPDATE refit_reports SET issue = coalesce($4, issue), status = $5, message = $6
       WHERE installation_id = $1 AND repository = $2 AND digest = $3 AND status = 'sending'`,
      [installationId, repository, digest, outcome.issue, outcome.status, outcome.message],
    );
  };

  // The report issue of each repository, for /status.
  const read = async () =>
    (
      await pool.query<{
        installation_id: string;
        repository: string;
        issue: number | null;
        status: string;
        message: string | null;
        updated_at: Date;
      }>(
        `SELECT installation_id, repository, issue, status, message, updated_at
         FROM refit_reports ORDER BY installation_id, repository`,
      )
    ).rows.map((row) => ({
      installationId: Number(row.installation_id),
      repository: row.repository,
      issue: row.issue,
      status: row.status,
      message: row.message,
      updatedAt: row.updated_at.toISOString(),
    }));

  return { repositories, claim, record, read };
}
