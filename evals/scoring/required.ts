// Required changes, locked before a round. Each says what must be gone from a file and what must
// replace it. A lock proves itself: every change fails at baseline and passes on its proof edit, so
// a change that was never broken or can never pass counts for nothing.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type RequiredChange = {
  id: string;
  entryId: string;
  file: string;
  /** Regex that matches while the break is there. */
  dead: string;
  /** Regexes that show the fix: at least one must match. Empty when removing the code is the fix. */
  alive: string[];
  /** The smallest edit that fixes it, used only to prove the lock can pass. */
  proof: { from: string; to: string };
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
    const text = read(dir, change.file);
    if (!text.includes(change.proof.from)) problems.push(`${change.id}: proof edit not found`);
    writeFileSync(path.join(dir, change.file), text.split(change.proof.from).join(change.proof.to));
  }
  for (const change of lock.required) {
    if (!gradeChange(dir, change).fixed) problems.push(`${change.id} fails on its proof edit`);
  }
  return problems;
}

/** Packages a diff moved across a major version in a package.json, for the "none unneeded" target. */
export function majorUpgrades(diff: string): string[] {
  const major = (range: string) => /(\d+)/.exec(range)?.[1];
  const moved: string[] = [];
  for (const section of diff.split(/^(?=diff --git )/m)) {
    if (!/^diff --git a\/(?:.+\/)?package\.json /m.test(section)) continue;
    const pairs = (sign: string) =>
      new Map(
        [...section.matchAll(new RegExp(`^\\${sign}\\s*"([^"]+)":\\s*"([^"]+)"`, 'gm'))].map(
          (m) => [m[1] as string, m[2] as string],
        ),
      );
    const before = pairs('-');
    for (const [name, range] of pairs('+')) {
      const old = before.get(name);
      if (old && major(old) !== major(range)) moved.push(`${name} ${old} -> ${range}`);
    }
  }
  return moved;
}
