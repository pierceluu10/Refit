import { syncDeadlineIssue, type DeadlineRequest } from './deadline-alerts.ts';
import type { DeadlineRegistry } from './deadline-registry.ts';
import { authenticateGitHubIssues, type GitHubAppConfiguration } from './github-app.ts';
import { requestGitHub } from './github.ts';
import { environmentFlag } from './monitoring.ts';
import type { openReportStore, ReportedRepository } from './report-store.ts';
import { buildReport, renderReport, REPORT_MARKER, reportDigest } from './report.ts';
import { isObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';

const REPORT_TITLE = 'Refit report: what this repository depends on';
// A write that failed or never finished is tried again after this long, not on every pass.
export const REPORT_RETRY_HOURS = 24;
const ISSUE_PAGE = 100;
const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;

type ReportStore = Awaited<ReturnType<typeof openReportStore>>;

// REFIT_HOSTED_REPORTS=1 keeps one report issue per inventoried repository; off by default.
export function hostedReports(environment: NodeJS.ProcessEnv) {
  return environmentFlag(environment, 'REFIT_HOSTED_REPORTS');
}

// Whether the issue already shows this digest, or a write of it failed too recently to try again.
// The store's claim decides; this only avoids asking GitHub for a token on every pass.
function settled(stored: ReportedRepository['report'], digest: string, now: Date) {
  if (!stored || stored.digest !== digest) return false;
  if (stored.status === 'opened' || stored.status === 'updated') return true;
  return now.getTime() - stored.updatedAt.getTime() < REPORT_RETRY_HOURS * MILLISECONDS_PER_HOUR;
}

// The report issue the App opened before, found by its marker, so a lost record or a reinstall
// keeps one issue per repository. shortcut: reads one page of the App's issues; page further if a
// repository holds more than 100 issues opened by Refit.
async function existingReport(request: DeadlineRequest, repository: string, login: string) {
  const issues = await request(
    'GET',
    `/repos/${repository}/issues?state=all&creator=${encodeURIComponent(login)}&per_page=${ISSUE_PAGE}`,
  );
  if (!Array.isArray(issues)) throw new PipelineInputError('GitHub did not return the issue list.');
  const found = issues.find(
    (issue) =>
      isObject(issue) &&
      !issue.pull_request &&
      typeof issue.body === 'string' &&
      issue.body.startsWith(REPORT_MARKER) &&
      Number.isSafeInteger(issue.number),
  );
  return found ? Number(found.number) : null;
}

// Opens or updates the report issue of every inventoried repository whose report changed. The
// write is taken in PostgreSQL first, so each change is written once across workers and restarts.
export async function syncReportIssues(options: {
  app: GitHubAppConfiguration;
  reports: ReportStore;
  registry: DeadlineRegistry;
  now: Date;
  signal: AbortSignal;
  onProgress?: (message: string) => void;
}) {
  const { reports, now } = options;
  let written = 0;
  for (const repository of await reports.repositories()) {
    if (options.signal.aborted) break;
    const progress = (message: string) =>
      options.onProgress?.(`[report ${repository.repository}] ${message}`);
    const report = buildReport({
      inventory: repository.inventory,
      registry: options.registry,
      repository: repository.repository,
      revision: repository.revision,
      now,
    });
    const digest = reportDigest(report);
    if (settled(repository.report, digest, now)) continue;
    let access: { token: string; login: string };
    try {
      access = await authenticateGitHubIssues(options.app, repository.repository);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      // Nothing was taken, so the next pass tries again.
      progress(`GitHub issue access failed: ${error.name}: ${error.message}`);
      continue;
    }
    const claimed = await reports.claim(
      repository.installationId,
      repository.repository,
      digest,
      now,
      REPORT_RETRY_HOURS,
    );
    if (!claimed) continue;
    const request: DeadlineRequest = (method, path, body) =>
      requestGitHub(access.token, method, path, body);
    try {
      const result = await syncDeadlineIssue({
        request,
        repository: repository.repository,
        issue:
          claimed.issue ?? (await existingReport(request, repository.repository, access.login)),
        title: REPORT_TITLE,
        body: renderReport(report),
        comment: `Refit updated this report${report.revision ? ` for commit \`${report.revision.slice(0, 12)}\`` : ''}.`,
      });
      await reports.record(repository.installationId, repository.repository, digest, {
        issue: result.issue,
        status: result.action,
        message: null,
      });
      written++;
      progress(`Issue #${result.issue} ${result.action}.`);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      await reports.record(repository.installationId, repository.repository, digest, {
        issue: null,
        status: 'failed',
        message: `${error.name}: ${error.message}`,
      });
      progress(`${error.name}: ${error.message}`);
    }
  }
  return written;
}
