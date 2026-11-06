import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BehindItem,
  ExternalChange,
  ExternalTask,
  RunRecord,
  ScanRepo,
} from '../shared/types.ts';
import type { ExistingPullRequest } from './pr.ts';
import type { ReportStore } from './reports.ts';
import type { RepoSettings } from './settings.ts';
import type {
  AppJob,
  BeforeOpenPullRequest,
  InstallationTokens,
  NotifyRun,
  OpenAnyPullRequest,
  QueuedJob,
  RunJob,
  RunTasks,
  ScanJob,
} from './types.ts';

export class JobCancelledError extends Error {
  constructor(repo: string) {
    super(`Refit was removed from ${repo}, so its job stopped`);
    this.name = 'JobCancelledError';
  }
}

export type JobRunnerDeps = {
  tokens: InstallationTokens;
  checkout: (token: string, repo: string, dir: string) => Promise<void>;
  scanRepo: ScanRepo;
  runTasks: RunTasks;
  openPullRequestFor: (installationId: number) => OpenAnyPullRequest;
  findPullRequest: (
    installationId: number,
    task: ExternalTask,
  ) => Promise<ExistingPullRequest | undefined>;
  beforeOpenPullRequest: BeforeOpenPullRequest;
  notifyRun: NotifyRun;
  readSettings: (dir: string) => Promise<RepoSettings>;
  isIgnored: (settings: RepoSettings, change: ExternalChange) => boolean;
  reports: ReportStore;
  enqueue: (job: AppJob) => Promise<void>;
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

// For the steps after the real work: a failure here is logged, since retrying would pay for the work again.
async function logged<T>(label: string, step: () => Promise<T>): Promise<T | undefined> {
  try {
    return await step();
  } catch (error) {
    console.error(`${label} failed: ${messageOf(error)}`);
    return undefined;
  }
}

function stopIfCancelled(repo: string, signal: AbortSignal) {
  if (signal.aborted) throw new JobCancelledError(repo);
}

const statusFor = (existing: ExistingPullRequest): BehindItem['status'] => {
  if (existing.state === 'open') return 'pr-open';
  return existing.state === 'merged' ? 'merged' : 'open';
};

function logRecord(repo: string, record: RunRecord & { note?: string }) {
  const line = `${repo} ${record.taskId} ${record.outcome}${record.note ? `: ${record.note}` : ''}`;
  if (record.outcome === 'failed') console.error(line);
  else console.log(line);
}

// One job: a fresh checkout, the work on it, then the checkout is deleted. The app only reads the
// checkout; the orchestrator's harness runs repo code in its Docker sandbox.
export function createJobRunner(deps: JobRunnerDeps) {
  async function scan(job: ScanJob, dir: string, signal: AbortSignal) {
    const settings = await deps.readSettings(dir);
    if (settings.paused) {
      console.log(`scan ${job.repo}: paused by its .refit.yml`);
      return;
    }
    const { report, tasks } = await deps.scanRepo(job.repo, dir);
    const items = report.items.filter((item) => !deps.isIgnored(settings, item.change));
    const toRun: ExternalTask[] = [];
    for (const task of tasks) {
      if (deps.isIgnored(settings, task.change)) continue;
      // A lookup that fails must not lose the task, so it runs; the opener still finds an open PR.
      const existing = await logged(`looking up the PR for ${task.id}`, () =>
        deps.findPullRequest(job.installationId, task),
      );
      // A task with a PR has ended, and a closed one was a person's decision, so no new run is paid for.
      if (!existing) {
        toRun.push(task);
        continue;
      }
      for (const item of items) {
        if (item.change.id !== task.change.id) continue;
        item.status = statusFor(existing);
        item.pr = existing.url;
      }
    }
    stopIfCancelled(job.repo, signal);
    await deps.reports.save(job.installationId, {
      ...report,
      items,
      errors: [...report.errors, ...settings.errors],
    });
    for (const task of toRun) {
      stopIfCancelled(job.repo, signal);
      await deps.enqueue({
        kind: 'run',
        installationId: job.installationId,
        repo: job.repo,
        task,
      });
    }
    console.log(`scanned ${job.repo}: ${items.length} item(s), ${toRun.length} task(s) queued`);
  }

  async function run(job: RunJob, dir: string, signal: AbortSignal) {
    const settings = await deps.readSettings(dir);
    if (settings.paused || deps.isIgnored(settings, job.task.change)) {
      console.log(`run ${job.task.id}: stopped by the .refit.yml of ${job.repo}`);
      return;
    }
    const openPullRequest: OpenAnyPullRequest = async (task, record, repoDir) => {
      stopIfCancelled(job.repo, signal);
      const before = await logged(`PR lifecycle for ${task.id}`, () =>
        deps.beforeOpenPullRequest({
          installationId: job.installationId,
          task,
          record,
          repoDir,
        }),
      );
      if (before?.pr) return before.pr;
      stopIfCancelled(job.repo, signal);
      return deps.openPullRequestFor(job.installationId)(task, record, repoDir);
    };
    const records = await deps.runTasks({
      repo: job.repo,
      dir,
      tasks: [job.task],
      openPullRequest,
      signal,
    });
    stopIfCancelled(job.repo, signal);
    for (const record of records) logRecord(job.repo, record);
    for (const { pr } of records) {
      if (!pr) continue;
      await logged(`recording ${pr} on the report of ${job.repo}`, () =>
        deps.reports.markPullRequest(job.repo, job.task.change.id, pr),
      );
    }
    await logged(`notifying about ${job.repo}`, async () =>
      deps.notifyRun({
        installationId: job.installationId,
        repo: job.repo,
        records,
        report: await deps.reports.latest(job.repo),
      }),
    );
  }

  return async (job: QueuedJob, signal: AbortSignal): Promise<void> => {
    stopIfCancelled(job.repo, signal);
    const dir = await mkdtemp(join(tmpdir(), 'refit-checkout-'));
    const remove = () => rm(dir, { recursive: true, force: true });
    const stopOnAbort = () => {
      remove().catch((error: unknown) =>
        console.error(`deleting the checkout of ${job.repo} failed: ${messageOf(error)}`),
      );
    };
    signal.addEventListener('abort', stopOnAbort, { once: true });
    try {
      await deps.checkout(await deps.tokens.token(job.installationId), job.repo, dir);
      stopIfCancelled(job.repo, signal);
      if (job.kind === 'scan') await scan(job, dir, signal);
      else await run(job, dir, signal);
    } catch (error) {
      // Deleting the checkout makes whatever was reading it fail; the cause is the cancellation.
      stopIfCancelled(job.repo, signal);
      throw error;
    } finally {
      signal.removeEventListener('abort', stopOnAbort);
      await remove();
    }
  };
}
