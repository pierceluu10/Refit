// Types for the plain-JavaScript claims checker, so pipeline tests can import it.

export interface Line {
  number: number;
  text: string;
}

export interface Token {
  token: string;
  start: number;
  end: number;
}

export type Query = Record<string, unknown>;
export type Computed = number | number[] | undefined;

export interface Value {
  doc: string;
  quote: string;
  says: string;
  status: 'reproduces' | 'differs' | 'not-checkable';
  recomputed?: string;
  reason?: string;
  results?: string[];
  note?: string;
}

export function scopedLines(markdown: string, headings?: string[]): Line[];
export function numericTokens(text: string): Token[];
export function wilson(k: number, n: number, z?: number): [number, number];
export function evaluate(query: Query, read: (file: string) => unknown): Computed;
export function parseSays(says: string): number | number[];
export function reproduces(says: string, value: Computed): boolean;
export function checkClaims(
  claimsFile: string,
  options?: { root?: string },
): { values: Value[]; problems: string[] };
