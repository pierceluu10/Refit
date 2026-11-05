// Changes when the code that reads a repo changes, so an improved scanner re-reads a clean repo once.
// Whole folders and no list to keep up, so a new scanner file can't be missed. An unrelated edit in them
// re-reads repos once too, which costs a clone each and an AI check only where a repo has unclear hits.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SOURCE_DIRS = ['inventory', 'dead-apis'];
const isSource = (file: string) => file.endsWith('.ts') && !file.endsWith('.test.ts');

/** A hash of the scanner's source under `root`. Tests and the list's data don't count. */
export function hashScannerSources(root: string): string {
  const hash = createHash('sha256');
  for (const dir of SOURCE_DIRS) {
    for (const file of readdirSync(path.join(root, dir)).filter(isSource).sort()) {
      hash.update(`${dir}/${file}\0`);
      hash.update(readFileSync(path.join(root, dir, file)));
    }
  }
  return hash.digest('hex');
}

export const SCANNER_VERSION = hashScannerSources(path.join(import.meta.dirname, '..'));
