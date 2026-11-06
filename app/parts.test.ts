import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadOptional, serviceTokenCheck, stubScanRepo } from './parts.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'refit-parts-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const base = () => pathToFileURL(join(dir, 'parts.ts')).href;

describe('loadOptional', () => {
  it('returns nothing when the module has not landed', async () => {
    expect(await loadOptional('./absent.mjs', base())).toEqual({});
  });

  it('returns the module when it has landed', async () => {
    await writeFile(join(dir, 'landed.mjs'), 'export const value = 7;');
    const loaded = await loadOptional<{ value: number }>('./landed.mjs', base());
    expect(loaded.value).toBe(7);
  });

  it('throws when a landed module has a broken import, rather than hiding it behind a stub', async () => {
    await writeFile(join(dir, 'broken.mjs'), "import './missing-inside.mjs';");
    await expect(loadOptional('./broken.mjs', base())).rejects.toThrow(/missing-inside/);
  });
});

describe('serviceTokenCheck', () => {
  const check = serviceTokenCheck('test-service-token');

  it('accepts only the exact bearer token', () => {
    expect(check('Bearer test-service-token')).toBe(true);
    expect(check('Bearer test-service-token2')).toBe(false);
    expect(check('test-service-token')).toBe(false);
    expect(check('Bearer ')).toBe(false);
    expect(check(undefined)).toBe(false);
  });

  it('matches nothing when no token is configured, including an empty bearer', () => {
    for (const unset of [undefined, '']) {
      const none = serviceTokenCheck(unset);
      expect(none('Bearer ')).toBe(false);
      expect(none('Bearer undefined')).toBe(false);
      expect(none(undefined)).toBe(false);
    }
  });
});

describe('stubScanRepo', () => {
  it('says plainly that nothing was scanned and queues no work', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-06T00:00:00Z') });
    const { report, tasks } = await stubScanRepo('refit-example-org/billing-api', '/illustrative');
    vi.useRealTimers();
    expect(tasks).toEqual([]);
    expect(report.items).toEqual([]);
    expect(report.scannedAt).toBe('2026-11-06T00:00:00.000Z');
    expect(report.errors[0]).toMatch(/Nothing was scanned/);
  });
});
