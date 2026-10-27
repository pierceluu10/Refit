// Types for the plain-JavaScript open-source Stripe scorer, so its test can import it.

export interface ScoreRow {
  repo: string;
  status: string;
  reason?: string;
  published: boolean;
  needsChange: boolean;
  runnableChecks: boolean;
  verdict: string | null;
  humanCodeFiles?: string[];
  refitCodeFiles?: string[];
  sharedFiles?: string[];
  [key: string]: unknown;
}
export function diffFiles(patch: string): string[];
export function reviewFor(
  reviews: Array<{ repo: string; run?: string; verdict: string }>,
  repo: string,
  runs: string[],
): { verdict: string } | undefined;
export function scoreRow(
  row: Record<string, any>,
  context: {
    review: { verdict: string } | undefined;
    patchFiles: string[] | undefined;
    human: { fix: string; codeFiles: string[] } | undefined;
  },
): ScoreRow;
export function summarize(rows: ScoreRow[]): {
  repositories: number;
  validated: number;
  published: number;
  reviewed: number;
  unreviewed: string[];
  verdicts: Record<string, number>;
  wrong: string[];
  coverage: { covered: number; needsChangeWithChecks: number };
  stops: Record<string, Array<{ repo: string; reason?: string }>>;
};
