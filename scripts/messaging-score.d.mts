// Types for the plain-JavaScript scorer, so pipeline tests can import it under strict TypeScript.

export interface MessagingLabels {
  repos: { repo: string }[];
  providers: { repo: string; provider: string; used: boolean }[];
  calls: { repo: string; file: string; line: number; deprecated: boolean }[];
  versions: { repo: string; file: string; below: boolean | null }[];
}

export interface MessagingResults {
  results: {
    repo: string;
    status: string;
    providers: { agent: { id: string } }[];
    calls: { file: string; line: number; use: string }[];
    packages: { name: string; file: string; deadline: unknown }[];
  }[];
}

export interface MessagingUnitScore {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
  errors: { kind: string; key: string }[];
}

export function scoreMessaging(
  labels: MessagingLabels,
  results: MessagingResults,
): {
  repositories: number;
  notScanned: string[];
  providers: MessagingUnitScore;
  calls: MessagingUnitScore;
  versions: MessagingUnitScore;
};
