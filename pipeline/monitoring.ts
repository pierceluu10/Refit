import {
  DEFAULT_LEAD_DAYS,
  deadlineTitle,
  dueDeadlineAlerts,
  syncDeadlineAlert,
  syncDeadlineIssue,
  timing,
} from './deadline-alerts.ts';
import type { ReportedExposure } from './deadline-exposure.ts';
import { applyDeadlineIgnores } from './deadline-ignores.ts';
import { daysUntil, type DeadlineRegistry } from './deadline-registry.ts';
import { authenticateGitHubIssues, type GitHubAppConfiguration } from './github-app.ts';
import { requestGitHub } from './github.ts';
import type { openInventoryStore } from './inventory-store.ts';
import { registryDigest } from './inventory.ts';
import type { MonitoredRepository, openMonitoringStore } from './monitoring-store.ts';
import { PipelineInputError } from './types.ts';

// A push, a registry change or an inventory this old asks for a new one, at most once per debounce.
export const RESCAN_AGE_HOURS = 24;
export const RESCAN_DEBOUNCE_MINUTES = 10;
// Status and the digest list at most this many deadlines, soonest first.
const STATUS_DEADLINES = 50;
const DIGEST_DEADLINES = 50;
export const DIGEST_INTERVAL_DAYS = 7;
const DIGEST_MARKER = '<!-- refit-deadline-digest -->';
const DIGEST_TITLE = 'Refit weekly digest: deadlines this repository depends on';
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

type InventoryStore = Awaited<ReturnType<typeof openInventoryStore>>;
type MonitoringStore = Awaited<ReturnType<typeof openMonitoringStore>>;

export interface HostedAlerts {
  leadDays: readonly number[];
  // A weekly issue per repository listing every exposed deadline, off by default.
  digest?: boolean;
}

// A switch read from the environment: 1 is on; 0, empty or unset is off; anything else is an error.
export function environmentFlag(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name];
  if (value === undefined || value === '' || value === '0') return false;
  if (value !== '1') throw new PipelineInputError(`${name} must be 1, 0 or unset.`);
  return true;
}

// REFIT_HOSTED_ALERTS=1 turns monitoring on with the default 90, 30 and 7 day lead times;
// REFIT_HOSTED_ALERT_DIGEST=1 adds the weekly digest.
export function hostedAlerts(environment: NodeJS.ProcessEnv): HostedAlerts | null {
  const digest = environmentFlag(environment, 'REFIT_HOSTED_ALERT_DIGEST');
  if (!environmentFlag(environment, 'REFIT_HOSTED_ALERTS')) {
    if (digest)
      throw new PipelineInputError('REFIT_HOSTED_ALERT_DIGEST requires REFIT_HOSTED_ALERTS=1.');
    return null;
  }
  return { leadDays: DEFAULT_LEAD_DAYS, digest };
}

// Stored exposures carry the days left when they were scanned; each pass counts again from now.
function current(repository: MonitoredRepository, now: Date) {
  return repository.exposures.map((exposure) => ({
    ...exposure,
    days: daysUntil(exposure.deadline.date, now),
  }));
}

// An invalid committed ignore file accepts nothing.
const ignores = (repository: MonitoredRepository) =>
  repository.ignores.error ? [] : repository.ignores.entries;

const cell = (value: string) => value.replaceAll('|', '\\|').replaceAll('`', "'");

// Every exposed deadline, soonest first, with its ignore or the alert issue opened for it.
function digestBody(options: {
  repository: MonitoredRepository;
  exposures: ReportedExposure[];
  issues: (deadline: string) => number | null | undefined;
  now: Date;
  leadDays: readonly number[];
}) {
  const { repository, exposures, now } = options;
  const { decisions } = applyDeadlineIgnores(
    exposures,
    ignores(repository),
    new Set(exposures.map((exposure) => exposure.deadline.id)),
    now,
  );
  const sorted = [...exposures].sort((a, b) => a.days - b.days);
  const rows = sorted.slice(0, DIGEST_DEADLINES).map((exposure) => {
    const [first] = exposure.evidence;
    const others = exposure.evidence.length - 1 + exposure.more;
    const until = decisions
      .get(exposure.deadline.id)
      ?.ignoredBy.map((entry) => entry.until)
      .sort()[0];
    const issue = options.issues(exposure.deadline.id);
    return [
      cell(deadlineTitle(exposure)),
      exposure.deadline.date,
      timing(exposure.days),
      first
        ? `\`${cell(`${first.file}:${first.line}`)}\`${others > 0 ? ` and ${others} more` : ''}`
        : '',
      until ? `Ignored until ${until}` : issue ? `#${issue}` : 'Not yet alerted',
    ].join(' | ');
  });
  const revision = repository.revision ? ` at commit \`${repository.revision.slice(0, 12)}\`` : '';
  return [
    DIGEST_MARKER,
    `**Deadlines this repository depends on**, as of ${now.toISOString().slice(0, 10)}${revision}.`,
    '',
    ...(rows.length
      ? [
          '| Deadline | Date | When | Evidence | Alert |',
          '|---|---|---|---|---|',
          ...rows.map((row) => `| ${row} |`),
          ...(sorted.length > rows.length
            ? ['', `…and ${sorted.length - rows.length} more deadlines.`]
            : []),
        ]
      : ["Refit found no exposed deadlines in this repository's latest inventory."]),
    '',
    `Refit updates this digest every ${DIGEST_INTERVAL_DAYS} days. It opens a separate issue for each deadline ${options.leadDays.join(', ')} days before it and when it passes, and never changes code.`,
  ].join('\n');
}

function digestComment(exposures: ReportedExposure[]) {
  const [soonest] = [...exposures].sort((a, b) => a.days - b.days);
  return soonest
    ? `Weekly digest: ${exposures.length} exposed ${exposures.length === 1 ? 'deadline' : 'deadlines'}, the soonest on ${soonest.deadline.date} (${timing(soonest.days)}).`
    : 'Weekly digest: no exposed deadlines.';
}

// Queues a new inventory for each repository a trigger made due.
export async function requestRescans(options: {
  monitoring: MonitoringStore;
  inventories: InventoryStore;
  registry: DeadlineRegistry;
  now: Date;
}) {
  const due = await options.monitoring.due(
    options.now,
    registryDigest(options.registry),
    RESCAN_DEBOUNCE_MINUTES,
    RESCAN_AGE_HOURS,
  );
  for (const item of due) await options.inventories.request(item.installationId, [item.repository]);
  await options.monitoring.rescanned(due, options.now);
  return due;
}

// Opens or updates one issue per repository and deadline when it reaches a lead time, from stored
// inventories only. A stage is taken before its issue is written, so it is sent at most once; a
// failed or interrupted write is not retried until the next stage. With `digest`, each repository
// with an exposure (or an earlier digest) also gets its weekly digest issue, taken the same way.
// Returns the number of deadline alerts sent.
export async function sendDeadlineAlerts(options: {
  app: GitHubAppConfiguration;
  monitoring: MonitoringStore;
  registry: DeadlineRegistry;
  now: Date;
  leadDays: readonly number[];
  digest?: boolean;
  signal: AbortSignal;
  onProgress?: (message: string) => void;
}) {
  const { monitoring, now, leadDays } = options;
  let sent = 0;
  for (const repository of await monitoring.repositories()) {
    if (options.signal.aborted) break;
    const progress = (message: string) =>
      options.onProgress?.(`[alerts ${repository.repository}] ${message}`);
    const exposures = current(repository, now);
    const due = dueDeadlineAlerts({
      exposures,
      ignores: ignores(repository),
      registry: options.registry,
      now,
      leadDays,
      sent: (deadline) => repository.alerts.find((alert) => alert.deadline === deadline)?.stage,
    });
    const digestDue =
      options.digest &&
      (exposures.length > 0 || repository.digest.issue !== null) &&
      (!repository.digest.at ||
        now.getTime() - repository.digest.at.getTime() >=
          DIGEST_INTERVAL_DAYS * MILLISECONDS_PER_DAY);
    if (!due.length && !digestDue) continue;
    let token: string;
    try {
      ({ token } = await authenticateGitHubIssues(options.app, repository.repository));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      // Nothing was taken, so the next pass tries again.
      progress(`GitHub issue access failed: ${error.name}: ${error.message}`);
      continue;
    }
    const request = (method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) =>
      requestGitHub(token, method, path, body);
    const opened = new Map<string, number>();
    for (const { exposure, stage } of due) {
      if (options.signal.aborted) break;
      const { id } = exposure.deadline;
      const claimed = await monitoring.claim(
        repository.installationId,
        repository.repository,
        id,
        stage,
        now,
      );
      if (!claimed) continue;
      try {
        const result = await syncDeadlineAlert({
          request,
          repository: repository.repository,
          issue: claimed.issue,
          exposure,
          revision: repository.revision,
          integrations: repository.integrations,
          leadDays,
        });
        await monitoring.record(repository.installationId, repository.repository, id, stage, {
          issue: result.issue,
          status: result.action,
          message: null,
        });
        sent++;
        opened.set(id, result.issue);
        progress(
          `Deadline ${id}: issue #${result.issue} ${result.action} (${timing(exposure.days)}).`,
        );
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        await monitoring.record(repository.installationId, repository.repository, id, stage, {
          issue: claimed.issue,
          status: 'failed',
          message: `${error.name}: ${error.message}`,
        });
        progress(`Deadline ${id}: ${error.name}: ${error.message}`);
      }
    }
    if (!digestDue || options.signal.aborted) continue;
    const claimed = await monitoring.claimDigest(
      repository.installationId,
      repository.repository,
      now,
      DIGEST_INTERVAL_DAYS,
    );
    if (!claimed) continue;
    try {
      const result = await syncDeadlineIssue({
        request,
        repository: repository.repository,
        issue: claimed.issue,
        title: DIGEST_TITLE,
        body: digestBody({
          repository,
          exposures,
          issues: (deadline) =>
            opened.get(deadline) ??
            repository.alerts.find((alert) => alert.deadline === deadline)?.issue,
          now,
          leadDays,
        }),
        comment: digestComment(exposures),
      });
      await monitoring.recordDigest(repository.installationId, repository.repository, result.issue);
      progress(`Digest: issue #${result.issue} ${result.action}.`);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      // The week stays taken, so a failed digest waits for the next one.
      progress(`Digest: ${error.name}: ${error.message}`);
    }
  }
  return sent;
}

// Exposed deadlines per installation, soonest first, with the alert sent for each.
export async function upcomingDeadlines(monitoring: MonitoringStore, now: Date) {
  const installations = new Map<
    number,
    {
      installationId: number;
      owner: string;
      deadlines: {
        repository: string;
        deadline: string;
        date: string;
        days: number;
        ignored: boolean;
        alert: { stage: number; issue: number | null; status: string } | null;
      }[];
      more: number;
    }
  >();
  for (const repository of await monitoring.repositories()) {
    const exposures = current(repository, now);
    const { decisions } = applyDeadlineIgnores(
      exposures,
      ignores(repository),
      new Set(exposures.map((exposure) => exposure.deadline.id)),
      now,
    );
    const installation = installations.get(repository.installationId) ?? {
      installationId: repository.installationId,
      owner: repository.owner,
      deadlines: [],
      more: 0,
    };
    installations.set(repository.installationId, installation);
    for (const exposure of exposures) {
      const alert = repository.alerts.find((item) => item.deadline === exposure.deadline.id);
      installation.deadlines.push({
        repository: repository.repository,
        deadline: exposure.deadline.id,
        date: exposure.deadline.date,
        days: exposure.days,
        ignored: Boolean(decisions.get(exposure.deadline.id)?.ignoredBy.length),
        alert: alert ? { stage: alert.stage, issue: alert.issue, status: alert.status } : null,
      });
    }
  }
  return [...installations.values()].map((installation) => {
    const deadlines = installation.deadlines.sort(
      (a, b) => a.days - b.days || a.repository.localeCompare(b.repository),
    );
    return {
      ...installation,
      deadlines: deadlines.slice(0, STATUS_DEADLINES),
      more: Math.max(0, deadlines.length - STATUS_DEADLINES),
    };
  });
}
