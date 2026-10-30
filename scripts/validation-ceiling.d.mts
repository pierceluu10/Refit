import type { RowBlocker } from './validation-funnel.mjs';

export const LANES: Record<string, string>;
export const NOT_VALIDATABLE: string[];
export interface BlockerRule extends RowBlocker {
  verdict: 'fixable' | 'not-validatable';
  lane?: string;
  cause?: string;
  changes?: number;
  reason?: string;
}
export interface ContractChange {
  id: string;
  reach: string;
  text: string;
}
export function blockingChanges(row: Record<string, unknown>, report?: unknown): ContractChange[];
export function changeRule(change: ContractChange): BlockerRule;
export function blockerRules(
  entry: RowBlocker,
  row: Record<string, unknown>,
  report: unknown,
  blockers: RowBlocker[],
): BlockerRule[];
export function validated(row: Record<string, unknown>): boolean;
export interface CeilingRow {
  repo: string;
  stage: string;
  verdict: 'validated' | 'fixable' | 'not-validatable';
  reasons?: string[];
  lanes?: string[];
  blockers: BlockerRule[];
}
export function classifyRow(row: Record<string, unknown>, report?: unknown): CeilingRow;
export function ceiling(
  rows: Record<string, unknown>[],
  reports?: Map<string, unknown>,
): {
  rows: number;
  affected: number;
  reports: number;
  validated: number;
  validatable: number;
  notValidatable: Record<string, number>;
  lanes: Record<string, { rows: number; only: number }>;
  uncovered: Record<string, { rows: number; only: number }>;
  repositories: CeilingRow[];
};
