import { dirname, join } from 'node:path';
import { Budget, defaultAi, defaultMemory, listRunViews, recordVerdict } from '../memory/index.ts';
import { BudgetExceededError } from '../orchestrator/budget.ts';
import { readConfig } from './config.ts';
import { cloneRepo } from './git.ts';
import {
  compareCommits,
  createAppJwt,
  createInstallationTokens,
  listInstallationRepos,
  listInstallations,
  listViewerRepos,
  pullDiff,
} from './github.ts';
import { createHealthCheck } from './health.ts';
import { createJobRunner } from './jobs.ts';
import { redactLogs } from './logs.ts';
import { loadParts } from './parts.ts';
import { createOpenPullRequest, findPullRequestFor } from './pr.ts';
import { createFileQueue } from './queue.ts';
import { createReportStore } from './reports.ts';
import { createWeeklyScan } from './schedule.ts';
import { createWebhookServer } from './server.ts';
import { isIgnored, readRepoSettings } from './settings.ts';
import type { RecordVerdict } from './types.ts';

const DEFAULT_HOST = '127.0.0.1';
// memory/README.md: a verdict can trigger a model call, so each gets its own cap instead of sharing one.
const VERDICT_BUDGET_USD = 1;

redactLogs();

const config = readConfig();
const host = process.env.HOST ?? DEFAULT_HOST;
const tokens = createInstallationTokens(config.appId, config.privateKey);
const stateDir = dirname(config.queueFile);
const reports = createReportStore(join(stateDir, 'reports'));
const parts = loadParts({
  reports,
  tokens,
  listRuns: () => defaultMemory().store.listRuns(),
});

const queue = await createFileQueue(
  config.queueFile,
  createJobRunner({
    tokens,
    checkout: cloneRepo,
    scanRepo: parts.scanRepo,
    runTasks: parts.runTasks,
    openPullRequestFor: (installationId) => createOpenPullRequest(tokens, installationId),
    findPullRequest: async (installationId, task) =>
      (await findPullRequestFor(tokens, installationId)(task)) ??
      parts.findOpenPullRequest(installationId, task),
    beforeOpenPullRequest: parts.beforeOpenPullRequest,
    notifyRun: parts.notifyRun,
    refreshConflicts: ({ installationId, repo }) =>
      parts.refreshConflicts(repo, installationId, (task) =>
        queue.enqueue({ kind: 'run', installationId, repo, task }),
      ),
    readSettings: readRepoSettings,
    isIgnored,
    reports,
    enqueue: (job) => queue.enqueue(job),
  }),
  {
    concurrency: config.queueConcurrency,
    // A refusal from the run budget is final, so another try would only hold a slot.
    shouldRetry: (error) => !(error instanceof BudgetExceededError),
    onForget: (job) =>
      job.repo ? reports.remove(job.repo) : reports.removeInstallation(job.installationId),
  },
);

const verdict: RecordVerdict = async (pr, human, finalDiff) => {
  await reports.markVerdict(pr, human);
  const learned = await recordVerdict(
    pr,
    human,
    { ...defaultMemory(), ...defaultAi(process.env, new Budget(VERDICT_BUDGET_USD)) },
    { finalDiff },
  );
  console.log(`verdict ${human} ${pr}${learned ? '' : ' (no stored run has this PR)'}`);
};

const server = createWebhookServer({
  webhookSecret: config.webhookSecret,
  tokens,
  listRepos: (token) => listInstallationRepos(token),
  compareCommits: (token, repo, base, head) => compareCommits(token, repo, base, head),
  pullDiff,
  queue,
  recordVerdict: verdict,
  listRunViews,
  viewerRepos: (userToken) => listViewerRepos(userToken, config.appId),
  isServiceToken: parts.isServiceToken,
  routes: parts.routes,
  checkHealth: createHealthCheck({
    stateDir,
    sandboxRequired: process.env.REFIT_SANDBOX === 'docker',
  }),
});

const weekly = createWeeklyScan({
  stateFile: join(stateDir, 'schedule.json'),
  listInstallations: () => listInstallations(createAppJwt(config.appId, config.privateKey)),
  listRepos: async (installationId) => listInstallationRepos(await tokens.token(installationId)),
  enqueue: (job) => queue.enqueue(job),
  afterSweep: async () => parts.sendWeeklyDigest(await reports.list()),
});
weekly.start();

server.listen(config.port, host, () => {
  console.log(`listening on http://${host}:${config.port}/webhooks`);
});

const shutdown = () => {
  server.close();
  weekly.stop();
  queue.close();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
