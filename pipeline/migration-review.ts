import { WEBHOOK_REVIEW_REASON } from './stripe-webhook-payloads.ts';
import type { Finding } from './types.ts';
import type { ProviderAdapter } from './providers.ts';
import {
  apiVersionSourceBlocked,
  declaresVersion,
  type ApiVersionEvidence,
} from './api-version.ts';
import { countBreakingOperationUsages } from './provider-operations.ts';
import { isTrackedResponseRemoval, unmappedBreakingChanges } from './openapi-diff.ts';
import type { runPipeline } from './run.ts';
import { HELPER_RULES, SUBSCRIPTION_PERIOD_RULE } from './stripe-subscription-periods.ts';

const DECLARED_TYPE_REVIEW_REASON =
  'Declared Stripe types identify possible usage but do not establish SDK or incoming-event provenance. Automatic migration, AI and publication require traced source evidence.';
const TYPE_EVIDENCE_REVIEW_REASON =
  'TypeScript types confirm reads of removed Stripe fields that Refit could not trace to an SDK response or a narrowed webhook event. Types, and casts in particular, do not establish provenance; automatic migration, AI and publication require traced source evidence.';
export const REMOVED_REQUEST_PARAMETER_REVIEW_REASON =
  'A traced SDK request sends a parameter the target API version removed. No reviewed replacement exists, and dropping or replacing it changes request behavior; automatic migration, AI and publication stop for review.';
const MAX_REASON_SITES = 3;
// How analyzer.ts ends the expression of a removed parameter set in an object no traced call receives.
const UNTRACED_BODY = ' outside a traced SDK request body';
const SKIPPED_SOURCE_REVIEW_REASON =
  'Unparseable source files were skipped. Their API usage and mutations are unknown; automatic migration, AI and publication require a complete source scan.';
const CLASS_CLIENT_REVIEW_REASON =
  'Affected SDK responses use a class client whose initialization, mutation or receiver lifetime requires review. Automatic migration, AI and publication require stable class-client provenance.';
const HELPER_CLIENT_REVIEW_REASON =
  'Affected SDK usage flows through a helper whose callers, client origins or mutations require review. Automatic migration, AI and publication require stable helper-client provenance.';

// Every reason the evidence needs review, in the order the first one is reported, each with the
// findings it covers (skipped files have none).
// `leaveUnmigratedWebhooks` lets patch generation and validation proceed around webhook reads that
// no rule migrates, when other confirmed work exists; they stay unresolved, so publication (which
// never passes it) still stops.
// `aiWebhooks`: AI is enabled and receives unmigrated webhook reads, so they never block on their own.
export function migrationReviewReasons(
  evidence: { findings: Finding[]; skippedFiles?: string[]; adapter?: ProviderAdapter },
  allowConfiguredWebhookMigration = false,
  leaveUnmigratedWebhooks = false,
  aiWebhooks = false,
) {
  const policy = evidence.adapter?.stripeSubscriptionPeriods;
  const otherWork = evidence.findings.some(
    (finding) =>
      finding.confidence === 'confirmed' && (!finding.webhook || finding.webhook.migration),
  );
  const flagged = (predicate: (finding: Finding) => unknown) => evidence.findings.filter(predicate);
  const contractReviews = [
    ...new Set(
      flagged((finding) => finding.contractReview).map((finding) => finding.contractReview!),
    ),
  ];
  return [
    {
      reason: WEBHOOK_REVIEW_REASON,
      findings: flagged(
        (finding) =>
          finding.webhook &&
          !(aiWebhooks && !finding.webhook.migration) &&
          finding.webhook.migration?.rule !== 'ai-version-tolerant' &&
          !(leaveUnmigratedWebhooks && otherWork && !finding.webhook.migration) &&
          !(
            allowConfiguredWebhookMigration &&
            finding.confidence === 'confirmed' &&
            HELPER_RULES.has(finding.webhook.migration?.rule ?? '')
          ) &&
          (!allowConfiguredWebhookMigration ||
            !policy ||
            finding.confidence !== 'confirmed' ||
            finding.webhook.schema !== 'subscription' ||
            !['.current_period_start', '.current_period_end'].includes(finding.expression) ||
            finding.webhook.migration?.rule !== SUBSCRIPTION_PERIOD_RULE ||
            finding.webhook.migration.priceId !== policy.priceId ||
            finding.webhook.migration.beforeApiVersion !== policy.beforeApiVersion ||
            finding.webhook.migration.afterApiVersion !== policy.afterApiVersion),
      ),
    },
    ...(evidence.skippedFiles?.length
      ? [{ reason: SKIPPED_SOURCE_REVIEW_REASON, findings: [] as Finding[] }]
      : []),
    ...contractReviews.map((reason) => ({
      reason,
      findings: flagged((finding) => finding.contractReview === reason),
    })),
    {
      reason: REMOVED_REQUEST_PARAMETER_REVIEW_REASON,
      findings: flagged((finding) => finding.requestParameter),
    },
    { reason: CLASS_CLIENT_REVIEW_REASON, findings: flagged((finding) => finding.classClient) },
    { reason: HELPER_CLIENT_REVIEW_REASON, findings: flagged((finding) => finding.helperClient) },
    {
      reason: DECLARED_TYPE_REVIEW_REASON,
      findings: flagged((finding) => finding.declaredType && finding.confidence !== 'confirmed'),
    },
    { reason: TYPE_EVIDENCE_REVIEW_REASON, findings: flagged((finding) => finding.typeEvidence) },
  ].filter((entry) => entry.findings.length || entry.reason === SKIPPED_SOURCE_REVIEW_REASON);
}

export function migrationReviewReason(...evidence: Parameters<typeof migrationReviewReasons>) {
  return migrationReviewReasons(...evidence)[0]?.reason;
}

// Owner decision 1: under it AI never writes the first patch beside a finding that needs review or a
// traced breaking operation change; the rules' patch comes first, and validation lets AI build on
// it unless aiSafetyStop holds.
export function reviewBlocksAi(
  evidence: Parameters<typeof migrationReviewReasons>[0] & { operationImpacts: readonly unknown[] },
) {
  return (
    evidence.operationImpacts.length > 0 ||
    Boolean(migrationReviewReason(evidence, true, true, true))
  );
}

// Owner decisions 1 and 8 (2026-10-24): with AI on, coverage stops (a removed request parameter,
// call sites traced to breaking changes, contract changes outside the rules, findings the rules
// leave unresolved) let AI build on the rules' patch. These safety stops still keep AI out: the
// API-version evidence, webhook payload version policy and every other finding that needs its
// source evidence reviewed.
export function aiSafetyStop(
  evidence: Parameters<typeof migrationReviewReasons>[0] & { apiVersion: ApiVersionEvidence },
) {
  if (
    evidence.apiVersion.applicability !== 'matches-before' ||
    apiVersionSourceBlocked(evidence.apiVersion)
  )
    return evidence.apiVersion.reason;
  return migrationReviewReasons(evidence, true, true, true).find(
    (entry) => entry.reason !== REMOVED_REQUEST_PARAMETER_REVIEW_REASON,
  )?.reason;
}

// Where traced calls still send a removed request parameter, and where an object Refit could not
// trace to a call sets it, so a stop says what to look at.
export function removedParameterSites(findings: Finding[]) {
  const removals = findings.filter((finding) => finding.requestParameter);
  const sites = removals.map((finding) =>
    finding.expression.endsWith(UNTRACED_BODY)
      ? `${finding.file}:${finding.line} sets ${finding.expression}`
      : `${finding.file}:${finding.line} sends ${finding.requestParameter!.parameter}`,
  );
  const lead = removals.some((finding) => finding.expression.endsWith(UNTRACED_BODY))
    ? 'Where'
    : sites.length === 1
      ? 'The call'
      : 'The calls';
  return `${lead}: ${sites.slice(0, MAX_REASON_SITES).join('; ')}${sites.length > MAX_REASON_SITES ? `; and ${sites.length - MAX_REASON_SITES} more in the run report` : ''}.`;
}

// Where a rescan of the migrated code still finds each usage, so the draft can list them.
export function unresolvedSites(findings: Finding[]) {
  return findings.map(({ file, line, changeId, expression, confidence, untraced }) => ({
    file,
    line,
    changeId,
    expression,
    confidence,
    ...(untraced ? { untraced } : {}),
  }));
}

// The code already sends the target version and Refit finds nothing the target breaks, traced or
// not: a merged Refit draft, or the customer's own migration. Every breaking change outside the
// migration rules still stops for review, except a removed response field the scanner searched
// the code for and found no read of, as after a merged draft that migrated it.
export function targetReached(
  scan: Pick<
    Awaited<ReturnType<typeof runPipeline>>,
    | 'apiVersion'
    | 'findings'
    | 'operationImpacts'
    | 'specificationDiff'
    | 'changes'
    | 'operationChanges'
    | 'requestChanges'
    | 'expandedFields'
  > & { skippedFiles?: string[] },
) {
  const target = scan.apiVersion.after;
  return Boolean(
    target &&
    target !== scan.apiVersion.before &&
    declaresVersion(scan.apiVersion.source, target) &&
    !scan.skippedFiles?.length &&
    !scan.findings.length &&
    !countBreakingOperationUsages(scan.operationImpacts) &&
    unmappedBreakingChanges(
      scan.specificationDiff,
      scan.changes,
      scan.findings,
      scan.operationChanges,
      scan.requestChanges,
      scan.expandedFields,
    ).every((entry) => isTrackedResponseRemoval(entry, scan.changes)),
  );
}
