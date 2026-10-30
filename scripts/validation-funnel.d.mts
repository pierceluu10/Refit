export const PREPARATION_GROUPS: [string, RegExp][];
export const STAGES: string[];
export interface FunnelStage {
  stage: string;
  detail?: string;
  message?: string;
  patch?: boolean;
}
export function preparationGroup(message: string): string;
export function funnelStage(row: Record<string, unknown>): FunnelStage;
export function funnel(rows: Record<string, unknown>[]): {
  rows: number;
  affected: number;
  stages: Record<string, number>;
  preparation: Record<string, number>;
  preparationPatch: Record<string, number>;
  grades: Record<string, number>;
  noCheck: Record<string, number>;
  repositories: ({ repo: string } & FunnelStage)[];
};
export const BLOCKERS: string[];
export interface RowBlocker {
  blocker: string;
  evidence: string;
}
export function rowBlockers(row: Record<string, unknown>, report?: unknown): RowBlocker[];
export function artifactReports(directory: string): Map<string, unknown>;
export function blockerCensus(
  rows: Record<string, unknown>[],
  reports?: Map<string, unknown>,
): {
  rows: number;
  affected: number;
  unblocked: number;
  reports: number;
  blockers: Record<string, { rows: number; only: number; repos: string[] }>;
  repositories: { repo: string; stage: string; blockers: RowBlocker[] }[];
};
