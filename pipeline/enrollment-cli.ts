import { parseArgs } from 'node:util';
import {
  approveRepositoryEnrollment,
  inspectRepositoryEnrollment,
} from './repository-enrollment.ts';
import { PipelineInputError } from './types.ts';
import { terminalText } from './workflow-presentation.ts';
import { cliErrorMessage } from './cli-errors.ts';

const USAGE =
  'Usage: refit enroll --repository <clean-git-root> --github owner/repository --base main [--json]\nApprove after review: add --approve <exact-fingerprint> --output <new-receipt-outside-git.json>\nReads the committed root .refit.json, baseline and adapter without running app code, installing dependencies, contacting GitHub or requesting AI. Inspect the settings and files before approval. A receipt does not grant GitHub access, run a worker or enable AI/publication.';

try {
  const { values } = parseArgs({
    options: {
      repository: { type: 'string' },
      github: { type: 'string' },
      base: { type: 'string' },
      approve: { type: 'string' },
      output: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) console.log(USAGE);
  else {
    if (
      !values.repository ||
      !values.github ||
      !values.base ||
      Boolean(values.approve) !== Boolean(values.output)
    )
      throw new PipelineInputError(USAGE);
    const enrollment = await inspectRepositoryEnrollment({
      repository: values.repository,
      github: values.github,
      base: values.base,
    });
    const review = {
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
      scope:
        'This review covers execution settings, baseline and adapter. Application code and current API source contents may change. No execution, AI or publication is enabled by this command.',
    };
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
    if (values.approve) {
      const result = await approveRepositoryEnrollment({
        enrollment,
        fingerprint: values.approve,
        output: values.output!,
      });
      console.log(
        values.json
          ? JSON.stringify(result, null, 2)
          : `Repository configuration approved\n\nTarget       ${terminalText(enrollment.repository)} at ${terminalText(enrollment.base)}\nFingerprint  ${enrollment.fingerprint}\nReceipt      ${terminalText(result.output)}\n\nSelect this receipt in a service target to activate the reviewed configuration. AI and draft publication remain separate opt-ins.`,
      );
    } else
      console.log(
        values.json
          ? JSON.stringify(review, null, 2)
          : `Review repository configuration\n\nTarget       ${terminalText(enrollment.repository)} at ${terminalText(enrollment.base)}\nRevision     ${enrollment.reviewedRevision}\nFingerprint  ${enrollment.fingerprint}\n\nAPI versions\n${versions}\n\nCommitted inputs\n${enrollment.files.map((file) => `  ${file.integration ? `${terminalText(file.integration)} ` : ''}${file.role}: ${terminalText(file.path)} (${file.bytes} bytes, SHA-256 ${file.sha256})`).join('\n')}\n\nSettings\n${settings}\n\n${review.scope}\nApprove only after inspecting these settings and files, using --approve with this exact fingerprint and --output outside Git.`,
      );
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(cliErrorMessage(error, 'enroll'));
  process.exitCode = 1;
}
