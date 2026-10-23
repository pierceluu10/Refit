// Types for the plain-JavaScript scorer, so pipeline code and tests can import it.
export interface WrapperSite {
  file: string;
  line: number;
  model: string;
  provider: string;
  wrapper: string;
}

export interface Counts {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
}

export interface WrapperScore extends Counts {
  repositories: number;
  byWrapper: Record<string, Counts>;
  falsePositiveSites: (WrapperSite & { repo: string })[];
  falseNegativeSites: (WrapperSite & { repo: string })[];
}

export function scoreWrapperSites(
  labelled: { repo: string; sites: WrapperSite[] }[],
  detected: Record<string, WrapperSite[]>,
): WrapperScore;
