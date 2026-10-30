// Types for the plain-JavaScript Shopify set selection, so its tests can import it.

export const DEFAULT_SEED: string;
export const TARGET: string;
export const SETS: Array<{ name: string; size: number }>;
export const QUERIES: string[];
export const STAGES: Array<{ days: number; authors: number; loosened: string[] }>;
export function searchQueries(): string[];
export function seedRank(seed: string, repo: string): string;
export function seededOrder(seed: string, repos: string[]): string[];
export function slugTokens(text: string): Set<string>;
export function supportedVersions(
  deadlines: { deadlines: Array<{ id: string; date: string }> },
  frozenAt: string,
): string[];
export function lockfilesOf(record: Record<string, unknown> | null | undefined): string[];
export function metadataIneligibility(
  record: unknown,
  since: string,
  stage?: { days?: number; authors?: number },
): string | null;
export function categories(check: unknown, supported: string[]): string[];
export function splitSets(
  seed: string,
  affected: string[],
  devAffected?: string[],
): Array<{ name: string; repos: string[] }>;
