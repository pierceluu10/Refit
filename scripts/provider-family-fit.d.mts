// Types for the plain-JavaScript provider family-fit classifier, so pipeline tests can import it.

export type Category = 'mechanism' | 'review' | 'new-code';

export interface Rule {
  category: Category;
  family: string;
  rule: string;
}

export interface Change {
  provider: string;
  key: string;
  shape: string;
  replacement?: string | null;
  sameOperation?: boolean;
  member?: string | null;
}

export interface ClassifiedChange extends Change {
  sources: string[];
  rule: string;
  category: Category;
  family: string;
}

export interface ProviderRow {
  provider: string;
  recorded: number;
  edits: number;
  review: number;
  covered: number;
  coveredPercent: number;
  editPercent: number;
  newCode: number;
  families: Record<string, number>;
  sources: string[];
}

export const MODEL_ID: RegExp;
export const NON_TEXT_MODEL: RegExp;
export const GITHUB_REST_TITLES: [RegExp, string][];
export const RULES: Record<string, Rule>;
export function classify(change: Change): string;
export function collectChanges(read: (name: string) => any): ClassifiedChange[];
export function rankProviders(
  changes: ClassifiedChange[],
  providerIds: string[],
): { ranked: ProviderRow[]; unknown: string[] };
