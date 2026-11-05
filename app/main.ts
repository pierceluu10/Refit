import { join } from 'node:path';
import { listRunViews } from '../memory/index.ts';
import { readConfig } from './config.ts';
import { createConsentStore } from './consent.ts';
import {
  compareCommits,
  createInstallationTokens,
  listInstallationIds,
  listInstallationRepos,
  listViewerRepos,
} from './github.ts';
import { createFileQueue } from './queue.ts';
import { createAppEvidence, createAppRunner, createAppVerdict } from './runner.ts';
import { createWebhookServer } from './server.ts';
import { createTick, createTriggerStore, startClock } from './triggers.ts';

const DEFAULT_HOST = '127.0.0.1';

const config = readConfig();
const host = process.env.HOST ?? DEFAULT_HOST;
const tokens = createInstallationTokens(config.appId, config.privateKey);
const consent = createConsentStore(join(config.dataDir, 'installations'));

const evidence = createAppEvidence(tokens, config.dataDir, consent);
const triggers = createTriggerStore(config.triggerDir);

const queue = await createFileQueue(
  config.queueFile,
  createAppRunner(tokens, triggers, evidence),
  (job) => triggers.merged(job, new Date()),
);

const server = createWebhookServer({
  webhookSecret: config.webhookSecret,
  tokens,
  listRepos: (token) => listInstallationRepos(token),
  compareCommits: (token, repo, base, head) => compareCommits(token, repo, base, head),
  queue,
  forgetRepo: async (job) => {
    await triggers.forget(job, new Date());
    await evidence.forget(job.repo);
  },
  recordVerdict: createAppVerdict(),
  evidence,
  consent,
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
