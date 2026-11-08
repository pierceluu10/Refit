import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BehindItem,
  ExternalChange,
  ExternalTask,
  RunRecord,
  ScanReport,
} from '../shared/types.ts';
import { createJobRunner, JobCancelledError } from './jobs.ts';
import type { JobRunnerDeps } from './jobs.ts';
import { HoldJobError } from './queue.ts';
import type { ExistingPullRequest } from './pr.ts';
import { createReportStore } from './reports.ts';
import type { RepoSettings } from './settings.ts';
import type { AppJob, OpenAnyPullRequest, RunJob, ScanJob } from './types.ts';

const INSTALLATION = 70000001;
const REPO = 'refit-example-org/billing-api';
const PR = `https://github.com/${REPO}/pull/41`;

const change = (dependency: string): ExternalChange => ({
  provider: dependency,
  id: `${dependency}-change`,
  kind: 'runtime-eol',
  title: `Illustrative ${dependency} change`,
  source: { url: 'https://example.com/illustrative', quote: 'Illustrative.' },
  affects: {},
  dependencyKind: 'runtime',
  dependency,
});
const taskOf = (dependency: string): ExternalTask => ({
  id: `${REPO}:${dependency}-change`,
  repo: REPO,
  change: change(dependency),
  usages: [],
  dependencies: [],
  priority: 1,
});
const itemOf = (dependency: string): BehindItem => ({
  repo: REPO,
  dependency: { repo: REPO, kind: 'runtime', name: dependency, declaredIn: [] },
  change: change(dependency),
  status: 'open',
});
const reportOf = (...dependencies: string[]): ScanReport => ({
  repo: REPO,
  scannedAt: '2026-11-06T00:00:00Z',
  items: dependencies.map(itemOf),
  costUsd: 0.5,
  errors: ['Illustrative: could not read one file'],
});
const SCAN: ScanJob = { kind: 'scan', installationId: INSTALLATION, repo: REPO, reason: 'push' };
const RUN: RunJob = { kind: 'run', installationId: INSTALLATION, repo: REPO, task: taskOf('node') };
const RECORD: RunRecord = {
  taskId: RUN.task.id,
  outcome: 'needs-review',
  diff: '',
  checks: [],
  costUsd: 0,
  transcriptPath: '',
};

let storeDir: string;
beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  storeDir = await mkdtemp(join(tmpdir(), 'refit-jobs-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(storeDir, { recursive: true, force: true });
});

const NO_SETTINGS: RepoSettings = { paused: false, ignore: [], errors: [] };

// Real report store and real temp dirs; everything that would reach the network or a model is faked.
function fakes(overrides: Partial<JobRunnerDeps> = {}) {
  const calls: string[] = [];
  const queued: AppJob[] = [];
  const reports = createReportStore(storeDir);
  let checkoutDir = '';
  const opener = vi.fn<OpenAnyPullRequest>(async () => PR);
  const deps: JobRunnerDeps = {
    tokens: { token: async (id) => `token-${id}` },
    checkout: async (token, repo, dir) => {
      checkoutDir = dir;
      calls.push(`checkout ${token} ${repo}`);
    },
    scanRepo: async (repo, dir) => {
      calls.push(`scan ${repo} ${dir === checkoutDir}`);
      expect(existsSync(dir)).toBe(true);
      return { report: reportOf('node', 'flask'), tasks: [taskOf('node'), taskOf('flask')] };
    },
    runTasks: async ({ repo, dir, tasks, openPullRequest }) => {
      calls.push(`run ${repo} ${dir === checkoutDir} ${tasks.map((task) => task.id).join()}`);
      expect(existsSync(dir)).toBe(true);
      return [{ ...RECORD, pr: await openPullRequest(tasks[0], RECORD, dir) }];
    },
    openPullRequestFor: (id) => {
      calls.push(`opener ${id}`);
      return opener;
    },
    findPullRequest: async () => undefined,
    beforeOpenPullRequest: async () => ({}),
    refreshConflicts: async () => {},
    notifyRun: async ({ repo, records, report }) => {
      calls.push(`notify ${repo} ${records.length} ${report?.items[0]?.status}`);
    },
    readSettings: async () => NO_SETTINGS,
    isIgnored: (settings, ignored) => settings.ignore.includes(ignored.dependency),
    reports,
    enqueue: async (job) => void queued.push(job),
    ...overrides,
  };
  return {
    deps,
    run: createJobRunner(deps),
    calls,
    queued,
    reports,
    opener,
    dir: () => checkoutDir,
  };
}

const live = () => new AbortController().signal;

describe('scan job', () => {
  it('checks out, scans, stores the report, queues one run per task and deletes the checkout', async () => {
    const fake = fakes();
    await fake.run(SCAN, live());
    expect(fake.calls).toEqual([
      `checkout token-${INSTALLATION} ${REPO}`,
      `scan ${REPO} true`,
      `notify ${REPO} 0 open`,
    ]);
    expect(fake.queued).toEqual([
      { kind: 'run', installationId: INSTALLATION, repo: REPO, task: taskOf('node') },
      { kind: 'run', installationId: INSTALLATION, repo: REPO, task: taskOf('flask') },
    ]);
    expect(await fake.reports.latest(REPO)).toMatchObject(reportOf('node', 'flask'));
    expect(existsSync(fake.dir())).toBe(false);
  });

  it('after storing the report it notifies with no records, then checks open PRs for conflicts', async () => {
    const order: string[] = [];
    const fake = fakes({
      scanRepo: async () => ({ report: reportOf('node'), tasks: [] }),
      notifyRun: async ({ records, report }) => {
        order.push(`notify ${records.length} ${report?.items.length}`);
      },
      refreshConflicts: async (job) => void order.push(`conflicts ${job.repo}`),
    });
    await fake.run(SCAN, new AbortController().signal);
    expect(order).toEqual(['notify 0 1', `conflicts ${REPO}`]);
  });

  it('a failing notify or conflict check is logged and fails nothing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = fakes({
      scanRepo: async () => ({ report: reportOf('node'), tasks: [taskOf('node')] }),
      notifyRun: async () => {
        throw new Error('slack is down');
      },
      refreshConflicts: async () => {
        throw new Error('github is down');
      },
    });
    await fake.run(SCAN, new AbortController().signal);
    expect(fake.queued).toHaveLength(1);
    expect(errors.mock.calls.flat().join('\n')).toMatch(/slack is down[\s\S]*github is down/);
  });

  it('a paused repo gets no notification or conflict check', async () => {
    const refreshConflicts = vi.fn<JobRunnerDeps['refreshConflicts']>();
    const notifyRun = vi.fn<JobRunnerDeps['notifyRun']>();
    const fake = fakes({
      refreshConflicts,
      notifyRun,
      readSettings: async () => ({ ...NO_SETTINGS, paused: true }),
    });
    await fake.run(SCAN, new AbortController().signal);
    expect(refreshConflicts).not.toHaveBeenCalled();
    expect(notifyRun).not.toHaveBeenCalled();
  });

  it('a paused repo is not scanned, and its older report stays', async () => {
    const scanRepo = vi.fn<JobRunnerDeps['scanRepo']>();
    const fake = fakes({
      scanRepo,
      readSettings: async () => ({ ...NO_SETTINGS, paused: true }),
    });
    await fake.reports.save(INSTALLATION, reportOf('older'));
    await fake.run(SCAN, live());
    expect(scanRepo).not.toHaveBeenCalled();
    expect(fake.queued).toEqual([]);
    expect((await fake.reports.latest(REPO))?.items.map((item) => item.dependency.name)).toEqual([
      'older',
    ]);
    expect(existsSync(fake.dir())).toBe(false);
  });

  it('drops ignored dependencies from the report and the queue, and reports settings errors', async () => {
    const fake = fakes({
      readSettings: async () => ({
        paused: false,
        ignore: ['flask'],
        errors: ['.refit.yml could not be read'],
      }),
    });
    await fake.run(SCAN, live());
    const saved = await fake.reports.latest(REPO);
    expect(saved?.items.map((item) => item.dependency.name)).toEqual(['node']);
    expect(saved?.errors).toEqual([
      'Illustrative: could not read one file',
      '.refit.yml could not be read',
    ]);
    expect(fake.queued.map((job) => job.kind === 'run' && job.task.change.dependency)).toEqual([
      'node',
    ]);
  });

  it.each<[ExistingPullRequest['state'], BehindItem['status']]>([
    ['open', 'pr-open'],
    ['merged', 'merged'],
    ['closed', 'open'],
  ])(
    'a task whose branch has a %s PR gets status %s, its link, and no run',
    async (state, status) => {
      const fake = fakes({
        findPullRequest: async (_id, task) =>
          task.change.dependency === 'node' ? { url: PR, state } : undefined,
      });
      await fake.run(SCAN, live());
      const items = (await fake.reports.latest(REPO))!.items;
      expect(items[0]).toMatchObject({ status, pr: PR });
      expect(items[1]).toMatchObject({ status: 'open' });
      expect(items[1].pr).toBeUndefined();
      expect(fake.queued.map((job) => job.kind === 'run' && job.task.change.dependency)).toEqual([
        'flask',
      ]);
    },
  );

  it('a failed PR lookup is logged and the task still runs', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = fakes({
      findPullRequest: async () => {
        throw new Error('GitHub is down');
      },
    });
    await fake.run(SCAN, live());
    expect(fake.queued).toHaveLength(2);
    expect(errors.mock.calls.flat().join('\n')).toContain('GitHub is down');
  });

  it('fails the job when the scan throws, and still deletes the checkout', async () => {
    const fake = fakes({
      scanRepo: async () => {
        throw new Error('inventory failed');
      },
    });
    await expect(fake.run(SCAN, live())).rejects.toThrow('inventory failed');
    expect(fake.queued).toEqual([]);
    expect(existsSync(fake.dir())).toBe(false);
  });

  it('stores nothing and queues nothing when the repo is removed during the scan', async () => {
    const controller = new AbortController();
    const fake = fakes({
      scanRepo: async () => {
        controller.abort();
        return { report: reportOf('node'), tasks: [taskOf('node')] };
      },
    });
    await expect(fake.run(SCAN, controller.signal)).rejects.toBeInstanceOf(JobCancelledError);
    expect(await fake.reports.latest(REPO)).toBeUndefined();
    expect(fake.queued).toEqual([]);
  });
});

describe('run job', () => {
  it('runs the one task with a wrapped opener, marks the report, notifies, deletes the checkout', async () => {
    const fake = fakes();
    await fake.reports.save(INSTALLATION, reportOf('node'));
    await fake.run(RUN, live());
    expect(fake.calls).toEqual([
      `checkout token-${INSTALLATION} ${REPO}`,
      `run ${REPO} true ${RUN.task.id}`,
      `opener ${INSTALLATION}`,
      `notify ${REPO} 1 pr-open`,
    ]);
    expect(fake.opener).toHaveBeenCalledWith(RUN.task, RECORD, fake.dir());
    expect((await fake.reports.latest(REPO))?.items[0]).toMatchObject({
      status: 'pr-open',
      pr: PR,
    });
    expect(existsSync(fake.dir())).toBe(false);
  });

  it.each([
    ['paused', { ...NO_SETTINGS, paused: true }],
    ['ignoring the dependency', { ...NO_SETTINGS, ignore: ['node'] }],
  ])('a task is not run when the repo is now %s', async (_, settings) => {
    const runTasks = vi.fn<JobRunnerDeps['runTasks']>();
    const fake = fakes({ runTasks, readSettings: async () => settings });
    await fake.run(RUN, live());
    expect(runTasks).not.toHaveBeenCalled();
    expect(fake.calls.filter((call) => call.startsWith('notify'))).toEqual([]);
  });

  it('a PR the lifecycle found replaces opening a new one', async () => {
    const lifecyclePr = `https://github.com/${REPO}/pull/7`;
    const before = vi.fn<JobRunnerDeps['beforeOpenPullRequest']>(async () => ({ pr: lifecyclePr }));
    const fake = fakes({ beforeOpenPullRequest: before });
    await fake.reports.save(INSTALLATION, reportOf('node'));
    await fake.run(RUN, live());
    expect(before).toHaveBeenCalledWith({
      installationId: INSTALLATION,
      task: RUN.task,
      record: RECORD,
      repoDir: fake.dir(),
    });
    expect(fake.opener).not.toHaveBeenCalled();
    expect((await fake.reports.latest(REPO))?.items[0].pr).toBe(lifecyclePr);
  });

  it('a lifecycle that throws is logged, and the PR opens anyway', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = fakes({
      beforeOpenPullRequest: async () => {
        throw new Error('lifecycle broke');
      },
    });
    await fake.run(RUN, live());
    expect(fake.opener).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls.flat().join('\n')).toContain('lifecycle broke');
  });

  it('a notify that throws is logged and never fails the job', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = fakes({
      notifyRun: async () => {
        throw new Error('slack is down');
      },
    });
    await expect(fake.run(RUN, live())).resolves.toBeUndefined();
    expect(errors.mock.calls.flat().join('\n')).toContain('slack is down');
  });

  it('logs a failed record with its note', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = { ...RECORD, outcome: 'failed', note: 'run budget reached' };
    const fake = fakes({ runTasks: async () => [failed as RunRecord] });
    await fake.run(RUN, live());
    expect(errors).toHaveBeenCalledWith(`${REPO} ${RUN.task.id} failed: run budget reached`);
  });

  it('holds the job in the queue when its task is waiting on budget, with no notification', async () => {
    const notifyRun = vi.fn(async () => {});
    const waiting = { ...RECORD, outcome: 'waiting-budget', note: 'not attempted: $0.50 left' };
    const fake = fakes({ runTasks: async () => [waiting as RunRecord], notifyRun });
    await expect(fake.run(RUN, live())).rejects.toBeInstanceOf(HoldJobError);
    expect(notifyRun).not.toHaveBeenCalled();
  });

  it('fails the job when the run throws, and still deletes the checkout', async () => {
    const fake = fakes({
      runTasks: async () => {
        throw new Error('no run records');
      },
    });
    await expect(fake.run(RUN, live())).rejects.toThrow('no run records');
    expect(fake.calls.filter((call) => call.startsWith('notify'))).toEqual([]);
    expect(existsSync(fake.dir())).toBe(false);
  });
});

describe('cancellation', () => {
  it('does not clone when the job is already cancelled', async () => {
    const checkout = vi.fn<JobRunnerDeps['checkout']>();
    const fake = fakes({ checkout });
    await expect(fake.run(SCAN, AbortSignal.abort())).rejects.toBeInstanceOf(JobCancelledError);
    expect(checkout).not.toHaveBeenCalled();
  });

  it('deleting a repo mid-run removes the checkout at once and blocks the opener', async () => {
    const controller = new AbortController();
    let opened: Promise<string> | undefined;
    let dirGoneAtOnce = false;
    const fake = fakes({
      runTasks: async ({ dir, tasks, openPullRequest, signal }) => {
        expect(signal).toBe(controller.signal);
        controller.abort();
        await vi.waitFor(() => expect(existsSync(dir)).toBe(false));
        dirGoneAtOnce = true;
        opened = openPullRequest(tasks[0], RECORD, dir);
        await opened.catch(() => undefined);
        return [RECORD];
      },
    });
    await expect(fake.run(RUN, controller.signal)).rejects.toBeInstanceOf(JobCancelledError);
    expect(dirGoneAtOnce).toBe(true);
    await expect(opened).rejects.toBeInstanceOf(JobCancelledError);
    expect(fake.opener).not.toHaveBeenCalled();
  });

  it('blocks the opener when the repo is removed during the lifecycle call', async () => {
    const controller = new AbortController();
    const fake = fakes({
      beforeOpenPullRequest: async () => {
        controller.abort();
        return {};
      },
    });
    await expect(fake.run(RUN, controller.signal)).rejects.toBeInstanceOf(JobCancelledError);
    expect(fake.opener).not.toHaveBeenCalled();
  });

  it('reports the cancellation, not the error it caused in whatever read the checkout', async () => {
    const controller = new AbortController();
    const fake = fakes({
      scanRepo: async () => {
        controller.abort();
        throw new Error('ENOENT: the checkout vanished');
      },
    });
    await expect(fake.run(SCAN, controller.signal)).rejects.toBeInstanceOf(JobCancelledError);
  });

  it('removes its abort listener when the job ends', async () => {
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const fake = fakes();
    await fake.run(SCAN, controller.signal);
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
