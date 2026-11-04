import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_PATTERN } from './types.ts';
import type { FileChange } from './types.ts';

const DELETED = 'D';

export class GitError extends Error {
  constructor(args: string[], code: number | null, stderr: string) {
    super(`git ${args[0]} exited with ${code}: ${stderr.trim()}`);
    this.name = 'GitError';
  }
}

export class InvalidRepoError extends Error {
  constructor(repo: string) {
    super(`Not a GitHub owner/name: ${JSON.stringify(repo)}`);
    this.name = 'InvalidRepoError';
  }
}

type GitOptions = { cwd?: string; env?: NodeJS.ProcessEnv; input?: string };

// Only git itself runs here, never the repo's code: no hooks run on clone, read-tree, apply or show.
function git(args: string[], { cwd, env, input }: GitOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(stdout).toString('utf8'))
        : reject(new GitError(args, code, Buffer.concat(stderr).toString('utf8'))),
    );
    child.stdin.end(input);
  });
}

// The token goes in through the environment, so it never lands in argv, .git/config or an error message.
export async function cloneRepo(token: string, repo: string, dir: string): Promise<void> {
  if (!REPO_PATTERN.test(repo)) throw new InvalidRepoError(repo);
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  await git(
    ['clone', '--quiet', '--depth', '1', '--no-tags', `https://github.com/${repo}.git`, dir],
    {
      env: {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
      },
    },
  );
}

// Applies the harness's diff to a scratch index, never the checkout's files, and reads back each file.
// shortcut: text files only; a binary or mode-only change needs `git diff --binary` from the harness first.
export async function filesFromDiff(repoDir: string, diff: string): Promise<FileChange[]> {
  const scratch = await mkdtemp(join(tmpdir(), 'refit-index-'));
  const options = { cwd: repoDir, env: { GIT_INDEX_FILE: join(scratch, 'index') } };
  try {
    await git(['read-tree', 'HEAD'], options);
    await git(['apply', '--cached', '--whitespace=nowarn', '-'], { ...options, input: diff });
    const status = await git(
      ['diff', '--cached', '--name-status', '--no-renames', '-z', 'HEAD'],
      options,
    );
    const fields = status.split('\0').filter(Boolean);
    const changes: FileChange[] = [];
    for (let index = 0; index < fields.length; index += 2) {
      const [code, path] = [fields[index], fields[index + 1]];
      changes.push(
        code === DELETED
          ? { path, delete: true }
          : { path, content: await git(['show', `:${path}`], options) },
      );
    }
    return changes;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
