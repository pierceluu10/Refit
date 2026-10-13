import { mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isObject, parseObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import { hostname } from 'node:os';

export function hasErrorCode(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && error.code === code;
}

export async function stateDirectoryOutsideRepository(repository: string, directory: string) {
  const root = await realpath(repository);
  const path = resolve(directory);
  const inside = (candidate: string) => {
    const location = relative(root, candidate);
    return (
      !location || (location !== '..' && !location.startsWith(`..${sep}`) && !isAbsolute(location))
    );
  };
  if (inside(path))
    throw new PipelineInputError('Watch state must be outside the monitored repository.');
  await mkdir(path, { recursive: true, mode: 0o700 });
  const physical = await realpath(path);
  if (inside(physical))
    throw new PipelineInputError('Watch state must not resolve inside the monitored repository.');
  return physical;
}

export async function readState(path: string) {
  try {
    return parseObject(await readFile(path, 'utf8'), path);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

export async function writeState(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const handle = await open(temporary, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function withStateLock<T>(
  directory: string,
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${name}.lock`);
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      let owner;
      try {
        owner = await readState(path);
      } catch (cause) {
        throw new PipelineInputError(
          `State ownership is unreadable: ${path}. Inspect the lock before retrying.`,
          { cause },
        );
      }
      if (
        !owner ||
        owner.host !== hostname() ||
        !Number.isSafeInteger(owner.pid) ||
        Number(owner.pid) <= 0 ||
        typeof owner.nonce !== 'string'
      )
        throw new PipelineInputError(
          `State ownership cannot be verified: ${path}. Inspect the lock before retrying.`,
        );
      let alive = true;
      try {
        process.kill(Number(owner.pid), 0);
      } catch (error) {
        if (hasErrorCode(error, 'ESRCH')) alive = false;
        else throw error;
      }
      if (alive)
        throw new PipelineInputError(`State is locked by active process ${owner.pid}: ${path}.`);
      const recovery = `${path}.recovery`;
      try {
        await mkdir(recovery, { mode: 0o700 });
      } catch (error) {
        if (hasErrorCode(error, 'EEXIST'))
          throw new PipelineInputError(`State recovery is already in progress: ${path}.`);
        throw error;
      }
      try {
        const current = await readState(path);
        if (!isObject(current) || current.nonce !== owner.nonce)
          throw new PipelineInputError(
            'Lock ownership changed during recovery. Retry the state operation.',
          );
        await rm(path);
        handle = await open(path, 'wx', 0o600);
      } finally {
        await rm(recovery, { recursive: true, force: true });
      }
    } else throw error;
  }
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, host: hostname(), nonce: randomUUID() }),
    );
    return await operation();
  } finally {
    await handle.close();
    await rm(path);
  }
}
