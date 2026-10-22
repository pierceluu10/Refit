import type { Pool } from 'pg';
import type { InventoryResult } from './inventory.ts';
import { PipelineInputError } from './types.ts';

// A crashed worker's inventory lease is reclaimed this many times before the request is dropped.
const MAX_INVENTORY_ATTEMPTS = 3;
const SCHEMA_LOCK = 4_206_100_002;

// One row per installed repository: its request state, and the last inventory with the revision
// and registry it was taken at. Rows go with the installed repository (removal or uninstall).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS refit_inventories (
  installation_id bigint NOT NULL,
  repository text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'running', 'idle')),
  requeue boolean NOT NULL DEFAULT false,
  requested_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  checked_at timestamptz,
  error text,
  base text,
  revision text,
  registry text,
  status text CHECK (status IN ('complete', 'stopped')),
  stop text,
  message text,
  scanned_at timestamptz,
  duration_ms integer,
  inventory jsonb,
  PRIMARY KEY (installation_id, repository),
  FOREIGN KEY (installation_id, repository)
    REFERENCES refit_installation_repositories (installation_id, repository) ON DELETE CASCADE
);
ALTER TABLE refit_inventories ENABLE ROW LEVEL SECURITY;
`;

export interface InventoryClaim {
  installationId: number;
  repository: string;
  previous: { revision: string | null; registry: string | null };
}

// Opens the inventory tables. The hosted store must be opened first: inventories reference its
// installed repositories.
export async function openInventoryStore(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK]);
    await client.query(SCHEMA);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  // Queues an inventory for repositories installed by an active installation. A running one is
  // queued again when it ends, so a push during a scan is not lost.
  const request = async (installationId: number, repositories: string[]) =>
    (
      await pool.query(
        `INSERT INTO refit_inventories (installation_id, repository, state)
         SELECT r.installation_id, r.repository, 'queued'
         FROM refit_installation_repositories r JOIN refit_installations i ON i.id = r.installation_id
         WHERE i.status = 'active' AND r.installation_id = $1 AND r.repository = ANY($2::text[])
         ON CONFLICT (installation_id, repository) DO UPDATE SET
           state = CASE WHEN refit_inventories.state = 'running' THEN 'running' ELSE 'queued' END,
           requeue = refit_inventories.state = 'running',
           requested_at = CASE WHEN refit_inventories.state = 'running'
             THEN refit_inventories.requested_at ELSE now() END,
           attempts = CASE WHEN refit_inventories.state = 'running'
             THEN refit_inventories.attempts ELSE 0 END`,
        [installationId, repositories.map((repository) => repository.toLowerCase())],
      )
    ).rowCount ?? 0;

  // Queues one repository wherever an active installation has it, for the operator command.
  const requestRepository = async (repository: string) => {
    const { rows } = await pool.query<{ installation_id: string }>(
      `SELECT r.installation_id FROM refit_installation_repositories r
       JOIN refit_installations i ON i.id = r.installation_id
       WHERE i.status = 'active' AND r.repository = $1`,
      [repository.toLowerCase()],
    );
    if (!rows[0])
      throw new PipelineInputError(`${repository} is not installed in an active installation.`);
    await request(Number(rows[0].installation_id), [repository]);
    return Number(rows[0].installation_id);
  };

  // Queues every installed repository that has never been inventoried, such as one installed while
  // the worker was down or before this table existed.
  const requestMissing = async () =>
    (
      await pool.query(
        `INSERT INTO refit_inventories (installation_id, repository, state)
         SELECT r.installation_id, r.repository, 'queued'
         FROM refit_installation_repositories r JOIN refit_installations i ON i.id = r.installation_id
         WHERE i.status = 'active'
         ON CONFLICT DO NOTHING`,
      )
    ).rowCount ?? 0;

  const claim = async (worker: string, leaseSeconds: number): Promise<InventoryClaim | null> => {
    await pool.query(
      `UPDATE refit_inventories SET state = 'idle', lease_owner = NULL, lease_expires_at = NULL,
         checked_at = now(), error = 'Worker lease expired repeatedly; request the inventory again.'
       WHERE state = 'running' AND lease_expires_at < now() AND attempts >= $1`,
      [MAX_INVENTORY_ATTEMPTS],
    );
    const { rows } = await pool.query<{
      installation_id: string;
      repository: string;
      revision: string | null;
      registry: string | null;
    }>(
      `UPDATE refit_inventories SET state = 'running', lease_owner = $1, attempts = attempts + 1,
         lease_expires_at = now() + make_interval(secs => $2)
       WHERE (installation_id, repository) = (
         SELECT v.installation_id, v.repository FROM refit_inventories v
         JOIN refit_installations i ON i.id = v.installation_id
         WHERE i.status = 'active'
           AND (v.state = 'queued' OR (v.state = 'running' AND v.lease_expires_at < now()))
         ORDER BY v.requested_at, v.repository LIMIT 1 FOR UPDATE OF v SKIP LOCKED)
       RETURNING installation_id, repository, revision, registry`,
      [worker, leaseSeconds],
    );
    if (!rows[0]) return null;
    return {
      installationId: Number(rows[0].installation_id),
      repository: rows[0].repository,
      previous: { revision: rows[0].revision, registry: rows[0].registry },
    };
  };

  // Records a refresh. An unchanged revision only updates when it was checked. Returns false when
  // the lease was lost or the repository was removed meanwhile, so the result is dropped.
  const finish = async (
    claimed: InventoryClaim,
    worker: string,
    outcome: { result: InventoryResult; registry: string; durationMs: number } | { error: string },
  ) => {
    const values = [claimed.installationId, claimed.repository, worker];
    const release = `state = CASE WHEN requeue THEN 'queued' ELSE 'idle' END, requeue = false,
      lease_owner = NULL, lease_expires_at = NULL, attempts = 0, checked_at = now()`;
    const where = `WHERE installation_id = $1 AND repository = $2 AND lease_owner = $3
      AND state = 'running'`;
    if ('error' in outcome)
      return Boolean(
        (
          await pool.query(`UPDATE refit_inventories SET ${release}, error = $4 ${where}`, [
            ...values,
            outcome.error,
          ])
        ).rowCount,
      );
    const { result } = outcome;
    if (result.outcome === 'unchanged')
      return Boolean(
        (await pool.query(`UPDATE refit_inventories SET ${release}, error = NULL ${where}`, values))
          .rowCount,
      );
    return Boolean(
      (
        await pool.query(
          `UPDATE refit_inventories SET ${release}, error = NULL, base = $4, revision = $5,
             registry = $6, status = $7, stop = $8, message = $9, inventory = $10,
             scanned_at = now(), duration_ms = $11
           ${where}`,
          [
            ...values,
            result.base,
            result.revision,
            outcome.registry,
            result.outcome,
            result.outcome === 'stopped' ? result.stop : null,
            result.outcome === 'stopped' ? result.message : null,
            result.outcome === 'complete' ? result.inventory : null,
            outcome.durationMs,
          ],
        )
      ).rowCount,
    );
  };

  const read = async (repository?: string) =>
    (
      await pool.query(
        `SELECT installation_id::text AS "installationId", repository, state, base, revision,
           status, stop, message, error, requested_at AS "requestedAt", checked_at AS "checkedAt",
           scanned_at AS "scannedAt", duration_ms AS "durationMs", inventory
         FROM refit_inventories WHERE $1::text IS NULL OR repository = $1
         ORDER BY installation_id, repository`,
        [repository?.toLowerCase() ?? null],
      )
    ).rows;

  return { request, requestRepository, requestMissing, claim, finish, read };
}
