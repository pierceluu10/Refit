import type { Pool, PoolClient } from 'pg';
import type { GitHubWebhook } from './github-webhooks.ts';
import { WebhookInputError } from './github-webhooks.ts';
import {
  confirmRepositoryIdentity,
  followLifecycle,
  type LifecyclePlan,
} from './hosted-lifecycle.ts';
import type { RepositoryApproval } from './repository-enrollment.ts';
import { digest } from './specifications.ts';
import { PipelineInputError } from './types.ts';

// A crashed worker's lease is reclaimed this many times before the job is marked failed.
const MAX_LEASE_ATTEMPTS = 3;
const TARGET_HASH_LENGTH = 16;
const SCHEMA_LOCK = 4_206_100_001;
// GitHub redelivers only deliveries from the past 3 days, so an older GUID can never recur.
const DELIVERY_RETENTION_DAYS = 30;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS refit_installations (
  id bigint PRIMARY KEY,
  owner text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'suspended', 'deleted')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS refit_installation_repositories (
  installation_id bigint NOT NULL REFERENCES refit_installations (id),
  repository text NOT NULL,
  github_id bigint NOT NULL,
  PRIMARY KEY (installation_id, repository)
);
CREATE TABLE IF NOT EXISTS refit_deliveries (
  id text PRIMARY KEY,
  hash text NOT NULL,
  event text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS refit_approvals (
  repository text NOT NULL,
  base text NOT NULL,
  fingerprint text NOT NULL,
  approval jsonb NOT NULL,
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repository, base)
);
CREATE TABLE IF NOT EXISTS refit_targets (
  id text PRIMARY KEY,
  repository text NOT NULL,
  base text NOT NULL,
  integration text,
  installation_id bigint NOT NULL REFERENCES refit_installations (id),
  fingerprint text NOT NULL,
  status text NOT NULL CHECK (status IN ('enrolled', 'cancelled')),
  message text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS refit_jobs (
  id bigserial PRIMARY KEY,
  target_id text NOT NULL REFERENCES refit_targets (id),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'finished', 'failed', 'cancelled')),
  lease_owner text,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  receipt jsonb
);
-- An operator retry permits one fresh attempt of a cached failure; successful results stay cached.
ALTER TABLE refit_jobs ADD COLUMN IF NOT EXISTS retry boolean NOT NULL DEFAULT false;
-- installation.updated_at of the newest installation event applied; older redeliveries are stale.
ALTER TABLE refit_installations ADD COLUMN IF NOT EXISTS changed_at timestamptz;
CREATE INDEX IF NOT EXISTS refit_deliveries_received ON refit_deliveries (received_at);
CREATE UNIQUE INDEX IF NOT EXISTS refit_jobs_open ON refit_jobs (target_id)
  WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS refit_targets_installation ON refit_targets (installation_id);
-- No policies: data APIs such as Supabase's see nothing; the owning worker role bypasses RLS.
ALTER TABLE refit_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE refit_installation_repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE refit_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE refit_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE refit_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE refit_jobs ENABLE ROW LEVEL SECURITY;
`;

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

async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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

export async function openHostedStore(pool: Pool) {
  await transaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK]);
    await client.query(SCHEMA);
  });

  const accept = (delivery: string, event: string, body: Uint8Array, change: GitHubWebhook) =>
    transaction(pool, async (client) => {
      await client.query(
        'DELETE FROM refit_deliveries WHERE received_at < now() - make_interval(days => $1)',
        [DELIVERY_RETENTION_DAYS],
      );
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
      if (change.kind === 'repository' || change.kind === 'account') {
        const plan = await followLifecycle(client, change);
        const stopped = await stop(client, plan);
        return {
          status: 'accepted' as const,
          enrolled: await enroll(client, change.installationId, plan.enroll),
          cancelled: stopped.targets,
          running: stopped.running,
        };
      }
      if (change.kind !== 'installation' && change.kind !== 'repositories')
        // Hosted mode acts on no pull request; the local service suggests agents from them.
        return { status: change.kind === 'ping' ? ('accepted' as const) : 'ignored', ...none };
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
      await client.query(
        `INSERT INTO refit_installations (id, owner, status, changed_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET status = $3, updated_at = now(),
           changed_at = GREATEST(refit_installations.changed_at, $4)`,
        [change.installationId, change.owner, status, changedAt && new Date(changedAt)],
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
        const cancelled = await cancel(
          client,
          'installation_id = $1',
          [change.installationId],
          `Installation ${change.action}.`,
        );
        return {
          status: 'accepted' as const,
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
      // An unsuspended installation resumes every installed repository; otherwise only new ones.
      const candidates =
        change.action === 'unsuspend'
          ? (
              await client.query<{ repository: string }>(
                'SELECT repository FROM refit_installation_repositories WHERE installation_id = $1',
                [change.installationId],
              )
            ).rows.map((row) => row.repository)
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
         WHERE r.repository = $1 AND i.status = 'active'`,
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

  const claim = (worker: string, leaseSeconds: number) =>
    transaction(
      pool,
      async (client): Promise<{ job: number; retry: boolean; target: HostedTarget } | null> => {
        await client.query(
          `UPDATE refit_jobs SET status = 'failed', finished_at = now(), lease_owner = NULL,
           receipt = jsonb_build_object('status', 'error', 'output', NULL,
             'message', 'Worker lease expired repeatedly; the job needs an explicit retry.')
         WHERE status = 'running' AND lease_expires_at < now() AND attempts >= $1`,
          [MAX_LEASE_ATTEMPTS],
        );
        const { rows } = await client.query<{ id: string; target_id: string; retry: boolean }>(
          `UPDATE refit_jobs SET status = 'running', lease_owner = $1, attempts = attempts + 1,
           lease_expires_at = now() + make_interval(secs => $2)
         WHERE id = (
           SELECT j.id FROM refit_jobs j JOIN refit_targets t ON t.id = j.target_id
           JOIN refit_approvals a
             ON a.repository = t.repository AND a.base = t.base AND a.fingerprint = t.fingerprint
           WHERE t.status = 'enrolled'
             AND (j.status = 'queued' OR (j.status = 'running' AND j.lease_expires_at < now()))
           ORDER BY j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED)
         RETURNING id, target_id, retry`,
          [worker, leaseSeconds],
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
        return {
          job: Number(rows[0].id),
          retry: rows[0].retry,
          target: {
            id: target.id,
            repository: target.repository,
            base: target.base,
            integration: target.integration,
            installationId: Number(target.installation_id),
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

  const read = async () => {
    const [installations, targets, jobs] = await Promise.all([
      pool.query(
        `SELECT i.id::text, i.owner, i.status,
           coalesce(array_agg(r.repository ORDER BY r.repository) FILTER (WHERE r.repository IS NOT NULL), '{}') AS repositories
         FROM refit_installations i LEFT JOIN refit_installation_repositories r ON r.installation_id = i.id
         GROUP BY i.id ORDER BY i.id`,
      ),
      pool.query(
        `SELECT id, repository, base, integration, installation_id::text AS "installationId",
           fingerprint, status, message FROM refit_targets ORDER BY id`,
      ),
      pool.query(
        `SELECT id::text, target_id AS "targetId", status, attempts, retry, receipt,
           created_at AS "createdAt", finished_at AS "finishedAt"
         FROM refit_jobs ORDER BY id`,
      ),
    ]);
    return { installations: installations.rows, targets: targets.rows, jobs: jobs.rows };
  };

  return { accept, approve, retire, enqueueDue, claim, retry, renew, finish, read };
}
