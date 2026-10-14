import { WEBHOOK_REVIEW_REASON } from './stripe-webhook-payloads.ts';
import type { Finding } from './types.ts';

const DECLARED_TYPE_REVIEW_REASON =
  'Declared Stripe types identify possible usage but do not establish SDK or incoming-event provenance. Automatic migration, AI and publication require traced source evidence.';
const SKIPPED_SOURCE_REVIEW_REASON =
  'Unparseable source files were skipped. Their API usage and mutations are unknown; automatic migration, AI and publication require a complete source scan.';

export function migrationReviewReason(evidence: { findings: Finding[]; skippedFiles?: string[] }) {
  if (evidence.findings.some((finding) => finding.webhook)) return WEBHOOK_REVIEW_REASON;
  if (evidence.skippedFiles?.length) return SKIPPED_SOURCE_REVIEW_REASON;
  if (evidence.findings.some((finding) => finding.declaredType)) return DECLARED_TYPE_REVIEW_REASON;
}
