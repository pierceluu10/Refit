// What keeps Aptitude watching with nobody starting a run: the rule for whether a repo needs a scan,
// each repo's last scan, the append-only record of every trigger, and the daily clock.
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { shutdownsArrived, type DeadApiList } from '../dead-apis/list.ts';
import { readJsonOr, writeJson } from '../dead-apis/proposals.ts';
import { InvalidRepoError } from './git.ts';
import { GitHubApiError } from './github.ts';
import { REPO_PATTERN } from './types.ts';
import type { ForgetJob, InstallationTokens, JobQueue, UnderstandJob } from './types.ts';

const HOUR_MS = 60 * 60 * 1000;
// Shutdown dates are whole days, so a daily tick sees one on its day. It also catches a lost webhook.
export const CLOCK_INTERVAL_MS = 24 * HOUR_MS;
// Two missed ticks in a row: one can be a restart, two means something is wrong.
export const STALE_AFTER_HOURS = 48;

export type ScanCause =
  'first-scan' | 'tree-changed' | 'list-change' | 'shutdown-date' | 'check-retry' | 'manual';
export type SkipCause = 'unchanged-clean' | 'unchanged-dirty';

export type RepoState = {
  installationId: number;
  treeSha: string; // the tree the scan really read, taken from the checkout
  listVersion: string; // inForceVersion on the day of the scan
  scannedOn: string; // that day
  clean: boolean;
  checkSettled: boolean; // false when the AI check failed or was capped, so the scan is worth repeating
  findings: number; // live and unclear: the ones that keep a repo from being clean
  unlistedProviders: string[];
  attempted: string[]; // live findings a fix has already been started for
};

export type TriggerRecord = {
  at: string;
  repo: string;
  installationId: number;
  trigger: UnderstandJob['reason'] | 'removed';
  sha?: string; // the commit a push named. The decision goes by the branch as it is, never by this.
  decision: 'scanned' | 'skipped' | 'failed' | 'merged' | 'removed';
  why: ScanCause | SkipCause | 'empty-repo' | 'error' | 'job-already-waiting' | 'uninstalled';
  treeSha?: string;
  listVersion?: string;
  clean?: boolean;
  findings?: number;
  unlistedProviders?: string[];
  fix?: 'ran' | 'failed' | 'already-attempted';
  error?: string;
  seconds: number;
  costUsd: number;
};

export type Decision =
  { scan: true; why: ScanCause } | { scan: false; why: SkipCause; state: RepoState };

/** The whole skip rule. A not-clean repo with nothing new is skipped as well, and stays reported. */
export function decide(
  reason: UnderstandJob['reason'],
  state: RepoState | undefined,
  treeSha: string,
  listVersion: string,
  list: DeadApiList,
  today: string,
): Decision {
  if (reason === 'manual') return { scan: true, why: 'manual' };
  if (!state) return { scan: true, why: 'first-scan' };
  if (state.treeSha !== treeSha) return { scan: true, why: 'tree-changed' };
  if (state.listVersion !== listVersion) {
    const dated = shutdownsArrived(list, state.scannedOn, today).length > 0;
    return { scan: true, why: dated ? 'shutdown-date' : 'list-change' };
  }
  if (!state.checkSettled) return { scan: true, why: 'check-retry' };
  return { scan: false, why: state.clean ? 'unchanged-clean' : 'unchanged-dirty', state };
}

export type TriggerStore = ReturnType<typeof createTriggerStore>;

// One file per repo's state, so a manual run beside the server can only lose its own repo's update.
export function createTriggerStore(dir: string) {
  const logFile = path.join(dir, 'log.jsonl');
  const stateFile = (repo: string) => {
    if (!REPO_PATTERN.test(repo)) throw new InvalidRepoError(repo);
    return path.join(dir, 'repos', `${repo}.json`);
  };
  const append = async (record: TriggerRecord) => {
    await mkdir(dir, { recursive: true });
    await appendFile(logFile, `${JSON.stringify(record)}\n`);
  };
  return {
    append,
    state: (repo: string) => readJsonOr<RepoState | undefined>(stateFile(repo), undefined),
    saveState: (repo: string, state: RepoState) => writeJson(stateFile(repo), state),
    /** A removed repo stops being watched, so it must not read as a repo that went quiet. */
    async forget(job: ForgetJob, at: Date) {
      await rm(stateFile(job.repo), { force: true });
      await append({
        at: at.toISOString(),
        repo: job.repo,
        installationId: job.installationId,
        trigger: 'removed',
        decision: 'removed',
        why: 'uninstalled',
        seconds: 0,
        costUsd: 0,
      });
    },
    async merged(job: UnderstandJob, at: Date) {
      await append({
        at: at.toISOString(),
        repo: job.repo,
        installationId: job.installationId,
        trigger: job.reason,
        ...(job.sha && { sha: job.sha }),
        decision: 'merged',
        why: 'job-already-waiting',
        seconds: 0,
        costUsd: 0,
      });
    },
    // shortcut: reads the whole log per summary, rotate it once it's too big to read on demand.
    async records(): Promise<TriggerRecord[]> {
      const text = await readFile(logFile, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      return text.split('\n').flatMap((line) => {
        if (!line) return [];
        try {
          return [JSON.parse(line) as TriggerRecord];
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          // A crash mid-append tears one line. Losing that line beats losing the record.
          console.error(`trigger log: skipped an unreadable line: ${error.message}`);
          return [];
        }
      });
    },
  };
}

export type TickDeps = {
  listInstallations: () => Promise<number[]>;
  tokens: InstallationTokens;
  listRepos: (token: string) => Promise<string[]>;
  queue: JobQueue;
};

/** Queues a check of every installed repo. Each job then decides for itself whether to scan. */
export function createTick(deps: TickDeps) {
  return async (): Promise<void> => {
    for (const installationId of await deps.listInstallations()) {
      try {
        const repos = await deps.listRepos(await deps.tokens.token(installationId));
        for (const repo of repos) {
          await deps.queue.enqueue({ kind: 'understand', installationId, repo, reason: 'clock' });
        }
      } catch (error) {
        if (!(error instanceof GitHubApiError)) throw error;
        // One broken installation must not stop the rest. Its repos show up stale in the summary.
        console.error(`clock: installation ${installationId}: ${error.message}`);
      }
    }
  };
}

/** Ticks now and then on the interval, so a restart catches up on what it missed. Returns the stop. */
export function startClock(tick: () => Promise<void>, intervalMs = CLOCK_INTERVAL_MS): () => void {
  const fire = () =>
    tick().catch((error: Error) => console.error(`clock tick failed: ${error.message}`));
  void fire();
  const timer = setInterval(fire, intervalMs);
  return () => clearInterval(timer);
}

export type RepoStatus =
  'clean' | 'clean-unlisted-waiting' | 'not-clean' | 'not-scanned' | 'removed';

export type RepoSummary = {
  repo: string;
  status: RepoStatus;
  stale: boolean;
  lastCheckAt?: string; // a check that worked: a scan or a skip, never a failure
  hoursSinceCheck?: number;
  lastScanAt?: string;
  last: Pick<TriggerRecord, 'at' | 'trigger' | 'decision' | 'why' | 'error'>;
  findings: number;
  unlistedProviders: string[];
  fix?: TriggerRecord['fix'];
  scans: number;
  skips: number;
  failures: number;
  costUsd: number;
};

function statusOf(row: RepoSummary, clean: boolean | undefined): RepoStatus {
  if (row.last.decision === 'removed') return 'removed';
  if (clean === undefined) return 'not-scanned';
  if (!clean) return 'not-clean';
  return row.unlistedProviders.length > 0 ? 'clean-unlisted-waiting' : 'clean';
}

/**
 * Per repo, worst first: what "always watching" can honestly claim. A repo with no working check in
 * the window is stale whatever else it did, and a repo that never had a working check is stale too.
 */
export function summarizeTriggers(
  records: TriggerRecord[],
  now: Date,
  staleAfterHours = STALE_AFTER_HOURS,
): RepoSummary[] {
  const rows = new Map<string, RepoSummary>();
  const cleanOf = new Map<string, boolean | undefined>();
  for (const record of records) {
    const row: RepoSummary = rows.get(record.repo) ?? {
      repo: record.repo,
      status: 'not-scanned',
      stale: false,
      last: record,
      findings: 0,
      unlistedProviders: [],
      scans: 0,
      skips: 0,
      failures: 0,
      costUsd: 0,
    };
    rows.set(record.repo, row);
    row.last = {
      at: record.at,
      trigger: record.trigger,
      decision: record.decision,
      why: record.why,
      ...(record.error && { error: record.error }),
    };
    row.costUsd += record.costUsd;
    if (record.decision === 'failed') row.failures += 1;
    if (record.decision === 'scanned') {
      row.scans += 1;
      row.lastScanAt = record.at;
      row.fix = record.fix;
    }
    if (record.decision === 'skipped') row.skips += 1;
    if (record.decision === 'scanned' || record.decision === 'skipped') {
      row.lastCheckAt = record.at;
      if (record.clean !== undefined) cleanOf.set(record.repo, record.clean);
      row.findings = record.findings ?? 0;
      row.unlistedProviders = record.unlistedProviders ?? [];
    }
    // A removed repo that comes back starts over: nothing it said before describes it now.
    if (record.decision === 'removed') cleanOf.delete(record.repo);
  }
  for (const row of rows.values()) {
    row.status = statusOf(row, cleanOf.get(row.repo));
    if (row.lastCheckAt) {
      row.hoursSinceCheck = (now.getTime() - Date.parse(row.lastCheckAt)) / HOUR_MS;
    }
    row.stale =
      row.status !== 'removed' &&
      (row.hoursSinceCheck === undefined || row.hoursSinceCheck > staleAfterHours);
  }
  const rank = (row: RepoSummary) => (row.stale ? 0 : row.status === 'not-clean' ? 1 : 2);
  return [...rows.values()].sort((a, b) => rank(a) - rank(b) || a.repo.localeCompare(b.repo));
}
