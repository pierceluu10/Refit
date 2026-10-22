// Scores package-inventory detections against blind hand labels (docs/PACKAGE-INVENTORY.md). A
// unit is one catalog provider declared directly in one manifest file of one repository, in one
// ecosystem ('npm' for package.json). Labels were written from reading the manifests before
// Refit's output on that repository was looked at. Pure, so the scorer has its own test.

export interface InventoryUnit {
  provider: string;
  ecosystem: string;
  file: string;
}

export interface LabelledRepository {
  repository: string;
  commit: string;
  units: InventoryUnit[];
}

export interface ScannedRepository {
  repository: string;
  commit: string;
  error?: string;
  units: InventoryUnit[];
}

interface Counts {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
}

export interface InventoryScore {
  repositories: number;
  // Labelled repositories with no scan result, or a scan error: their labels count as misses.
  unscanned: string[];
  overall: Counts;
  byEcosystem: Record<string, Counts>;
  // The same comparison at repository level: a provider found anywhere in the repository.
  providers: Counts;
  falsePositives: (InventoryUnit & { repository: string })[];
  falseNegatives: (InventoryUnit & { repository: string })[];
}

function key(unit: InventoryUnit) {
  return `${unit.provider}\0${unit.ecosystem}\0${unit.file}`;
}

function counts(truePositives: number, falsePositives: number, falseNegatives: number): Counts {
  return {
    truePositives,
    falsePositives,
    falseNegatives,
    precision:
      truePositives + falsePositives ? truePositives / (truePositives + falsePositives) : null,
    recall:
      truePositives + falseNegatives ? truePositives / (truePositives + falseNegatives) : null,
  };
}

export function scoreInventory(
  labels: LabelledRepository[],
  results: ScannedRepository[],
): InventoryScore {
  const tally = new Map<string, [number, number, number]>();
  const bump = (ecosystem: string, index: 0 | 1 | 2) => {
    const entry = tally.get(ecosystem) ?? [0, 0, 0];
    entry[index] += 1;
    tally.set(ecosystem, entry);
  };
  const score: InventoryScore = {
    repositories: labels.length,
    unscanned: [],
    overall: counts(0, 0, 0),
    byEcosystem: {},
    providers: counts(0, 0, 0),
    falsePositives: [],
    falseNegatives: [],
  };
  const providerCounts: [number, number, number] = [0, 0, 0];
  for (const label of labels) {
    const result = results.find(
      (item) => item.repository === label.repository && item.commit === label.commit,
    );
    if (!result || result.error) score.unscanned.push(label.repository);
    const found = new Map(
      (result?.error ? [] : (result?.units ?? [])).map((unit) => [key(unit), unit]),
    );
    const expected = new Map(label.units.map((unit) => [key(unit), unit]));
    for (const [id, unit] of found)
      if (expected.has(id)) bump(unit.ecosystem, 0);
      else {
        bump(unit.ecosystem, 1);
        score.falsePositives.push({ repository: label.repository, ...unit });
      }
    for (const [id, unit] of expected)
      if (!found.has(id)) {
        bump(unit.ecosystem, 2);
        score.falseNegatives.push({ repository: label.repository, ...unit });
      }
    const foundProviders = new Set([...found.values()].map((unit) => unit.provider));
    const expectedProviders = new Set(label.units.map((unit) => unit.provider));
    for (const provider of foundProviders)
      providerCounts[expectedProviders.has(provider) ? 0 : 1] += 1;
    for (const provider of expectedProviders)
      if (!foundProviders.has(provider)) providerCounts[2] += 1;
  }
  const total: [number, number, number] = [0, 0, 0];
  for (const [ecosystem, entry] of [...tally].sort(([a], [b]) => a.localeCompare(b))) {
    score.byEcosystem[ecosystem] = counts(...entry);
    entry.forEach((value, index) => (total[index] += value));
  }
  score.overall = counts(...total);
  score.providers = counts(...providerCounts);
  return score;
}
