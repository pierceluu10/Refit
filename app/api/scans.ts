import type { IncomingMessage, ServerResponse } from 'node:http';
import { redactSecrets } from '../../harness/secrets.ts';
import type { ScanReport } from '../../shared/types.ts';
import { GitHubApiError } from '../github.ts';
import type { Route } from '../parts.ts';
import { SCAN_FAILED } from '../progress.ts';
import type { QueuedJob } from '../types.ts';
import { publicReport } from './routes.ts';
import type { ReportReader } from './routes.ts';

const SCANS_PATH = '/api/scans';
const INSTALLATION_ID = /^\d+$/;
const OK = 200;
const BAD_REQUEST = 400;
const UNAUTHORIZED = 401;
const NOT_FOUND = 404;
const SERVER_ERROR = 500;
const BAD_GATEWAY = 502;
const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

// waiting: GitHub lists the repo but no scan has been queued for it.
export type ScanState = 'waiting' | 'queued' | 'running' | 'done' | 'failed';
export type ScanView = { repo: string; state: ScanState; report?: ScanReport };

export type ScansDeps = {
  reports: Pick<ReportReader, 'latest'>;
  pending: () => QueuedJob[];
  scanning: (repo: string) => boolean;
  listInstallations: () => Promise<{ id: number; suspended: boolean }[]>;
  listRepos: (installationId: number) => Promise<string[]>;
  isAuthorized: (authorization: string | undefined) => boolean;
};

const hasFailed = (report: ScanReport) =>
  report.items.length === 0 && report.errors.some((error) => error.startsWith(SCAN_FAILED));

function stateOf(repo: string, report: ScanReport | undefined, deps: ScansDeps): ScanState {
  if (deps.scanning(repo)) return 'running';
  if (deps.pending().some((job) => job.kind === 'scan' && job.repo === repo)) return 'queued';
  if (!report) return 'waiting';
  return hasFailed(report) ? 'failed' : 'done';
}

// GitHub says which repos are installed, since /api/repos only knows those with a finished scan.
async function installedRepos(installationId: string | null, deps: ScansDeps): Promise<string[]> {
  const ids =
    installationId !== null
      ? [Number(installationId)]
      : (await deps.listInstallations()).filter((item) => !item.suspended).map((item) => item.id);
  const repos = await Promise.all(ids.map((id) => deps.listRepos(id)));
  return repos.flat().sort((a, b) => a.localeCompare(b));
}

async function viewsFor(installationId: string | null, deps: ScansDeps): Promise<ScanView[]> {
  const repos = await installedRepos(installationId, deps);
  return Promise.all(
    repos.map(async (repo) => {
      const report = await deps.reports.latest(repo);
      return {
        repo,
        state: stateOf(repo, report, deps),
        ...(report && { report: publicReport(report) }),
      };
    }),
  );
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, JSON_HEADERS).end(JSON.stringify(body));
}

function sendFailure(response: ServerResponse, error: unknown) {
  if (error instanceof GitHubApiError && error.status === NOT_FOUND) {
    return sendJson(response, NOT_FOUND, { error: 'GitHub has no such installation' });
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(`api ${SCANS_PATH} failed: ${redactSecrets(message)}`);
  if (error instanceof GitHubApiError) {
    return sendJson(response, BAD_GATEWAY, { error: 'GitHub request failed' });
  }
  sendJson(response, SERVER_ERROR, { error: 'Internal server error' });
}

export function createScanRoute(deps: ScansDeps): Route {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const url = URL.parse(request.url ?? '/', 'http://localhost');
    if (request.method !== 'GET' || url?.pathname !== SCANS_PATH) return false;
    if (!deps.isAuthorized(request.headers.authorization)) {
      sendJson(response, UNAUTHORIZED, { error: 'Unauthorized' });
      return true;
    }
    const installationId = url.searchParams.get('installation_id');
    if (installationId !== null && !INSTALLATION_ID.test(installationId)) {
      sendJson(response, BAD_REQUEST, { error: 'installation_id must be a number' });
      return true;
    }
    try {
      sendJson(response, OK, await viewsFor(installationId, deps));
    } catch (error) {
      sendFailure(response, error);
    }
    return true;
  };
}
