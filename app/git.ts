import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unredact } from '../harness/secrets.ts';
import { REPO_PATTERN } from './types.ts';
import type { FileChange } from './types.ts';

const DELETED = 'D';
// A stalled clone must end as a failed job, not hold the one queue for every customer.
const GIT_TIMEOUT_MS = 15 * 60 * 1000;

export class GitError extends Error {
  constructor(args: string[], code: number | string | null, stderr: string) {
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

type GitOptions = { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number };

// Only git itself runs here, never the repo's code: no hooks run on clone, read-tree, apply or show.
function git(
  args: string[],
  { cwd, env, input, timeoutMs = GIT_TIMEOUT_MS }: GitOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
      timeout: timeoutMs,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('exit', (_code, signal) => {
      if (!signal) return;
      // A helper git started can outlive it and hold the pipes open, so 'close' may never come.
      child.stdout.destroy();
      child.stderr.destroy();
      reject(new GitError(args, signal, Buffer.concat(stderr).toString('utf8')));
    });
    child.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(stdout).toString('utf8'))
        : reject(new GitError(args, code, Buffer.concat(stderr).toString('utf8'))),
    );
    child.stdin.end(input);
  });
}

// The token goes in through the environment, so it never lands in argv, .git/config or an error message.
export async function cloneRepo(
  token: string,
  repo: string,
  dir: string,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<void> {
  if (!REPO_PATTERN.test(repo)) throw new InvalidRepoError(repo);
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  await git(
    ['clone', '--quiet', '--depth', '1', '--no-tags', `https://github.com/${repo}.git`, dir],
    {
      timeoutMs,
      env: {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
      },
    },
  );
}

export const treeOfCheckout = async (dir: string): Promise<string> =>
  (await git(['rev-parse', 'HEAD^{tree}'], { cwd: dir })).trim();

// Applies the harness's diff to a scratch index, never the checkout's files, and reads back each file.
// shortcut: text files only; a binary or mode-only change needs `git diff --binary` from the harness first.
export async function filesFromDiff(repoDir: string, diff: string): Promise<FileChange[]> {
  const scratch = await mkdtemp(join(tmpdir(), 'aptitude-index-'));
  const options = { cwd: repoDir, env: { GIT_INDEX_FILE: join(scratch, 'index') } };
  try {
    await git(['read-tree', 'HEAD'], options);
    const originals = new Map<string, string[] | undefined>();
    for (const [, file] of diff.matchAll(/^--- a\/(.+)$/gm)) {
      const text = await git(['show', `HEAD:${file}`], { cwd: repoDir }).catch(() => undefined);
      originals.set(file as string, text?.split('\n'));
    }
    const input = unredact(diff, (file) => originals.get(file));
    await git(['apply', '--cached', '--whitespace=nowarn', '-'], { ...options, input });
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
