import { readConfig } from './config.ts';
import { createInstallationTokens, listInstallationRepos } from './github.ts';
import { createWebhookServer } from './server.ts';
import { createMemoryQueue, logVerdict } from './stubs.ts';

const DEFAULT_HOST = '127.0.0.1';

const config = readConfig();
const host = process.env.HOST ?? DEFAULT_HOST;
const server = createWebhookServer({
  webhookSecret: config.webhookSecret,
  tokens: createInstallationTokens(config.appId, config.privateKey),
  listRepos: (token) => listInstallationRepos(token),
  queue: createMemoryQueue(),
  recordVerdict: logVerdict,
});

server.listen(config.port, host, () => {
  console.log(`listening on http://${host}:${config.port}/webhooks`);
});

const shutdown = () => server.close();
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
