// Loads proven fixes: providers/<id>/proven.ts exports `provenFixes`. A folder may hold only that.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ProvenFix } from '../../harness/proven.ts';
import { PROVIDERS_ROOT } from './pack.ts';

const ID = /^[a-z0-9][a-z0-9-]*$/;

// A retired model's quoted id becomes its replacement. A file that also sets something the new model
// handles differently is left for Claude: `blockedBy` is what the list entry's "requires" names, and
// `dropLines` the lines those fixes all removed.
export function modelSwap(
  entryId: string,
  from: string,
  to: string,
  blockedBy?: RegExp,
  dropLines?: RegExp,
): ProvenFix {
  const quoted = new RegExp(`(["'\`])${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`, 'g');
  return {
    entryId,
    apply: (text) => {
      if (blockedBy?.test(text)) return undefined;
      const next = text.replace(quoted, (_, quote: string) => `${quote}${to}${quote}`);
      if (next === text) return undefined;
      return dropLines ? next.replace(dropLines, '') : next;
    },
  };
}

export async function loadProvenFixes(
  providers: string[],
  allowed: string[],
  root = PROVIDERS_ROOT,
): Promise<ProvenFix[]> {
  const fixes = await Promise.all(
    providers.map(async (provider) => {
      const file = join(root, provider, 'proven.ts');
      if (!ID.test(provider) || !existsSync(file)) return [];
      const module = (await import(pathToFileURL(file).href)) as { provenFixes?: ProvenFix[] };
      return module.provenFixes ?? [];
    }),
  );
  return fixes.flat().filter((fix) => allowed.includes(fix.entryId));
}
