// Uninstalling erases an org from every store. Each test seeds two orgs and checks the other survives.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JsonAuditStore } from '../compliance/audit.ts';
import type { MemoryRecipe, SelfEvalReport, StoredRun } from '../memory/types.ts';
import { JsonMemoryStore } from '../memory/store.ts';
import type { ExternalTask, ScanReport } from '../shared/types.ts';
import { createForget } from './forget.ts';
import { createJobRunner } from './jobs.ts';
import type { JobRunnerDeps } from './jobs.ts';
import { forgetNotified } from './notify/index.ts';
import { createFileQueue } from './queue.ts';
import { createReportStore } from './reports.ts';
import { createWeeklyScan } from './schedule.ts';
import { trackJobs } from './progress.ts';
import type { ForgetJob, QueuedJob } from './types.ts';

const INSTALLATION = 70000001;
const OTHER_INSTALLATION = 70000002;
const ACCOUNT = 'refit-example-org';
const GONE = `${ACCOUNT}/billing-api`;
const KEPT = 'other-example-org/storefront';
const UNINSTALL: ForgetJob = { kind: 'forget', installationId: INSTALLATION, account: ACCOUNT };

const task = (repo: string): ExternalTask =>
  ({ id: `${repo}:node-18`, repo, change: { id: 'node-18' } }) as unknown as ExternalTask;

const scanReport = (repo: string): ScanReport => ({
  repo,
  scannedAt: '2026-11-06T00:00:00Z',
  items: [],
  costUsd: 0,
  errors: [],
});

const run = (repo: string, transcriptPath = ''): StoredRun => ({
  id: `${repo}:node-18-abcd1234`,
  recordedAt: '2026-11-06T00:00:00Z',
  task: task(repo),
  record: {
    taskId: `${repo}:node-18`,
    outcome: 'needs-review',
    diff: 'illustrative diff',
    checks: [],
    costUsd: 0,
    transcriptPath,
    pr: `https://github.com/${repo}/pull/1`,
  },
  transcript: 'illustrative transcript',
  usedRecipeIds: [],
});

const recipe = (id: string, repos: string[], failedRunIds: string[] = []): MemoryRecipe =>
  ({
    id,
    provider: 'node',
    kind: 'other',
    preconditions: '',
    steps: '',
    pitfalls: '',
    sourceRuns: repos.map((repo) => `${repo}:node-18-abcd1234`),
    verifiedRepos: repos.length,
    diffSketch: '',
    repos,
    createdAt: '2026-11-06T00:00:00Z',
    updatedAt: '2026-11-06T00:00:00Z',
    failedRunIds,
  }) as MemoryRecipe;

let root: string;
const paths = () => ({
  memoryDir: join(root, 'memory'),
  auditDir: join(root, 'audit'),
  runLog: join(root, 'runs.jsonl'),
  scanReportDir: join(root, 'scan-reports'),
  notified: join(root, 'notified.json'),
  reportsDir: join(root, 'reports'),
});

function setup(settled: (id: number) => Promise<void> = async () => {}) {
  const { memoryDir, auditDir, runLog, scanReportDir, notified, reportsDir } = paths();
  const reports = createReportStore(reportsDir);
  const forget = createForget({
    reports,
    memoryDir,
    auditDir,
    runLog,
    scanReportDir,
    forgetNotified: (isForgotten) => forgetNotified(isForgotten, notified),
    settled,
  });
  return {
    reports,
    forget,
    memory: new JsonMemoryStore(memoryDir),
    audit: new JsonAuditStore(auditDir),
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'refit-forget-test-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('uninstall erases the org from', () => {
  it('reports, including a repo only linked by installation id', async () => {
    const { reports, forget } = setup();
    await reports.save(INSTALLATION, scanReport(GONE));
    await reports.save(INSTALLATION, scanReport('old-org-name/renamed'));
    await reports.save(OTHER_INSTALLATION, scanReport(KEPT));
    await forget(UNINSTALL);
    expect((await reports.list()).map((report) => report.repo)).toEqual([KEPT]);
  });

  it('run records and the temp folder holding each transcript', async () => {
    const { memory, forget } = setup();
    const folder = mkdtempSync(join(tmpdir(), 'refit-run-forget-test-'));
    writeFileSync(join(folder, 'transcript.jsonl'), 'illustrative');
    await memory.saveRun(run(GONE, join(folder, 'transcript.jsonl')));
    await memory.saveRun(run(KEPT));
    await forget(UNINSTALL);
    expect((await memory.listRuns()).map((item) => item.task.repo)).toEqual([KEPT]);
    expect(existsSync(folder)).toBe(false);
  });

  it('never deletes a transcript path outside the harness temp folders', async () => {
    const { memory, forget } = setup();
    const outside = join(root, 'keep-me', 'transcript.jsonl');
    mkdirSync(join(root, 'keep-me'));
    writeFileSync(outside, 'illustrative');
    await memory.saveRun(run(GONE, outside));
    await forget(UNINSTALL);
    expect(existsSync(outside)).toBe(true);
  });

  it('saved scans in memory', async () => {
    const { memory, forget } = setup();
    await memory.saveScan(scanReport(GONE));
    await memory.saveScan(scanReport(KEPT));
    await forget(UNINSTALL);
    expect((await memory.listScans()).map((scan) => scan.repo)).toEqual([KEPT]);
  });

  it('recipes: deletes one only it taught, strips it from one others taught', async () => {
    const { memory, forget } = setup();
    await memory.saveRecipe(recipe('only-gone', [GONE]));
    await memory.saveRecipe(recipe('shared', [GONE, KEPT], [`${GONE}:node-18-abcd1234`]));
    await memory.saveRecipe(recipe('only-kept', [KEPT]));
    await forget(UNINSTALL);
    const left = await memory.listRecipes();
    expect(left.map((item) => item.id).sort()).toEqual(['only-kept', 'shared']);
    const shared = left.find((item) => item.id === 'shared');
    expect(shared?.repos).toEqual([KEPT]);
    expect(shared?.sourceRuns).toEqual([`${KEPT}:node-18-abcd1234`]);
    expect(shared?.failedRunIds).toEqual([]);
    expect(JSON.stringify(left)).not.toContain(ACCOUNT);
  });

  it('self-evals and the fixed self-eval task list', async () => {
    const { memory, forget } = setup();
    const ids = [`${GONE}:node-18`, `${KEPT}:node-18`];
    await memory.setSelfEvalTaskIds(ids);
    await memory.saveSelfEval({
      id: 'eval-1',
      ranAt: '2026-11-06T00:00:00Z',
      taskIds: ids,
      results: ids.map((taskId) => ({ taskId, before: 'failed', after: 'verified' })),
      verifiedRateBefore: 0,
      verifiedRateAfter: 1,
      costUsd: 0,
      summary: '',
    } satisfies SelfEvalReport);
    await forget(UNINSTALL);
    expect(await memory.getSelfEvalTaskIds()).toEqual([`${KEPT}:node-18`]);
    const [report] = await memory.listSelfEvals();
    expect(report.taskIds).toEqual([`${KEPT}:node-18`]);
    expect(report.results.map((result) => result.taskId)).toEqual([`${KEPT}:node-18`]);
  });

  it('the audit trail', async () => {
    const { audit, forget } = setup();
    for (const repo of [GONE, KEPT]) {
      await audit.append({
        at: '2026-11-06T00:00:00Z',
        repo,
        changeId: 'node-18',
        action: 'detected',
        evidence: [],
        actor: 'refit',
      });
    }
    await forget(UNINSTALL);
    expect((await audit.list()).map((entry) => entry.repo)).toEqual([KEPT]);
    expect(readdirSync(paths().auditDir)).toHaveLength(1);
  });

  it('the orchestrator run log and report copies', async () => {
    const { runLog, scanReportDir } = paths();
    const { forget } = setup();
    const lines = [{ repo: GONE }, { repo: KEPT }].map((line) => JSON.stringify(line));
    writeFileSync(runLog, `${lines.join('\n')}\n{"repo":"torn`);
    mkdirSync(scanReportDir);
    writeFileSync(join(scanReportDir, 'a.json'), JSON.stringify(scanReport(GONE)));
    writeFileSync(join(scanReportDir, 'b.json'), JSON.stringify(scanReport(KEPT)));
    await forget(UNINSTALL);
    expect(readFileSync(runLog, 'utf8')).not.toContain(ACCOUNT);
    expect(readFileSync(runLog, 'utf8')).toContain(KEPT);
    expect(readdirSync(scanReportDir)).toEqual(['b.json']);
  });

  it('the record of what Slack was told', async () => {
    const { notified } = paths();
    const { forget } = setup();
    const keys = [
      `https://github.com/${GONE}/pull/1`,
      JSON.stringify([GONE, 'node-18', 'node']),
      `https://github.com/${KEPT}/pull/1`,
      JSON.stringify([KEPT, 'node-18', 'node']),
    ];
    writeFileSync(notified, JSON.stringify(keys));
    await forget(UNINSTALL);
    expect(JSON.parse(readFileSync(notified, 'utf8'))).toEqual(keys.slice(2));
  });

  it('matches the owner in any case', async () => {
    const { memory, forget } = setup();
    await memory.saveRun(run('Refit-Example-Org/Billing-Api'));
    await forget(UNINSTALL);
    expect(await memory.listRuns()).toEqual([]);
  });

  it('never matches a longer owner that starts the same', async () => {
    const { memory, forget } = setup();
    await memory.saveRun(run(`${ACCOUNT}-two/app`));
    await forget(UNINSTALL);
    expect(await memory.listRuns()).toHaveLength(1);
  });

  it('erases what a stopping job writes after the first pass', async () => {
    let release = () => {};
    const stopped = new Promise<void>((resolve) => (release = resolve));
    const { memory, forget } = setup(() => stopped);
    const erasing = forget(UNINSTALL);
    await vi.waitFor(() => expect(existsSync(paths().memoryDir)).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await memory.saveRun(run(GONE));
    release();
    await erasing;
    expect(await memory.listRuns()).toEqual([]);
  });

  it('rejects when a store cannot be read, so the delivery can be redelivered', async () => {
    const { memory, forget } = setup();
    await memory.saveRun(run(GONE));
    writeFileSync(join(paths().memoryDir, 'runs', 'corrupt.json'), '{');
    await expect(forget(UNINSTALL)).rejects.toBeInstanceOf(SyntaxError);
  });
});

describe('removing one repo', () => {
  it('drops only its report and leaves memory and audit alone', async () => {
    const { reports, memory, forget } = setup();
    await reports.save(INSTALLATION, scanReport(GONE));
    await memory.saveRun(run(GONE));
    await forget({ kind: 'forget', installationId: INSTALLATION, repo: GONE });
    expect(await reports.list()).toEqual([]);
    expect(await memory.listRuns()).toHaveLength(1);
  });
});

describe('uninstall through the real queue and job runner', () => {
  it('drops the queue entries, deletes a running checkout and leaves no failed report', async () => {
    const { reports, forget } = setup();
    const queueFile = join(root, 'queue.json');
    let checkoutDir = '';
    let scanning = () => {};
    const started = new Promise<void>((resolve) => (scanning = resolve));
    let abort = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error('the checkout was deleted'));
    });
    const runner = createJobRunner({
      tokens: { token: async () => 'ghs_test_installation_token' },
      checkout: async (_token: string, _repo: string, dir: string) => void (checkoutDir = dir),
      readSettings: async () => ({ paused: false, ignore: [], errors: [] }),
      scanRepo: () => {
        scanning();
        return aborted;
      },
    } as unknown as JobRunnerDeps);
    const jobs = trackJobs(async (job: QueuedJob, signal: AbortSignal) => {
      signal.addEventListener('abort', abort, { once: true });
      await runner(job, signal);
    }, reports);
    const queue = await createFileQueue(queueFile, jobs.run, {
      concurrency: 1,
      retries: 0,
      onForget: forget,
    });
    const scan = { kind: 'scan', installationId: INSTALLATION, reason: 'install' } as const;
    await queue.enqueue({ ...scan, repo: GONE });
    await queue.enqueue({ ...scan, repo: `${ACCOUNT}/waiting` });
    await started;
    expect(existsSync(checkoutDir)).toBe(true);
    expect(queue.pending()).toHaveLength(2);

    await queue.enqueue(UNINSTALL);
    await queue.idle();
    queue.close();

    expect(queue.pending()).toEqual([]);
    expect(JSON.parse(readFileSync(queueFile, 'utf8'))).toEqual([]);
    expect(existsSync(checkoutDir)).toBe(false);
    expect(await reports.list()).toEqual([]);
  });
});

describe('the schedule', () => {
  it('holds no org data and never re-scans an uninstalled org', async () => {
    const stateFile = join(root, 'schedule.json');
    const enqueue = vi.fn(async () => {});
    const weekly = createWeeklyScan({
      stateFile,
      listInstallations: async () => [{ id: OTHER_INSTALLATION, suspended: false }],
      listRepos: async () => [KEPT],
      enqueue,
    });
    await weekly.sweep();
    expect(enqueue.mock.calls.flat()).toEqual([
      { kind: 'scan', installationId: OTHER_INSTALLATION, repo: KEPT, reason: 'schedule' },
    ]);
    expect(Object.keys(JSON.parse(readFileSync(stateFile, 'utf8')))).toEqual(['lastSweepAt']);
  });
});
