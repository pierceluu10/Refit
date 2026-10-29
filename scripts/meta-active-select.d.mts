// Types for the plain-JavaScript Meta set selection, so its test can import it.

export const SOON_DAYS: number;
export function searchQueries(): Array<{ signal: string; query: string }>;
export function splitQuery(query: string): string[];
export function benchmarkRepositories(
  directory: string,
  skip?: string[],
): Promise<Map<string, string>>;
export function retirements(registry: {
  deadlines: Array<{ provider: string; kind: string; date: string; versions: string[] }>;
}): Map<string, string>;
export function versionStatus(
  version: string,
  dates: Map<string, string>,
  frozenAt: string,
): 'retired' | 'retiring' | 'supported';
export function textSignals(text: string): { fbInit: string[]; basicDisplay: boolean };
export function affectedReasons(
  prescan: {
    scan: { calls: Array<{ use: string; file: string; version: string | null }> };
    moves: { stops: Array<{ reasons: string[] }> } | null;
    text: { fbInit: string[]; basicDisplay: boolean };
  },
  dates: Map<string, string>,
  frozenAt: string,
): string[];
export function splitSets<T extends { repo: string }>(
  repos: T[],
  seed: string,
  blindSize: number,
  devSize: number,
): { blind: T[]; dev: T[] };
