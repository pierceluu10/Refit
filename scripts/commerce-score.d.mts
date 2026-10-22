// Types for the plain-JavaScript scorer, so pipeline tests can import it under strict TypeScript.

export const PROVIDERS: string[];

export interface CommerceLabels {
  labels: { repo: string; providers: string[]; exposures: string[]; pins: string[] }[];
}

export interface CommerceResults {
  repos: {
    repo: string;
    providers: string[];
    exposures: string[];
    pins: string[];
    error?: string;
  }[];
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
  agents:
    | {
        detected?: {
          id: string;
          apiVersions?: { provider: string; version: string; use: string }[];
        }[];
      }
    | undefined,
  deadlines: { exposures?: { deadline: { id: string; provider: string } }[] } | undefined,
): { providers: string[]; exposures: string[]; pins: string[] };

export function scoreCommerce(
  labels: CommerceLabels,
  results: CommerceResults,
): {
  labelled: number;
  scored: number;
  failed: string[];
  providers: Tally;
  exposures: Tally;
  pins: Tally;
};
