import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AnyTask, StoredRun } from '../memory/types.ts';
import { runRepoJob, scanRepo } from '../orchestrator/index.ts';
import { apiAsExternalTask } from '../orchestrator/scan.ts';
import type { ExternalTask, ScanReport, ScanRepo } from '../shared/types.ts';
import type { SessionRepos } from './api/auth.ts';
import { createApiRoutes, isServiceToken, resolveAccess } from './api/index.ts';
import { createSessions } from './api/session.ts';
import type { ViewerRepos } from './api/session.ts';
import { AUDIT_PATHS, serveAudit } from './audit/index.ts';
import {
  createBeforeOpenPullRequest,
  createFindOpenPullRequest,
  findTaskForPr,
  refreshConflicts,
} from './lifecycle/index.ts';
import type { FindOpenPullRequest } from './lifecycle/index.ts';
import { notifyRun, sendWeeklyDigest } from './notify/index.ts';
import type { LoginConfig } from './config.ts';
import type { ReportStore } from './reports.ts';
import type { BeforeOpenPullRequest, InstallationTokens, NotifyRun, RunTasks } from './types.ts';

// True when the route handled the request.
export type Route = (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;
export type IsServiceToken = (authorization: string | undefined) => boolean;

export type Parts = {
  scanRepo: ScanRepo;
  runTasks: RunTasks;
  isServiceToken: IsServiceToken;
  viewerRepos: ViewerRepos;
  userToken: (request: IncomingMessage) => string | undefined;
  routes: Route[];
  beforeOpenPullRequest: BeforeOpenPullRequest;
  notifyRun: NotifyRun;
  // Finds a PR the lifecycle moved a task onto, which a lookup by the task's own branch can't see.
  findOpenPullRequest: FindOpenPullRequest;
  // Re-runs tasks whose open PRs conflict with the default branch.
  refreshConflicts: (
    repo: string,
    installationId: number,
    rerun: (task: ExternalTask) => Promise<void>,
  ) => Promise<void>;
  sendWeeklyDigest: (reports: ScanReport[]) => Promise<void>;
};

export type PartsDeps = {
  reports: ReportStore;
  tokens: InstallationTokens;
  listRuns: () => Promise<StoredRun[]>;
  viewerRepos: ViewerRepos;
  login?: LoginConfig;
  fetchImpl?: typeof fetch;
};

// The queue carries ExternalTasks, and an older stored run may hold a plain MigrationTask.
const asExternalTask = (task: AnyTask): ExternalTask =>
  'dependencies' in task ? task : apiAsExternalTask(task);

function auditRoute({ reports }: PartsDeps, sessionRepos: SessionRepos): Route {
  const listRepos = async () => (await reports.list()).map((report) => report.repo);
  return async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method !== 'GET' || !AUDIT_PATHS.includes(path)) return false;
    await serveAudit(request, response, {
      access: (incoming) => resolveAccess(incoming, sessionRepos),
      listRepos,
    });
    return true;
  };
}

export function loadParts(deps: PartsDeps): Parts {
  const { tokens, listRuns, login, viewerRepos, fetchImpl } = deps;
  const sessions = createSessions(login, { viewerRepos, fetchImpl });
  return {
    scanRepo,
    runTasks: runRepoJob,
    isServiceToken,
    viewerRepos: sessions.viewerRepos,
    userToken: sessions.userToken,
    routes: [
      sessions.route,
      createApiRoutes({ ...deps, sessionRepos: sessions.repos }),
      auditRoute(deps, sessions.repos),
    ],
    beforeOpenPullRequest: createBeforeOpenPullRequest({ tokens }),
    notifyRun,
    findOpenPullRequest: createFindOpenPullRequest({ tokens }),
    refreshConflicts: async (repo, installationId, rerun) => {
      await refreshConflicts(repo, {
        installationId,
        tokens,
        findTask: findTaskForPr(listRuns),
        rerun: (task) => rerun(asExternalTask(task)),
      });
    },
    sendWeeklyDigest,
  };
}
