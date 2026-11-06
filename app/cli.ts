#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { runRepoJob } from '../orchestrator/index.ts';
import { stubOpenPullRequest } from '../orchestrator/stubs.ts';
import type { OpenPullRequest, RunRepoJob } from '../shared/types.ts';
import { readCredentials } from './config.ts';
import type { AppCredentials } from './config.ts';
import { createAppJwt, createInstallationTokens, installationForRepo } from './github.ts';
import { createOpenPullRequest } from './pr.ts';
import { REPO_PATTERN } from './types.ts';

const USAGE = 'usage: refit run --repo <path> [--repo <path> ...] [--dry-run]';
const GIT_TIMEOUT_MS = 10_000;
const GITHUB_REMOTE = /github\.com[:/](.+?)(?:\.git)?\/?$/;

export class NotInstalledError extends Error {
  constructor(repo: string, cause: unknown) {
    super(`The Refit App can't reach ${repo}, so no PR could open. Install it there first.`, {
      cause,
    });
    this.name = 'NotInstalledError';
  }
}

// owner/name from the checkout's origin, or undefined when it isn't on GitHub. This only reads git
// metadata on the host; nothing in the repo runs. Any URL credentials are dropped with the match.
export async function originRepo(dir: string): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)(
      'git',
      ['-C', dir, 'remote', 'get-url', 'origin'],
      {
        timeout: GIT_TIMEOUT_MS,
      },
    );
    const repo = GITHUB_REMOTE.exec(stdout.trim())?.[1];
    return repo && REPO_PATTERN.test(repo) ? repo : undefined;
  } catch {
    return undefined; // not a git checkout, or no origin
  }
}

// The real opener when App credentials are present and the checkout is on GitHub; the stub otherwise.
export async function openerFor(
  repo: string | undefined,
  credentials: AppCredentials | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<{ openPullRequest: OpenPullRequest; real: boolean }> {
  if (!repo || !credentials) return { openPullRequest: stubOpenPullRequest, real: false };
  const { appId, privateKey } = credentials;
  let installationId: number;
  try {
    installationId = await installationForRepo(createAppJwt(appId, privateKey), repo, fetchImpl);
  } catch (error) {
    throw new NotInstalledError(repo, error); // before any spend: the run could never open its PR
  }
  const tokens = createInstallationTokens(appId, privateKey, fetchImpl);
  return { openPullRequest: createOpenPullRequest(tokens, installationId, fetchImpl), real: true };
}

function parse(argv: string[], cwd: string) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: 'string', multiple: true },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  if (positionals.length !== 1 || positionals[0] !== 'run') throw new Error('expected `run`');
  if (!values.repo?.length) throw new Error('--repo is required');
  const dirs = values.repo.map((path) => {
    const dir = resolve(cwd, path);
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`${dir} is not a directory`);
    }
    return dir;
  });
  return { dirs, dryRun: values['dry-run'] };
}

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  run: RunRepoJob = runRepoJob,
): Promise<number> {
  let args: ReturnType<typeof parse>;
  try {
    // npm runs workspace scripts from app/, so a relative path means where the person typed it.
    args = parse(argv, env.INIT_CWD ?? process.cwd());
  } catch (error) {
    console.error(`refit: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  try {
    const credentials = readCredentials(env);
    for (const dir of args.dirs) {
      const origin = await originRepo(dir);
      const { openPullRequest, real } = await openerFor(origin, credentials);
      const repo = origin ?? basename(dir);
      if (!real) console.warn(`${repo}: PR links are stubs (no App credentials or GitHub origin)`);
      const records = await run({ repo, dir, openPullRequest, dryRun: args.dryRun });
      console.log(`Refit run on ${repo}${args.dryRun ? ' (dry run: no PRs opened)' : ''}`);
      for (const { taskId, outcome, pr } of records) {
        console.log(`  ${outcome.padEnd(12)} ${taskId}${pr ? `  ${pr}` : ''}`);
      }
    }
    return 0;
  } catch (error) {
    console.error(`refit: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
