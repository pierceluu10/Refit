import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises';
import { devNull } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { authenticateGitHubRead, type GitHubAppConfiguration } from './github-app.ts';
import { requestGitHub } from './github.ts';
import { gitEnvironment } from './git-environment.ts';
import { publicationConfiguration } from './publication.ts';
import { digest, isObject } from './specifications.ts';
import { hasErrorCode, readState, withStateLock, writeState } from './state-files.ts';
import { PipelineInputError } from './types.ts';

const execute = promisify(execFile);
const FETCH_TIMEOUT_MS = 60_000;
const GIT_TIMEOUT_MS = 30_000;
const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;
const REVISION = /^[a-f0-9]{40}$/;
const STAGING_DIRECTORY = /^\.checkout-[a-f0-9-]{36}$/;

export interface GitHubCheckoutTarget {
  repository: string;
  base: string;
  app: GitHubAppConfiguration;
}
export interface GitHubCheckout {
  directory: string;
  repository: string;
  base: string;
  revision: string;
}

function revision(value: unknown): string {
  if (typeof value !== 'string' || !REVISION.test(value))
    throw new PipelineInputError('Managed checkout requires a valid committed Git object ID.');
  return value;
}

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return false;
    throw error;
  }
}

async function physicalDirectory(path: string) {
  const status = await lstat(path);
  if (!status.isDirectory() || status.isSymbolicLink() || (await realpath(path)) !== path)
    throw new PipelineInputError('Managed checkout directories must not be symbolic links.');
}

async function git(directory: string, args: string[], token?: string) {
  try {
    return await execute('git', ['-C', directory, ...args], {
      env: gitEnvironment(token),
      timeout: args[0] === 'fetch' ? FETCH_TIMEOUT_MS : GIT_TIMEOUT_MS,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    });
  } catch (cause) {
    if (!(cause instanceof Error)) throw cause;
    let details =
      'stderr' in cause && typeof cause.stderr === 'string' ? cause.stderr : cause.message;
    if (token) {
      for (const secret of [token, Buffer.from(`x-access-token:${token}`).toString('base64')])
        details = details.replaceAll(secret, '[redacted]');
    }
    throw new PipelineInputError(
      `Managed Git ${args[0]} failed: ${details.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 512)}`,
    );
  }
}

async function verifyCheckout(directory: string, state: Record<string, unknown>, remote: string) {
  await physicalDirectory(directory);
  await physicalDirectory(join(directory, '.git'));
  const config = join(directory, '.git', 'config');
  if (
    !(await lstat(config)).isFile() ||
    (await lstat(config)).isSymbolicLink() ||
    digest(await readFile(config)) !== state.configHash
  )
    throw new PipelineInputError(
      'Managed Git configuration changed. Refusing to run or overwrite this checkout.',
    );
  if ((await git(directory, ['remote', 'get-url', 'origin'])).stdout.trim() !== remote)
    throw new PipelineInputError(
      'Managed checkout remote does not match the authorized repository.',
    );
  if (
    (await git(directory, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching']))
      .stdout
  )
    throw new PipelineInputError(
      'Managed checkout has local changes or extra files. Refusing to overwrite them.',
    );
  const head = revision(
    (await git(directory, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim(),
  );
  if (head !== state.revision && !(state.phase === 'updating' && head === state.pendingRevision))
    throw new PipelineInputError(
      'Managed checkout HEAD changed outside Refit. Refusing to advance it.',
    );
  return head;
}

export async function withGitHubCheckout<T>(
  options: {
    directory: string;
    target: GitHubCheckoutTarget;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
  },
  operation: (checkout: GitHubCheckout) => Promise<T>,
) {
  const { target } = options;
  publicationConfiguration(target.repository, target.base, undefined, target.app);
  const root = resolve(options.directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await realpath(root);
  return withStateLock(directory, 'checkout', async () => {
    options.signal?.throwIfAborted();
    const identity = digest(
      JSON.stringify({
        repository: target.repository.toLowerCase(),
        base: target.base,
        appId: target.app.appId,
      }),
    );
    const statePath = join(directory, 'managed-checkout.json');
    const checkout = join(directory, 'checkout');
    const remote = `https://github.com/${target.repository}.git`;
    let state = await readState(statePath);
    if (
      state &&
      (state.formatVersion !== 1 ||
        state.identity !== identity ||
        !['prepared', 'ready', 'updating'].includes(String(state.phase)) ||
        typeof state.configHash !== 'string')
    )
      throw new PipelineInputError(
        'Managed checkout state belongs to another GitHub target or is invalid.',
      );
    if (!state && (await exists(checkout)))
      throw new PipelineInputError(
        'Checkout exists without Refit ownership evidence. Choose a new state directory.',
      );
    if (state?.phase === 'prepared') {
      if (typeof state.stagingName !== 'string' || !STAGING_DIRECTORY.test(state.stagingName))
        throw new PipelineInputError('Prepared checkout has invalid staging evidence.');
      const staging = join(directory, state.stagingName);
      if (!(await exists(checkout))) {
        await verifyCheckout(staging, state, remote);
        await rename(staging, checkout);
      } else if (await exists(staging))
        throw new PipelineInputError(
          'Prepared checkout has ambiguous destinations. Inspect its state before retrying.',
        );
      state = { ...state, phase: 'ready' };
      await writeState(statePath, state);
    }
    if (state) {
      const head = await verifyCheckout(checkout, state, remote);
      if (state.phase === 'updating' && head === state.pendingRevision) {
        state = { ...state, phase: 'ready', revision: head, pendingRevision: null };
        await writeState(statePath, state);
      }
    }
    options.onProgress?.(
      `Refreshing ${target.repository} at ${target.base} with the GitHub App...`,
    );
    const authentication = await authenticateGitHubRead(target.app, target.repository);
    const reference = await requestGitHub(
      authentication.token,
      'GET',
      `/repos/${target.repository}/git/ref/heads/${encodeURIComponent(target.base)}`,
    );
    if (!isObject(reference) || !isObject(reference.object) || reference.object.type !== 'commit')
      throw new PipelineInputError('GitHub base does not reference a commit.');
    const nextRevision = revision(reference.object.sha);
    options.signal?.throwIfAborted();
    if (!state) {
      const stagingName = `.checkout-${randomUUID()}`;
      const staging = join(directory, stagingName);
      const template = await mkdtemp(join(directory, '.template-'));
      let prepared = false;
      try {
        await mkdir(staging, { mode: 0o700 });
        await git(staging, ['init', '--quiet', `--template=${template}`]);
        await git(staging, ['config', 'core.hooksPath', devNull]);
        await git(staging, ['config', 'core.fsmonitor', 'false']);
        await git(staging, ['remote', 'add', 'origin', remote]);
        await git(
          staging,
          ['fetch', '--quiet', '--depth=1', '--no-tags', 'origin', nextRevision],
          authentication.token,
        );
        options.signal?.throwIfAborted();
        await git(staging, ['checkout', '--quiet', '--detach', nextRevision]);
        state = {
          formatVersion: 1,
          identity,
          phase: 'prepared',
          stagingName,
          revision: nextRevision,
          configHash: digest(await readFile(join(staging, '.git', 'config'))),
        };
        await verifyCheckout(staging, state, remote);
        await writeState(statePath, state);
        prepared = true;
        await rename(staging, checkout);
        state = { ...state, phase: 'ready' };
        await writeState(statePath, state);
      } finally {
        await rm(template, { recursive: true, force: true });
        if (!prepared) await rm(staging, { recursive: true, force: true });
      }
    } else if (state.revision !== nextRevision) {
      await git(
        checkout,
        ['fetch', '--quiet', '--depth=1', '--no-tags', 'origin', nextRevision],
        authentication.token,
      );
      options.signal?.throwIfAborted();
      state = { ...state, phase: 'updating', pendingRevision: nextRevision };
      await writeState(statePath, state);
      await git(checkout, ['checkout', '--quiet', '--detach', nextRevision]);
      state = { ...state, phase: 'ready', revision: nextRevision, pendingRevision: null };
      await verifyCheckout(checkout, state, remote);
      await writeState(statePath, state);
    }
    options.signal?.throwIfAborted();
    options.onProgress?.(
      `Managed checkout: ${nextRevision.slice(0, 12)}. Your working copy is unchanged.`,
    );
    return operation({
      directory: checkout,
      repository: target.repository,
      base: target.base,
      revision: nextRevision,
    });
  });
}
