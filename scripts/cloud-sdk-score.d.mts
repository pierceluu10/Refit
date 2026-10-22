// Types for the plain-JavaScript scorer, so pipeline tests can import it under strict TypeScript.

export interface CloudSdkLabels {
  repos: { repo: string }[];
  sites: {
    repo: string;
    file: string;
    line: number;
    sdk: string | null;
    service: string | null;
    client: boolean;
  }[];
}

export interface CloudSdkResults {
  results: {
    repo: string;
    status: string;
    clients: { file: string; line: number; sdk: string; service: string; use: string }[];
  }[];
}

export interface CloudSdkScore {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  wrongService: number;
  precision: number | null;
  recall: number | null;
}

export function scoreCloudSdk(
  labels: CloudSdkLabels,
  results: CloudSdkResults,
): {
  repositories: number;
  notScanned: string[];
  overall: CloudSdkScore;
  bySdk: Record<string, CloudSdkScore>;
  byService: Record<string, CloudSdkScore>;
  errors: { kind: string; key: string; service: string | null; expected?: string | null }[];
};
