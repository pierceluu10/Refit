// Types for the plain-JavaScript fresh deadline scorer, so pipeline tests can import it under
// strict TypeScript. They describe only the fields the functions read.

export interface Interval {
  k: number;
  n: number;
  rate: number | null;
  low: number | null;
  high: number | null;
}

export interface LineLabel {
  repo: string;
  file: string;
  line: number;
  version: string;
  provider: string;
  label: string;
  note?: string;
}

export interface EvidenceItem {
  file: string;
  line: number;
  version: string;
  use: string;
}

export interface DeadlineGroup {
  deadline: { id: string };
  more?: number;
  nonLiveMore?: number;
  evidence?: EvidenceItem[];
  nonLive?: EvidenceItem[];
}

export interface DeadlinesResult {
  error?: string;
  exposures?: DeadlineGroup[];
  mentions?: DeadlineGroup[];
}

export interface ReportedLine {
  file: string;
  line: number;
  version: string;
  use: string;
  deadline: string;
}

export interface UseScore {
  precision: Interval;
  recall: Interval;
}

export interface FreshScore {
  repositories: number;
  errored: string[];
  exposed: number;
  exposedShare: Interval;
  repoPrecision: Interval;
  repoRecall: Interval;
  pairPrecision: Interval;
  pairRecall: Interval;
  live: UseScore;
  catalog: UseScore;
  test: UseScore;
  comment: UseScore;
  beyondLimit: number;
  falsePositivePairs: string[][];
  falseNegativePairs: string[][];
  lineFalsePositives: (ReportedLine & { repo: string; label: string; note?: string })[];
  lineFalseNegatives: (LineLabel & { deadline: string; reported: string })[];
  misclassified: (ReportedLine & { repo: string; label: string; note?: string })[];
  unlabelledReported: (ReportedLine & { repo: string })[];
}

export const LABELS: string[];
export function applicationReason(manifest: Record<string, unknown>): string | null;
export function wilson(k: number, n: number, z?: number): Interval;
export function reportedLines(result: DeadlinesResult | undefined): {
  lines: Map<string, ReportedLine>;
  cappedLive: Set<string>;
  cappedNonLive: Set<string>;
};
export function scoreFresh(
  repos: string[],
  labels: LineLabel[],
  results: Record<string, DeadlinesResult>,
  deadlineOf: Map<string, { id: string }>,
): FreshScore;
