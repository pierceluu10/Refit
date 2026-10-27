// Types for the plain-JavaScript open-source Stripe selection, so its test can import it.

export const ACTIVE_DAYS: number;
export const MIN_STARS: number;
export const ORG_MIN_STARS: number;
export const MIN_AUTHORS: number;
export const MAX_DISK_KB: number;
export const LOCKFILES: Record<string, string>;
export const NOT_A_PRODUCT: RegExp;
export function activeSince(frozenAt: string): string;
export function splitStars(range: number[]): number[][];
export function starQualifier(range: number[]): string;
export function repoGroups(base: string, repos: string[]): string[][];
export function stripeManifest(path: string): boolean;
export function declaresStripe(manifest: unknown): boolean;
export function lightIneligibility(
  record: Record<string, any> | null,
  since: string,
): string | null;
export function humanAuthors(commit: unknown): Set<string>;
export function testScript(manifest: unknown): string | null;
export function lockedStripeVersion(text: string, manager: string): string | null;
export function compareSemver(a: string, b: string): number;
export function sdkApiVersion(releases: Record<string, string>, locked: string): string | undefined;
export function serverStripeFile(path: string, text: string): boolean;
export function sourceFiles(directory: string): Promise<string[]>;
