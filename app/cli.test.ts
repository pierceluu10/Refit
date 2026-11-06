import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunRepoJob } from '../shared/types.ts';
import { main, NotInstalledError, openerFor, originRepo } from './cli.ts';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const CREDENTIALS = { appId: '1', privateKey };
const REPO = 'refit-example-org/billing-api';

let dir: string;
const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args]);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'refit-cli-'));
  git('init', '--quiet');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('originRepo', () => {
  it.each([
    [`https://github.com/${REPO}.git`, REPO],
    [`https://github.com/${REPO}`, REPO],
    [`git@github.com:${REPO}.git`, REPO],
    [`https://x-access-token:not-a-real-token@github.com/${REPO}.git`, REPO],
    ['https://gitlab.com/refit-example-org/billing-api.git', undefined],
  ])('reads %s as %s', async (url, expected) => {
    git('remote', 'add', 'origin', url);
    expect(await originRepo(dir)).toBe(expected);
  });

  it('is undefined with no origin or outside git', async () => {
    expect(await originRepo(dir)).toBeUndefined();
    expect(await originRepo(join(dir, 'missing'))).toBeUndefined();
  });
});

describe('openerFor', () => {
  it('keeps the stub without credentials or without a GitHub repo, and never calls GitHub', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (const [repo, credentials] of [
      [REPO, undefined],
      [undefined, CREDENTIALS],
    ] as const) {
      const { real, openPullRequest } = await openerFor(repo, credentials, fetchImpl);
      expect(real).toBe(false);
      const link = await openPullRequest(
        { id: 'illustrative-task' } as never,
        {} as never,
        '/illustrative',
      );
      expect(link).toBe('stub://pr/illustrative-task');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('asks GitHub which installation owns the repo and returns the real opener', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json({ id: 70000001 }));
    expect((await openerFor(REPO, CREDENTIALS, fetchImpl)).real).toBe(true);
    expect(String(fetchImpl.mock.calls[0][0])).toContain(`/repos/${REPO}/installation`);
  });

  it('fails before any spend when the App is not installed on the repo', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json({ message: 'Not Found' }, 404));
    await expect(openerFor(REPO, CREDENTIALS, fetchImpl)).rejects.toThrow(NotInstalledError);
  });
});

describe('main', () => {
  it('runs with the stub opener and the folder name when nothing identifies the repo', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: Parameters<RunRepoJob>[0][] = [];
    const run: RunRepoJob = async (input) => {
      calls.push(input);
      return [];
    };
    expect(await main(['run', '--repo', dir, '--dry-run'], {}, run)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].dir).toBe(dir);
    expect(calls[0].dryRun).toBe(true);
    expect(REPO).not.toBe(calls[0].repo);
  });

  it.each([[['run']], [['walk', '--repo', '.']], [['run', '--repo', '/no/such/refit/path']]])(
    'exits 2 with usage for %j',
    async (argv) => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const run = vi.fn<RunRepoJob>();
      expect(await main(argv, {}, run)).toBe(2);
      expect(run).not.toHaveBeenCalled();
      expect(errors.mock.calls[0][0]).toContain('usage: refit run');
    },
  );
});
