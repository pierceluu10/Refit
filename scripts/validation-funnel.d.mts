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
  grades: Record<string, number>;
  noCheck: Record<string, number>;
  repositories: ({ repo: string } & FunnelStage)[];
};
