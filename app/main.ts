import { dirname, join } from 'node:path';
import { JsonAuditStore } from '../compliance/audit.ts';
import {
  Budget,
  defaultAi,
  defaultMemory,
  JsonMemoryStore,
  listRunViews,
  recordVerdict,
} from '../memory/index.ts';
import { BudgetExceededError } from '../orchestrator/budget.ts';
import { defaultOut, defaultReports } from '../orchestrator/deps.ts';
import { createScanRoute } from './api/scans.ts';
import { readConfig } from './config.ts';
import { createDeliveryLog } from './deliveries.ts';
import { createForget } from './forget.ts';
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
import { createJobRunner } from './jobs.ts';
import { forgetNotified } from './notify/index.ts';
import { loadParts } from './parts.ts';
import { createOpenPullRequest, findPullRequestFor } from './pr.ts';
import { trackJobs } from './progress.ts';
import { createFileQueue } from './queue.ts';
import { createReportStore } from './reports.ts';
import { createWeeklyScan } from './schedule.ts';
import { createWebhookServer } from './server.ts';
import { isIgnored, readRepoSettings } from './settings.ts';
import type { RecordVerdict } from './types.ts';

const DEFAULT_HOST = '127.0.0.1';
// memory/README.md: a verdict can trigger a model call, so each gets its own cap instead of sharing one.
const VERDICT_BUDGET_USD = 1;

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

const jobs = trackJobs(
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
  reports,
);

const queue = await createFileQueue(config.queueFile, jobs.run, {
  concurrency: config.queueConcurrency,
  // A refusal from the run budget is final, so another try would only hold a slot.
  shouldRetry: (error) => !(error instanceof BudgetExceededError),
  onForget: createForget({
    reports,
    memoryDir: JsonMemoryStore.fromEnv().dir,
    auditDir: JsonAuditStore.fromEnv().dir,
    runLog: defaultOut,
    scanReportDir: defaultReports,
    forgetNotified,
    settled: jobs.settled,
  }),
});

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

const listRepos = async (installationId: number) =>
  listInstallationRepos(await tokens.token(installationId));
const installations = () => listInstallations(createAppJwt(config.appId, config.privateKey));

const server = createWebhookServer({
  webhookSecret: config.webhookSecret,
  deliveries: await createDeliveryLog(join(stateDir, 'deliveries.json')),
  tokens,
  listRepos: (token) => listInstallationRepos(token),
  compareCommits: (token, repo, base, head) => compareCommits(token, repo, base, head),
  pullDiff,
  queue,
  recordVerdict: verdict,
  listRunViews,
  viewerRepos: (userToken) => listViewerRepos(userToken, config.appId),
  isServiceToken: parts.isServiceToken,
  routes: [
    ...parts.routes,
    createScanRoute({
      reports,
      pending: queue.pending,
      scanning: jobs.scanning,
      listInstallations: installations,
      listRepos,
      isAuthorized: parts.isServiceToken,
    }),
  ],
});

const weekly = createWeeklyScan({
  stateFile: join(stateDir, 'schedule.json'),
  listInstallations: installations,
  listRepos,
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
