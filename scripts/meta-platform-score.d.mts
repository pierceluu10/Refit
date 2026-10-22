// Types for the plain-JavaScript scorer, so pipeline tests can import it under strict TypeScript.

export const GUARD_REASON: string;

export interface MetaPlatformResult {
  repo: string;
  calls: string[];
  guarded: string[];
  moved: string[];
  error?: string;
}

export function repositoryResult(
  scan: { calls?: { file: string; line: number; use: string }[] } | undefined,
  moves:
    | {
        stops?: { reasons?: string[] }[];
        moves?: { requests?: { file: string; line: number }[] }[];
      }
    | undefined,
): Omit<MetaPlatformResult, 'repo'>;

export function scoreMetaPlatform(
  labels: { labels: { repo: string; requests: { file: string; line: number }[] }[] },
  results: { repos: MetaPlatformResult[] },
): {
  repositories: number;
  failed: string[];
  labelled: number;
  found: number;
  guarded: number;
  moved: number;
  falseGuards: number;
  foundRecall: number | null;
  guardRecall: number | null;
  guardPrecision: number | null;
  misses: { repo: string; line: string; error: string }[];
};
