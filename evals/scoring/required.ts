// Required changes, locked before a round. Each says what must be gone from a file and what must
// replace it. A lock proves itself: every change fails at baseline and passes on its proof edit, so
// a change that was never broken or can never pass counts for nothing.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export { majorUpgrades } from '../../harness/findings.ts';

export type RequiredChange = {
  id: string;
  entryId: string;
  file: string;
  /** Regex that matches while the break is there. */
  dead: string;
  /** Regexes that show the fix: at least one must match. Empty when removing the code is the fix. */
  alive: string[];
  /** The smallest edits that fix it, used only to prove the lock can pass. */
  proof: { from: string; to: string } | { from: string; to: string }[];
};

export type RepoLock = { repo: string; commit: string; required: RequiredChange[] };

const read = (dir: string, file: string) => {
  try {
    return readFileSync(path.join(dir, file), 'utf8');
  } catch {
    return '';
  }
};

export function gradeChange(dir: string, change: RequiredChange): { fixed: boolean; why: string } {
  const text = read(dir, change.file);
  if (!text) return { fixed: change.alive.length === 0, why: `${change.file} is gone` };
  if (new RegExp(change.dead).test(text)) return { fixed: false, why: 'dead code still there' };
  const replaced =
    change.alive.length === 0 || change.alive.some((alive) => new RegExp(alive).test(text));
  return replaced
    ? { fixed: true, why: 'dead code gone and the replacement is there' }
    : { fixed: false, why: 'dead code gone, but no replacement from the list' };
}

/** Problems with a lock on a pristine checkout, or none. Edits the checkout: pass a throwaway copy. */
export function proveLock(dir: string, lock: RepoLock): string[] {
  const problems: string[] = [];
  for (const change of lock.required) {
    if (gradeChange(dir, change).fixed) problems.push(`${change.id} passes at baseline`);
    let text = read(dir, change.file);
    const edits = Array.isArray(change.proof) ? change.proof : [change.proof];
    if (!edits.some(({ from }) => text.includes(from))) {
      problems.push(`${change.id}: proof edit not found`);
    }
    for (const { from, to } of edits) text = text.split(from).join(to);
    writeFileSync(path.join(dir, change.file), text);
  }
  for (const change of lock.required) {
    if (!gradeChange(dir, change).fixed) problems.push(`${change.id} fails on its proof edit`);
  }
  return problems;
}
