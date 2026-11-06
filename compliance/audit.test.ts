import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuditEntry } from '../shared/types.ts';
import {
  JsonAuditStore,
  MemoryAuditStore,
  listAudit,
  recordAudit,
  repoFileName,
  setAuditStore,
} from './audit.ts';

const entry = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  at: '2026-11-06T01:00:00.000Z',
  repo: 'refit-dev/demo-next-web',
  changeId: 'rule:payments:pci-dss-6.4.3-scripts',
  obligationId: 'payments:pci-dss-6.4.3-scripts',
  action: 'detected',
  evidence: ['example evidence'],
  actor: 'refit',
  ...overrides,
});

describe('JsonAuditStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'refit-audit-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('stores entries per repo and lists them oldest first', async () => {
    const store = new JsonAuditStore(dir);
    await store.append(
      entry({
        at: '2026-11-06T03:00:00Z',
        action: 'pr-opened',
        pr: 'https://github.com/refit-dev/demo-next-web/pull/1',
      }),
    );
    await store.append(entry({ at: '2026-11-06T01:00:00Z' }));
    await store.append(entry({ repo: 'refit-dev/demo-node-api', action: 'not-affected' }));

    const next = await store.list('refit-dev/demo-next-web');
    expect(next.map((e) => e.action)).toEqual(['detected', 'pr-opened']);
    expect(next[1].pr).toBe('https://github.com/refit-dev/demo-next-web/pull/1');
    expect(await store.list()).toHaveLength(3);
    expect(await store.list('refit-dev/nothing-here')).toEqual([]);
    // A second store on the same directory reads the same trail.
    expect(await new JsonAuditStore(dir).list('refit-dev/demo-node-api')).toHaveLength(1);
  });

  it('keeps every entry when many are written at once', async () => {
    const store = new JsonAuditStore(dir);
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        store.append(entry({ at: new Date(Date.UTC(2026, 10, 6, 0, 0, i)).toISOString() })),
      ),
    );
    expect(await store.list('refit-dev/demo-next-web')).toHaveLength(50);
  });

  it('skips a torn last line from a crash and keeps the rest', async () => {
    const store = new JsonAuditStore(dir);
    await store.append(entry());
    await appendFile(
      join(dir, repoFileName('refit-dev/demo-next-web')),
      '{"at":"2026-11-06',
      'utf8',
    );
    expect(await store.list('refit-dev/demo-next-web')).toHaveLength(1);
  });

  it('redacts secrets from evidence before writing', async () => {
    const store = new JsonAuditStore(dir);
    const token = `ghp_${'a'.repeat(36)}`;
    await store.append(
      entry({ evidence: [`push failed with token ${token}`, 'Authorization: Bearer abc.def'] }),
    );
    const [stored] = await store.list('refit-dev/demo-next-web');
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored.evidence).toEqual([
      'push failed with token [redacted]',
      'Authorization: Bearer [redacted]',
    ]);
  });

  it('refuses malformed entries loudly', async () => {
    const store = new JsonAuditStore(dir);
    await expect(
      store.append(entry({ action: 'deleted' as AuditEntry['action'] })),
    ).rejects.toThrow(/unknown audit action/);
    await expect(store.append(entry({ repo: '' }))).rejects.toThrow(/needs a repo/);
    await expect(store.append(entry({ at: 'yesterday' }))).rejects.toThrow(/bad timestamp/);
  });
});

describe('recordAudit and listAudit', () => {
  afterEach(() => {
    setAuditStore(undefined);
  });

  it('go through the configured store', async () => {
    const store = new MemoryAuditStore();
    setAuditStore(store);
    await recordAudit(entry({ actor: 'octocat', action: 'merged' }));
    const [listed] = await listAudit('refit-dev/demo-next-web');
    expect(listed).toMatchObject({ action: 'merged', actor: 'octocat' });
    expect(store.entries).toHaveLength(1);
  });
});
