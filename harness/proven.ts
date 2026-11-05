// Proven fixes: plain-code edits for breaks that climbed the ladder. They run first and spend no
// model. They still have to pass the rescan and the checks, and what they can't finish goes to
// Claude, so a proven fix can never block an attempt.
import { readFile, writeFile } from 'node:fs/promises';
import type { RepoTask } from './findings.ts';
import { resolveInSandbox } from './tools.ts';

export type ProvenFix = {
  entryId: string;
  // The file's new text, or undefined when this fix doesn't know how to handle this file.
  apply: (text: string, file: string) => string | undefined;
};

// Edits the working copy in place. Only files the scan flagged for the fix's entry are touched.
export async function applyProvenFixes(
  dir: string,
  task: RepoTask,
  fixes: ProvenFix[],
): Promise<{ entryIds: string[]; files: string[] }> {
  const entryIds = new Set<string>();
  const files = new Set<string>();
  for (const fix of fixes) {
    const flagged = task.findings.filter(
      (finding) => finding.entryId === fix.entryId && finding.matchClass !== 'comment',
    );
    for (const file of new Set(flagged.map((finding) => finding.file))) {
      const target = await resolveInSandbox(dir, file).catch(() => undefined);
      const text = target && (await readFile(target, 'utf8').catch(() => undefined));
      const next = target && text !== undefined ? fix.apply(text, file) : undefined;
      if (target && next !== undefined && next !== text) {
        await writeFile(target, next);
        entryIds.add(fix.entryId);
        files.add(file);
      }
    }
  }
  return { entryIds: [...entryIds], files: [...files] };
}
