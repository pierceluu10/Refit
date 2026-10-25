import { WEBHOOK_REVIEW_REASON } from './stripe-webhook-payloads.ts';
import type { Finding } from './types.ts';
import type { ProviderAdapter } from './providers.ts';
import { declaresVersion } from './api-version.ts';
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
const SKIPPED_SOURCE_REVIEW_REASON =
  'Unparseable source files were skipped. Their API usage and mutations are unknown; automatic migration, AI and publication require a complete source scan.';

// `leaveUnmigratedWebhooks` lets patch generation and validation proceed around webhook reads that
// no rule migrates, when other confirmed work exists; they stay unresolved, so publication (which
// never passes it) still stops.
// `aiWebhooks`: AI is enabled and receives unmigrated webhook reads, so they never block on their own.
export function migrationReviewReason(
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
  if (
    evidence.findings.some(
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
    )
  )
    return WEBHOOK_REVIEW_REASON;
  if (evidence.skippedFiles?.length) return SKIPPED_SOURCE_REVIEW_REASON;
  const contractReview = evidence.findings.find((finding) => finding.contractReview);
  if (contractReview) return contractReview.contractReview;
  if (evidence.findings.some((finding) => finding.requestParameter))
    return REMOVED_REQUEST_PARAMETER_REVIEW_REASON;
  if (evidence.findings.some((finding) => finding.classClient))
    return 'Affected SDK responses use a class client whose initialization, mutation or receiver lifetime requires review. Automatic migration, AI and publication require stable class-client provenance.';
  if (evidence.findings.some((finding) => finding.helperClient))
    return 'Affected SDK usage flows through a helper whose callers, client origins or mutations require review. Automatic migration, AI and publication require stable helper-client provenance.';
  if (
    evidence.findings.some((finding) => finding.declaredType && finding.confidence !== 'confirmed')
  )
    return DECLARED_TYPE_REVIEW_REASON;
  if (evidence.findings.some((finding) => finding.typeEvidence)) return TYPE_EVIDENCE_REVIEW_REASON;
}

// With --publish-unresolved, a deterministic migration proceeds around traced calls that still send
// a removed request parameter: they stay unresolved and the draft lists them for the owner.
export function withoutRequestParameters<T extends { findings: Finding[] }>(evidence: T): T {
  return {
    ...evidence,
    findings: evidence.findings.filter((finding) => !finding.requestParameter),
  };
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
