// How much of one inventory run another run found, repo by repo, and what each cost. $0: it only
// reads saved reports. Usage: node inventory/evaluation/compare.ts <baselineDir> <candidateDir>
//
// A baseline usage counts as found when the candidate has a usage with the same channel (via) and
// the same provider: the same id once lowercased and stripped of punctuation, one id containing
// the other (4+ characters), the same SDK package within one vendor family, or a shared API host.
// Names alone can differ for the same API ("custom-backend" and "NEXT_PUBLIC_API_URL backend"),
// so this undercounts rather than overcounts.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ApiUsage } from '../../shared/types.ts';
import type { InventoryReport } from '../agent.ts';

const normal = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

export function sameProvider(a: ApiUsage, b: ApiUsage): boolean {
  const [left, right] = [normal(a.provider), normal(b.provider)];
  if (left === right) return true;
  if (left.length >= 4 && right.length >= 4 && (left.includes(right) || right.includes(left))) {
    return true;
  }
  const family = (usage: ApiUsage) => usage.provider.split('-')[0];
  if (a.sdk && b.sdk && a.sdk.name === b.sdk.name && family(a) === family(b)) return true;
  const hosts = new Set(a.hints?.hosts ?? []);
  return (b.hints?.hosts ?? []).some((host) => hosts.has(host));
}

export function compareRuns(
  baseline: Pick<InventoryReport, 'usages'>,
  candidate: Pick<InventoryReport, 'usages'>,
): { found: number; missing: ApiUsage[]; extra: ApiUsage[] } {
  const matches = (a: ApiUsage, b: ApiUsage) => a.via === b.via && sameProvider(a, b);
  const missing = baseline.usages.filter((a) => !candidate.usages.some((b) => matches(a, b)));
  const extra = candidate.usages.filter((b) => !baseline.usages.some((a) => matches(a, b)));
  return { found: baseline.usages.length - missing.length, missing, extra };
}

async function reports(dir: string): Promise<Map<string, InventoryReport>> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  const entries = await Promise.all(
    names.map(
      async (name) =>
        [
          name,
          JSON.parse(await readFile(path.join(dir, name), 'utf8')) as InventoryReport,
        ] as const,
    ),
  );
  return new Map(entries);
}

if (import.meta.main) {
  const [baselineDir, candidateDir] = process.argv.slice(2);
  const [baselines, candidates] = await Promise.all([reports(baselineDir), reports(candidateDir)]);
  const total = { found: 0, baseline: 0, baselineUsd: 0, candidateUsd: 0 };
  for (const [name, baseline] of baselines) {
    const candidate = candidates.get(name);
    if (!candidate) continue;
    const { found, missing } = compareRuns(baseline, candidate);
    total.found += found;
    total.baseline += baseline.usages.length;
    total.baselineUsd += baseline.costUsd;
    total.candidateUsd += candidate.costUsd;
    console.log(
      `${baseline.repo}: found ${found}/${baseline.usages.length}; baseline $${baseline.costUsd.toFixed(4)}, ${baseline.usages.length} usages; candidate $${candidate.costUsd.toFixed(4)}, ${candidate.usages.length} usages`,
    );
    for (const usage of missing) console.log(`  missing ${usage.provider} via ${usage.via}`);
  }
  console.log(
    `All: found ${total.found}/${total.baseline}; baseline $${total.baselineUsd.toFixed(4)}, candidate $${total.candidateUsd.toFixed(4)}`,
  );
}
