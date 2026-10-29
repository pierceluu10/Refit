// Types for the plain-JavaScript holdout selection, so its tests can import it.

export const DEFAULT_SEED: string;
export const PUSHED_SINCE: string;
export const MAX_DISK_KB: number;
export const TARGET: string;
export const SETS: Array<{ name: string; size: number }>;
export const MAX_BATCH: number;
export function seedRank(seed: string, repo: string): string;
export function seededOrder(seed: string, repos: string[]): string[];
export function slugTokens(text: string): Set<string>;
export function declaresStripe(text: string): boolean;
export function metadataIneligibility(record: unknown): string | null;
export function packageManagerOf(record: unknown): string;
export function usesStripeSdk(files: Array<{ path: string; text: string }>): boolean;
export function apiVersionOf(
  version: { pins: string[]; locked: string | null },
  releases: Record<string, string>,
): { before: string; beforeSource: string } | null;
export function checkIneligibility(
  check: unknown,
  specs: { has(version: string): boolean },
): string | null;
export function assignSets<T>(
  kept: T[],
  sets?: Array<{ name: string; size: number }>,
): Array<{ name: string; repos: T[] }>;
export function lockedStripe(text: string, manager: string): string | null;
