// Types for the plain-JavaScript Slack scorer, so its pipeline test can import it under strict
// TypeScript. They describe only what the function reads.

export interface SlackLabel {
  file: string;
  line: number;
  methods: string[];
}

export interface SlackScore {
  repositories: number;
  skipped: string[];
  labels: number;
  reported: number;
  matched: number;
  methodsAgree: number;
  precision: number | null;
  recall: number | null;
  methodAgreement: number | null;
  misses: string[];
  extras: string[];
  disagreements: string[];
}

export function scoreSlack(
  labels: { repos: ({ repo: string; commit: string } & Record<string, unknown>)[] },
  results: {
    results: ({ repo: string; commit: string; error?: string } & Record<string, unknown>)[];
  },
  field?: string,
): SlackScore;
