import type { Pool, PoolClient } from 'pg';
import type { AiLedger } from './ai-budget.ts';
import type { GitHubWebhook } from './github-webhooks.ts';
import { WebhookInputError } from './github-webhooks.ts';
import { transaction } from './hosted-database.ts';
import {
  confirmRepositoryIdentity,
  followLifecycle,
  type LifecyclePlan,
} from './hosted-lifecycle.ts';
import { migrateHostedSchema } from './hosted-migrations.ts';
import { recordApprovalCommand } from './hosted-approval-store.ts';
import {
  DEFAULT_TENANCY_LIMITS,
  installationRefusals,
  reserveUsage,
  TENANCY_REFUSALS,
  USAGE_DAY,
  type HostedTenancy,
  type TenancyRefusal,
} from './hosted-tenancy.ts';
import type { RepositoryApproval } from './repository-enrollment.ts';
import { digest } from './specifications.ts';
import { readState } from './state-files.ts';
import { PipelineInputError } from './types.ts';

// A crashed worker's lease is reclaimed this many times before the job is marked failed.
const MAX_LEASE_ATTEMPTS = 3;
const TARGET_HASH_LENGTH = 16;
// Serializes claims so two workers never start jobs for one installation at once.
const CLAIM_LOCK = 4_206_100_002;

export interface HostedTarget {
  id: string;
  repository: string;
  base: string;
  integration: string | null;
  installationId: number;
  approval: RepositoryApproval;
}

export interface HostedReceipt {
  status: string;
  output: string | null;
  message: string | null;
  revision?: string | null;
  readiness?: string | null;
}

export function hostedTargetId(repository: string, base: string, integration?: string | null) {
  const hash = digest(`${repository.toLowerCase()}#${base}`).slice(0, TARGET_HASH_LENGTH);
  return integration ? `${hash}.${integration}` : hash;
}

// Creates or refreshes targets for installed repositories that have a stored approval, and queues
// one job for each. Installed repositories without an approval are recorded but never run.
async function enroll(client: PoolClient, installationId: number, repositories: string[]) {
  const { rows } = await client.query<{ approval: RepositoryApproval }>(
    'SELECT approval FROM refit_approvals WHERE repository = ANY($1::text[])',
    [repositories],
  );
  const enrolled: string[] = [];
  for (const { approval } of rows)
    for (const integration of approval.integrations ?? [null]) {
      const id = hostedTargetId(approval.repository, approval.base, integration);
      await client.query(
        `INSERT INTO refit_targets (id, repository, base, integration, installation_id, fingerprint, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'enrolled')
         ON CONFLICT (id) DO UPDATE SET installation_id = $5, fingerprint = $6,
           status = 'enrolled', message = NULL, updated_at = now()`,
        [id, approval.repository, approval.base, integration, installationId, approval.fingerprint],
      );
      await client.query(
        `INSERT INTO refit_jobs (target_id, status) VALUES ($1, 'queued') ON CONFLICT DO NOTHING`,
        [id],
      );
      enrolled.push(id);
    }
  return enrolled;
}

async function installedRepositories(client: PoolClient, installationId: number) {
  const { rows } = await client.query<{ repository: string }>(
    'SELECT repository FROM refit_installation_repositories WHERE installation_id = $1',
    [installationId],
  );
  return rows.map((row) => row.repository);
}

// Cancels targets and their open jobs. Running jobs are returned so this process can abort them;
// workers in other processes stop when their next lease renewal fails.
async function cancel(client: PoolClient, where: string, values: unknown[], message: string) {
  const { rows: targets } = await client.query<{ id: string }>(
    `UPDATE refit_targets SET status = 'cancelled', message = $${values.length + 1}, updated_at = now()
     WHERE status = 'enrolled' AND ${where} RETURNING id`,
    [...values, message],
  );
  const { rows: jobs } = await client.query<{ id: string; previous: string }>(
    `UPDATE refit_jobs j SET status = 'cancelled', finished_at = now()
     FROM refit_jobs previous
     WHERE previous.id = j.id AND j.target_id = ANY($1::text[]) AND j.status IN ('queued', 'running')
     RETURNING j.id, previous.status AS previous`,
    [targets.map((target) => target.id)],
  );
  return {
    targets: targets.map((target) => target.id),
    running: jobs.filter((job) => job.previous === 'running').map((job) => Number(job.id)),
  };
}

// Applies a lifecycle plan's cancellations; running jobs are returned so this process aborts them.
async function stop(client: PoolClient, plan: LifecyclePlan) {
  const stopped = { targets: [] as string[], running: [] as number[] };
  for (const entry of plan.cancel) {
    const result = await cancel(
      client,
      'installation_id = $1 AND repository = $2',
      [entry.installationId, entry.repository],
      entry.message,
    );
    stopped.targets.push(...result.targets);
    stopped.running.push(...result.running);
  }
  return stopped;
}

// Without a tenancy, no account is allowed: only the serving worker records deliveries.
export async function openHostedStore(
  pool: Pool,
  tenancy: HostedTenancy = { accounts: [], limits: DEFAULT_TENANCY_LIMITS },
) {
  await migrateHostedSchema(pool);

  const accept = (delivery: string, event: string, body: Uint8Array, change: GitHubWebhook) =>
    transaction(pool, async (client) => {
      // claim locks jobs and then installations; taking its lock first keeps the order the same.
      await client.query('SELECT pg_advisory_xact_lock($1)', [CLAIM_LOCK]);
      const hash = digest(body);
      const inserted = await client.query(
        'INSERT INTO refit_deliveries (id, hash, event) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [delivery, hash, event],
      );
      const none = { enrolled: [] as string[], cancelled: [] as string[], running: [] as number[] };
      if (!inserted.rowCount) {
        const { rows } = await client.query<{ hash: string; event: string }>(
          'SELECT hash, event FROM refit_deliveries WHERE id = $1',
          [delivery],
        );
        if (rows[0].hash !== hash || rows[0].event !== event)
          throw new WebhookInputError(
            409,
            'This delivery GUID already belongs to another payload.',
          );
        return { status: 'duplicate' as const, ...none };
      }
      // Approval commands answer a replayed comment as a duplicate by its comment ID.
      if (change.kind === 'issue_comment')
        return { status: await recordApprovalCommand(client, change), ...none };
      // The signature covers the body but not the delivery GUID, and GitHub redelivers under the
      // original GUID, so a known body under a new GUID is a replay.
      const { rowCount: replayed } = await client.query(
        'SELECT 1 FROM refit_deliveries WHERE hash = $1 AND id <> $2 LIMIT 1',
        [hash, delivery],
      );
      if (replayed)
        throw new WebhookInputError(
          409,
          'This payload was already accepted under another delivery GUID; refusing a replay.',
        );
      if (change.kind === 'repository' || change.kind === 'account') {
        const allowed = tenancy.accounts.includes(change.owner);
        const plan = await followLifecycle(client, change, allowed);
        const stopped = await stop(client, plan);
        return {
          status: allowed ? ('accepted' as const) : ('not-allowed' as const),
          enrolled: await enroll(client, change.installationId, plan.enroll),
          cancelled: stopped.targets,
          running: stopped.running,
        };
      }
      if (change.kind !== 'installation' && change.kind !== 'repositories')
        // Hosted mode acts on no pull request; the local service suggests agents from them. A push
        // is accepted so monitoring can re-scan the repository.
        return {
          status:
            change.kind === 'ping' || change.kind === 'push' ? ('accepted' as const) : 'ignored',
          ...none,
        };
      const { rows: prior } = await client.query<{
        owner: string;
        status: string;
        changed_at: Date | null;
      }>('SELECT owner, status, changed_at FROM refit_installations WHERE id = $1 FOR UPDATE', [
        change.installationId,
      ]);
      if (prior[0] && prior[0].owner !== change.owner)
        throw new WebhookInputError(409, 'Installation owner changed unexpectedly.');
      const changedAt =
        change.kind === 'installation' && change.updatedAt ? change.updatedAt : null;
      // GitHub never reuses an installation ID, so no later delivery revives a deleted one.
      if (
        prior[0]?.status === 'deleted' ||
        (changedAt && prior[0]?.changed_at && changedAt < prior[0].changed_at.getTime())
      )
        return { status: 'stale' as const, ...none };
      // Repository changes and accepted permissions leave a suspension in place.
      const status =
        change.kind === 'repositories' || change.action === 'new_permissions_accepted'
          ? (prior[0]?.status ?? 'active')
          : change.action === 'deleted'
            ? 'deleted'
            : change.action === 'suspend'
              ? 'suspended'
              : 'active';
      // Other accounts' installations are recorded, so allowing the account later backfills them.
      const allowed = tenancy.accounts.includes(change.owner);
      await client.query(
        `INSERT INTO refit_installations (id, owner, status, allowed, changed_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET status = $3, allowed = $4, updated_at = now(),
           changed_at = GREATEST(refit_installations.changed_at, $5)`,
        [change.installationId, change.owner, status, allowed, changedAt && new Date(changedAt)],
      );
      for (const repository of change.added)
        await client.query(
          `INSERT INTO refit_installation_repositories (installation_id, repository, github_id)
           VALUES ($1, $2, $3) ON CONFLICT (installation_id, repository) DO UPDATE SET github_id = $3`,
          [change.installationId, repository.name, repository.id],
        );
      const removed = change.removed.map((repository) => repository.name);
      if (removed.length)
        await client.query(
          'DELETE FROM refit_installation_repositories WHERE installation_id = $1 AND repository = ANY($2::text[])',
          [change.installationId, removed],
        );
      if (status !== 'active') {
        // Repository rows stay for the uninstall grace period; their inventories go now.
        if (status === 'deleted')
          await client.query('DELETE FROM refit_inventories WHERE installation_id = $1', [
            change.installationId,
          ]);
        const cancelled = await cancel(
          client,
          'installation_id = $1',
          [change.installationId],
          `Installation ${change.action}.`,
        );
        return {
          status: allowed ? ('accepted' as const) : ('not-allowed' as const),
          enrolled: [],
          cancelled: cancelled.targets,
          running: cancelled.running,
        };
      }
      const cancelled = removed.length
        ? await cancel(
            client,
            'installation_id = $1 AND repository = ANY($2::text[])',
            [change.installationId, removed],
            'Repository removed from the installation.',
          )
        : { targets: [], running: [] };
      if (!allowed)
        return {
          status: 'not-allowed' as const,
          enrolled: [],
          cancelled: cancelled.targets,
          running: cancelled.running,
        };
      // An unsuspended installation resumes every installed repository; otherwise only new ones.
      const candidates =
        change.action === 'unsuspend'
          ? await installedRepositories(client, change.installationId)
          : change.added.map((repository) => repository.name);
      return {
        status: 'accepted' as const,
        enrolled: await enroll(client, change.installationId, candidates),
        cancelled: cancelled.targets,
        running: cancelled.running,
      };
    });

  // Records a reviewed approval. A repository already installed is enrolled immediately.
  const approve = (approval: RepositoryApproval, approvedBy: string) =>
    transaction(pool, async (client) => {
      await client.query(
        `INSERT INTO refit_approvals (repository, base, fingerprint, approval, approved_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (repository, base) DO UPDATE SET fingerprint = $3, approval = $4,
           approved_by = $5, approved_at = now()`,
        [approval.repository, approval.base, approval.fingerprint, approval, approvedBy],
      );
      const { rows } = await client.query<{ installation_id: string }>(
        `SELECT r.installation_id FROM refit_installation_repositories r
         JOIN refit_installations i ON i.id = r.installation_id
         WHERE r.repository = $1 AND i.status = 'active' AND i.allowed`,
        [approval.repository],
      );
      return rows[0] ? enroll(client, Number(rows[0].installation_id), [approval.repository]) : [];
    });

  // Stops a target whose repository GitHub no longer serves, or whose name changed hands.
  const retire = (targetId: string, githubId: number | null) =>
    transaction(
      pool,
      async (client) =>
        (await stop(client, await confirmRepositoryIdentity(client, targetId, githubId))).targets
          .length > 0,
    );

  // Removes a repository's approval and cancels its targets; running jobs are returned to abort.
  const revoke = (repository: string, revokedBy: string) =>
    transaction(pool, async (client) => {
      const { rowCount } = await client.query('DELETE FROM refit_approvals WHERE repository = $1', [
        repository,
      ]);
      const cancelled = await cancel(
        client,
        'repository = $1',
        [repository],
        `Approval revoked by ${revokedBy}.`,
      );
      return {
        revoked: Boolean(rowCount),
        cancelled: cancelled.targets,
        running: cancelled.running,
      };
    });

  const enqueueDue = async (intervalSeconds: number) =>
    (
      await pool.query(
        `INSERT INTO refit_jobs (target_id, status)
         SELECT t.id, 'queued' FROM refit_targets t
         WHERE t.status = 'enrolled' AND NOT EXISTS (
           SELECT 1 FROM refit_jobs j WHERE j.target_id = t.id
             AND (j.status IN ('queued', 'running') OR j.created_at > now() - make_interval(secs => $1)))
         ON CONFLICT DO NOTHING`,
        [intervalSeconds],
      )
    ).rowCount ?? 0;

  // Takes the next job from the installation that waited longest, skipping installations with a
  // live running job or at today's job cap. Reclaiming an expired lease does not count again.
  const claim = (worker: string, leaseSeconds: number) =>
    transaction(
      pool,
      async (client): Promise<{ job: number; retry: boolean; target: HostedTarget } | null> => {
        await client.query('SELECT pg_advisory_xact_lock($1)', [CLAIM_LOCK]);
        await client.query(
          `UPDATE refit_jobs SET status = 'failed', finished_at = now(), lease_owner = NULL,
           receipt = jsonb_build_object('status', 'error', 'output', NULL,
             'message', 'Worker lease expired repeatedly; the job needs an explicit retry.')
         WHERE status = 'running' AND lease_expires_at < now() AND attempts >= $1`,
          [MAX_LEASE_ATTEMPTS],
        );
        const { rows } = await client.query<{
          id: string;
          target_id: string;
          retry: boolean;
          attempts: number;
        }>(
          `UPDATE refit_jobs SET status = 'running', lease_owner = $1, attempts = attempts + 1,
           lease_expires_at = now() + make_interval(secs => $2)
         WHERE id = (
           SELECT j.id FROM refit_jobs j JOIN refit_targets t ON t.id = j.target_id
           JOIN refit_approvals a
             ON a.repository = t.repository AND a.base = t.base AND a.fingerprint = t.fingerprint
           JOIN refit_installations i ON i.id = t.installation_id
           LEFT JOIN refit_installation_usage u
             ON u.installation_id = i.id AND u.day = ${USAGE_DAY}
           WHERE t.status = 'enrolled' AND i.allowed AND i.status = 'active'
             AND (j.status = 'queued' OR (j.status = 'running' AND j.lease_expires_at < now()))
             AND (j.attempts > 0 OR coalesce(u.jobs, 0) < $3)
             AND NOT EXISTS (
               SELECT 1 FROM refit_jobs r JOIN refit_targets rt ON rt.id = r.target_id
               WHERE rt.installation_id = t.installation_id AND r.id <> j.id
                 AND r.status = 'running' AND r.lease_expires_at >= now())
           ORDER BY i.last_claimed_at NULLS FIRST, j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED)
         RETURNING id, target_id, retry, attempts`,
          [worker, leaseSeconds, tenancy.limits.dailyJobs],
        );
        if (!rows[0]) return null;
        const { rows: targets } = await client.query<{
          id: string;
          repository: string;
          base: string;
          integration: string | null;
          installation_id: string;
          approval: RepositoryApproval;
        }>(
          `SELECT t.id, t.repository, t.base, t.integration, t.installation_id, a.approval
         FROM refit_targets t JOIN refit_approvals a
           ON a.repository = t.repository AND a.base = t.base AND a.fingerprint = t.fingerprint
         WHERE t.id = $1`,
          [rows[0].target_id],
        );
        const target = targets[0];
        const installationId = Number(target.installation_id);
        await client.query('UPDATE refit_installations SET last_claimed_at = now() WHERE id = $1', [
          installationId,
        ]);
        if (
          rows[0].attempts === 1 &&
          !(await reserveUsage(client, installationId, 'jobs', tenancy.limits.dailyJobs))
        )
          throw new PipelineInputError(`Installation ${installationId} reached its daily job cap.`);
        return {
          job: Number(rows[0].id),
          retry: rows[0].retry,
          target: {
            id: target.id,
            repository: target.repository,
            base: target.base,
            integration: target.integration,
            installationId,
            approval: target.approval,
          },
        };
      },
    );

  // Queues one retry for an enrolled target, or marks its already-queued job as a retry.
  const retry = (targetId: string) =>
    transaction(pool, async (client) => {
      const { rows: targets } = await client.query<{ status: string }>(
        'SELECT status FROM refit_targets WHERE id = $1 FOR UPDATE',
        [targetId],
      );
      if (targets[0]?.status !== 'enrolled')
        throw new PipelineInputError(`No enrolled hosted target ${targetId}.`);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO refit_jobs (target_id, status, retry) VALUES ($1, 'queued', true)
         ON CONFLICT DO NOTHING RETURNING id`,
        [targetId],
      );
      const queued = rows[0]
        ? rows
        : (
            await client.query<{ id: string }>(
              `UPDATE refit_jobs SET retry = true WHERE target_id = $1 AND status = 'queued'
               RETURNING id`,
              [targetId],
            )
          ).rows;
      if (!queued[0])
        throw new PipelineInputError(
          `Hosted target ${targetId} has a running job; retry after it finishes.`,
        );
      return Number(queued[0].id);
    });

  const renew = async (job: number, worker: string, leaseSeconds: number) =>
    Boolean(
      (
        await pool.query(
          `UPDATE refit_jobs SET lease_expires_at = now() + make_interval(secs => $3)
           WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
          [job, worker, leaseSeconds],
        )
      ).rowCount,
    );

  // A cancelled job keeps its cancelled status but still retains the evidence it produced.
  const finish = async (
    job: number,
    worker: string,
    status: 'finished' | 'failed',
    receipt: HostedReceipt,
  ) =>
    Boolean(
      (
        await pool.query(
          `UPDATE refit_jobs SET receipt = $4, finished_at = now(), lease_owner = NULL,
             lease_expires_at = NULL,
             status = CASE WHEN status = 'cancelled' THEN 'cancelled' ELSE $3 END
           WHERE id = $1 AND lease_owner = $2 AND status IN ('running', 'cancelled')`,
          [job, worker, status, receipt],
        )
      ).rowCount,
    );

  // Applies the configured accounts. Newly allowed active installations enroll every approved
  // installed repository; newly disallowed ones are cancelled as if uninstalled.
  const allow = () =>
    transaction(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [CLAIM_LOCK]);
      const { rows } = await client.query<{ id: string; allowed: boolean; status: string }>(
        `UPDATE refit_installations SET allowed = owner = ANY($1::text[]), updated_at = now()
         WHERE allowed <> (owner = ANY($1::text[])) RETURNING id, allowed, status`,
        [tenancy.accounts],
      );
      const result = {
        enrolled: [] as string[],
        cancelled: [] as string[],
        running: [] as number[],
      };
      for (const row of rows) {
        const id = Number(row.id);
        if (!row.allowed) {
          const cancelled = await cancel(
            client,
            'installation_id = $1',
            [id],
            'Account is no longer allowed.',
          );
          result.cancelled.push(...cancelled.targets);
          result.running.push(...cancelled.running);
        } else if (row.status === 'active')
          result.enrolled.push(
            ...(await enroll(client, id, await installedRepositories(client, id))),
          );
      }
      return result;
    });

  // Counts one inventory against the installation's daily cap; a refusal means it must not run.
  const reserveInventory = (installationId: number) =>
    transaction(pool, async (client): Promise<TenancyRefusal | null> => {
      const { rows } = await client.query<{ allowed: boolean; status: string }>(
        'SELECT allowed, status FROM refit_installations WHERE id = $1',
        [installationId],
      );
      if (!rows[0]?.allowed || rows[0].status !== 'active') return TENANCY_REFUSALS.notAllowed;
      return (await reserveUsage(
        client,
        installationId,
        'inventories',
        tenancy.limits.dailyInventories,
      ))
        ? null
        : TENANCY_REFUSALS.dailyInventories;
    });

  // One AI ledger per installation. A legacy budget.json is imported on first use, so moving the
  // ledger into PostgreSQL does not forget recorded spend.
  const aiLedger = (installationId: number, legacyFile?: string): AiLedger => ({
    update: (change) =>
      transaction(pool, async (client) => {
        await client.query(
          'INSERT INTO refit_ai_ledgers (installation_id) VALUES ($1) ON CONFLICT DO NOTHING',
          [installationId],
        );
        const { rows } = await client.query<{ state: Record<string, unknown> | null }>(
          'SELECT state FROM refit_ai_ledgers WHERE installation_id = $1 FOR UPDATE',
          [installationId],
        );
        const stored = rows[0].state ?? (legacyFile ? await readState(legacyFile) : undefined);
        await client.query(
          'UPDATE refit_ai_ledgers SET state = $2, updated_at = now() WHERE installation_id = $1',
          [installationId, change(stored)],
        );
      }),
  });

  // The ledger every installation's AI requests also reserve against.
  const aiTotalLedger = (): AiLedger => ({
    update: (change) =>
      transaction(pool, async (client) => {
        await client.query(
          'INSERT INTO refit_ai_total_ledger DEFAULT VALUES ON CONFLICT DO NOTHING',
        );
        const { rows } = await client.query<{ state: Record<string, unknown> | null }>(
          'SELECT state FROM refit_ai_total_ledger FOR UPDATE',
        );
        await client.query('UPDATE refit_ai_total_ledger SET state = $1, updated_at = now()', [
          change(rows[0].state ?? undefined),
        ]);
      }),
  });

  // Running jobs whose lease is still live, with the worker holding each.
  const leases = async () =>
    new Map(
      (
        await pool.query<{ id: string; lease_owner: string }>(
          `SELECT id, lease_owner FROM refit_jobs WHERE status = 'running' AND lease_expires_at > now()`,
        )
      ).rows.map((row) => [Number(row.id), row.lease_owner]),
    );

  const read = async () => {
    const [installations, targets, jobs] = await Promise.all([
      pool.query<{
        id: string;
        owner: string;
        status: string;
        allowed: boolean;
        repositories: string[];
        jobsToday: number;
        inventoriesToday: number;
      }>(
        `SELECT i.id::text, i.owner, i.status, i.allowed,
           coalesce(array_agg(r.repository ORDER BY r.repository) FILTER (WHERE r.repository IS NOT NULL), '{}') AS repositories,
           coalesce(u.jobs, 0) AS "jobsToday", coalesce(u.inventories, 0) AS "inventoriesToday"
         FROM refit_installations i LEFT JOIN refit_installation_repositories r ON r.installation_id = i.id
         LEFT JOIN refit_installation_usage u ON u.installation_id = i.id AND u.day = ${USAGE_DAY}
         GROUP BY i.id, u.jobs, u.inventories ORDER BY i.id`,
      ),
      pool.query(
        `SELECT id, repository, base, integration, installation_id::text AS "installationId",
           fingerprint, status, message FROM refit_targets ORDER BY id`,
      ),
      pool.query(
        `SELECT j.id::text, j.target_id AS "targetId", j.status, j.attempts, j.retry, j.receipt,
           j.created_at AS "createdAt", j.finished_at AS "finishedAt",
           t.installation_id::text AS "installationId",
           (j.status = 'running' AND j.lease_expires_at >= now()) AS live
         FROM refit_jobs j JOIN refit_targets t ON t.id = j.target_id ORDER BY j.id`,
      ),
    ]);
    const running = new Set(jobs.rows.filter((job) => job.live).map((job) => job.installationId));
    const listed = installations.rows.map((installation) => ({
      ...installation,
      refusals: installationRefusals(
        { ...installation, running: running.has(installation.id) },
        tenancy.limits,
      ),
    }));
    const refusals = new Map(
      listed.map((installation) => [installation.id, installation.refusals]),
    );
    return {
      installations: listed,
      targets: targets.rows,
      jobs: jobs.rows.map(({ live: _live, installationId, ...job }) => ({
        ...job,
        // Why a queued job has not started; the inventory cap never holds jobs back.
        waiting:
          job.status === 'queued'
            ? (refusals
                .get(installationId)
                ?.find((refusal) => refusal !== TENANCY_REFUSALS.dailyInventories) ?? null)
            : null,
      })),
    };
  };

  return {
    accept,
    approve,
    retire,
    revoke,
    enqueueDue,
    claim,
    retry,
    renew,
    finish,
    read,
    allow,
    reserveInventory,
    aiLedger,
    aiTotalLedger,
    leases,
  };
}
