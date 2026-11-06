import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalTask } from '../shared/types.ts';
import { buildParts, loadOptional, serviceTokenCheck, stubScanRepo } from './parts.ts';
import type { Modules, PartsDeps } from './parts.ts';

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

describe('buildParts', () => {
  const NONE: Modules = { orchestrator: {}, api: {}, audit: {}, lifecycle: {}, notify: {} };
  const TOKENS = { token: async () => 'ghs_test_installation_token' };
  const DEPS = {
    reports: { list: async () => [{ repo: 'org/a' }] },
    tokens: TOKENS,
    listRuns: async () => [],
  } as unknown as PartsDeps;
  const TASK = { id: 'illustrative-task' } as ExternalTask;

  it('warns once per missing part, and every stub is safe to call', async () => {
    const warnings: string[] = [];
    const parts = buildParts(NONE, DEPS, {}, (line) => warnings.push(line));
    expect(warnings.join('\n')).toMatch(/scanRepo/);
    expect(warnings.join('\n')).toMatch(/PR lifecycle/);
    expect(parts.routes).toEqual([]);
    expect(await parts.findOpenPullRequest(1, TASK)).toBeUndefined();
    await parts.refreshConflicts('org/a', 1, async () => {});
    await parts.sendWeeklyDigest([]);
    await expect(parts.runTasks({} as never)).rejects.toThrow(/no runRepoJob/);
  });

  it("passes P3's lifecycle what it asked for, including the rerun", async () => {
    const seen: unknown[] = [];
    const findTask = () => undefined;
    const rerun = async () => {};
    const parts = buildParts(
      {
        ...NONE,
        lifecycle: {
          createFindOpenPullRequest: ({ tokens }) => {
            seen.push(tokens);
            return async () => ({ url: 'https://example.com/illustrative', state: 'open' });
          },
          findTaskForPr: (listRuns) => {
            seen.push(listRuns);
            return findTask;
          },
          refreshConflicts: async (repo, options) => void seen.push(repo, options),
        },
      },
      DEPS,
      {},
      () => {},
    );
    expect((await parts.findOpenPullRequest(1, TASK))?.state).toBe('open');
    await parts.refreshConflicts('org/a', 7, rerun);
    expect(seen).toEqual([
      TOKENS,
      DEPS.listRuns,
      'org/a',
      { installationId: 7, tokens: TOKENS, findTask, rerun },
    ]);
  });

  it('only sends audit paths to the audit route, with the service-token check', async () => {
    const calls: unknown[] = [];
    const isServiceToken = () => true;
    const parts = buildParts(
      {
        ...NONE,
        api: { isServiceToken },
        audit: {
          AUDIT_PATHS: ['/api/audit'],
          serveAudit: async (_request, _response, { isAuthorized, listRepos }) => {
            calls.push(isAuthorized, await listRepos());
          },
        },
      },
      DEPS,
      {},
      () => {},
    );
    const [route] = parts.routes;
    const request = (url: string, method = 'GET') => ({ url, method }) as never;
    expect(await route(request('/api/other'), {} as never)).toBe(false);
    expect(await route(request('/api/audit', 'POST'), {} as never)).toBe(false);
    expect(calls).toEqual([]);
    expect(await route(request('/api/audit?repo=org/a'), {} as never)).toBe(true);
    expect(calls).toEqual([isServiceToken, ['org/a']]);
  });
});
