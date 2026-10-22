// Scores workspace attribution against blind labels (docs/WORKSPACE-ATTRIBUTION.md). Each finding
// Refit reports (a provider package, a provider hostname or a deadline match) names a file; its
// label gives the file's enclosing package and whether the path is product code. Pure, so the
// scorer has its own test.

export interface LabelledFile {
  file: string;
  package: string;
  category: string;
}

export interface ReportedFinding {
  file: string;
  // Whether Refit counts the finding as live: every detection, and deadline evidence with use live.
  live: boolean;
  // The package Refit attributes it to; null before attribution existed (the repository root).
  workspace: string | null;
}

export interface AttributionScore {
  findings: number;
  unlabelled: number;
  // Labelled findings whose reported package (the root when none) is the labelled one.
  attributed: { correct: number; total: number; accuracy: number | null };
  // Live findings in product code, of all labelled live findings.
  live: { product: number; total: number; precision: number | null };
  // Labelled product findings Refit reported live before, still reported live (no lost recall).
  productLive: number;
}

const ratio = (part: number, whole: number) => (whole ? part / whole : null);

export function scoreAttribution(
  labels: LabelledFile[],
  findings: ReportedFinding[],
): AttributionScore {
  const byFile = new Map(labels.map((label) => [label.file, label]));
  let unlabelled = 0;
  let correct = 0;
  let total = 0;
  let liveProduct = 0;
  let liveTotal = 0;
  for (const finding of findings) {
    const label = byFile.get(finding.file);
    if (!label) {
      unlabelled += 1;
      continue;
    }
    total += 1;
    if ((finding.workspace ?? '.') === label.package) correct += 1;
    if (finding.live) {
      liveTotal += 1;
      if (label.category === 'product') liveProduct += 1;
    }
  }
  return {
    findings: findings.length,
    unlabelled,
    attributed: { correct, total, accuracy: ratio(correct, total) },
    live: { product: liveProduct, total: liveTotal, precision: ratio(liveProduct, liveTotal) },
    productLive: liveProduct,
  };
}
