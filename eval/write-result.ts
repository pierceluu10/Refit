import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RESULTS = join(dirname(fileURLToPath(import.meta.url)), 'results');

export function resultStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export async function writeResult(name: string, value: unknown) {
  await mkdir(RESULTS, { recursive: true });
  const file = join(RESULTS, `${name}-${resultStamp()}.json`);
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}
