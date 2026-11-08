import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { redactLogs } from './logs.ts';

const PRIVATE_KEY =
  '-----BEGIN RSA PRIVATE KEY-----\nMIIEfixtureNotARealKey0123456789\nabcdef\n-----END RSA PRIVATE KEY-----';
const ENV = {
  GITHUB_APP_PRIVATE_KEY: PRIVATE_KEY,
  GITHUB_WEBHOOK_SECRET: 'fixture-webhook-secret-value',
  REFIT_SERVICE_TOKEN: 'fixture-service-token-value',
  ANTHROPIC_API_KEY: 'sk-ant-fixture0000000000000000000000',
};
const SECRETS = Object.values(ENV);
const INSTALLATION_TOKEN = 'ghs_fixtureInstallationToken000000000000';
const METHODS = ['debug', 'info', 'log', 'warn', 'error'] as const;

describe('redactLogs', () => {
  const originals = Object.fromEntries(METHODS.map((method) => [method, console[method]]));
  const before = process.listeners('uncaughtException');

  afterEach(() => {
    Object.assign(console, originals);
    for (const listener of process.listeners('uncaughtException')) {
      if (!before.includes(listener)) process.off('uncaughtException', listener);
    }
    vi.restoreAllMocks();
  });

  it.each(METHODS)('console.%s prints no secret in any argument shape', (method) => {
    const printed: string[] = [];
    console[method] = (...args: unknown[]) => void printed.push(args.join(' '));
    redactLogs(ENV);
    for (const secret of SECRETS) {
      console[method](`failed with ${secret}`);
      console[method]('job failed:', new Error(`clone used ${secret}`));
      console[method]({ nested: { value: secret } });
      console[method]('%s then %o', secret, [secret]);
    }
    console[method](`git said x-access-token:${INSTALLATION_TOKEN}`);
    const output = printed.join('\n');
    for (const secret of [...SECRETS, INSTALLATION_TOKEN]) expect(output).not.toContain(secret);
    expect(output).toContain('job failed:');
  });

  it('keeps ordinary lines readable', () => {
    const printed: string[] = [];
    console.log = (...args: unknown[]) => void printed.push(args.join(' '));
    redactLogs(ENV);
    console.log('queued scan %s', 'refit-example-org/billing-api');
    expect(printed).toEqual(['queued scan refit-example-org/billing-api']);
  });

  it('redacts an uncaught error, which node would print past console', async () => {
    const script = `
      import { redactLogs } from ${JSON.stringify(new URL('logs.ts', import.meta.url).href)};
      redactLogs();
      throw new Error('crashed holding ' + process.env.GITHUB_WEBHOOK_SECRET);
    `;
    const run = promisify(execFile)(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', script],
      { env: { PATH: process.env.PATH, ...ENV } },
    );
    const failure = (await run.then(
      () => expect.unreachable('the crash must exit non-zero'),
      (error: unknown) => error,
    )) as { code: number; stderr: string };
    expect(failure.code, failure.stderr).toBe(1);
    expect(failure.stderr).toContain('crashed holding');
    expect(failure.stderr).not.toContain(ENV.GITHUB_WEBHOOK_SECRET);
  });
});
