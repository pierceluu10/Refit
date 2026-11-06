import { readFileSync } from 'node:fs';

const DEFAULT_PORT = 3000;
const DEFAULT_QUEUE_FILE = '.refit/queue.json';
const DEFAULT_QUEUE_CONCURRENCY = 2;

export class MissingConfigError extends Error {
  constructor(variable: string) {
    super(`Missing environment variable ${variable}`);
    this.name = 'MissingConfigError';
  }
}

export class InvalidConfigError extends Error {
  constructor(variable: string, expected: string) {
    super(`Environment variable ${variable} must be ${expected}`);
    this.name = 'InvalidConfigError';
  }
}

export type AppCredentials = { appId: string; privateKey: string };

export type AppConfig = AppCredentials & {
  webhookSecret: string;
  port: number;
  queueFile: string;
  queueConcurrency: number;
};

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

function readConcurrency(env: NodeJS.ProcessEnv): number {
  if (!env.REFIT_QUEUE_CONCURRENCY) return DEFAULT_QUEUE_CONCURRENCY;
  const concurrency = Number(env.REFIT_QUEUE_CONCURRENCY);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new InvalidConfigError('REFIT_QUEUE_CONCURRENCY', 'a whole number of at least 1');
  }
  return concurrency;
}

// The App's identity, for callers that open PRs without serving webhooks, like the CLI.
export function readCredentials(env: NodeJS.ProcessEnv = process.env): AppCredentials | undefined {
  if (!env.GITHUB_APP_ID) return undefined;
  if (!env.GITHUB_APP_PRIVATE_KEY && !env.GITHUB_APP_PRIVATE_KEY_FILE) return undefined;
  return { appId: env.GITHUB_APP_ID, privateKey: readPrivateKey(env) };
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    appId: required(env, 'GITHUB_APP_ID'),
    privateKey: readPrivateKey(env),
    webhookSecret: required(env, 'GITHUB_WEBHOOK_SECRET'),
    port: env.PORT ? Number(env.PORT) : DEFAULT_PORT,
    queueFile: env.REFIT_QUEUE_FILE || DEFAULT_QUEUE_FILE,
    queueConcurrency: readConcurrency(env),
  };
}
