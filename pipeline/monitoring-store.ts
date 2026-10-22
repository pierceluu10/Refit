import type { Pool } from 'pg';
import type { DeadlineExposure } from './deadline-exposure.ts';
import { transaction } from './hosted-store.ts';
import type { Inventory } from './inventory.ts';

const SCHEMA_LOCK = 4_206_100_004;

// Monitoring state for each inventoried repository, and the last alert stage sent per deadline.
// Both go with the installed repository, so removal or uninstall deletes them. Times come from the
// monitoring clock, which tests replace.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS refit_monitoring (
  installation_id bigint NOT NULL,
  repository text NOT NULL,
  pushed boolean NOT NULL DEFAULT false,
  rescanned_at timestamptz NOT NULL,
  PRIMARY KEY (installation_id, repository),
  FOREIGN KEY (installation_id, repository)
    REFERENCES refit_installation_repositories (installation_id, repository) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS refit_deadline_alerts (
  installation_id bigint NOT NULL,
  repository text NOT NULL,
  deadline text NOT NULL,
  stage integer NOT NULL,
  issue integer,
  status text NOT NULL CHECK (status IN ('sending', 'opened', 'updated', 'failed')),
  message text,
  sent_at timestamptz NOT NULL,
  PRIMARY KEY (installation_id, repository, deadline),
  FOREIGN KEY (installation_id, repository)
    REFERENCES refit_installation_repositories (installation_id, repository) ON DELETE CASCADE
);
ALTER TABLE refit_monitoring ENABLE ROW LEVEL SECURITY;
ALTER TABLE refit_deadline_alerts ENABLE ROW LEVEL SECURITY;
`;

// Joins a table aliased `t` to an allowed, active installation.
const ALLOWED = `JOIN refit_installations i ON i.id = t.installation_id
  WHERE i.status = 'active' AND i.allowed`;

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
  exposures: DeadlineExposure[];
  ignores: Inventory['ignores'];
  integrations: Inventory['integrations'];
  alerts: DeadlineAlert[];
}

// Opens the monitoring tables. The hosted and inventory stores must be opened first.
export async function openMonitoringStore(pool: Pool) {
  await transaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK]);
    await client.query(SCHEMA);
  });

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
             WHEN v.registry IS NOT NULL AND v.registry <> $2 THEN 'registry'
             ELSE 'age' END AS reason
         FROM refit_monitoring t
         JOIN refit_inventories v
           ON v.installation_id = t.installation_id AND v.repository = t.repository
         ${ALLOWED} AND v.state = 'idle'
           AND t.rescanned_at <= $1::timestamptz - make_interval(mins => $3)
           AND (t.pushed OR (v.registry IS NOT NULL AND v.registry <> $2)
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

  // Every complete inventory of an allowed, active installation with the alerts sent for it.
  const repositories = async (): Promise<MonitoredRepository[]> => {
    const [inventories, alerts] = await Promise.all([
      pool.query<{
        installation_id: string;
        owner: string;
        repository: string;
        revision: string | null;
        exposures: DeadlineExposure[];
        ignores: Inventory['ignores'];
        integrations: Inventory['integrations'];
      }>(
        `SELECT t.installation_id, i.owner, t.repository, t.revision,
           t.inventory -> 'deadlines' -> 'exposures' AS exposures,
           t.inventory -> 'ignores' AS ignores, t.inventory -> 'integrations' AS integrations
         FROM refit_inventories t ${ALLOWED} AND t.status = 'complete'
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

  return { pushed, due, rescanned, repositories, claim, record };
}
