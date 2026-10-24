import type { Pool, PoolClient } from 'pg';
import { transaction } from './hosted-database.ts';
import { PipelineInputError } from './types.ts';

// The schema lock workers took before versioned migrations, so old and new workers never interleave.
const MIGRATION_LOCK = 4_206_100_001;

const HISTORY = `
CREATE TABLE IF NOT EXISTS refit_schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE refit_schema_migrations ENABLE ROW LEVEL SECURITY;
`;

// Versions 1 and 2 are the schema workers created before versioned migrations, so they stay
// idempotent: they adopt a database those workers set up, with or without the retry column.
// Later versions run exactly once and need not be.
const INITIAL = `
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

const TENANCY = `
-- Accounts are allowed only by REFIT_HOSTED_ACCOUNTS, which the service applies on start.
ALTER TABLE refit_installations ADD COLUMN IF NOT EXISTS allowed boolean NOT NULL DEFAULT false;
ALTER TABLE refit_installations ADD COLUMN IF NOT EXISTS last_claimed_at timestamptz;
CREATE TABLE IF NOT EXISTS refit_installation_usage (
  installation_id bigint NOT NULL REFERENCES refit_installations (id),
  day date NOT NULL,
  jobs integer NOT NULL DEFAULT 0,
  inventories integer NOT NULL DEFAULT 0,
  PRIMARY KEY (installation_id, day)
);
CREATE TABLE IF NOT EXISTS refit_ai_ledgers (
  installation_id bigint PRIMARY KEY REFERENCES refit_installations (id),
  state jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE refit_installation_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE refit_ai_ledgers ENABLE ROW LEVEL SECURITY;
`;

const APPROVALS = `
-- One approval issue per installed repository without a stored approval.
CREATE TABLE IF NOT EXISTS refit_approval_issues (
  repository text PRIMARY KEY,
  installation_id bigint NOT NULL REFERENCES refit_installations (id),
  base text,
  issue integer,
  state text NOT NULL CHECK (state IN ('review', 'proposal', 'invalid', 'no-providers', 'approved', 'failed')),
  fingerprint text,
  shown text[] NOT NULL DEFAULT '{}',
  refresh boolean NOT NULL DEFAULT false,
  message text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Each comment is handled once, so a replayed delivery cannot approve twice or make Refit reply.
CREATE TABLE IF NOT EXISTS refit_approval_commands (
  id bigserial PRIMARY KEY,
  comment_id bigint NOT NULL,
  edited boolean NOT NULL,
  installation_id bigint NOT NULL,
  repository text NOT NULL,
  issue integer NOT NULL,
  author text NOT NULL,
  command text NOT NULL CHECK (command IN ('approve', 'revoke')),
  argument text,
  status text NOT NULL CHECK (status IN ('pending', 'processing', 'done')),
  claimed_at timestamptz,
  outcome text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (comment_id, edited)
);
ALTER TABLE refit_approval_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE refit_approval_commands ENABLE ROW LEVEL SECURITY;
`;

// One row per installed repository: its request state, and the last inventory with the revision
// and registry it was taken at. Rows go with the installed repository (removal or uninstall).
const INVENTORIES = `
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
  -- The last complete inventory and its commit, kept when a later scan stops.
  inventory jsonb,
  inventory_revision text,
  PRIMARY KEY (installation_id, repository),
  FOREIGN KEY (installation_id, repository)
    REFERENCES refit_installation_repositories (installation_id, repository) ON DELETE CASCADE
);
ALTER TABLE refit_inventories ENABLE ROW LEVEL SECURITY;
`;

// Monitoring state for each inventoried repository, and the last alert stage sent per deadline.
// Both go with the installed repository, so removal or uninstall deletes them. Times come from the
// monitoring clock, which tests replace.
const MONITORING = `
CREATE TABLE IF NOT EXISTS refit_monitoring (
  installation_id bigint NOT NULL,
  repository text NOT NULL,
  pushed boolean NOT NULL DEFAULT false,
  rescanned_at timestamptz NOT NULL,
  digest_issue integer,
  digest_at timestamptz,
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

// The report issue Refit keeps for each inventoried repository, with the digest of what it last
// wrote. It goes with the installed repository, so removal or uninstall deletes it.
const REPORTS = `
CREATE TABLE IF NOT EXISTS refit_reports (
  installation_id bigint NOT NULL,
  repository text NOT NULL,
  issue integer,
  digest text NOT NULL,
  status text NOT NULL CHECK (status IN ('sending', 'opened', 'updated', 'failed')),
  message text,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (installation_id, repository),
  FOREIGN KEY (installation_id, repository)
    REFERENCES refit_installation_repositories (installation_id, repository) ON DELETE CASCADE
);
ALTER TABLE refit_reports ENABLE ROW LEVEL SECURITY;
`;

export interface HostedMigration {
  version: number;
  name: string;
  up: (client: PoolClient) => Promise<unknown>;
}

// Append new versions; never edit or reorder an applied one.
export const MIGRATIONS: HostedMigration[] = [
  { version: 1, name: 'Initial hosted tables', up: (client) => client.query(INITIAL) },
  {
    version: 2,
    name: 'Operator retry flag on jobs',
    // An operator retry permits one fresh attempt of a cached failure; successful results stay cached.
    up: (client) =>
      client.query(
        'ALTER TABLE refit_jobs ADD COLUMN IF NOT EXISTS retry boolean NOT NULL DEFAULT false',
      ),
  },
  {
    version: 3,
    name: 'Allowed accounts, claim fairness, daily usage and AI ledgers',
    up: (client) => client.query(TENANCY),
  },
  {
    version: 4,
    name: 'Approval issues and commands',
    up: (client) => client.query(APPROVALS),
  },
  {
    version: 5,
    name: 'Repository inventories',
    up: (client) => client.query(INVENTORIES),
  },
  {
    version: 6,
    name: 'Deadline monitoring and alerts',
    up: (client) => client.query(MONITORING),
  },
  {
    version: 7,
    name: 'Report issues',
    up: (client) => client.query(REPORTS),
  },
  {
    version: 8,
    name: 'Installation event order and rename cascades',
    // installation.updated_at of the newest installation event applied; older redeliveries are
    // stale. Inventories, monitoring state, deadline alerts and report rows follow a repository or account
    // rename. Deliveries are never pruned.
    up: (client) =>
      client.query(`
ALTER TABLE refit_installations ADD COLUMN changed_at timestamptz;
ALTER TABLE refit_inventories
  DROP CONSTRAINT refit_inventories_installation_id_repository_fkey,
  ADD FOREIGN KEY (installation_id, repository)
    REFERENCES refit_installation_repositories (installation_id, repository)
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE refit_monitoring
  DROP CONSTRAINT refit_monitoring_installation_id_repository_fkey,
  ADD FOREIGN KEY (installation_id, repository)
    REFERENCES refit_installation_repositories (installation_id, repository)
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE refit_deadline_alerts
  DROP CONSTRAINT refit_deadline_alerts_installation_id_repository_fkey,
  ADD FOREIGN KEY (installation_id, repository)
    REFERENCES refit_installation_repositories (installation_id, repository)
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE refit_reports
  DROP CONSTRAINT refit_reports_installation_id_repository_fkey,
  ADD FOREIGN KEY (installation_id, repository)
    REFERENCES refit_installation_repositories (installation_id, repository)
    ON DELETE CASCADE ON UPDATE CASCADE;
`),
  },
  {
    version: 9,
    name: 'Delivery body hash index',
    // A known body under a new delivery GUID is refused as a replay; the lookup is by hash.
    up: (client) =>
      client.query('CREATE INDEX IF NOT EXISTS refit_deliveries_hash ON refit_deliveries (hash)'),
  },
  {
    version: 10,
    name: 'AI ledger across installations',
    // One row: the spend of every installation together, capped by REFIT_HOSTED_AI_BUDGET_USD.
    up: (client) =>
      client.query(`
CREATE TABLE IF NOT EXISTS refit_ai_total_ledger (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  state jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE refit_ai_total_ledger ENABLE ROW LEVEL SECURITY;
`),
  },
  {
    version: 11,
    name: 'Worker pause',
    // At most one row: while it exists, no worker claims a job, so a deploy interrupts nothing.
    up: (client) =>
      client.query(`
CREATE TABLE IF NOT EXISTS refit_worker_pause (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  paused_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE refit_worker_pause ENABLE ROW LEVEL SECURITY;
`),
  },
];

// Reads the applied versions without creating anything. `unknown` lists versions a newer worker
// applied; this worker runs against them because migrations only add.
export async function hostedSchemaStatus(pool: Pool) {
  const { rows } = await pool.query<{ present: boolean }>(
    `SELECT to_regclass('refit_schema_migrations') IS NOT NULL AS present`,
  );
  const applied = rows[0].present
    ? (
        await pool.query<{ version: number; name: string; appliedAt: Date }>(
          `SELECT version, name, applied_at AS "appliedAt" FROM refit_schema_migrations
           ORDER BY version`,
        )
      ).rows
    : [];
  const versions = new Set(applied.map((migration) => migration.version));
  return {
    applied,
    pending: MIGRATIONS.filter((migration) => !versions.has(migration.version)),
    unknown: applied.filter(
      (migration) => !MIGRATIONS.some((known) => known.version === migration.version),
    ),
  };
}

// Applies pending versions in order, each in its own transaction under the migration lock, and
// checks the history again inside the lock, so workers that start together apply each version once.
export async function migrateHostedSchema(pool: Pool) {
  await transaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    await client.query(HISTORY);
  });
  const applied: HostedMigration[] = [];
  for (const migration of MIGRATIONS)
    await transaction(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
      const { rows } = await client.query<{ name: string }>(
        'SELECT name FROM refit_schema_migrations WHERE version = $1',
        [migration.version],
      );
      // Another build recorded this version for a different migration; skipping would leave the
      // schema without this one.
      if (rows.length && rows[0].name !== migration.name)
        throw new PipelineInputError(
          `Schema version ${migration.version} was applied as "${rows[0].name}", but this worker expects "${migration.name}".`,
        );
      if (rows.length) return;
      await migration.up(client);
      await client.query('INSERT INTO refit_schema_migrations (version, name) VALUES ($1, $2)', [
        migration.version,
        migration.name,
      ]);
      applied.push(migration);
    });
  return applied;
}
