import {
  DEFAULT_LEAD_DAYS,
  dueDeadlineAlerts,
  syncDeadlineAlert,
  timing,
} from './deadline-alerts.ts';
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
// Status lists at most this many upcoming deadlines per installation, soonest first.
const STATUS_DEADLINES = 50;

type InventoryStore = Awaited<ReturnType<typeof openInventoryStore>>;
type MonitoringStore = Awaited<ReturnType<typeof openMonitoringStore>>;

export interface HostedAlerts {
  leadDays: readonly number[];
}

// REFIT_HOSTED_ALERTS=1 turns monitoring on with the default 90, 30 and 7 day lead times.
export function hostedAlerts(environment: NodeJS.ProcessEnv): HostedAlerts | null {
  const value = environment.REFIT_HOSTED_ALERTS;
  if (value === undefined || value === '' || value === '0') return null;
  if (value !== '1') throw new PipelineInputError('REFIT_HOSTED_ALERTS must be 1, 0 or unset.');
  return { leadDays: DEFAULT_LEAD_DAYS };
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
// failed or interrupted write is not retried until the next stage.
export async function sendDeadlineAlerts(options: {
  app: GitHubAppConfiguration;
  monitoring: MonitoringStore;
  registry: DeadlineRegistry;
  now: Date;
  leadDays: readonly number[];
  signal: AbortSignal;
  onProgress?: (message: string) => void;
}) {
  const { monitoring, now, leadDays } = options;
  let sent = 0;
  for (const repository of await monitoring.repositories()) {
    if (options.signal.aborted) break;
    const progress = (message: string) =>
      options.onProgress?.(`[alerts ${repository.repository}] ${message}`);
    const due = dueDeadlineAlerts({
      exposures: current(repository, now),
      ignores: ignores(repository),
      registry: options.registry,
      now,
      leadDays,
      sent: (deadline) => repository.alerts.find((alert) => alert.deadline === deadline)?.stage,
    });
    if (!due.length) continue;
    let token: string;
    try {
      ({ token } = await authenticateGitHubIssues(options.app, repository.repository));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      // Nothing was taken, so the next pass tries again.
      progress(`GitHub issue access failed: ${error.name}: ${error.message}`);
      continue;
    }
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
          request: (method, path, body) => requestGitHub(token, method, path, body),
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
