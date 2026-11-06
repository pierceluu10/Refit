// Placeholder entry points for O5 (MVP-PLAN.md). Each returns nothing until the real agent lands,
// so other prompts can code against compliance/ tonight.
import type {
  AuditEntry,
  ObligationsToChanges,
  RecordAudit,
  WatchRegulations,
} from '../shared/types.ts';

export const watchRegulations: WatchRegulations = async () => [];

export const obligationsToChanges: ObligationsToChanges = async () => [];

export const recordAudit: RecordAudit = async () => {};

export async function listAudit(_repo: string): Promise<AuditEntry[]> {
  return [];
}
