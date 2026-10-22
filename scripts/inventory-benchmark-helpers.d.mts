// Types for the plain-JavaScript inventory benchmark helpers, so pipeline tests can import them
// under strict TypeScript. They describe only the fields the functions read.

export type Group = 'js-ts' | 'python' | 'go';

export const LANGUAGE_GROUPS: Group[];
export const EXCLUDED_NAME: RegExp;
export const SKIPPED_DIRECTORIES: Set<string>;
export const VIA: string[];
export const LANGUAGES: string[];
export const MISS_CATEGORIES: string[];

export function excludedName(fullName: string, topics?: string[]): boolean;
export function skippedPath(path: string): boolean;
export function isSource(group: Group, path: string): boolean;
export function sourceFileCount(group: Group, paths: string[]): number;
export function candidateManifests(paths: string[]): string[];
export function applicationReason(
  group: Group,
  paths: string[],
  manifests?: Record<string, Record<string, unknown> | null>,
): string | null;
export function isProduction(path: string): boolean;
export function jsPackage(specifier: string): string | null;
export function importSpecifiers(
  path: string,
  text: string,
): { specifier: string; line: number; language: 'js' | 'python' | 'go' }[];
export function urlHosts(text: string): { host: string; line: number }[];
export function dependencyDeclarations(
  path: string,
  text: string,
): { name: string; dev: boolean; file: string }[];

export interface Label {
  provider: string;
  via: 'sdk' | 'http';
  package: string | null;
  host: string | null;
  language: string;
  file: string;
  line: number;
  monorepo: boolean;
  notes?: string;
}

export interface LabelsFile {
  repos: { repo: string; commit: string; none: boolean; labels: Label[] }[];
}

export interface FrozenList {
  repos: { repo: string; commit: string; group?: Group }[];
}

export interface CatalogEntry {
  id: string;
  packages: string[];
  hostnames: string[];
}

export interface ResultsFile {
  catalog: CatalogEntry[];
  repos: {
    repo: string;
    group?: Group;
    commit?: string;
    error?: string;
    detections: { provider: string; detector: string; files: string[] }[];
  }[];
}

export interface Interval {
  k: number;
  n: number;
  rate: number | null;
  low: number | null;
  high: number | null;
}

export interface Tally {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: Interval;
  recall: Interval;
}

export interface Detected {
  repo: string;
  group?: Group;
  provider: string;
  detectors: string[];
  files: string[];
}

export interface Missed {
  repo: string;
  group?: Group;
  provider: string;
  inCatalog: boolean;
  files: string[];
  category: string;
  detail: string;
}

export function validateLabels(
  list: FrozenList,
  labels: LabelsFile,
): { repo: string | null; problem: string }[];
export function missCategory(
  labels: Label[],
  catalog: CatalogEntry[],
): { category: string; detail: string };
export function wilson(k: number, n: number, z?: number): Interval;
export function scoreInventory(
  labels: LabelsFile,
  results: ResultsFile,
): {
  repositories: number;
  errored: { repo: string; error: string }[];
  catalogProviders: Tally;
  allProviders: Tally;
  byGroup: Record<string, { catalogProviders: Tally; allProviders: Tally }>;
  missesByCategory: Record<string, number>;
  perProvider: Record<string, Tally & { inCatalog: boolean }>;
  falsePositives: Detected[];
  falseNegatives: Missed[];
};
