import type { IncomingMessage, ServerResponse } from 'node:http';
import { redactSecrets } from '../../harness/secrets.ts';
import type { DependencyUsage, ScanReport } from '../../shared/types.ts';
import { AUDIT_PATHS } from '../audit/index.ts';
import { GitHubApiError } from '../github.ts';
import { parseMarker } from '../lifecycle/marker.ts';
import { RUNS_PATH } from '../runs.ts';
import { REPO_PATTERN } from '../types.ts';
import type { InstallationTokens } from '../types.ts';
import { canRead, resolveAccess } from './auth.ts';
import type { Access, SessionRepos } from './auth.ts';
import { listRefitPullRequests } from './pulls.ts';
import type { PullRequest } from './pulls.ts';

const OK = 200;
const BAD_REQUEST = 400;
const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
const NOT_FOUND = 404;
const METHOD_NOT_ALLOWED = 405;
const SERVER_ERROR = 500;
const BAD_GATEWAY = 502;
// GitHub refusing one installation or repo (suspended, removed); anything else is a real outage.
const REFUSED_STATUSES = new Set([FORBIDDEN, NOT_FOUND]);

const REPOS_PATH = '/api/repos';
const REPORT_PATH = '/api/report';
const PRS_PATH = '/api/prs';
const LOCAL_ORIGIN = 'http://localhost';
const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

const BAD_REPO = 'repo must be owner/name';

export type StoredReport = ScanReport & { installationId?: number };

export type ReportReader = {
  latest: (repo: string) => Promise<StoredReport | undefined>;
  list: () => Promise<StoredReport[]>;
};

export type ApiDeps = {
  reports: ReportReader;
  tokens: InstallationTokens;
  serviceToken?: string; // defaults to REFIT_SERVICE_TOKEN, read per request
  sessionRepos?: SessionRepos;
  fetchImpl?: typeof fetch;
};

export type PrView = {
  repo: string;
  number: number;
  title: string;
  url: string;
  state: 'open' | 'merged' | 'closed';
  draft: boolean;
  branch: string;
  updatedAt: string;
  dependency?: string;
  target?: string;
};

type Reply = { status: number; body: unknown };

const failure = (status: number, error: string): Reply => ({ status, body: { error } });

function publicDependency(dependency: DependencyUsage): DependencyUsage {
  return {
    repo: dependency.repo,
    kind: dependency.kind,
    name: dependency.name,
    ecosystem: dependency.ecosystem,
    version: dependency.version,
    declaredIn: dependency.declaredIn.map(({ file, line }) => ({ file, line })),
    callSites: dependency.callSites?.map(({ file, line, operation, fields }) => ({
      file,
      line,
      operation,
      fields,
    })),
  };
}

// Fields are listed, not stripped, so a field added to a stored report later stays private until chosen.
// shortcut: errors are free text, so this removes secrets but not a source line quoted in an exception
// message; have the scanner write structured errors (file and reason) to close that.
export function publicReport(report: ScanReport): ScanReport {
  return {
    repo: report.repo,
    scannedAt: report.scannedAt,
    items: report.items.map((item) => ({
      ...item,
      dependency: publicDependency(item.dependency),
    })),
    costUsd: report.costUsd,
    errors: report.errors.map((error) => redactSecrets(error)),
  };
}

function prView(repo: string, pull: PullRequest): PrView {
  const marker = parseMarker(pull.body);
  return {
    repo,
    number: pull.number,
    title: pull.title,
    url: pull.html_url,
    state: pull.merged_at ? 'merged' : pull.state,
    draft: pull.draft,
    branch: pull.head.ref,
    updatedAt: pull.updated_at,
    ...(marker && { dependency: marker.dependency, target: marker.target }),
  };
}

// shortcut: a repo appears after its first scan, since installs aren't listed here; P1 deletes a report on uninstall, so removed repos drop off.
async function serveRepos(_query: URLSearchParams, deps: ApiDeps, access: Access): Promise<Reply> {
  const reports = await deps.reports.list();
  const repos = reports
    .map((report) => report.repo)
    .filter((repo) => canRead(access, repo))
    .sort((a, b) => a.localeCompare(b));
  return { status: OK, body: repos };
}

async function serveReport(query: URLSearchParams, deps: ApiDeps, access: Access): Promise<Reply> {
  const repo = query.get('repo');
  if (repo === null || !REPO_PATTERN.test(repo)) return failure(BAD_REQUEST, BAD_REPO);
  // Same answer as a repo that doesn't exist, so another org's repo names can't be probed.
  const report = canRead(access, repo) ? await deps.reports.latest(repo) : undefined;
  return report
    ? { status: OK, body: publicReport(report) }
    : failure(NOT_FOUND, 'No report for this repo');
}

async function reportsFor(
  wanted: string | null,
  deps: ApiDeps,
  access: Access,
): Promise<StoredReport[]> {
  const reports = wanted === null ? await deps.reports.list() : [await deps.reports.latest(wanted)];
  return reports.filter(
    (report): report is StoredReport => report !== undefined && canRead(access, report.repo),
  );
}

// One suspended or removed installation leaves its PRs out instead of failing everyone else's list.
async function prViews({ repo, installationId }: StoredReport, deps: ApiDeps): Promise<PrView[]> {
  if (installationId === undefined) return [];
  try {
    const token = await deps.tokens.token(installationId);
    const pulls = await listRefitPullRequests(token, repo, 'all', deps.fetchImpl);
    return pulls.map((pull) => prView(repo, pull));
  } catch (error) {
    if (!(error instanceof GitHubApiError && REFUSED_STATUSES.has(error.status))) throw error;
    console.error(`api /api/prs skipped ${repo}: ${redactSecrets(error.message)}`);
    return [];
  }
}

async function servePrs(query: URLSearchParams, deps: ApiDeps, access: Access): Promise<Reply> {
  const wanted = query.get('repo');
  if (wanted !== null && !REPO_PATTERN.test(wanted)) return failure(BAD_REQUEST, BAD_REPO);
  const reports = await reportsFor(wanted, deps, access);
  const views = await Promise.all(reports.map((report) => prViews(report, deps)));
  const newestFirst = (a: PrView, b: PrView) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  return { status: OK, body: views.flat().sort(newestFirst) };
}

const ROUTES: Record<
  string,
  (query: URLSearchParams, deps: ApiDeps, access: Access) => Promise<Reply>
> = {
  [REPOS_PATH]: serveRepos,
  [REPORT_PATH]: serveReport,
  [PRS_PATH]: servePrs,
};

// Every /api path that returns customer data; the isolation test walks this list.
export const DATA_PATHS = [...Object.keys(ROUTES), ...AUDIT_PATHS, RUNS_PATH];

export function sendJson(response: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  response.writeHead(status, JSON_HEADERS).end(text);
}

// The handler resolves false, touching nothing, for any path it doesn't own, and never rejects.
export function createApiRoutes(
  deps: ApiDeps,
): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  return async (request, response) => {
    // URL.parse rather than new URL: a request line like `//` is invalid and new URL would throw.
    const url = URL.parse(request.url ?? '/', LOCAL_ORIGIN);
    const route = url && ROUTES[url.pathname];
    if (!route) return false;
    try {
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        sendJson(response, METHOD_NOT_ALLOWED, { error: 'Method not allowed' });
      } else {
        const access = await resolveAccess(request, deps.sessionRepos, deps.serviceToken);
        if (!access) sendJson(response, UNAUTHORIZED, { error: 'Unauthorized' });
        else {
          const reply = await route(url.searchParams, deps, access);
          sendJson(response, reply.status, reply.body);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`api ${url.pathname} failed: ${redactSecrets(message)}`);
      if (response.headersSent) response.end();
      else if (error instanceof GitHubApiError) {
        sendJson(response, BAD_GATEWAY, { error: 'GitHub request failed' });
      } else sendJson(response, SERVER_ERROR, { error: 'Internal server error' });
    }
    return true;
  };
}
