// Types for the plain-JavaScript selection helpers, so pipeline tests can import them under strict
// TypeScript. They describe only what the functions read.

export const SCAN_LIMITS: { files: number; fileBytes: number; totalBytes: number };
export const EXCLUDED_DIRECTORIES: Set<string>;
export const SOURCE_EXTENSION: RegExp;
export const EXCLUDED_NAME: RegExp;
export const SIZE_BUCKETS: Record<'openai' | 'anthropic', string[]>;

export interface Manifest {
  private?: boolean;
  dependencies?: Record<string, string>;
  [field: string]: unknown;
}

export interface TreeListing {
  truncated?: boolean;
  tree: { path: string; type: string; size?: number }[];
}

export function validRepoName(name: unknown): boolean;
export function validSha(sha: unknown): boolean;
export function validWorkspaceManifest(path: string): boolean;
export function declaresSdk(manifest: Manifest | null | undefined, sdk: string): boolean;
export function appShape(
  manifest: Manifest | null | undefined,
  paths?: string[],
  directory?: string,
): string | null;
export function excludedName(fullName: string, topics?: string[]): boolean;
export function scanLimitsFromTree(listing: TreeListing): string | null;
export function detectModelCall(
  path: string,
  text: string,
  provider: 'openai' | 'anthropic',
): boolean;
export function compareCandidates(
  a: { repo: string; stars: number },
  b: { repo: string; stars: number },
): number;
export function frozenListNames(json: unknown): string[];
export function checkoutDirectory(root: string, repo: string): string;
export function shallowCheckout(root: string, repo: string, sha: string): Promise<string>;

export const CANDIDATE_LOCKFILES: Set<string>;
export const MAX_CANDIDATE_BYTES: number;
export const VIA: string[];
export const REASONS: string[];
export const LABEL_KEYS: string[];
export const COMMITTED_KEYS: string[];
export const LANGUAGE_RULES: Record<string, string>;

export interface Registry {
  deadlines: {
    id: string;
    provider: string;
    kind: string;
    versions: string[];
    replacement?: string;
  }[];
}
export interface ModelPattern {
  regex: RegExp;
  byId: Map<string, { deadline: string }>;
}
export interface LabelCandidate {
  repo: string;
  provider: string;
  file: string;
  line: number;
  column: number;
  model: string;
  replacement: string;
  [field: string]: unknown;
}
export function modelPattern(registry: Registry, provider: string): ModelPattern;
export function findCandidates(
  text: string,
  pattern: ModelPattern,
): { line: number; column: number; model: string }[];
export function candidateFile(path: string, bytes: Uint8Array): boolean;
export function languageOf(path: string): string;
export function isGenerated(path: string): boolean;
export function followReplacement(registry: Registry, id: string): string;
export function packBatches<T>(groups: T[][], max: number): T[][];
export function validateLabels(
  candidates: LabelCandidate[],
  labels: Record<string, unknown>[],
  contextLines?: string[],
): { key: string; kind: string }[];
