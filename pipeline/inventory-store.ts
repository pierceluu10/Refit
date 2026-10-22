import type { Pool } from 'pg';
import { transaction } from './hosted-database.ts';
import {
  DEFAULT_TENANCY_LIMITS,
  reserveUsage,
  USAGE_DAY,
  type TenancyLimits,
} from './hosted-tenancy.ts';
import type { InventoryResult } from './inventory.ts';
import { PipelineInputError } from './types.ts';

// A crashed worker's inventory lease is reclaimed this many times before the request is dropped.
const MAX_INVENTORY_ATTEMPTS = 3;

export interface InventoryClaim {
  installationId: number;
  repository: string;
  previous: { revision: string | null; registry: string | null };
}

// Reads and writes the inventory table, which hosted migration 5 creates when the hosted store
// opens. Only allowed, active installations are inventoried, each at most
// `limits.dailyInventories` times per UTC day.
export function openInventoryStore(pool: Pool, limits: TenancyLimits = DEFAULT_TENANCY_LIMITS) {
  // Queues an inventory for repositories installed by an allowed, active installation. A running
  // one is queued again when it ends, so a push during a scan is not lost.
  const request = async (installationId: number, repositories: string[]) =>
    (
      await pool.query(
        `INSERT INTO refit_inventories (installation_id, repository, state)
         SELECT r.installation_id, r.repository, 'queued'
         FROM refit_installation_repositories r JOIN refit_installations i ON i.id = r.installation_id
         WHERE i.status = 'active' AND i.allowed AND r.installation_id = $1 AND r.repository = ANY($2::text[])
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

  // Queues one repository wherever an allowed, active installation has it, for the operator command.
  const requestRepository = async (repository: string) => {
    const { rows } = await pool.query<{ installation_id: string }>(
      `SELECT r.installation_id FROM refit_installation_repositories r
       JOIN refit_installations i ON i.id = r.installation_id
       WHERE i.status = 'active' AND i.allowed AND r.repository = $1`,
      [repository.toLowerCase()],
    );
    if (!rows[0])
      throw new PipelineInputError(
        `${repository} is not installed in an allowed, active installation.`,
      );
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
         WHERE i.status = 'active' AND i.allowed
         ON CONFLICT DO NOTHING`,
      )
    ).rowCount ?? 0;

  // Takes the oldest request of an installation under today's inventory cap. The first attempt
  // counts against the cap; reclaiming a crashed worker's lease does not count again.
  const claim = (worker: string, leaseSeconds: number) =>
    transaction(pool, async (client): Promise<InventoryClaim | null> => {
      await client.query(
        `UPDATE refit_inventories SET state = 'idle', lease_owner = NULL, lease_expires_at = NULL,
           checked_at = now(), error = 'Worker lease expired repeatedly; request the inventory again.'
         WHERE state = 'running' AND lease_expires_at < now() AND attempts >= $1`,
        [MAX_INVENTORY_ATTEMPTS],
      );
      const { rows } = await client.query<{
        installation_id: string;
        repository: string;
        attempts: number;
        revision: string | null;
        registry: string | null;
      }>(
        `SELECT v.installation_id, v.repository, v.attempts, v.revision, v.registry
         FROM refit_inventories v JOIN refit_installations i ON i.id = v.installation_id
         LEFT JOIN refit_installation_usage u
           ON u.installation_id = i.id AND u.day = ${USAGE_DAY}
         WHERE i.status = 'active' AND i.allowed
           AND (v.state = 'queued' OR (v.state = 'running' AND v.lease_expires_at < now()))
           AND (v.attempts > 0 OR coalesce(u.inventories, 0) < $1)
         ORDER BY v.requested_at, v.repository LIMIT 1 FOR UPDATE OF v SKIP LOCKED`,
        [limits.dailyInventories],
      );
      const candidate = rows[0];
      if (!candidate) return null;
      const installationId = Number(candidate.installation_id);
      // Another worker can reach the cap between the check above and this reservation.
      if (
        candidate.attempts === 0 &&
        !(await reserveUsage(client, installationId, 'inventories', limits.dailyInventories))
      )
        return null;
      await client.query(
        `UPDATE refit_inventories SET state = 'running', lease_owner = $3, attempts = attempts + 1,
           lease_expires_at = now() + make_interval(secs => $4)
         WHERE installation_id = $1 AND repository = $2`,
        [installationId, candidate.repository, worker, leaseSeconds],
      );
      return {
        installationId,
        repository: candidate.repository,
        previous: { revision: candidate.revision, registry: candidate.registry },
      };
    });

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
