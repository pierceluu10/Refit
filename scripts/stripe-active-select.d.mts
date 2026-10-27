// Types for the plain-JavaScript active-set selection, so its test can import it.

export const ACTIVE_DAYS: number;
export const SIZE_RANGES: string[];
export const DEFAULT_EXCLUDES: string[];
export function searchQueries(): string[];
export function activeSince(frozenAt: string): string;
export function apiVersionPins(text: string): string[];
export function readExclusions(paths: string[]): Promise<{
  repos: Set<string>;
  lists: Array<{ list: string; repositories: number }>;
  specs: Map<string, string>;
}>;
export function pause(ms: number): Promise<void>;
export function githubClient(token: string): (path: string, init?: RequestInit) => Promise<any>;
export function cachedIn(work: string): <T>(name: string, compute: () => Promise<T>) => Promise<T>;
