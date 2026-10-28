import type { Pool } from 'pg';
import type { DocumentationSource } from './documentation-sources.ts';
import type { Inventory } from './inventory.ts';

export interface WatchSources {
  specification: string | null;
  documentation: DocumentationSource[];
}

// What one capture of a target found: the content hash of each source, or why it failed.
export type WatchCapture =
  | { kind: 'specification' | 'documentation'; url: string; hash: string }
  | { kind: 'specification' | 'documentation'; url: string; error: string };

export interface WatchTarget {
  provider: string;
  sources: WatchSources;
  captures: WatchCapture[] | null;
}

// Reads and writes the watch target table, which hosted migration 12 creates when the store opens.
export function openWatchTargetStore(pool: Pool) {
  // Registers every watched vendor of a complete inventory. A target's sources follow the catalog
  // the latest inventory was taken with; nothing about the repository is stored here.
  const register = async (inventory: Inventory) => {
    const registered: string[] = [];
    for (const provider of inventory.providers) {
      if (provider.watch?.status !== 'watched') continue;
      const { specification, documentation } = provider.watch;
      await pool.query(
        `INSERT INTO refit_watch_targets (provider, sources) VALUES ($1, $2)
         ON CONFLICT (provider) DO UPDATE SET sources = EXCLUDED.sources`,
        [provider.id, { specification, documentation }],
      );
      registered.push(provider.id);
    }
    return registered;
  };

  // Takes the target checked longest ago, if it was never checked or not within `intervalSeconds`,
  // and marks it checked so another worker skips it.
  const claimDue = async (intervalSeconds: number) =>
    (
      await pool.query<WatchTarget>(
        `UPDATE refit_watch_targets SET checked_at = now()
         WHERE provider = (
           SELECT provider FROM refit_watch_targets
           WHERE checked_at IS NULL OR checked_at < now() - make_interval(secs => $1)
           ORDER BY checked_at NULLS FIRST, provider LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING provider, sources, captures`,
        [intervalSeconds],
      )
    ).rows[0] ?? null;

  // A source whose hash differs from the last capture's marks the target changed.
  const record = async (provider: string, captures: WatchCapture[], changed: boolean) =>
    pool.query(
      `UPDATE refit_watch_targets SET captures = $2,
         changed_at = CASE WHEN $3 THEN now() ELSE changed_at END,
         error = $4
       WHERE provider = $1`,
      [
        provider,
        JSON.stringify(captures),
        changed,
        captures.some((capture) => 'error' in capture)
          ? 'One or more sources could not be captured.'
          : null,
      ],
    );

  // Every target with the inventoried repositories whose latest inventory detected the vendor.
  const read = async () =>
    (
      await pool.query(
        `SELECT t.provider, t.sources, t.registered_at AS "registeredAt",
           t.checked_at AS "checkedAt", t.captures, t.changed_at AS "changedAt", t.error,
           coalesce((SELECT array_agg(v.repository ORDER BY v.repository)
             FROM refit_inventories v, jsonb_array_elements(v.inventory->'providers') p
             WHERE p->>'id' = t.provider), '{}') AS repositories
         FROM refit_watch_targets t ORDER BY t.provider`,
      )
    ).rows;

  return { register, claimDue, record, read };
}
