import { join } from 'node:path';
import { scanDeadApis } from '../inventory/dead-scan.ts';
import { Budget, defaultAi, defaultMemory, listRunViews, recordVerdict } from '../memory/index.ts';
import { runRepoJob } from '../orchestrator/index.ts';
import { readConfig } from './config.ts';
import { createConsentStore } from './consent.ts';
import { createEvidence } from './evidence.ts';
import { createFactStore } from './fix-facts.ts';
import { cloneRepo } from './git.ts';
import {
  commitFiles,
  compareCommits,
  compareFiles,
  createInstallationTokens,
  listInstallationRepos,
  listPullComments,
  listPullCommits,
  listPullFiles,
  listViewerRepos,
} from './github.ts';
import { createJobRunner } from './jobs.ts';
import { createOpenPullRequest } from './pr.ts';
import { createFileQueue } from './queue.ts';
import { createWebhookServer } from './server.ts';
import type { RecordEvidence, RecordHabits, RecordVerdict } from './types.ts';

const DEFAULT_HOST = '127.0.0.1';
// memory/README.md: a verdict can trigger a model call, so each gets its own cap instead of sharing one.
const VERDICT_BUDGET_USD = 1;

const config = readConfig();
const host = process.env.HOST ?? DEFAULT_HOST;
const tokens = createInstallationTokens(config.appId, config.privateKey);
const consent = createConsentStore(join(config.dataDir, 'installations'));

// shortcut: memory's recordEvidence and shareLearning are on rebuild/otabek, so until they land the
// app's own fact files hold the evidence and these two only log it. They are the only lines to swap.
const sendEvidence: RecordEvidence = async (pr, evidence, { consented }) => {
  console.log(`evidence ${pr}: ${Object.keys(evidence).join(', ')} (shareLearning ${consented})`);
};
const sendHabits: RecordHabits = async ({ repo, rejections, edits }) => {
  console.log(`habits ${repo}: ${rejections.count} rejected, ${edits.count} edited`);
};

const evidence = createEvidence({
  tokens,
  github: { listPullCommits, listPullFiles, commitFiles, compareFiles, listPullComments },
  facts: createFactStore(join(config.dataDir, 'fixes')),
  consent,
  recordEvidence: sendEvidence,
  recordHabits: sendHabits,
});

const queue = await createFileQueue(
  config.queueFile,
  createJobRunner({
    tokens,
    runRepoJob,
    checkout: cloneRepo,
    openPullRequestFor: (installationId) =>
      createOpenPullRequest(tokens, installationId, fetch, evidence.opened),
    rescan: async ({ installationId, repo }, dir, at) => {
      if (!(await evidence.hasFixToWatch(repo))) return;
      const { findings } = await scanDeadApis(dir, repo);
      await evidence.rescanFound(installationId, repo, findings, at);
    },
  }),
);

const verdict: RecordVerdict = async (pr, human) => {
  const learned = await recordVerdict(pr, human, {
    ...defaultMemory(),
    ...defaultAi(process.env, new Budget(VERDICT_BUDGET_USD)),
  });
  console.log(`verdict ${human} ${pr}${learned ? '' : ' (no stored run has this PR)'}`);
};

const server = createWebhookServer({
  webhookSecret: config.webhookSecret,
  tokens,
  listRepos: (token) => listInstallationRepos(token),
  compareCommits: (token, repo, base, head) => compareCommits(token, repo, base, head),
  queue,
  recordVerdict: verdict,
  evidence,
  consent,
  listRunViews,
  viewerRepos: (userToken) => listViewerRepos(userToken, config.appId),
});

server.listen(config.port, host, () => {
  console.log(`listening on http://${host}:${config.port}/webhooks`);
});

const shutdown = () => server.close();
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
