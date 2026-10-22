export const TOLERANCE: number;
export interface PayPalScore {
  repositories: number;
  labelled: number;
  reported: number;
  matched: number;
  precision: number | null;
  recall: number | null;
  wrong: { repo: string; at: string }[];
  missed: { repo: string; at: string }[];
}
export function scorePayPal(
  results: {
    repo: string;
    status: string;
    calls?: { file: string; line: number; use: string }[];
  }[],
  labels: { repos: { repo: string; requests: string[] }[] },
  tolerance?: number,
): PayPalScore;
