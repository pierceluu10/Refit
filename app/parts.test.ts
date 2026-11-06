import type { ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnyTask, StoredRun } from '../memory/types.ts';
import type { ExternalTask, MigrationTask } from '../shared/types.ts';
import {
  API,
  OPEN_PULLS,
  REPO,
  fakeGitHub,
  pullFixture,
  pullUrl,
} from './lifecycle/fixtures/fake-github.ts';
import { loadParts } from './parts.ts';
import type { PartsDeps } from './parts.ts';
import { isIgnored } from './settings.ts';

const SERVICE_TOKEN = 'illustrative-service-token';
const STORED_REPORT = { repo: 'org/a' };

const deps = (listRuns: PartsDeps['listRuns'] = async () => []) =>
  ({
    reports: { list: async () => [STORED_REPORT] },
    tokens: { token: async () => 'ghs_test_installation_token' },
    listRuns,
  }) as unknown as PartsDeps;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('refreshConflicts', () => {
  const SOURCE = { url: 'https://example.com/illustrative', quote: 'illustrative' };
  const UPGRADE: ExternalTask = {
    id: 'illustrative-node-22',
    repo: REPO,
    priority: 1,
    usages: [],
    change: {
      provider: 'node',
      id: 'node-22',
      kind: 'runtime-eol',
      title: 'Node 18 reaches end of life',
      source: SOURCE,
      affects: {},
      dependencyKind: 'runtime',
      dependency: 'node',
      toVersion: '22',
    },
    dependencies: [{ repo: REPO, kind: 'runtime', name: 'node', version: '18', declaredIn: [] }],
  };
  const OLDER: MigrationTask = {
    id: 'illustrative-stripe-sdk',
    repo: REPO,
    priority: 1,
    usages: [
      {
        repo: REPO,
        provider: 'stripe',
        via: 'sdk',
        sdk: { name: 'stripe', version: '14.0.0' },
        callSites: [],
      },
    ],
    change: {
      provider: 'stripe',
      id: 'stripe-sdk-major',
      kind: 'sdk-major',
      title: 'Stripe SDK major version',
      source: SOURCE,
      affects: {},
    },
  };

  // One conflicted PR nobody edited, whose stored run holds the given task. Fetch is faked globally
  // because the wired lifecycle reaches GitHub with the default fetch.
  async function rerunOf(task: AnyTask) {
    const github = fakeGitHub({
      [OPEN_PULLS]: { body: [pullFixture({ number: 7 })] },
      [`GET ${API}/pulls/7`]: {
        body: pullFixture({ number: 7, mergeable: false, mergeableState: 'dirty' }),
      },
      [`GET ${API}/issues/7/comments?per_page=100`]: { body: [] },
      [`POST ${API}/issues/7/comments`]: { status: 201 },
      [`GET ${API}/compare/main...head-7`]: {
        body: { commits: [{ parents: [{}], author: { type: 'Bot' } }] },
      },
    });
    vi.stubGlobal('fetch', github.fetchImpl);
    const stored = { recordedAt: '2026-11-01T00:00:00.000Z', task, record: { pr: pullUrl(7) } };
    const parts = loadParts(deps(async () => [stored as StoredRun]));
    const rerun = vi.fn(async (_task: ExternalTask) => {});
    await parts.refreshConflicts(REPO, 7, rerun);
    expect(rerun, JSON.stringify(github.calls)).toHaveBeenCalledOnce();
    return rerun.mock.calls[0][0];
  }

  it('re-runs an upgrade task with its external fields intact', async () => {
    expect(await rerunOf(UPGRADE)).toEqual(UPGRADE);
  });

  it('re-runs an older stored MigrationTask as an API task the run job can read', async () => {
    const task = await rerunOf(OLDER);
    expect(task.id).toBe(OLDER.id);
    expect(task.usages).toEqual(OLDER.usages);
    expect(task.change).toMatchObject({ dependencyKind: 'api', dependency: 'stripe' });
    expect(task.dependencies).toMatchObject([{ kind: 'sdk', name: 'stripe', version: '14.0.0' }]);
    // The run job's first read of a task; a change without a dependency name throws here.
    expect(isIgnored({ paused: false, ignore: ['stripe'], errors: [] }, task.change)).toBe(true);
  });
});

describe('routes', () => {
  const fakeResponse = () => {
    const response = {
      status: 0,
      sent: '',
      setHeader: () => response,
      writeHead: (status: number) => {
        response.status = status;
        return response;
      },
      end: (body?: string) => {
        response.sent = body ?? '';
        return response;
      },
    };
    return response;
  };

  const request = (url: string, method = 'GET', authorization?: string) =>
    ({ url, method, headers: { authorization } }) as never;

  async function serve(incoming: never) {
    const response = fakeResponse();
    for (const route of loadParts(deps()).routes) {
      if (await route(incoming, response as unknown as ServerResponse)) return response;
    }
    return undefined;
  }

  it('leaves paths no module owns unhandled', async () => {
    expect(await serve(request('/api/other'))).toBeUndefined();
  });

  it('sends only a GET of an audit path to the audit route', async () => {
    expect(await serve(request('/api/audit', 'POST'))).toBeUndefined();
  });

  it('holds both the report and audit APIs behind the service token', async () => {
    vi.stubEnv('REFIT_SERVICE_TOKEN', SERVICE_TOKEN);
    for (const path of ['/api/repos', '/api/audit']) {
      expect((await serve(request(path)))?.status, path).toBe(401);
      expect((await serve(request(path, 'GET', 'Bearer wrong')))?.status, path).toBe(401);
    }
  });

  it('answers the audit route once authorized', async () => {
    vi.stubEnv('REFIT_SERVICE_TOKEN', SERVICE_TOKEN);
    const answer = await serve(request('/api/obligations', 'GET', `Bearer ${SERVICE_TOKEN}`));
    expect(answer?.status).toBe(200);
    expect(answer?.sent).toBe('[]');
  });
});
