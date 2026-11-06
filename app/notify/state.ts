import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

function parseKeys(content: string): Set<string> | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!Array.isArray(parsed)) return undefined;
    return new Set(parsed.filter((key): key is string => typeof key === 'string'));
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export async function readSent(file: string): Promise<Set<string>> {
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw error;
  }
  const keys = parseKeys(content);
  if (keys) return keys;
  // Unlike the queue, starting empty is the safe side here: one repeated alert beats no alerts.
  console.error('notify: state file is corrupt, starting it again');
  return new Set();
}

// shortcut: the file only grows and one process owns it, prune it and share it when a store exists.
export async function writeSent(file: string, keys: Iterable<string>): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify([...keys]));
  await rename(temporary, file);
}
