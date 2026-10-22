# Hosted data

What the hosted worker (`refit hosted serve`) stores, how long it keeps it, how its schema changes, and how to back it up and restore it. Setup and deployment are in [Hosted onboarding](HOSTED-ONBOARDING.md#deploy-on-flyio).

The worker keeps two kinds of state:

- **PostgreSQL** (Supabase in production): installations, approvals, targets, jobs and their receipts.
- **The state directory** (`/data/state` on the Fly volume): one directory per target holding its managed checkout and evidence.

## Tables

Every table has row-level security enabled and no policies, so Supabase's Data API sees no rows. The worker's `refit_hosted` role owns the tables and bypasses row-level security.

| Table                             | One row per                                      | Stores                                                                                                                                                                                                                                                                       |
| --------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `refit_schema_migrations`         | applied schema version                           | `version`, `name`, `applied_at`.                                                                                                                                                                                                                                             |
| `refit_installations`             | GitHub App installation of the owner's account   | Installation id, owner login, `status` (`active`, `suspended`, `deleted`) and `updated_at`, the time of the last change. For a deleted installation, `updated_at` is when it was uninstalled.                                                                                |
| `refit_installation_repositories` | repository currently in an installation          | Installation id, repository full name and GitHub repository id.                                                                                                                                                                                                              |
| `refit_deliveries`                | accepted webhook delivery                        | Delivery GUID, SHA-256 of the body, event name and `received_at`. A redelivery with the same GUID and body is a duplicate; a different body is rejected. Payloads are not stored.                                                                                            |
| `refit_approvals`                 | approved repository and base branch              | The approval receipt as JSON (reviewed revision, file hashes, integrations), its fingerprint, the approver's login and the time of approval.                                                                                                                                 |
| `refit_targets`                   | repository, base and integration being monitored | Target id (a hash of repository and base, plus the integration id), repository, base, integration, installation, the approval fingerprint it was enrolled with, and `status` (`enrolled` or `cancelled`) with a message.                                                     |
| `refit_jobs`                      | poll of a target                                 | Target, `status` (`queued`, `running`, `finished`, `failed`, `cancelled`), lease owner and expiry, attempt count, operator `retry` flag, creation and finish times, and the receipt as JSON: status, evidence path, message, checked-out revision and `refit doctor` status. |

The state directory holds `targets/<target id>/`: `github/` is the App-managed checkout and `runs/` the evidence of each job (manifests, patches, logs). Receipts point into `runs/`.

## Retention

| Event                                   | Immediately                                                                                                                             | After the grace period                                                                                                                                                                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installation deleted (uninstall)        | Its targets and open jobs are cancelled in the transaction that records the delivery; running jobs are aborted. Rows and evidence stay. | Only with `refit hosted serve --purge-uninstalled`: after `UNINSTALL_GRACE_DAYS` (7 days) the worker deletes the installation's repository rows, its targets, their jobs and receipts, and each target's state directory, in one transaction. |
| Installation suspended                  | Targets and open jobs are cancelled.                                                                                                    | Nothing is deleted. Unsuspending enrolls the repositories again.                                                                                                                                                                              |
| Repository removed from an installation | Its repository row is deleted and its targets and open jobs are cancelled.                                                              | Nothing is deleted; re-adding the repository enrolls the same target with its history.                                                                                                                                                        |

- Deleting is opt-in (owner decision, 2026-10-22). Without `--purge-uninstalled` the worker deletes nothing and an uninstalled installation's rows and evidence stay until an operator removes them. With it, the worker checks for expired installations on every pass of its loop, before claiming jobs, and logs what it deleted.
- If a target's directory cannot be removed, the target keeps its rows and is logged. The next pass tries again.
- The deleted installation's row stays as the record that it was uninstalled. Approvals belong to a repository, not an installation, so they stay too. A later installation of the same repository enrolls it from the stored approval with a fresh history.
- **Reinstalling within the grace period restores everything.** GitHub gives a reinstalled App a new installation id. Enrollment moves each existing target to the new installation, so its job history and evidence stay. At the end of the grace period only the old installation's leftover repository rows are deleted.
- Deliveries are never deleted. AI budget ledgers (`installation-<id>` under the budget directory) record spend and are not pruned.

## Schema migrations

`pipeline/hosted-migrations.ts` holds numbered migrations, and `refit_schema_migrations` records which versions have been applied.

- `refit hosted serve` applies pending versions when it starts. `refit hosted migrate` applies them without starting the worker.
- `refit hosted migrate --dry-run` lists applied and pending versions without changing anything, not even by creating the history table.
- Each version runs in its own transaction holding PostgreSQL advisory lock `4206100001`, the lock workers took before versioned migrations. The history is checked again once the lock is held. Two workers that start together therefore apply each version once, and a worker from an older release never interleaves with a migration.
- Versions 1 and 2 recreate the schema that workers built before versioned migrations, and both are idempotent. The first new-style start on the live database records them and changes nothing else. A test builds main's exact schema (`pipeline/fixtures/hosted-schema-main.sql`), inserts rows, migrates, and checks that every row, column, constraint, index and row-level security flag is unchanged and that the result matches a fresh install.
- A worker that finds versions it does not know (`Applied by a newer worker` in the dry run) still runs, because migrations only add. This is what makes rolling back a deploy safe.

To add a migration:

1. Append `{ version: <next>, name, up }` to `MIGRATIONS`. Never edit, renumber or remove an applied version.
2. Keep it additive: new tables, new columns that are nullable or have a default, new indexes. The previous release must still run against the new schema during a rollback.
3. Enable row-level security on every new table, with no policies.
4. It must finish within the 30-second statement timeout. Long index builds need `CREATE INDEX CONCURRENTLY`, which cannot run inside a transaction and needs a separate decision.
5. Extend `pipeline/hosted-migrations.test.ts`.

## Connections and outages

`pipeline/hosted-database.ts` opens the pool:

- **Connection timeout:** 10 seconds.
- **Statement timeout:** 30 seconds, set with `SET statement_timeout` on each new connection, because the Supabase session pooler may not pass it as a startup parameter.
- **Client-side query timeout:** 35 seconds, so a lost network cannot hang a query.
- **Idle-client errors** (for example, the server restarting) are logged instead of crashing the process.

While PostgreSQL is unreachable, the worker stays up:

- At boot and in its loop, it logs `PostgreSQL is unavailable` and retries after 5 seconds, doubling the wait up to 60 seconds.
- A running job tolerates one failed lease renewal. A lease is renewed three times per lease period, so one missed renewal leaves it valid.
- If the next renewal could land after the lease expires, the worker stops the job instead. No other worker can claim a job while its lease holds.
- Once the lease expires, any worker reclaims the job, counting another attempt. After three attempts the job is marked failed and needs `refit hosted retry`.
- Webhooks that arrive during an outage get a 500 response. GitHub does not redeliver them on its own: redeliver them from the App's **Advanced** settings once the database is back.

`pipeline/hosted-outage.test.ts` stops and starts a throwaway PostgreSQL container under two workers to check this behavior. It is gated on `REFIT_POSTGRES_OUTAGE_IMAGE=postgres:17-alpine`, and it never touches a shared container.

## Backup and restore

The database and the volume are backed up separately. Restoring one does not restore the other.

### PostgreSQL on Supabase

- Pro, Team and Enterprise projects get daily backups, kept for 7, 14 and 30 days. Point-in-time recovery is a paid add-on that replaces the daily backups. Restore both from **Database → Backups** in the Supabase dashboard. A restore covers the whole project database, not only Refit's tables.
- Free projects have no downloadable backups. Take your own dump instead, from a machine that holds the URL. The `refit_*` pattern matches every Refit table and the job id sequence.

  ```bash
  pg_dump "$REFIT_DATABASE_URL" --table='refit_*' --format=custom --file=refit-hosted.dump
  ```

To restore only Refit's tables:

1. Stop the worker.
2. Restore the dump as the owning role:

   ```bash
   pg_restore --clean --if-exists --no-owner --role=refit_hosted --dbname="$REFIT_DATABASE_URL" refit-hosted.dump
   ```

3. Start the worker. It applies any migrations newer than the dump.

After any restore:

- Jobs that were running when the backup was taken are reclaimed once their leases expire.
- Installations, approvals and deliveries recorded after the backup are missing. Redeliver the App's webhooks from that time, and re-run `refit hosted approve` for approvals stored since then.

### The Fly volume

- Fly snapshots `refit_data` once every 24 hours and keeps each snapshot for 5 days by default.
- Fly's restore steps for a lost host:
  1. `fly volumes list` and `fly volumes snapshots list <volume id>` to find the snapshot.
  2. `fly volumes create refit_data --snapshot-id <snapshot id> -s 20 --region iad` to restore it into a new volume.
  3. `fly scale count 1` to create a Machine that mounts it.
- If the old Machine and volume still exist, stop the worker first, and confirm with `fly volumes list` which volume the new Machine attached.
- Evidence missing after a restore only removes that job's evidence: receipts stay in PostgreSQL, and the next job checks out the repository again.
- Directories for targets that no longer exist in the database are never pruned automatically.
