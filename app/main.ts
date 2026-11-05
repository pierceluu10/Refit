import { Budget, defaultAi, defaultMemory, listRunViews, recordVerdict } from '../memory/index.ts';
import { readConfig } from './config.ts';
import {
  compareCommits,
  createInstallationTokens,
  listInstallationIds,
  listInstallationRepos,
  listViewerRepos,
} from './github.ts';
import { createFileQueue } from './queue.ts';
import { createAppRunner } from './runner.ts';
import { createWebhookServer } from './server.ts';
import { createTick, createTriggerStore, startClock } from './triggers.ts';
import type { RecordVerdict } from './types.ts';

const DEFAULT_HOST = '127.0.0.1';
// memory/README.md: a verdict can trigger a model call, so each gets its own cap instead of sharing one.
const VERDICT_BUDGET_USD = 1;

const config = readConfig();
const host = process.env.HOST ?? DEFAULT_HOST;
const tokens = createInstallationTokens(config.appId, config.privateKey);

const triggers = createTriggerStore(config.triggerDir);

const queue = await createFileQueue(config.queueFile, createAppRunner(tokens, triggers), (job) =>
  triggers.merged(job, new Date()),
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
  forgetRepo: (job) => triggers.forget(job, new Date()),
  recordVerdict: verdict,
  listRunViews,
  viewerRepos: (userToken) => listViewerRepos(userToken, config.appId),
});

server.listen(config.port, host, () => {
  console.log(`listening on http://${host}:${config.port}/webhooks`);
});

const stopClock = startClock(
  createTick({
    listInstallations: () => listInstallationIds(config.appId, config.privateKey),
    tokens,
    listRepos: (token) => listInstallationRepos(token),
    queue,
  }),
);

const shutdown = () => {
  stopClock();
  server.close();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
