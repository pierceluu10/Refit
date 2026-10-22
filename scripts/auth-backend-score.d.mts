// Types for the plain-JavaScript scorer, so pipeline tests can import it under strict TypeScript.

export const PROVIDERS: string[];

export interface AuthBackendLabels {
  labels: { repo: string; providers: string[]; exposures: string[] }[];
}

export interface AuthBackendResults {
  repos: { repo: string; providers: string[]; exposures: string[]; error?: string }[];
}

export interface Tally {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  precision: number | null;
  recall: number | null;
  misses: { repo: string; item: string; error: 'false positive' | 'false negative' }[];
}

export function repositoryResult(
  agents: { detected?: { id: string }[] } | undefined,
  deadlines: { exposures?: { deadline: { id: string; provider: string } }[] } | undefined,
): { providers: string[]; exposures: string[] };

export function scoreAuthBackend(
  labels: AuthBackendLabels,
  results: AuthBackendResults,
): {
  labelled: number;
  scored: number;
  failed: string[];
  providers: Tally;
  exposures: Tally;
};
