import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InvalidConfigError, MissingConfigError, readConfig, readCredentials } from './config.ts';

const PEM = '-----BEGIN RSA PRIVATE KEY-----\nfake-key-for-tests\n-----END RSA PRIVATE KEY-----\n';
const BASE = { GITHUB_APP_ID: '12345', GITHUB_WEBHOOK_SECRET: 'super-secret-value' };

describe('readConfig', () => {
  it('reads an inline key and defaults the port', () => {
    expect(readConfig({ ...BASE, GITHUB_APP_PRIVATE_KEY: PEM })).toEqual({
      appId: '12345',
      privateKey: PEM,
      webhookSecret: 'super-secret-value',
      port: 3000,
      queueFile: '.refit/queue.json',
      queueConcurrency: 2,
    });
  });

  it('reads the key from a file and honours PORT', () => {
    const dir = mkdtempSync(join(tmpdir(), 'refit-config-'));
    try {
      const file = join(dir, 'app.pem');
      writeFileSync(file, PEM);
      const config = readConfig({ ...BASE, GITHUB_APP_PRIVATE_KEY_FILE: file, PORT: '4100' });
      expect(config.privateKey).toBe(PEM);
      expect(config.port).toBe(4100);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it.each([
    [
      'GITHUB_APP_ID',
      { GITHUB_WEBHOOK_SECRET: BASE.GITHUB_WEBHOOK_SECRET, GITHUB_APP_PRIVATE_KEY: PEM },
    ],
    ['GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_FILE', BASE],
    ['GITHUB_WEBHOOK_SECRET', { GITHUB_APP_ID: BASE.GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY: PEM }],
  ])('names %s when missing and leaks no values', (variable, env) => {
    let caught: unknown;
    try {
      readConfig(env);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MissingConfigError);
    const message = (caught as Error).message;
    expect(message).toBe(`Missing environment variable ${variable}`);
    for (const value of [PEM, BASE.GITHUB_APP_ID, BASE.GITHUB_WEBHOOK_SECRET]) {
      expect(message).not.toContain(value);
    }
  });
});

describe('REFIT_QUEUE_CONCURRENCY', () => {
  const env = { ...BASE, GITHUB_APP_PRIVATE_KEY: PEM };

  it('honours a whole number', () => {
    expect(readConfig({ ...env, REFIT_QUEUE_CONCURRENCY: '5' }).queueConcurrency).toBe(5);
  });

  it.each(['0', '-1', '1.5', 'many'])('rejects %s', (value) => {
    expect(() => readConfig({ ...env, REFIT_QUEUE_CONCURRENCY: value })).toThrow(
      InvalidConfigError,
    );
  });
});

describe('readCredentials', () => {
  it('returns the App identity without needing a webhook secret', () => {
    expect(readCredentials({ GITHUB_APP_ID: '12345', GITHUB_APP_PRIVATE_KEY: PEM })).toEqual({
      appId: '12345',
      privateKey: PEM,
    });
  });

  it('is undefined when either half is missing', () => {
    expect(readCredentials({})).toBeUndefined();
    expect(readCredentials({ GITHUB_APP_ID: '12345' })).toBeUndefined();
    expect(readCredentials({ GITHUB_APP_PRIVATE_KEY: PEM })).toBeUndefined();
  });
});
