import { WEBHOOK_REVIEW_REASON } from './stripe-webhook-payloads.ts';
import type { Finding } from './types.ts';
import type { ProviderAdapter } from './providers.ts';
import {
  SUBSCRIPTION_PERIOD_EITHER_RULE,
  SUBSCRIPTION_PERIOD_RULE,
} from './stripe-subscription-periods.ts';

const DECLARED_TYPE_REVIEW_REASON =
  'Declared Stripe types identify possible usage but do not establish SDK or incoming-event provenance. Automatic migration, AI and publication require traced source evidence.';
const SKIPPED_SOURCE_REVIEW_REASON =
  'Unparseable source files were skipped. Their API usage and mutations are unknown; automatic migration, AI and publication require a complete source scan.';

// `leaveUnmigratedWebhooks` lets patch generation and validation proceed around webhook reads that
// no rule migrates, when other confirmed work exists; they stay unresolved, so publication (which
// never passes it) still stops.
export function migrationReviewReason(
  evidence: { findings: Finding[]; skippedFiles?: string[]; adapter?: ProviderAdapter },
  allowConfiguredWebhookMigration = false,
  leaveUnmigratedWebhooks = false,
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
        !(leaveUnmigratedWebhooks && otherWork && !finding.webhook.migration) &&
        !(
          allowConfiguredWebhookMigration &&
          finding.confidence === 'confirmed' &&
          finding.webhook.migration?.rule === SUBSCRIPTION_PERIOD_EITHER_RULE
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
  if (evidence.findings.some((finding) => finding.classClient))
    return 'Affected SDK responses use a class client whose initialization, mutation or receiver lifetime requires review. Automatic migration, AI and publication require stable class-client provenance.';
  if (evidence.findings.some((finding) => finding.helperClient))
    return 'Affected SDK usage flows through a helper whose callers, client origins or mutations require review. Automatic migration, AI and publication require stable helper-client provenance.';
  if (
    evidence.findings.some((finding) => finding.declaredType && finding.confidence !== 'confirmed')
  )
    return DECLARED_TYPE_REVIEW_REASON;
}
