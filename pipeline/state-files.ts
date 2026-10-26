import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isObject, parseObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import { hostname, uptime } from 'node:os';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';

// Evidence that holds a full contract diff is stored gzip-compressed under its name plus this
// suffix: a Stripe 2024-06-20 to 2026-09-30.endive scan is about 90 MB of JSON and 2 MB gzipped.
export const COMPRESSED_SUFFIX = '.gz';
export const compressEvidence = promisify(gzip);
const decompress = promisify(gunzip);

// The text of `name` in an evidence directory, compressed or as Refit wrote it before compression,
// or undefined when neither exists.
export async function readEvidence(directory: string, name: string) {
  for (const path of [`${name}${COMPRESSED_SUFFIX}`, name]) {
    try {
      const content = await readFile(join(directory, path));
      return (path === name ? content : await decompress(content)).toString('utf8');
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error;
    }
  }
  return undefined;
}

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
  await writeAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeAtomically(path: string, content: string | Uint8Array) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
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

// Linux's identifier for the current boot; other systems have none.
export const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';

async function bootId() {
  try {
    return (await readFile(BOOT_ID_PATH, 'utf8')).trim();
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

// After a restart a lock's process ID can belong to another process (on Fly the machine keeps its
// hostname), so a lock from an earlier boot is stale. A lock without a boot id, written before
// they were recorded or where there is none, is from an earlier boot when its file predates it.
async function fromEarlierBoot(path: string, owner: Record<string, unknown>, boot?: string) {
  if (typeof owner.boot === 'string') return boot !== undefined && owner.boot !== boot;
  return (await stat(path)).mtimeMs < Date.now() - uptime() * 1000;
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
      let alive = !(await fromEarlierBoot(path, owner, await bootId()));
      if (alive)
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
    const boot = await bootId();
    await handle.writeFile(
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        nonce: randomUUID(),
        ...(boot ? { boot } : {}),
      }),
    );
    return await operation();
  } finally {
    await handle.close();
    await rm(path);
  }
}
