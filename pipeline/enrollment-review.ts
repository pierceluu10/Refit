import { proposalSummary } from './enrollment-proposal.ts';
import type { inspectRepositoryEnrollment } from './repository-enrollment.ts';
import { terminalText } from './workflow-presentation.ts';

type Enrollment = Awaited<ReturnType<typeof inspectRepositoryEnrollment>>;

const SCOPE =
  'This review covers execution settings, baseline and adapter. Application code and current API source contents may change. No execution, AI or publication is enabled by this command.';

// What `refit enroll` shows before approval; the hosted approval issue shows the same review.
export function enrollmentReview(enrollment: Enrollment) {
  return {
    formatVersion: 1,
    kind: 'refit-enrollment-review',
    repository: enrollment.repository,
    base: enrollment.base,
    reviewedRevision: enrollment.reviewedRevision,
    fingerprint: enrollment.fingerprint,
    files: enrollment.files,
    settings: enrollment.settings,
    apiVersion: enrollment.apiVersion,
    profiles: enrollment.profiles.map(({ id, apiVersion }) => ({ id, apiVersion })),
    generated: enrollment.generated
      ? {
          summary: proposalSummary(enrollment.generated),
          apiVersion: enrollment.generated.apiVersion,
          target: enrollment.generated.target,
          checks: enrollment.generated.checks,
        }
      : null,
    scope: SCOPE,
  };
}

export function enrollmentReviewText(enrollment: Enrollment) {
  const settings = JSON.stringify(enrollment.settings, null, 2)
    .split('\n')
    .map(terminalText)
    .join('\n');
  const versions = enrollment.profiles
    .map(
      ({ id, apiVersion }) =>
        `${id ? `${terminalText(id)}: ` : ''}${terminalText(apiVersion.reason)} Source: ${terminalText(apiVersion.source.status)} (${terminalText(apiVersion.policy)}).`,
    )
    .join('\n');
  const files = enrollment.files
    .map(
      (file) =>
        `  ${file.integration ? `${terminalText(file.integration)} ` : ''}${file.role}: ${terminalText(file.path)} (${file.bytes} bytes, SHA-256 ${file.sha256})`,
    )
    .join('\n');
  const generated = enrollment.generated
    ? `Generated    ${terminalText(proposalSummary(enrollment.generated))}\n\n`
    : '';
  return `Review repository configuration\n\nTarget       ${terminalText(enrollment.repository)} at ${terminalText(enrollment.base)}\nRevision     ${enrollment.reviewedRevision}\nFingerprint  ${enrollment.fingerprint}\n\n${generated}API versions\n${versions}\n\n${enrollment.generated ? 'Inputs (the generated .refit.json and saved Stripe contracts)' : 'Committed inputs'}\n${files}\n\nSettings\n${settings}\n\n${SCOPE}`;
}
