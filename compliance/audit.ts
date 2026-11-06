// The audit trail: every step Refit takes on a change or obligation, with its evidence. Stored as
// local JSON lines, one file per repo, behind an interface a Postgres store can implement
// (see audit.sql). Entries are append-only; nothing here edits or deletes one.

import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuditEntry, RecordAudit } from '../shared/types.ts';
import { redactSecrets } from './wording.ts';

export interface AuditStore {
  append(entry: AuditEntry): Promise<void>;
  // Entries for one repo, oldest first. Without a repo, every entry.
  list(repo?: string): Promise<AuditEntry[]>;
}

export const AUDIT_ACTIONS: AuditEntry['action'][] = [
  'detected',
  'matched',
  'not-affected',
  'pr-opened',
  'pr-updated',
  'merged',
  'closed',
];

// Checks an entry's shape and redacts secrets from its free text. Throws on a malformed entry,
// since a bad audit record is worse than a loud failure.
export function normalizeEntry(entry: AuditEntry): AuditEntry {
  if (!entry || typeof entry !== 'object') throw new Error('audit entry must be an object');
  if (typeof entry.repo !== 'string' || !entry.repo.trim())
    throw new Error('audit entry needs a repo');
  if (typeof entry.changeId !== 'string' || !entry.changeId.trim()) {
    throw new Error('audit entry needs a changeId');
  }
  if (!AUDIT_ACTIONS.includes(entry.action)) {
    throw new Error(`unknown audit action: ${String(entry.action)}`);
  }
  const at = entry.at ? new Date(entry.at) : new Date();
  if (Number.isNaN(at.getTime())) throw new Error(`audit entry has a bad timestamp: ${entry.at}`);
  const out: AuditEntry = {
    at: at.toISOString(),
    repo: entry.repo,
    changeId: entry.changeId,
    action: entry.action,
    evidence: (Array.isArray(entry.evidence) ? entry.evidence : []).map((e) =>
      redactSecrets(String(e)),
    ),
    actor: entry.actor || 'refit',
  };
  if (entry.obligationId) out.obligationId = entry.obligationId;
  if (entry.pr) out.pr = entry.pr;
  return out;
}

const byTime = (a: AuditEntry, b: AuditEntry) => a.at.localeCompare(b.at);

export function repoFileName(repo: string): string {
  return `${repo.replace(/[^A-Za-z0-9._-]+/g, '__')}.jsonl`;
}

export class JsonAuditStore implements AuditStore {
  readonly dir: string;
  // Appends to one file are chained, so concurrent writers in this process never interleave.
  private chains = new Map<string, Promise<void>>();

  constructor(dir: string) {
    this.dir = dir;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): JsonAuditStore {
    return new JsonAuditStore(env.REFIT_AUDIT_DIR ?? join(process.cwd(), '.refit', 'audit'));
  }

  async append(entry: AuditEntry): Promise<void> {
    const clean = normalizeEntry(entry);
    const file = join(this.dir, repoFileName(clean.repo));
    const previous = this.chains.get(file) ?? Promise.resolve();
    const next = previous.then(async () => {
      await mkdir(this.dir, { recursive: true });
      await appendFile(file, `${JSON.stringify(clean)}\n`, 'utf8');
    });
    this.chains.set(
      file,
      next.catch(() => {}),
    );
    await next;
  }

  async list(repo?: string): Promise<AuditEntry[]> {
    const files = repo
      ? [repoFileName(repo)]
      : (await readdir(this.dir).catch(() => [] as string[])).filter((f) => f.endsWith('.jsonl'));
    const entries: AuditEntry[] = [];
    for (const name of files) {
      const text = await readFile(join(this.dir, name), 'utf8').catch(() => '');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as AuditEntry;
          // Two repos can't share a file name in practice, but check the field anyway.
          if (!repo || entry.repo === repo) entries.push(entry);
        } catch {
          // A torn last line (a crash mid-write) is skipped; every complete line is kept.
        }
      }
    }
    return entries.sort(byTime);
  }
}

export class MemoryAuditStore implements AuditStore {
  readonly entries: AuditEntry[] = [];
  async append(entry: AuditEntry): Promise<void> {
    this.entries.push(normalizeEntry(entry));
  }
  async list(repo?: string): Promise<AuditEntry[]> {
    return this.entries.filter((e) => !repo || e.repo === repo).sort(byTime);
  }
}

let defaultStore: AuditStore | undefined;

export function auditStore(): AuditStore {
  defaultStore ??= JsonAuditStore.fromEnv();
  return defaultStore;
}

// Swaps the store, e.g. for Postgres or a test. Returns the previous one.
export function setAuditStore(store: AuditStore | undefined): AuditStore | undefined {
  const previous = defaultStore;
  defaultStore = store;
  return previous;
}

export const recordAudit: RecordAudit = (entry) => auditStore().append(entry);

export function listAudit(repo: string): Promise<AuditEntry[]> {
  return auditStore().list(repo);
}
