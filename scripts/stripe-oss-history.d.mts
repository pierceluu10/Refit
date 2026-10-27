// Types for the plain-JavaScript historical-mode selection, so its test can import it.

export function dependencyMoves(
  history: Array<{ sha: string; range?: string }>,
): Array<{ sha: string; from: string; to: string }>;
export function versionOrder(a: string, b: string): number;
export function diffExclusions(): string[];
