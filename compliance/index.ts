// compliance/: Refit's rules and regulations agent and the audit trail (MVP-PLAN.md, prompt O5).
// Refit never says code is compliant and never gives legal advice; rule PRs are needs-review.
import type { ObligationsToChanges, WatchRegulations } from '../shared/types.ts';
import { createObligationsToChanges } from './match.ts';
import { createWatchRegulations } from './watch.ts';

// Reads official texts with the real model, metered against REFIT_AI_BUDGET_USD. Without a key or
// a cap it reads nothing and says why on stderr; readRegulations returns those errors directly.
export const watchRegulations: WatchRegulations = (since) => createWatchRegulations()(since);

// Applicable obligations become ExternalChanges; the rest are written to the audit trail as
// "not affected" with the reason. matchObligations returns the verdicts too.
export const obligationsToChanges: ObligationsToChanges = (repo, surfaces, obligations) =>
  createObligationsToChanges()(repo, surfaces, obligations);

export {
  AUDIT_ACTIONS,
  JsonAuditStore,
  MemoryAuditStore,
  auditStore,
  listAudit,
  recordAudit,
  setAuditStore,
  type AuditStore,
} from './audit.ts';
export { listObligations, saveObligations } from './obligations.ts';
export { RULE_FAMILIES, familyOf, type RuleFamily, type RuleFamilyId } from './families.ts';
export { fixtureFetcher, httpFetcher, officialFixtures, type Fetcher } from './fetch.ts';
export {
  createObligationsToChanges,
  matchObligations,
  type MatchOptions,
  type ObligationMatch,
  type ObligationVerdict,
} from './match.ts';
export {
  Budget,
  BudgetExceededError,
  complianceModelId,
  createComplianceModel,
  fakeModel,
  scriptedModel,
  type ModelClient,
} from './model.ts';
export {
  NO_LEGAL_ADVICE,
  RULE_PLAYBOOKS,
  RULE_TASK_GUIDANCE,
  rulePlaybook,
  rulePrBody,
  ruleOutcome,
  type RulePrInput,
} from './playbooks.ts';
export {
  createWatchRegulations,
  readRegulations,
  type RegulationsRead,
  type WatchOptions,
} from './watch.ts';
export { findClaims, redactSecrets, scrubClaims } from './wording.ts';
