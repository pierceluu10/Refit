import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inForceVersion, type DeadApiList } from '../dead-apis/list.ts';
import { utcDay } from '../dead-apis/proposals.ts';
import type { DeadScanReport } from '../inventory/dead-scan.ts';
import type { Finding, OpenPullRequest, RunRecord, RunRepoJob } from '../shared/types.ts';
import { messageOf } from './redact.ts';
import {
  decide,
  type RepoState,
  type ScanCause,
  type TriggerRecord,
  type TriggerStore,
} from './triggers.ts';
import type { InstallationTokens, UnderstandJob } from './types.ts';

export type JobRunnerDeps = {
  tokens: InstallationTokens;
  runRepoJob: RunRepoJob;
  checkout: (token: string, repo: string, dir: string) => Promise<void>;
  openPullRequestFor: (installationId: number) => OpenPullRequest;
  headTree: (token: string, repo: string) => Promise<string | undefined>;
  treeOfCheckout: (dir: string) => Promise<string>;
  scan: (dir: string, repo: string) => Promise<DeadScanReport>;
  loadList: () => DeadApiList;
  triggers: TriggerStore;
  scannerVersion: string;
  now?: () => Date;
  // What the run has spent. The loop's records leave out match, inventory and watcher spend; this saw it all.
  spentUsd?: () => number;
  // Tells evidence what this scan found. `at` is from before the clone.
  rescan: (job: UnderstandJob, findings: Finding[], at: string) => Promise<void>;
};

type Outcome = Omit<
  TriggerRecord,
  'at' | 'repo' | 'installationId' | 'trigger' | 'sha' | 'seconds'
>;

const UNSETTLED_CHECKS: ReadonlySet<string> = new Set(['failed', 'capped']);

// A finding is its entry in its file: an unrelated edit moves the line, and that isn't a new break.
const liveFindings = (report: DeadScanReport) => [
  ...new Set(
    report.details
      .filter((one) => one.matchClass === 'live')
      .map((one) => `${one.entryId}|${one.file}`),
  ),
];
const openFindings = (report: DeadScanReport) =>
  report.details.filter((one) => one.matchClass === 'live' || one.matchClass === 'unclear').length;

const VERDICTS: ReadonlySet<RunRecord['outcome']> = new Set(['verified', 'not-affected']);

// A PR or a real verdict on every change. No records, or a task that never got to run, isn't a try.
const hadItsTry = (records: RunRecord[]) =>
  records.some((record) => record.pr) ||
  (records.length > 0 && records.every((record) => VERDICTS.has(record.outcome)));

// One job. Everything that wakes a repo comes through here and gets the same decision: one GitHub call
// for the tree, then either a skip or a fresh checkout and a scan. Only a live finding no fix has been
// started for goes on to the loop. The app only reads the checkout; the harness runs repo code in its
// Docker sandbox.
export function createJobRunner(deps: JobRunnerDeps) {
  const now = deps.now ?? (() => new Date());

  // The scan and any fix, in one checkout. The state is saved even when the fix fails, because the scan
  // itself was fine. That failure comes back so the job still ends as failed, once it's on the record.
  // A fix that didn't get its try stays pending, so the next tick tries again.
  async function scanAndFix(
    job: UnderstandJob,
    token: string,
    why: ScanCause,
    previous: RepoState | undefined,
    listVersion: string,
    today: string,
  ): Promise<{ outcome: Outcome; failure?: unknown }> {
    const dir = await mkdtemp(join(tmpdir(), 'aptitude-checkout-'));
    const at = now().toISOString();
    try {
      await deps.checkout(token, job.repo, dir);
      // From the clone, not the earlier read: a push between the two must not pass as this scan's tree.
      const treeSha = await deps.treeOfCheckout(dir);
      const report = await deps.scan(dir, job.repo);
      // What only a newer scanner can see isn't a fix coming back. The next scan, on this scanner, tells.
      if (!previous || previous.scannerVersion === deps.scannerVersion) {
        try {
          await deps.rescan(job, report.findings, at);
        } catch (error) {
          // Learning from a rescan never stands between a repo and its fix.
          console.error(`rescan evidence for ${job.repo} failed: ${messageOf(error)}`);
        }
      }
      const live = liveFindings(report);
      const tried = why === 'manual' ? [] : (previous?.attempted ?? []);
      let fix: TriggerRecord['fix'];
      let failure: unknown;
      let fixCostUsd = 0;
      let fixPending = false;
      if (live.some((finding) => !tried.includes(finding))) {
        const spentBefore = deps.spentUsd?.() ?? 0;
        try {
          const records = await deps.runRepoJob({
            repo: job.repo,
            dir,
            openPullRequest: deps.openPullRequestFor(job.installationId),
          });
          fixCostUsd = records.reduce((sum, record) => sum + record.costUsd, 0);
          fixPending = !hadItsTry(records);
          fix = fixPending ? 'unfinished' : 'ran';
          const outcomes = records.map((record) => `${record.taskId} ${record.outcome}`);
          console.log(`ran ${job.repo}: ${outcomes.join(', ') || 'no provider changes'}`);
        } catch (error) {
          fix = 'failed';
          failure = error;
          fixPending = true;
        }
        // shortcut: a verdict learning during the fix counts here too, split the budget if that skews a repo.
        if (deps.spentUsd) fixCostUsd = deps.spentUsd() - spentBefore;
      } else if (live.length > 0) {
        fix = 'already-attempted';
      }
      const clean = report.clean;
      const findings = openFindings(report);
      const unlistedProviders = report.unlistedProviders;
      await deps.triggers.saveState(job.repo, {
        installationId: job.installationId,
        treeSha,
        listVersion,
        scannerVersion: deps.scannerVersion,
        scannedOn: today,
        clean,
        checkSettled: !UNSETTLED_CHECKS.has(report.check?.outcome ?? ''),
        findings,
        unlistedProviders,
        attempted: fixPending ? tried.filter((finding) => live.includes(finding)) : live,
        fixPending,
      });
      return {
        failure,
        outcome: {
          decision: 'scanned',
          why,
          treeSha,
          listVersion,
          clean,
          findings,
          unlistedProviders,
          ...(fix && { fix }),
          ...(failure ? { error: messageOf(failure) } : {}),
          costUsd: (report.check?.costUsd ?? 0) + fixCostUsd,
        },
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async function attempt(job: UnderstandJob): Promise<{ outcome: Outcome; failure?: unknown }> {
    const today = utcDay(now());
    const list = deps.loadList();
    const listVersion = inForceVersion(list, today);
    const stored = await deps.triggers.state(job.repo);
    // Another installation's scan says nothing about this one: a reinstall starts over.
    const state = stored?.installationId === job.installationId ? stored : undefined;
    const token = await deps.tokens.token(job.installationId);
    const tree = await deps.headTree(token, job.repo);
    if (tree === undefined) {
      return { outcome: { decision: 'skipped', why: 'empty-repo', listVersion, costUsd: 0 } };
    }
    const decision = decide(job.reason, state, tree, listVersion, deps.scannerVersion, list, today);
    if (decision.scan) return scanAndFix(job, token, decision.why, state, listVersion, today);
    const { clean, findings, unlistedProviders } = decision.state;
    return {
      outcome: {
        decision: 'skipped',
        why: decision.why,
        treeSha: tree,
        listVersion,
        clean,
        findings,
        unlistedProviders,
        costUsd: 0,
      },
    };
  }

  return async (job: UnderstandJob): Promise<void> => {
    const startedAt = performance.now();
    const removals = deps.triggers.removals(job.repo);
    const note = async (outcome: Outcome) => {
      await deps.triggers.append({
        at: now().toISOString(),
        repo: job.repo,
        installationId: job.installationId,
        trigger: job.reason,
        ...(job.sha && { sha: job.sha }),
        ...outcome,
        seconds: (performance.now() - startedAt) / 1000,
      });
      console.log(`${job.reason} ${job.repo}: ${outcome.decision} ${outcome.why}`);
      // Removed while this ran: what the job just saved mustn't bring the repo back.
      if (deps.triggers.removals(job.repo) !== removals) await deps.triggers.forget(job, now());
    };
    let result: Awaited<ReturnType<typeof attempt>>;
    try {
      result = await attempt(job);
    } catch (error) {
      // No state is written on this path, so nothing here can read as a clean scan and the next trigger tries again.
      await note({ decision: 'failed', why: 'error', error: messageOf(error), costUsd: 0 });
      throw error;
    }
    await note(result.outcome);
    if (result.failure) throw result.failure;
  };
}
