import type { Pool } from 'pg';
import { transaction } from './hosted-database.ts';
import type { Inventory, InventoryExposure } from './inventory.ts';

// Joins a table aliased `t` to an allowed, active installation. Owner decision (2026-10-22):
// alerts and digests reach only repositories with a stored approval.
const ALLOWED = `JOIN refit_installations i ON i.id = t.installation_id
  WHERE i.status = 'active' AND i.allowed
    AND EXISTS (SELECT 1 FROM refit_approvals a WHERE lower(a.repository) = t.repository)`;

export interface DeadlineAlert {
  deadline: string;
  stage: number;
  issue: number | null;
  status: 'sending' | 'opened' | 'updated' | 'failed';
  message: string | null;
  sentAt: Date;
}

export interface MonitoredRepository {
  installationId: number;
  owner: string;
  repository: string;
  revision: string | null;
  exposures: InventoryExposure[];
  ignores: Inventory['ignores'];
  integrations: Inventory['integrations'];
  alerts: DeadlineAlert[];
  digest: { issue: number | null; at: Date | null };
}

// Reads and writes the monitoring tables, which hosted migration 6 creates when the hosted store
// opens.
export function openMonitoringStore(pool: Pool) {
  // Records a default-branch push for an inventoried or installed repository of an allowed
  // installation. Returns false for anything else, which is then ignored.
  const pushed = async (installationId: number, repository: string, now: Date) =>
    Boolean(
      (
        await pool.query(
          `INSERT INTO refit_monitoring (installation_id, repository, pushed, rescanned_at)
           SELECT t.installation_id, t.repository, true, $3
           FROM refit_installation_repositories t ${ALLOWED}
             AND t.installation_id = $1 AND t.repository = $2
           ON CONFLICT (installation_id, repository) DO UPDATE SET pushed = true`,
          [installationId, repository.toLowerCase(), now],
        )
      ).rowCount,
    );

  // Repositories whose inventory should be taken again: a push, a different registry or an
  // inventory older than `ageHours`, at most once per `debounceMinutes`. Repositories seen for the
  // first time start their clock now.
  const due = (now: Date, registry: string, debounceMinutes: number, ageHours: number) =>
    transaction(pool, async (client) => {
      await client.query(
        `INSERT INTO refit_monitoring (installation_id, repository, rescanned_at)
         SELECT t.installation_id, t.repository, $1 FROM refit_inventories t ${ALLOWED}
         ON CONFLICT DO NOTHING`,
        [now],
      );
      const { rows } = await client.query<{
        installation_id: string;
        repository: string;
        reason: 'push' | 'registry' | 'age';
      }>(
        `SELECT t.installation_id, t.repository,
           CASE WHEN t.pushed THEN 'push'
             WHEN v.registry IS NOT NULL AND v.registry <> $2 AND v.error IS NULL THEN 'registry'
             ELSE 'age' END AS reason
         FROM refit_monitoring t
         JOIN refit_inventories v
           ON v.installation_id = t.installation_id AND v.repository = t.repository
         ${ALLOWED} AND v.state = 'idle'
           AND t.rescanned_at <= $1::timestamptz - make_interval(mins => $3)
           AND (t.pushed OR (v.registry IS NOT NULL AND v.registry <> $2 AND v.error IS NULL)
             OR t.rescanned_at <= $1::timestamptz - make_interval(hours => $4))
         ORDER BY t.installation_id, t.repository`,
        [now, registry, debounceMinutes, ageHours],
      );
      return rows.map((row) => ({
        installationId: Number(row.installation_id),
        repository: row.repository,
        reason: row.reason,
      }));
    });

  // Marks re-scans as requested. Called after the inventory request, so a crash in between costs
  // one extra re-scan rather than a lost one.
  const rescanned = async (
    repositories: { installationId: number; repository: string }[],
    now: Date,
  ) => {
    await pool.query(
      `UPDATE refit_monitoring SET pushed = false, rescanned_at = $3
       WHERE (installation_id, repository) IN (
         SELECT * FROM unnest($1::bigint[], $2::text[]))`,
      [
        repositories.map((item) => item.installationId),
        repositories.map((item) => item.repository),
        now,
      ],
    );
  };

  // The last complete inventory of each monitored repository, kept through a stopped re-scan, with
  // the alerts sent for it.
  const repositories = async (): Promise<MonitoredRepository[]> => {
    const [inventories, alerts] = await Promise.all([
      pool.query<{
        installation_id: string;
        owner: string;
        repository: string;
        revision: string | null;
        exposures: InventoryExposure[];
        ignores: Inventory['ignores'];
        integrations: Inventory['integrations'];
        digest_issue: number | null;
        digest_at: Date | null;
      }>(
        `SELECT t.installation_id, i.owner, t.repository, t.inventory_revision AS revision,
           t.inventory -> 'deadlines' -> 'exposures' AS exposures,
           t.inventory -> 'ignores' AS ignores, t.inventory -> 'integrations' AS integrations,
           m.digest_issue, m.digest_at
         FROM refit_inventories t
         LEFT JOIN refit_monitoring m
           ON m.installation_id = t.installation_id AND m.repository = t.repository
         ${ALLOWED} AND t.inventory IS NOT NULL
         ORDER BY t.installation_id, t.repository`,
      ),
      pool.query<{
        installation_id: string;
        repository: string;
        deadline: string;
        stage: number;
        issue: number | null;
        status: DeadlineAlert['status'];
        message: string | null;
        sent_at: Date;
      }>(
        `SELECT installation_id, repository, deadline, stage, issue, status, message, sent_at
         FROM refit_deadline_alerts ORDER BY deadline`,
      ),
    ]);
    return inventories.rows.map((row) => ({
      installationId: Number(row.installation_id),
      owner: row.owner,
      repository: row.repository,
      revision: row.revision,
      exposures: row.exposures,
      ignores: row.ignores,
      integrations: row.integrations,
      alerts: alerts.rows
        .filter(
          (alert) =>
            alert.installation_id === row.installation_id && alert.repository === row.repository,
        )
        .map((alert) => ({
          deadline: alert.deadline,
          stage: alert.stage,
          issue: alert.issue,
          status: alert.status,
          message: alert.message,
          sentAt: alert.sent_at,
        })),
      digest: { issue: row.digest_issue, at: row.digest_at },
    }));
  };

  // Takes one alert stage before anything is sent, so a stage is sent at most once even across
  // restarts and concurrent workers. Returns the issue to update (null opens one), or null when
  // the stage was already taken or the repository is no longer installed by an allowed account.
  const claim = async (
    installationId: number,
    repository: string,
    deadline: string,
    stage: number,
    now: Date,
  ) => {
    const { rows } = await pool.query<{ issue: number | null }>(
      `INSERT INTO refit_deadline_alerts
         (installation_id, repository, deadline, stage, status, sent_at)
       SELECT t.installation_id, t.repository, $3, $4, 'sending', $5
       FROM refit_installation_repositories t ${ALLOWED}
         AND t.installation_id = $1 AND t.repository = $2
       ON CONFLICT (installation_id, repository, deadline) DO UPDATE
         SET stage = EXCLUDED.stage, status = 'sending', message = NULL, sent_at = EXCLUDED.sent_at
         WHERE refit_deadline_alerts.stage > EXCLUDED.stage
       RETURNING issue`,
      [installationId, repository, deadline, stage, now],
    );
    return rows[0] ? { issue: rows[0].issue } : null;
  };

  const record = async (
    installationId: number,
    repository: string,
    deadline: string,
    stage: number,
    outcome: {
      issue: number | null;
      status: 'opened' | 'updated' | 'failed';
      message: string | null;
    },
  ) => {
    await pool.query(
      `UPDATE refit_deadline_alerts SET issue = $5, status = $6, message = $7
       WHERE installation_id = $1 AND repository = $2 AND deadline = $3 AND stage = $4
         AND status = 'sending'`,
      [installationId, repository, deadline, stage, outcome.issue, outcome.status, outcome.message],
    );
  };

  // Takes this week's digest for a repository before it is written, as `claim` does for alerts.
  // Returns the digest issue to update (null opens one), or null when it is not due.
  const claimDigest = async (
    installationId: number,
    repository: string,
    now: Date,
    intervalDays: number,
  ) => {
    const { rows } = await pool.query<{ digest_issue: number | null }>(
      `INSERT INTO refit_monitoring (installation_id, repository, rescanned_at, digest_at)
       SELECT t.installation_id, t.repository, $3, $3
       FROM refit_installation_repositories t ${ALLOWED}
         AND t.installation_id = $1 AND t.repository = $2
       ON CONFLICT (installation_id, repository) DO UPDATE SET digest_at = EXCLUDED.digest_at
         WHERE refit_monitoring.digest_at IS NULL
           OR refit_monitoring.digest_at <= EXCLUDED.digest_at - make_interval(days => $4)
       RETURNING digest_issue`,
      [installationId, repository, now, intervalDays],
    );
    return rows[0] ? { issue: rows[0].digest_issue } : null;
  };

  const recordDigest = async (installationId: number, repository: string, issue: number) => {
    await pool.query(
      `UPDATE refit_monitoring SET digest_issue = $3
       WHERE installation_id = $1 AND repository = $2`,
      [installationId, repository, issue],
    );
  };

  return {
    pushed,
    due,
    rescanned,
    repositories,
    claim,
    record,
    claimDigest,
    recordDigest,
  };
}
