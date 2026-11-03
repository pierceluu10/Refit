import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderChange, ProviderHints } from '../../shared/types.ts';
import type { WatchReport } from './types.ts';
import {
  cacheFile,
  defaultWatchDir,
  dropCachedReads,
  hintsCover,
  noteRepoProviders,
  normalizeHints,
  readOutcome,
  readThroughCache,
  refreshTime,
  watchCostReport,
  type WatchRead,
} from './watch-cache.ts';

const change = (id: string): ProviderChange => ({
  provider: 'resend',
  id: `resend:${id}`,
  kind: 'other',
  title: 'An illustrative change',
  source: { url: 'https://example.com/changelog', quote: '(illustrative)' },
  affects: {},
});

const DAY = new Date('2026-11-03T12:00:00Z');
const now = () => DAY;

// A read that finishes, costs $0.20 and records the hints it was led by.
function reader(overrides: Partial<WatchRead> = {}) {
  const led: ProviderHints[] = [];
  const read = vi.fn(async (hints: ProviderHints): Promise<WatchRead> => {
    led.push(hints);
    return {
      changes: [change(`c${led.length}`)],
      finished: true,
      costUsd: 0.2,
      model: 'claude-sonnet-5-5',
      turns: 4,
      ...overrides,
    };
  });
  return { read, led };
}

const tempDir = () => mkdtemp(join(tmpdir(), 'aptitude-watch-cache-'));

describe('hints', () => {
  it('compares hints trimmed, de-duplicated and case-folded, and lets an empty request match any read', () => {
    expect(normalizeHints({ packages: [' Resend ', 'resend'], hosts: ['API.Resend.com'] })).toEqual(
      { packages: ['resend'], hosts: ['api.resend.com'] },
    );
    const read = { packages: ['resend', '@resend/node'], hosts: ['api.resend.com'] };
    expect(hintsCover(read, {})).toBe(true);
    expect(hintsCover(read, { packages: ['RESEND'] })).toBe(true);
    expect(hintsCover(read, { packages: ['resend', 'react-email'] })).toBe(false);
    expect(hintsCover(read, { docsUrls: ['https://resend.com/changelog'] })).toBe(false);
  });
});

describe('readOutcome', () => {
  const report = (issues: string[]) =>
    ({ model: 'm', turns: 2, issues: issues.map((message) => ({ message })) }) as WatchReport;
  it('calls a read finished only when its report says the loop ended on its own', () => {
    expect(readOutcome(report([]))).toMatchObject({ finished: true, turns: 2 });
    expect(readOutcome(report(['quote not found word for word']))).toMatchObject({
      finished: true,
    });
    expect(readOutcome(report(['run ended early: budget']))).toMatchObject({
      finished: false,
      reason: 'run ended early: budget',
    });
    expect(readOutcome(report(['run ended early: max-turns']))).toMatchObject({ finished: false });
    expect(readOutcome(report(['the agent ended without submitting changes']))).toMatchObject({
      finished: false,
    });
    expect(readOutcome(undefined)).toMatchObject({ finished: false });
  });
});

describe('readThroughCache', () => {
  it('reads a provider once a day, from a file other processes can read too', async () => {
    const dir = await tempDir();
    const { read } = reader();
    const first = await readThroughCache({ dir, provider: 'resend', read, now });
    const second = await readThroughCache({ dir, provider: 'Resend', read, now });
    expect(read).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    const stored = JSON.parse(await readFile(cacheFile(dir, 'resend', '2026-11-03'), 'utf8'));
    expect(stored).toMatchObject({ provider: 'resend', day: '2026-11-03', costUsd: 0.2, turns: 4 });
    // The next UTC day is a new read.
    await readThroughCache({
      dir,
      provider: 'resend',
      read,
      now: () => new Date('2026-11-04T00:01:00Z'),
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('serves callers the read covers, and reads again, led by every hint seen, for one it does not', async () => {
    const dir = await tempDir();
    const { read, led } = reader();
    await readThroughCache({ dir, provider: 'resend', hints: { packages: ['resend'] }, read, now });
    await readThroughCache({ dir, provider: 'resend', hints: {}, read, now });
    await readThroughCache({ dir, provider: 'resend', hints: { packages: ['resend'] }, read, now });
    expect(read).toHaveBeenCalledTimes(1);
    await readThroughCache({
      dir,
      provider: 'resend',
      hints: { hosts: ['api.resend.com'] },
      read,
      now,
    });
    expect(led[1]).toEqual({ packages: ['resend'], hosts: ['api.resend.com'] });
    // The wider read replaced the first, so both callers are served from it now.
    await readThroughCache({ dir, provider: 'resend', hints: { packages: ['resend'] }, read, now });
    await readThroughCache({
      dir,
      provider: 'resend',
      hints: { hosts: ['api.resend.com'] },
      read,
      now,
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('returns a read that ended early but never caches it', async () => {
    const dir = await tempDir();
    const log = vi.fn();
    const early = reader({ finished: false, reason: 'run ended early: budget' });
    const changes = await readThroughCache({ dir, provider: 'resend', read: early.read, now, log });
    expect(changes).toHaveLength(1);
    expect(log.mock.calls[0][0]).toContain('not cached (run ended early: budget)');
    const full = reader();
    await readThroughCache({ dir, provider: 'resend', read: full.read, now });
    expect(full.read).toHaveBeenCalledTimes(1);
  });

  it('caches nothing when the read throws, and rethrows its error', async () => {
    const dir = await tempDir();
    const failed = reader({ finished: false, error: new Error('changelog unreachable') });
    await expect(
      readThroughCache({ dir, provider: 'meta', read: failed.read, now }),
    ).rejects.toThrow('changelog unreachable');
    const report = await watchCostReport(dir, '2026-11-03');
    expect(report.rows).toEqual([
      expect.objectContaining({ provider: 'meta', reads: 1, cachedReads: 0, costUsd: 0.2 }),
    ]);
  });

  it('shares one read between callers in a process that start together', async () => {
    const dir = await tempDir();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const read = vi.fn(async (): Promise<WatchRead> => {
      await gate;
      return { changes: [change('a')], finished: true, costUsd: 0.2 };
    });
    const calls = [1, 2, 3].map(() => readThroughCache({ dir, provider: 'stripe', read, now }));
    release();
    await Promise.all(calls);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('waits for another process holding the lock, then reuses what it cached', async () => {
    const dir = await tempDir();
    const file = cacheFile(dir, 'stripe', '2026-11-03');
    await mkdir(join(dir, '2026-11-03'), { recursive: true });
    const lock = file.replace(/\.json$/, '.lock');
    // This process stands in for the other one: its pid is alive.
    await writeFile(
      lock,
      JSON.stringify({ pid: process.pid, host: hostname(), at: DAY.toISOString() }),
    );
    const { read } = reader();
    const waiting = readThroughCache({ dir, provider: 'stripe', read, now, pollMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The other process finishes: it writes its read and lets go of the lock.
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        provider: 'stripe',
        day: '2026-11-03',
        hints: {},
        readAt: DAY.toISOString(),
        costUsd: 0.9,
        changes: [change('theirs')],
      }),
    );
    const { rm } = await import('node:fs/promises');
    await rm(lock);
    expect((await waiting).map((found) => found.id)).toEqual(['resend:theirs']);
    expect(read).not.toHaveBeenCalled();
  });

  it('takes over a lock whose process is gone', async () => {
    const dir = await tempDir();
    const lock = cacheFile(dir, 'stripe', '2026-11-03').replace(/\.json$/, '.lock');
    await mkdir(join(dir, '2026-11-03'), { recursive: true });
    await writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 12345, host: hostname(), at: '' }));
    const { read } = reader();
    await readThroughCache({ dir, provider: 'stripe', read, now, pollMs: 5 });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('refreshes on purpose: once for reads made before the refresh time, or by dropping the file', async () => {
    const dir = await tempDir();
    const { read } = reader();
    await readThroughCache({ dir, provider: 'openai', read, now });
    const refreshBefore = new Date(DAY.getTime() + 1);
    const later = () => new Date(DAY.getTime() + 60_000);
    await readThroughCache({ dir, provider: 'openai', read, now: later, refreshBefore });
    await readThroughCache({ dir, provider: 'openai', read, now: later, refreshBefore });
    expect(read).toHaveBeenCalledTimes(2);

    expect(await dropCachedReads(dir, 'openai', '2026-11-03')).toEqual([
      cacheFile(dir, 'openai', '2026-11-03'),
    ]);
    await readThroughCache({ dir, provider: 'openai', read, now });
    expect(read).toHaveBeenCalledTimes(3);

    expect(refreshTime('openai', { APTITUDE_WATCH_REFRESH: 'stripe, OpenAI' }, DAY)).toEqual(DAY);
    expect(refreshTime('openai', { APTITUDE_WATCH_REFRESH: 'all' }, DAY)).toEqual(DAY);
    expect(refreshTime('openai', { APTITUDE_WATCH_REFRESH: 'stripe' }, DAY)).toBeUndefined();
    expect(refreshTime('openai', {}, DAY)).toBeUndefined();
  });

  it('keeps a since read apart from the latest one', async () => {
    const dir = await tempDir();
    const { read } = reader();
    await readThroughCache({ dir, provider: 'stripe', read, now });
    await readThroughCache({ dir, provider: 'stripe', since: '2026-01-01', read, now });
    expect(read).toHaveBeenCalledTimes(2);
    expect(
      (await readdir(join(dir, '2026-11-03'))).filter((name) => name.endsWith('.json')).sort(),
    ).toEqual(['stripe--since-2026-01-01.json', 'stripe.json']);
  });
});

describe('defaultWatchDir', () => {
  it('is APTITUDE_WATCH_CACHE when set, so every process of a run shares one folder', () => {
    expect(defaultWatchDir({ APTITUDE_WATCH_CACHE: '/shared/watch' })).toBe('/shared/watch');
    expect(defaultWatchDir({})).toBe(join(tmpdir(), 'aptitude-watch'));
  });
});

describe('watchCostReport', () => {
  it("splits each provider's reads that day over the repos whose inventory named it", async () => {
    const dir = await tempDir();
    const { read } = reader();
    await readThroughCache({ dir, provider: 'stripe', read, now });
    await readThroughCache({ dir, provider: 'stripe', read, now });
    await readThroughCache({ dir, provider: 'resend', read, now });
    await noteRepoProviders(dir, 'acme/shop', ['Stripe', 'resend'], DAY);
    await noteRepoProviders(dir, 'acme/blog', ['stripe'], DAY);
    await noteRepoProviders(dir, 'acme/shop', ['stripe'], DAY); // a second run of the same repo

    const report = await watchCostReport(dir, '2026-11-03');
    expect(report.rows).toEqual([
      {
        provider: 'resend',
        reads: 1,
        cachedReads: 1,
        costUsd: 0.2,
        served: 0,
        repos: ['acme/shop'],
        costPerRepoUsd: 0.2,
      },
      {
        provider: 'stripe',
        reads: 1,
        cachedReads: 1,
        costUsd: 0.2,
        served: 1,
        repos: ['acme/blog', 'acme/shop'],
        costPerRepoUsd: 0.1,
      },
    ]);
    expect(report.totalUsd).toBeCloseTo(0.4);
    expect((await watchCostReport(dir, '2026-11-02')).rows).toEqual([]);
  });
});
