// What onboarding polls, on the real queue, report store and route: only GitHub and the scan are fake.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScanReport } from '../shared/types.ts';
import { createScanRoute } from './api/scans.ts';
import type { ScanView } from './api/scans.ts';
import { trackJobs } from './progress.ts';
import { createFileQueue } from './queue.ts';
import type { FileQueue } from './queue.ts';
import { createReportStore } from './reports.ts';
import type { QueuedJob } from './types.ts';

const INSTALLATION = 70000001;
const FIRST = 'refit-example-org/billing-api';
const SECOND = 'refit-example-org/storefront';

const scanJob = (repo: string): QueuedJob => ({
  kind: 'scan',
  installationId: INSTALLATION,
  repo,
  reason: 'install',
});
const report = (repo: string): ScanReport => ({
  repo,
  scannedAt: '2026-11-06T00:00:00Z',
  items: [],
  costUsd: 0,
  errors: [],
});

let dir: string;
let server: Server;
let queue: FileQueue | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'refit-first-scan-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  queue?.close();
  queue = undefined;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

async function startApp(scan: (job: QueuedJob) => Promise<void>) {
  const reports = createReportStore(join(dir, 'reports'));
  const jobs = trackJobs(async (job) => scan(job), reports);
  queue = await createFileQueue(join(dir, 'queue.json'), jobs.run, { concurrency: 1, retries: 0 });
  const route = createScanRoute({
    reports,
    pending: queue.pending,
    scanning: jobs.scanning,
    listInstallations: async () => [{ id: INSTALLATION, suspended: false }],
    listRepos: async () => [FIRST, SECOND],
    isAuthorized: () => true,
  });
  server = createServer((request, response) => void route(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const states = async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/scans?installation_id=${INSTALLATION}`,
    );
    return ((await response.json()) as ScanView[]).map((view) => view.state);
  };
  return { reports, states };
}

describe('a first scan as onboarding sees it', () => {
  it('goes from waiting to queued to running to done, one repo at a time', async () => {
    const finish = new Map<string, () => void>();
    const { reports, states } = await startApp(
      (job) =>
        new Promise<void>((resolve) => {
          finish.set(job.repo, () => {
            void reports.save(INSTALLATION, report(job.repo)).then(resolve);
          });
        }),
    );
    expect(await states()).toEqual(['waiting', 'waiting']);

    await queue!.enqueue(scanJob(FIRST));
    await queue!.enqueue(scanJob(SECOND));
    await vi.waitFor(() => expect(finish.has(FIRST)).toBe(true));
    expect(await states()).toEqual(['running', 'queued']);

    finish.get(FIRST)!();
    await vi.waitFor(() => expect(finish.has(SECOND)).toBe(true));
    expect(await states()).toEqual(['done', 'running']);

    finish.get(SECOND)!();
    await queue!.idle();
    expect(await states()).toEqual(['done', 'done']);
  });

  it('shows failed once a scan has used its tries, not a spinner forever', async () => {
    const { states } = await startApp(async () => {
      throw new Error('clone failed');
    });
    await queue!.enqueue(scanJob(FIRST));
    await queue!.idle();
    expect(await states()).toEqual(['failed', 'waiting']);
  });

  it('replaces a failed report when a later scan works', async () => {
    let fail = true;
    const { reports, states } = await startApp(async (job) => {
      if (fail) throw new Error('clone failed');
      await reports.save(INSTALLATION, report(job.repo));
    });
    await queue!.enqueue(scanJob(FIRST));
    await queue!.idle();
    expect(await states()).toEqual(['failed', 'waiting']);
    fail = false;
    await queue!.enqueue(scanJob(FIRST));
    await queue!.idle();
    expect(await states()).toEqual(['done', 'waiting']);
  });
});
