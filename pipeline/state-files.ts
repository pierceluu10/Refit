import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parseObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';

export function hasErrorCode(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && error.code === code;
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
    if (hasErrorCode(error, 'EEXIST'))
      throw new PipelineInputError(
        `State is locked: ${path}. Another process may be active; stale locks require operator inspection.`,
      );
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid }));
    return await operation();
  } finally {
    await handle.close();
    await rm(path);
  }
}
