// Types for the plain-JavaScript GitHub API scorer, so its pipeline test can import it under
// strict TypeScript. They describe only what the function reads.

interface Agreement {
  labels: number;
  reported: number;
  matched: number;
  precision: number | null;
  recall: number | null;
  misses: string[];
  extras: string[];
}

export interface GitHubScore extends Agreement {
  repositories: number;
  skipped: string[];
  routeAgreement: number | null;
  compared: number;
  disagreements: string[];
  pins: Agreement;
}

export function scoreGitHub(
  labels: { repos: ({ repo: string; commit: string } & Record<string, unknown>)[] },
  results: {
    results: ({ repo: string; commit: string; error?: string } & Record<string, unknown>)[];
  },
): GitHubScore;
