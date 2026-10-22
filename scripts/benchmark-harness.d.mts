// Types for the plain-JavaScript benchmark harness, so the TypeScript benchmark CLIs and tests can
// import it. They follow docs/benchmarks/schemas/harness.schema.json.

export type ResultsFormat =
  'stripe-results' | 'shopify-results' | 'ai-model-results' | 'deadline-results';

export interface Revision {
  commit: string | null;
  source: 'git' | 'archive' | 'unknown';
  dirty: { files: string[]; sha256: string } | null;
  allowDirty: boolean;
}

export interface DockerVersions {
  version: string;
  image: string;
  imageId: string;
  repoDigests: string[];
}

export interface Harness {
  formatVersion: 1;
  format: ResultsFormat;
  refit: Revision;
  list: { path: string; sha256: string };
  options: Record<string, unknown>;
  node: string;
  docker: DockerVersions | null;
  startedAt: string;
  resumes?: Array<{ startedAt: string; node: string; docker: DockerVersions | null }>;
}

export interface Infrastructure {
  kind: 'clone' | 'registry' | 'docker' | 'no-manifest';
  message: string;
}

export type Classification =
  | { outcomeClass: 'repository' }
  | { outcomeClass: 'infrastructure'; infrastructure: Infrastructure };

export type Row = Record<string, unknown> & { repo?: string; commit?: string };

export const COMMIT_STAMP: string;
export function refitRevision(root: string, options?: { allowDirty?: boolean }): Promise<Revision>;
export function dockerVersions(image: string): Promise<DockerVersions>;
export function startRun(settings: {
  format: ResultsFormat;
  refitRoot: string;
  list: { path: string; file: string };
  options: Record<string, unknown>;
  environment?: string[];
  image?: string;
  allowDirty?: boolean;
}): Promise<Harness>;
export function resumeMismatches(previous: Harness, current: Harness): string[];
export function json(value: unknown): string;
export function openRunDirectory(
  output: string,
  harness: Harness,
  options?: { resume?: boolean },
): Promise<{ harness: Harness; rows: Array<Row | null> }>;
export function openResultsFile(
  path: string,
  harness: Harness,
  options?: { resume?: boolean },
): Promise<{ harness: Harness; rows: Row[] }>;
export function finishedRow(
  row: Row | null | undefined,
  entry: { repo: string; commit: string },
): boolean;
export function checkoutError(directory: string, commit: string): Promise<string | undefined>;
export function classifyRow(format: ResultsFormat, row: Row): Classification;
export function splitRows<T extends Row>(
  format: ResultsFormat,
  rows: T[],
): {
  results: Array<T & { outcomeClass: 'repository' }>;
  infrastructure: Array<T & { outcomeClass: 'infrastructure'; infrastructure: Infrastructure }>;
};
