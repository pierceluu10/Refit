// Recall of an inventory report against a hand-built ground-truth list.
// Usage: node inventory/evaluation/score.ts <report.json> <ground-truth.json>
import { readFile } from 'node:fs/promises';
import type { InventoryReport } from '../agent.ts';

export type GroundTruthSite = {
  provider: string;
  via: string;
  file: string;
  line: number;
  operation: string;
  note?: string;
};
export type GroundTruth = { repo: string; commit: string; callSites: GroundTruthSite[] };

// A statement split over a few lines may be pinned to its first or its call line.
export const LINE_TOLERANCE = 2;
const CLIENT_INIT = 'client init';

export function scoreRecall(report: Pick<InventoryReport, 'usages'>, truth: GroundTruth) {
  const found = report.usages.flatMap((usage) => usage.callSites);
  const expected = truth.callSites.filter((site) => site.operation !== CLIENT_INIT);
  const misses = expected.filter(
    (site) =>
      !found.some(
        (candidate) =>
          candidate.file === site.file && Math.abs(candidate.line - site.line) <= LINE_TOLERANCE,
      ),
  );
  return {
    expected: expected.length,
    hits: expected.length - misses.length,
    recall: expected.length === 0 ? 1 : (expected.length - misses.length) / expected.length,
    misses,
  };
}

if (import.meta.main) {
  const [reportPath, truthPath] = process.argv.slice(2);
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as InventoryReport;
  const truth = JSON.parse(await readFile(truthPath, 'utf8')) as GroundTruth;
  const score = scoreRecall(report, truth);
  console.log(
    `${truth.repo}: recall ${score.hits}/${score.expected} = ${(score.recall * 100).toFixed(1)}%`,
  );
  for (const miss of score.misses) {
    console.log(`  miss ${miss.provider} ${miss.file}:${miss.line} ${miss.operation}`);
  }
}
