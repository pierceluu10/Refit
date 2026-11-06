import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ExternalTask, RunRepoJob, ScanReport, ScanRepo } from '../shared/types.ts';
import type { ReportStore } from './reports.ts';
import type {
  BeforeOpenPullRequest,
  InstallationTokens,
  NotifyRun,
  OpenAnyPullRequest,
  RunTasks,
} from './types.ts';

// Other prompts land these modules on their own branches. A module that isn't there yet gets a labelled
// stub, so merging one needs no edit here; the integration prompt deletes the stubs.

// True when the route handled the request.
export type Route = (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;
export type IsServiceToken = (authorization: string | undefined) => boolean;

export type Parts = {
  scanRepo: ScanRepo;
  runTasks: RunTasks;
  isServiceToken: IsServiceToken;
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
  listRuns: () => Promise<unknown[]>;
};

type FindOpenPullRequest = (
  installationId: number,
  task: ExternalTask,
) => Promise<{ url: string; state: 'open' } | undefined>;

type RealRunRepoJob = (
  input: Omit<Parameters<RunRepoJob>[0], 'openPullRequest'> & {
    openPullRequest: OpenAnyPullRequest;
    tasks?: unknown[];
    signal?: AbortSignal;
  },
) => Promise<Awaited<ReturnType<RunRepoJob>>>;
type Orchestrator = { scanRepo: ScanRepo; runRepoJob: RealRunRepoJob };
type Api = { isServiceToken: IsServiceToken; createApiRoutes: (deps: PartsDeps) => Route };
type Audit = {
  AUDIT_PATHS: string[];
  serveAudit: (
    request: IncomingMessage,
    response: ServerResponse,
    deps: { isAuthorized: IsServiceToken; listRepos: () => Promise<string[]> },
  ) => Promise<void>;
};
type Lifecycle = {
  createBeforeOpenPullRequest: (deps: PartsDeps) => BeforeOpenPullRequest;
  createFindOpenPullRequest: (deps: { tokens: InstallationTokens }) => FindOpenPullRequest;
  findTaskForPr: (listRuns: PartsDeps['listRuns']) => unknown;
  refreshConflicts: (
    repo: string,
    options: {
      installationId: number;
      tokens: InstallationTokens;
      findTask: unknown;
      rerun: (task: ExternalTask) => Promise<void>;
    },
  ) => Promise<unknown>;
};
type Notify = { notifyRun: NotifyRun; sendWeeklyDigest: (reports: ScanReport[]) => Promise<void> };

export type Modules = {
  orchestrator: Partial<Orchestrator>;
  api: Partial<Api>;
  audit: Partial<Audit>;
  lifecycle: Partial<Lifecycle>;
  notify: Partial<Notify>;
};

// Only the module itself being missing means it hasn't landed; a broken import inside it still throws.
export async function loadOptional<T>(
  specifier: string,
  base: string = import.meta.url,
): Promise<Partial<T>> {
  const url = new URL(specifier, base);
  if (!existsSync(url)) return {};
  return (await import(/* @vite-ignore */ url.href)) as Partial<T>;
}

const digest = (value: string) => createHash('sha256').update(value).digest();

// Stands in for P3's check. Hashing gives timingSafeEqual equal lengths; an unset token matches nothing.
export const serviceTokenCheck =
  (expected: string | undefined): IsServiceToken =>
  (authorization) =>
    Boolean(expected) && timingSafeEqual(digest(authorization ?? ''), digest(`Bearer ${expected}`));

export const stubScanRepo: ScanRepo = async (repo) => ({
  report: {
    repo,
    scannedAt: new Date().toISOString(),
    items: [],
    costUsd: 0,
    errors: ['Nothing was scanned: the orchestrator has no scanRepo in this build.'],
  },
  tasks: [],
});

function auditRoute(
  { AUDIT_PATHS, serveAudit }: Partial<Audit>,
  { reports }: PartsDeps,
  isAuthorized: IsServiceToken,
): Route | undefined {
  if (!AUDIT_PATHS || !serveAudit) return undefined;
  const listRepos = async () => (await reports.list()).map((report) => report.repo);
  return async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method !== 'GET' || !AUDIT_PATHS.includes(path)) return false;
    await serveAudit(request, response, { isAuthorized, listRepos });
    return true;
  };
}

export function buildParts(
  { orchestrator, api, audit, lifecycle, notify }: Modules,
  deps: PartsDeps,
  env: NodeJS.ProcessEnv,
  warn: (line: string) => void,
): Parts {
  const stub = <T>(part: string, real: T | undefined, fallback: T): T => {
    if (real === undefined) warn(`using a stub for ${part}: its module hasn't landed`);
    return real ?? fallback;
  };

  const isServiceToken = stub(
    'the service-token check',
    api.isServiceToken,
    serviceTokenCheck(env.REFIT_SERVICE_TOKEN),
  );
  const runRepoJob = orchestrator.runRepoJob;
  const apiRoutes = stub('the report API', api.createApiRoutes?.(deps), undefined);
  const auditRoutes = stub('the audit API', auditRoute(audit, deps, isServiceToken), undefined);
  const { tokens, listRuns } = deps;
  return {
    scanRepo: stub('scanRepo', orchestrator.scanRepo, stubScanRepo),
    runTasks: async (input) => {
      if (!runRepoJob) throw new Error('The orchestrator has no runRepoJob in this build.');
      return runRepoJob(input);
    },
    isServiceToken,
    routes: [apiRoutes, auditRoutes].filter((route) => route !== undefined),
    beforeOpenPullRequest: stub(
      'the PR lifecycle',
      lifecycle.createBeforeOpenPullRequest?.(deps),
      async () => ({}),
    ),
    notifyRun: stub('notifications', notify.notifyRun, async () => {}),
    findOpenPullRequest:
      lifecycle.createFindOpenPullRequest?.({ tokens }) ?? (async () => undefined),
    refreshConflicts: async (repo, installationId, rerun) => {
      await lifecycle.refreshConflicts?.(repo, {
        installationId,
        tokens,
        findTask: lifecycle.findTaskForPr?.(listRuns),
        rerun,
      });
    },
    sendWeeklyDigest: notify.sendWeeklyDigest ?? (async () => {}),
  };
}

export async function loadParts(
  deps: PartsDeps,
  env: NodeJS.ProcessEnv = process.env,
  warn: (line: string) => void = console.warn,
): Promise<Parts> {
  const [orchestrator, api, audit, lifecycle, notify] = await Promise.all([
    loadOptional<Orchestrator>('../orchestrator/index.ts'),
    loadOptional<Api>('./api/index.ts'),
    loadOptional<Audit>('./audit/index.ts'),
    loadOptional<Lifecycle>('./lifecycle/index.ts'),
    loadOptional<Notify>('./notify/index.ts'),
  ]);
  return buildParts({ orchestrator, api, audit, lifecycle, notify }, deps, env, warn);
}
