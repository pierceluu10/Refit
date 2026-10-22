// Types for the plain-JavaScript Cloudflare scorer, so its pipeline test can import it under
// strict TypeScript. They describe only what the function reads.

export interface CloudflareScore {
  repositories: number;
  skipped: string[];
  labels: number;
  reported: number;
  matched: number;
  precision: number | null;
  recall: number | null;
  endpointAgreement: number | null;
  compared: number;
  misses: string[];
  extras: string[];
  disagreements: string[];
}

export function scoreCloudflare(
  labels: { repos: ({ repo: string; commit: string } & Record<string, unknown>)[] },
  results: {
    results: ({ repo: string; commit: string; error?: string } & Record<string, unknown>)[];
  },
): CloudflareScore;
