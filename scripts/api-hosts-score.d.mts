export interface ApiHostScore {
  repositories: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
  wrong: { repo: string; host: string }[];
  missed: { repo: string; host: string }[];
}
export function scoreApiHosts(
  found: Record<string, string[]>,
  labels: { repos: { repo: string; hosts: string[] }[] },
): ApiHostScore;
