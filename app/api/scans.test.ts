import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScanReport } from '../../shared/types.ts';
import { GitHubApiError } from '../github.ts';
import { SCAN_FAILED, trackJobs } from '../progress.ts';
import type { ReportStore } from '../reports.ts';
import type { QueuedJob } from '../types.ts';
import { createScanRoute } from './scans.ts';
import type { ScansDeps } from './scans.ts';

const INSTALLATION = 70000001;
const REPO = 'refit-example-org/billing-api';
const OTHER = 'refit-example-org/storefront';
const JOB: QueuedJob = {
  kind: 'scan',
  installationId: INSTALLATION,
  repo: REPO,
  reason: 'install',
};

const report = (errors: string[] = []): ScanReport => ({
  repo: REPO,
  scannedAt: '2026-11-06T00:00:00Z',
  items: [],
  costUsd: 0,
  errors,
});

let server: Server | undefined;

async function get(overrides: Partial<ScansDeps> = {}, query = `?installation_id=${INSTALLATION}`) {
  const route = createScanRoute({
    reports: { latest: async () => undefined },
    pending: () => [],
    scanning: () => false,
    listInstallations: async () => [],
    listRepos: async () => [REPO],
    isAuthorized: () => true,
    ...overrides,
  });
  server = createServer((request, response) => void route(request, response));
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/api/scans${query}`);
  return { status: response.status, body: (await response.json()) as unknown };
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe('GET /api/scans', () => {
  it('lists an installed repo before any scan exists', async () => {
    expect((await get()).body).toEqual([{ repo: REPO, state: 'waiting' }]);
  });

  it('says queued while the job waits', async () => {
    const { body } = await get({ pending: () => [JOB] });
    expect(body).toEqual([{ repo: REPO, state: 'queued' }]);
  });

  it('says running over queued, since a running job stays in the queue', async () => {
    const { body } = await get({ pending: () => [JOB], scanning: () => true });
    expect(body).toEqual([{ repo: REPO, state: 'running' }]);
  });

  it('ignores run jobs when deciding a repo is queued', async () => {
    const run = { kind: 'run', installationId: INSTALLATION, repo: REPO } as QueuedJob;
    const { body } = await get({ pending: () => [run] });
    expect(body).toEqual([{ repo: REPO, state: 'waiting' }]);
  });

  it('says done and returns the public report', async () => {
    const stored = { ...report(), installationId: INSTALLATION };
    const { body } = await get({ reports: { latest: async () => stored } });
    expect(body).toEqual([{ repo: REPO, state: 'done', report: report() }]);
  });

  it('keeps a scan with unreadable files as done', async () => {
    const { body } = await get({ reports: { latest: async () => report(['bad .refit.yml']) } });
    expect(body).toMatchObject([{ state: 'done' }]);
  });

  it('says failed for a scan that never finished', async () => {
    const failed = report([`${SCAN_FAILED}: git clone exited with 128`]);
    const { body } = await get({ reports: { latest: async () => failed } });
    expect(body).toMatchObject([{ state: 'failed' }]);
  });

  it('without an installation id, covers every active installation', async () => {
    const listRepos = vi.fn(async (id: number) => (id === 1 ? [OTHER] : [REPO]));
    const { body } = await get(
      {
        listInstallations: async () => [
          { id: 1, suspended: false },
          { id: 2, suspended: false },
          { id: 3, suspended: true },
        ],
        listRepos,
      },
      '',
    );
    expect(listRepos.mock.calls.map(([id]) => id)).toEqual([1, 2]);
    expect((body as { repo: string }[]).map((scan) => scan.repo)).toEqual([REPO, OTHER]);
  });

  it('answers 401 without the service token', async () => {
    expect((await get({ isAuthorized: () => false })).status).toBe(401);
  });

  it('answers 400 for an installation id that is not a number', async () => {
    expect((await get({}, '?installation_id=1%20OR%201')).status).toBe(400);
  });

  it('answers 404 for an installation GitHub does not know', async () => {
    const missing = new GitHubApiError('POST', '/app/installations/1/access_tokens', 404);
    const { status } = await get({
      listRepos: async () => {
        throw missing;
      },
    });
    expect(status).toBe(404);
  });

  it('answers 502 when GitHub fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { status } = await get({
      listRepos: async () => {
        throw new GitHubApiError('GET', '/installation/repositories', 503);
      },
    });
    expect(status).toBe(502);
  });
});

describe('trackJobs', () => {
  const fakeReports = (existing?: ScanReport) => {
    const save = vi.fn(async () => {});
    return {
      save,
      store: { latest: async () => existing, save } as unknown as ReportStore,
    };
  };
  const signal = () => new AbortController().signal;

  it('reports a scan as running only while it runs', async () => {
    let finish = () => {};
    const { store } = fakeReports();
    const jobs = trackJobs(() => new Promise<void>((resolve) => (finish = resolve)), store);
    const work = jobs.run(JOB, signal());
    expect(jobs.scanning(REPO)).toBe(true);
    finish();
    await work;
    expect(jobs.scanning(REPO)).toBe(false);
  });

  it('leaves a failed report and rethrows, so the queue still retries', async () => {
    const { store, save } = fakeReports();
    const jobs = trackJobs(async () => {
      throw new Error('clone failed');
    }, store);
    await expect(jobs.run(JOB, signal())).rejects.toThrow('clone failed');
    expect(save).toHaveBeenCalledWith(
      INSTALLATION,
      expect.objectContaining({ repo: REPO, errors: [`${SCAN_FAILED}: clone failed`] }),
    );
  });

  it('never replaces a good report with a failure', async () => {
    const { store, save } = fakeReports(report());
    const jobs = trackJobs(async () => {
      throw new Error('clone failed');
    }, store);
    await expect(jobs.run(JOB, signal())).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });

  it('writes nothing for a job an uninstall stopped', async () => {
    const { store, save } = fakeReports();
    const jobs = trackJobs(async () => {
      throw new Error('aborted');
    }, store);
    await expect(jobs.run(JOB, AbortSignal.abort())).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });

  it('settles only when that installation has stopped', async () => {
    let finish = () => {};
    const { store } = fakeReports();
    const jobs = trackJobs(() => new Promise<void>((resolve) => (finish = resolve)), store);
    void jobs.run(JOB, signal());
    let settled = false;
    void jobs.settled(INSTALLATION).then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    await jobs.settled(INSTALLATION + 1);
    finish();
    await vi.waitFor(() => expect(settled).toBe(true));
  });
});
