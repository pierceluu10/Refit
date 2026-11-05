import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inForceVersion, type DeadApiList } from '../dead-apis/list.ts';
import { utcDay } from '../dead-apis/proposals.ts';
import { redactSecrets } from '../harness/secrets.ts';
import type { DeadScanReport } from '../inventory/dead-scan.ts';
import type { OpenPullRequest, RunRepoJob } from '../shared/types.ts';
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
  now?: () => Date;
};

type Outcome = Omit<
  TriggerRecord,
  'at' | 'repo' | 'installationId' | 'trigger' | 'sha' | 'seconds'
>;

const UNSETTLED_CHECKS: ReadonlySet<string> = new Set(['failed', 'capped']);
const messageOf = (error: unknown) =>
  redactSecrets(error instanceof Error ? error.message : String(error));

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

// One job. Everything that wakes a repo comes through here and gets the same decision: one GitHub call
// for the tree, then either a skip or a fresh checkout and a scan. Only a live finding no fix has been
// started for goes on to the loop. The app only reads the checkout; the harness runs repo code in its
// Docker sandbox.
export function createJobRunner(deps: JobRunnerDeps) {
  const now = deps.now ?? (() => new Date());

  // The scan and any fix, in one checkout. The state is saved even when the fix fails, because the scan
  // itself was fine. That failure comes back so the job still ends as failed, once it's on the record.
  async function scanAndFix(
    job: UnderstandJob,
    token: string,
    why: ScanCause,
    previous: RepoState | undefined,
    listVersion: string,
    today: string,
  ): Promise<{ outcome: Outcome; failure?: unknown }> {
    const dir = await mkdtemp(join(tmpdir(), 'aptitude-checkout-'));
    try {
      await deps.checkout(token, job.repo, dir);
      // From the clone, not the earlier read: a push between the two must not pass as this scan's tree.
      const treeSha = await deps.treeOfCheckout(dir);
      const report = await deps.scan(dir, job.repo);
      const live = liveFindings(report);
      const tried = why === 'manual' ? [] : (previous?.attempted ?? []);
      let fix: TriggerRecord['fix'];
      let failure: unknown;
      let fixCostUsd = 0;
      if (live.some((finding) => !tried.includes(finding))) {
        try {
          const records = await deps.runRepoJob({
            repo: job.repo,
            dir,
            openPullRequest: deps.openPullRequestFor(job.installationId),
          });
          fixCostUsd = records.reduce((sum, record) => sum + record.costUsd, 0);
          fix = 'ran';
          const outcomes = records.map((record) => `${record.taskId} ${record.outcome}`);
          console.log(`ran ${job.repo}: ${outcomes.join(', ') || 'no provider changes'}`);
        } catch (error) {
          fix = 'failed';
          failure = error;
        }
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
        scannedOn: today,
        clean,
        checkSettled: !UNSETTLED_CHECKS.has(report.check?.outcome ?? ''),
        findings,
        unlistedProviders,
        // A fix that failed hasn't had its try: the next real change gets one, the next tick doesn't.
        attempted: failure ? tried : live,
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
    const state = await deps.triggers.state(job.repo);
    const token = await deps.tokens.token(job.installationId);
    const tree = await deps.headTree(token, job.repo);
    if (tree === undefined) {
      return { outcome: { decision: 'skipped', why: 'empty-repo', listVersion, costUsd: 0 } };
    }
    const decision = decide(job.reason, state, tree, listVersion, list, today);
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
