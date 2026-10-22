import type { Pool, PoolClient } from 'pg';
import { transaction } from './hosted-database.ts';

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
      const { rowCount } = await client.query(
        'SELECT 1 FROM refit_schema_migrations WHERE version = $1',
        [migration.version],
      );
      if (rowCount) return;
      await migration.up(client);
      await client.query('INSERT INTO refit_schema_migrations (version, name) VALUES ($1, $2)', [
        migration.version,
        migration.name,
      ]);
      applied.push(migration);
    });
  return applied;
}
