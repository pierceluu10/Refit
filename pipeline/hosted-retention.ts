import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { transaction } from './hosted-database.ts';

// A reinstall within this window re-attaches the uninstalled repositories' targets, job history and
// evidence; afterwards they are deleted.
export const UNINSTALL_GRACE_DAYS = 7;
// hostedTargetId: a 16-character hash, then an optional workflow integration id.
const TARGET_ID = /^[a-f0-9]{16}(\.[a-z][a-z0-9-]{0,63})?$/;

// Deletes what an uninstalled installation left once the grace period has passed since its last
// change (the uninstall): its installed repositories, its targets, their jobs and receipts, and
// each target's state directory (managed checkout and evidence). The installation row stays as the
// record that it was uninstalled; approvals belong to repositories and stay too. A target whose
// directory cannot be removed keeps its rows for the next pass.
export async function purgeUninstalled(pool: Pool, stateDirectory: string) {
  return transaction(pool, async (client) => {
    const { rows: installations } = await client.query<{ id: string }>(
      `SELECT i.id::text FROM refit_installations i
       WHERE i.status = 'deleted' AND i.updated_at < now() - make_interval(days => $1)
         AND (EXISTS (SELECT 1 FROM refit_targets t WHERE t.installation_id = i.id)
           OR EXISTS (SELECT 1 FROM refit_installation_repositories r WHERE r.installation_id = i.id))
       FOR UPDATE`,
      [UNINSTALL_GRACE_DAYS],
    );
    const ids = installations.map((installation) => installation.id);
    const { rows: targets } = await client.query<{ id: string }>(
      'SELECT id FROM refit_targets WHERE installation_id = ANY($1::bigint[]) FOR UPDATE',
      [ids],
    );
    const pruned: string[] = [];
    const kept: { target: string; reason: string }[] = [];
    for (const { id } of targets) {
      if (!TARGET_ID.test(id)) {
        kept.push({ target: id, reason: 'Target id cannot name a state directory.' });
        continue;
      }
      try {
        await rm(join(stateDirectory, 'targets', id), { recursive: true, force: true });
        pruned.push(id);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error)) throw error;
        kept.push({ target: id, reason: error.message });
      }
    }
    const jobs =
      (await client.query('DELETE FROM refit_jobs WHERE target_id = ANY($1::text[])', [pruned]))
        .rowCount ?? 0;
    await client.query('DELETE FROM refit_targets WHERE id = ANY($1::text[])', [pruned]);
    await client.query(
      'DELETE FROM refit_installation_repositories WHERE installation_id = ANY($1::bigint[])',
      [ids],
    );
    return { installations: ids.map(Number), targets: pruned, jobs, kept };
  });
}
