// Types for the plain-JavaScript model-site scorer, so pipeline tests can import it under strict
// TypeScript. They describe only the fields the functions read.

export type SiteProvider = 'openai' | 'anthropic' | 'gemini' | 'compatible';
export type SiteVia = 'sdk' | 'wrapper' | 'raw-http' | 'indirect';

export interface SiteLabel {
  repo: string;
  file: string;
  line: number;
  model: string;
  provider: SiteProvider | string;
  via: SiteVia | string;
  registry: boolean;
  notes?: string;
}

export interface NegativeFile {
  set: string;
  repo: string;
  file: string;
}

export interface SiteLabels {
  sample: Record<string, string[]>;
  sites: SiteLabel[];
  negatives: NegativeFile[];
}

// One repository's `refit deadlines --json` result, or the error that stopped it.
export interface DeadlinesRun {
  error?: string;
  exposures?: {
    deadline: { id: string; provider: string };
    more: number;
    evidence: { kind: string; file: string; line: number; version: string }[];
  }[];
}

export interface ReportedSite {
  file: string;
  line: number;
  model: string;
  provider: string;
  deadline: string;
}

export interface Interval {
  k: number;
  n: number;
  rate: number | null;
  low: number | null;
  high: number | null;
}

export interface ScoredSite extends ReportedSite {
  repo: string;
  negativeFile: boolean;
}

export interface SetScore {
  set: string;
  repositories: number;
  errored: { repo: string; error: string }[];
  labelledSites: number;
  registrySites: number;
  nonRegistrySites: number;
  compatibleSites: number;
  precision: Interval;
  recall: Interval;
  recallAllSites: Interval;
  negativeFileFalsePositives: number;
  truePositives: ScoredSite[];
  falsePositives: ScoredSite[];
  compatibleHits: ScoredSite[];
  falseNegatives: SiteLabel[];
  beyondLimit: SiteLabel[];
}

export const SETS: string[];
export const VIA: string[];
export const PROVIDERS: string[];
export const SOURCE: RegExp;
export function isProduction(path: string): boolean;
export function modelCandidates(text: string): { line: number; literals: string[] }[];
export function talksToProvider(set: string, text: string): boolean;
export function seededOrder<T>(items: T[], seed: number): T[];
export function validateSiteLabels(labels: Partial<SiteLabels>): string[];
export function wilson(k: number, n: number, z?: number): Interval;
export function reportedSites(result: DeadlinesRun | undefined): {
  sites: ReportedSite[];
  capped: Set<string>;
};
export function scoreSet(
  set: string,
  labels: SiteLabels,
  results: Record<string, DeadlinesRun>,
  deadlineOf: Map<string, string>,
): SetScore;
