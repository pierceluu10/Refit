import { readFileSync } from 'node:fs';

const DEFAULT_PORT = 3000;
const DEFAULT_QUEUE_FILE = '.aptitude/queue.json';
const DEFAULT_DATA_DIR = '.aptitude/app';

export class MissingConfigError extends Error {
  constructor(variable: string) {
    super(`Missing environment variable ${variable}`);
    this.name = 'MissingConfigError';
  }
}

export type AppConfig = {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  port: number;
  queueFile: string;
  dataDir: string;
};

// Where the app keeps installation settings and what it has seen of each fix.
export const appDataDir = (env: NodeJS.ProcessEnv = process.env) =>
  env.APTITUDE_APP_DIR || DEFAULT_DATA_DIR;

function required(env: NodeJS.ProcessEnv, variable: string): string {
  const value = env[variable];
  if (!value) throw new MissingConfigError(variable);
  return value;
}

function readPrivateKey(env: NodeJS.ProcessEnv): string {
  if (env.GITHUB_APP_PRIVATE_KEY) return env.GITHUB_APP_PRIVATE_KEY;
  if (env.GITHUB_APP_PRIVATE_KEY_FILE) return readFileSync(env.GITHUB_APP_PRIVATE_KEY_FILE, 'utf8');
  throw new MissingConfigError('GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_FILE');
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    appId: required(env, 'GITHUB_APP_ID'),
    privateKey: readPrivateKey(env),
    webhookSecret: required(env, 'GITHUB_WEBHOOK_SECRET'),
    port: env.PORT ? Number(env.PORT) : DEFAULT_PORT,
    queueFile: env.APTITUDE_QUEUE_FILE || DEFAULT_QUEUE_FILE,
    dataDir: appDataDir(env),
  };
}
