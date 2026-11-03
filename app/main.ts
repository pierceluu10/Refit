import { Budget, defaultAi, defaultMemory, recordVerdict } from '../memory/index.ts';
import { readConfig } from './config.ts';
import { cloneRepo } from './git.ts';
import {
  compareCommits,
  createInstallationTokens,
  listInstallationRepos,
  listViewerRepos,
} from './github.ts';
import { createJobRunner } from './jobs.ts';
import { createOpenPullRequest } from './pr.ts';
import { createFileQueue } from './queue.ts';
import { createWebhookServer } from './server.ts';
import { listRunViews, runRepoJob } from './stubs.ts';
import type { RecordVerdict } from './types.ts';

const DEFAULT_HOST = '127.0.0.1';
// memory/README.md: a verdict can trigger a model call, so each gets its own cap instead of sharing one.
const VERDICT_BUDGET_USD = 1;

const config = readConfig();
const host = process.env.HOST ?? DEFAULT_HOST;
const tokens = createInstallationTokens(config.appId, config.privateKey);

const queue = await createFileQueue(
  config.queueFile,
  createJobRunner({
    tokens,
    runRepoJob,
    checkout: cloneRepo,
    openPullRequestFor: (installationId) => createOpenPullRequest(tokens, installationId),
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
  listRunViews,
  viewerRepos: (userToken) => listViewerRepos(userToken, config.appId),
});

server.listen(config.port, host, () => {
  console.log(`listening on http://${host}:${config.port}/webhooks`);
});

const shutdown = () => server.close();
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
