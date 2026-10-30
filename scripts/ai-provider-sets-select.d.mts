// Types for the plain-JavaScript AI-provider set selection, so its tests can import it.

type Language = 'js' | 'py';
type SourceFile = { path: string; text: string };
export interface SetSpec {
  name: string;
  purpose: 'measurement' | 'dev';
  js: number;
  py: number;
  minimum: Record<Language, number>;
}

export const DEFAULT_SEED: string;
export const FROZEN_AT: string;
export const PUSHED_SINCE: string;
export const MAX_DISK_KB: number;
export const MAX_BATCH: number;
export const CHANGE_TYPES: string[];
export const UNREGISTERED_RETIRED: Record<string, string[]>;
export const CURRENT_MAJOR: Record<string, Record<Language, Record<string, number>>>;
export const PROVIDERS: Record<
  string,
  { packages: Record<Language, string[]>; tags: Record<string, RegExp[]> }
>;
export const SETS: Record<string, SetSpec[]>;
export function slugTokens(text: string): Set<string>;
export function declaredJs(text: string, packages: string[]): Record<string, string>;
export function declaredPy(text: string, packages: string[]): Record<string, string>;
export function majorOf(spec: string | null | undefined): number | null;
export function lockedVersion(text: string, manager: string, name: string): string | null;
export function retiredModels(registry: unknown, provider: string, frozenAt?: string): string[];
export function retiredPattern(models: string[]): RegExp;
export function changeTypes(options: {
  files: SourceFile[];
  provider: string;
  retired: RegExp;
  sdkVersions: Record<string, string>;
  language: Language;
}): string[];
export function usesSdk(files: SourceFile[], provider: string, language: Language): boolean;
export function applicationFiles(files: SourceFile[]): SourceFile[];
export function metadataIneligibility(record: unknown): string | null;
export function languageOf(check: { uses?: Partial<Record<Language, boolean>> }): Language | null;
export function checkIneligibility(check: unknown): string | null;
export function fillSets<T extends { changeTypes: string[] }>(
  sets: Array<Omit<SetSpec, 'purpose'> & { purpose?: string }>,
  next: (stratum: string, language: string, accept: (candidate: T) => boolean) => Promise<T | null>,
): Promise<
  Array<SetSpec & { repos: Array<T & { stratum: string }>; shortfall: Record<string, number> }>
>;
