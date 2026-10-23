import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterEach, expect, it } from 'vitest';
import { transaction } from './hosted-database.ts';
import { hostedSchemaStatus, MIGRATIONS, migrateHostedSchema } from './hosted-migrations.ts';
import { openHostedStore } from './hosted-store.ts';
import { DEFAULT_TENANCY_LIMITS } from './hosted-tenancy.ts';

const DATABASE = process.env.REFIT_POSTGRES_URL;
// The lock main's workers took around their schema statement.
const MAIN_SCHEMA_LOCK = 4_206_100_001;
const TABLES = [
  'refit_installations',
  'refit_installation_repositories',
  'refit_deliveries',
  'refit_approvals',
  'refit_targets',
  'refit_jobs',
];
const execute = promisify(execFile);
const bin = resolve('bin/refit.mjs');
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// Each test gets its own schema so runs never share rows.
async function database() {
  const schema = `refit_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: DATABASE });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pools: pg.Pool[] = [];
  const connect = () => {
    const pool = new pg.Pool({ connectionString: DATABASE, options: `-c search_path=${schema}` });
    pools.push(pool);
    return pool;
  };
  cleanups.push(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  const url = new URL(DATABASE!);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return { schema, pool: connect(), connect, url: url.href };
}

// The schema exactly as main's workers created it before versioned migrations.
async function createMainSchema(pool: pg.Pool) {
  const schema = await readFile(resolve('pipeline/fixtures/hosted-schema-main.sql'), 'utf8');
  await transaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [MAIN_SCHEMA_LOCK]);
    await client.query(schema);
  });
}

// Columns, defaults, constraints, indexes and row-level security of the hosted tables.
async function shape(pool: pg.Pool, schema: string) {
  const query = async (sql: string) =>
    JSON.parse(JSON.stringify((await pool.query(sql, [TABLES])).rows).replaceAll(`${schema}.`, ''));
  return {
    columns: await query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = ANY($1) ORDER BY 1, 2`,
    ),
    constraints: await query(
      `SELECT c.conrelid::regclass::text AS table, c.conname, pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       WHERE c.connamespace = current_schema()::regnamespace AND c.conrelid::regclass::text = ANY($1)
       ORDER BY 1, 2`,
    ),
    indexes: await query(
      `SELECT tablename, indexname, indexdef FROM pg_indexes
       WHERE schemaname = current_schema() AND tablename = ANY($1) ORDER BY 1, 2`,
    ),
    security: await query(
      `SELECT relname, relrowsecurity FROM pg_class
       WHERE relnamespace = current_schema()::regnamespace AND relname = ANY($1) ORDER BY 1`,
    ),
  };
}

async function rows(pool: pg.Pool) {
  const tables: Record<string, unknown[]> = {};
  for (const table of TABLES)
    tables[table] = (
      await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY 1`)
    ).rows.map(({ row }) => row);
  return tables;
}

async function history(pool: pg.Pool) {
  return (
    await pool.query<{ version: number; name: string }>(
      'SELECT version, name FROM refit_schema_migrations ORDER BY version',
    )
  ).rows;
}

async function refit(args: string[], url: string) {
  const { stdout } = await execute(process.execPath, [bin, ...args], {
    env: { PATH: process.env.PATH, REFIT_DATABASE_URL: url },
  });
  return stdout;
}

it.skipIf(!DATABASE)(
  'adopts a database main created, keeping every row, and matches a fresh install',
  async () => {
    const upgraded = await database();
    await createMainSchema(upgraded.pool);
    const approval = {
      formatVersion: 1,
      kind: 'refit-repository-approval',
      repository: 'example/application',
      base: 'main',
      fingerprint: 'f'.repeat(64),
      files: [],
      reviewedRevision: 'a'.repeat(40),
      approvedAt: '2026-10-20T00:00:00.000Z',
    };
    await upgraded.pool.query(
      `INSERT INTO refit_installations (id, owner, status, updated_at) VALUES
         (456, 'example', 'active', '2026-10-20T01:00:00Z'),
         (900, 'example', 'deleted', '2026-10-21T01:00:00Z');
       INSERT INTO refit_installation_repositories VALUES
         (456, 'example/application', 789), (900, 'example/archive', 790);
       INSERT INTO refit_deliveries (id, hash, event, received_at) VALUES
         ('delivery-1', 'hash-1', 'installation', '2026-10-20T01:00:00Z');
       INSERT INTO refit_approvals (repository, base, fingerprint, approval, approved_by, approved_at)
         VALUES ('example/application', 'main', '${'f'.repeat(64)}', '${JSON.stringify(approval)}',
           'octo-reviewer', '2026-10-20T00:30:00Z');
       INSERT INTO refit_targets (id, repository, base, integration, installation_id, fingerprint,
           status, message, updated_at) VALUES
         ('0123456789abcdef', 'example/application', 'main', NULL, 456, '${'f'.repeat(64)}',
           'enrolled', NULL, '2026-10-20T01:00:00Z'),
         ('fedcba9876543210', 'example/archive', 'main', NULL, 900, '${'e'.repeat(64)}',
           'cancelled', 'Installation deleted.', '2026-10-21T01:00:00Z');
       INSERT INTO refit_jobs (target_id, status, attempts, created_at, finished_at, receipt, retry)
         VALUES
         ('0123456789abcdef', 'finished', 1, '2026-10-20T01:00:00Z', '2026-10-20T01:05:00Z',
           '{"status": "unchanged", "output": null, "message": "No contract change."}', false),
         ('fedcba9876543210', 'cancelled', 0, '2026-10-21T00:00:00Z', NULL, NULL, false),
         ('0123456789abcdef', 'queued', 0, '2026-10-21T02:00:00Z', NULL, NULL, true);`,
    );
    const before = await rows(upgraded.pool);
    const mainShape = await shape(upgraded.pool, upgraded.schema);

    const store = await openHostedStore(upgraded.pool, {
      accounts: ['example'],
      limits: DEFAULT_TENANCY_LIMITS,
    });
    // Versions 3 and 8 add tenancy and event-order columns to installations; every other value
    // stays as main wrote it.
    expect(await rows(upgraded.pool)).toEqual({
      ...before,
      refit_installations: before.refit_installations.map((row) => ({
        ...(row as object),
        allowed: false,
        last_claimed_at: null,
        changed_at: null,
      })),
    });
    expect(await history(upgraded.pool)).toEqual(
      MIGRATIONS.map(({ version, name }) => ({ version, name })),
    );
    // The serving worker allows its accounts on start; then the upgraded store still serves the
    // queued operator retry, and new ids follow the old ones.
    await store.allow();
    expect(await store.claim('test-worker', 60)).toEqual({
      job: 3,
      retry: true,
      target: expect.objectContaining({ id: '0123456789abcdef', installationId: 456 }),
    });
    expect(
      await store.finish(3, 'test-worker', 'finished', {
        status: 'unchanged',
        output: null,
        message: 'No contract change.',
      }),
    ).toBe(true);
    // allow() may queue a job for the newly allowed installation first, so only the order is checked.
    expect(await store.retry('0123456789abcdef')).toBeGreaterThan(3);

    const fresh = await database();
    await migrateHostedSchema(fresh.pool);
    const upgradedShape = await shape(upgraded.pool, upgraded.schema);
    expect(await shape(fresh.pool, fresh.schema)).toEqual(upgradedShape);
    // Versions 1 and 2 adopt main's schema unchanged: only versions 3 and 8 add columns to it.
    expect(upgradedShape.columns.length - mainShape.columns.length).toBe(3);
    // A second start applies nothing.
    expect(await migrateHostedSchema(upgraded.pool)).toEqual([]);
  },
);

it.skipIf(!DATABASE)(
  'applies each version once when new workers and a worker from main start together',
  async () => {
    const { pool, connect } = await database();
    const results = await Promise.all([
      createMainSchema(pool).then(() => []),
      ...[connect(), connect(), connect(), connect()].map((worker) => migrateHostedSchema(worker)),
    ]);
    const applied = results.flat().map((migration) => migration.version);
    console.log(
      'Versions applied per worker:',
      JSON.stringify(results.map((r) => r.map((m) => m.version))),
    );
    expect(applied.sort((a, b) => a - b)).toEqual(MIGRATIONS.map((migration) => migration.version));
    expect((await history(pool)).map((migration) => migration.version)).toEqual(
      MIGRATIONS.map((migration) => migration.version),
    );
  },
);

it.skipIf(!DATABASE)(
  'reports applied, pending and newer versions, and migrate --dry-run changes nothing',
  async () => {
    const { pool, url } = await database();
    const status = await hostedSchemaStatus(pool);
    expect(status).toEqual({ applied: [], pending: MIGRATIONS, unknown: [] });

    const dryRun = await refit(['hosted', 'migrate', '--dry-run'], url);
    console.log(dryRun);
    expect(dryRun).toBe(
      'Applied: none\nPending: 1 Initial hosted tables\nPending: 2 Operator retry flag on jobs\nPending: 3 Allowed accounts, claim fairness, daily usage and AI ledgers\nPending: 4 Approval issues and commands\nPending: 5 Repository inventories\nPending: 6 Deadline monitoring and alerts\nPending: 7 Report issues\nPending: 8 Installation event order and rename cascades\nPending: 9 Delivery body hash index\n',
    );
    const created = await pool.query(
      `SELECT count(*)::int AS count FROM pg_class
       WHERE relnamespace = current_schema()::regnamespace`,
    );
    expect(created.rows[0].count).toBe(0);

    expect(await refit(['hosted', 'migrate'], url)).toBe(
      'Applied: 1 Initial hosted tables\nApplied: 2 Operator retry flag on jobs\nApplied: 3 Allowed accounts, claim fairness, daily usage and AI ledgers\nApplied: 4 Approval issues and commands\nApplied: 5 Repository inventories\nApplied: 6 Deadline monitoring and alerts\nApplied: 7 Report issues\nApplied: 8 Installation event order and rename cascades\nApplied: 9 Delivery body hash index\n',
    );
    expect(await refit(['hosted', 'migrate'], url)).toBe('No pending migrations.\n');
    await pool.query(
      `INSERT INTO refit_schema_migrations (version, name) VALUES (10, 'From a newer worker')`,
    );
    expect(await refit(['hosted', 'migrate', '--dry-run'], url)).toBe(
      'Applied: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10\nApplied by a newer worker: 10 From a newer worker\nNo pending migrations.\n',
    );
    const { unknown, pending } = await hostedSchemaStatus(pool);
    expect({ unknown: unknown.map((migration) => migration.version), pending }).toEqual({
      unknown: [10],
      pending: [],
    });
  },
);

it.skipIf(!DATABASE)(
  'refuses a version that another build recorded under a different name',
  async () => {
    const { pool } = await database();
    await migrateHostedSchema(pool);
    const last = MIGRATIONS.at(-1)!;
    await pool.query('UPDATE refit_schema_migrations SET name = $1 WHERE version = $2', [
      'branch-only-migration',
      last.version,
    ]);
    await expect(migrateHostedSchema(pool)).rejects.toThrow(
      `Schema version ${last.version} was applied as "branch-only-migration", but this worker expects "${last.name}".`,
    );
  },
);
