// Scores cloud-hosted model detection against blind line labels (docs/MODEL-HOSTS.md). Only
// detections on labelled lines are scored, since the labels cover a seeded sample of candidate
// lines. A detection is correct when a label on its line names the same host, kind and value.
// Pure, so the scorer has its own test.

export interface HostUnit {
  host: string;
  kind: string;
  value: string;
  use: string;
}

export interface LabelledLine {
  at: string;
  units: HostUnit[];
}

export interface DetectedSite {
  file: string;
  line: number;
  host: string;
  kind: string;
  value: string;
}

interface Counts {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
}

const counts = (tp: number, fp: number, fn: number): Counts => ({
  truePositives: tp,
  falsePositives: fp,
  falseNegatives: fn,
  precision: tp + fp ? tp / (tp + fp) : null,
  recall: tp + fn ? tp / (tp + fn) : null,
});

export function scoreModelHosts(lines: LabelledLine[], sites: DetectedSite[]) {
  const key = (unit: { host: string; kind: string; value: string }) =>
    `${unit.host}\0${unit.kind}\0${unit.value}`;
  const tally = new Map<string, [number, number, number]>();
  const bump = (host: string, index: 0 | 1 | 2) => {
    const entry = tally.get(host) ?? [0, 0, 0];
    entry[index] += 1;
    tally.set(host, entry);
  };
  const byUse: Record<string, number> = {};
  const falsePositives: DetectedSite[] = [];
  const falseNegatives: (HostUnit & { at: string })[] = [];
  for (const line of lines) {
    const found = sites.filter((site) => `${site.file}:${site.line}` === line.at);
    const expected = new Map(line.units.map((unit) => [key(unit), unit]));
    const matched = new Set<string>();
    for (const site of found) {
      const unit = expected.get(key(site));
      if (unit && !matched.has(key(site))) {
        matched.add(key(site));
        bump(site.host, 0);
        byUse[unit.use] = (byUse[unit.use] ?? 0) + 1;
      } else if (!unit) {
        bump(site.host, 1);
        falsePositives.push(site);
      }
    }
    for (const unit of line.units)
      if (!matched.has(key(unit))) {
        bump(unit.host, 2);
        falseNegatives.push({ at: line.at, ...unit });
      }
  }
  const total: [number, number, number] = [0, 0, 0];
  const byHost: Record<string, Counts> = {};
  for (const [host, entry] of [...tally].sort(([a], [b]) => a.localeCompare(b))) {
    byHost[host] = counts(...entry);
    entry.forEach((value, index) => (total[index] += value));
  }
  return {
    overall: counts(...total),
    byHost,
    truePositivesByUse: byUse,
    falsePositives,
    falseNegatives,
  };
}
