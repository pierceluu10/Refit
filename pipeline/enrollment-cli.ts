import { parseArgs } from 'node:util';
import {
  approveRepositoryEnrollment,
  inspectRepositoryEnrollment,
} from './repository-enrollment.ts';
import { enrollmentReview, enrollmentReviewText } from './enrollment-review.ts';
import { PipelineInputError } from './types.ts';
import { terminalText } from './workflow-presentation.ts';
import { cliErrorMessage } from './cli-errors.ts';

const USAGE =
  'Usage: refit enroll --repository <clean-git-root> --github owner/repository --base main [--publish-unresolved] [--json]\nApprove after review: add --approve <exact-fingerprint> --output <new-receipt-outside-git.json>\nReads the committed root .refit.json, baseline and adapter without running app code, installing dependencies, contacting GitHub or requesting AI. With no .refit.json committed, it reviews the Stripe configuration Refit generates from the code, read with the contracts refit stripe-snapshot --version saved; --publish-unresolved generates one for a repository without a lockfile or checks too, for a worker run with --publish-unresolved, and records why Refit cannot test its patches. Inspect the settings and files before approval. A receipt does not grant GitHub access, run a worker or enable AI/publication.';
const HELP = 'Run refit enroll --help for its options.';

try {
  const { values } = parseArgs({
    options: {
      repository: { type: 'string' },
      github: { type: 'string' },
      base: { type: 'string' },
      approve: { type: 'string' },
      output: { type: 'string' },
      'publish-unresolved': { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) console.log(USAGE);
  else {
    const { repository, github, base } = values;
    if (!repository || !github || !base) {
      const missing = Object.entries({ repository, github, base })
        .filter(([, value]) => !value)
        .map(([name]) => `--${name}`);
      throw new PipelineInputError(
        `${new Intl.ListFormat('en').format(missing)} ${missing.length === 1 ? 'is' : 'are'} required. ${HELP}`,
      );
    }
    if (Boolean(values.approve) !== Boolean(values.output))
      throw new PipelineInputError(`--approve and --output go together. ${HELP}`);
    const enrollment = await inspectRepositoryEnrollment({
      repository,
      github,
      base,
      allowUntested: values['publish-unresolved'],
    });
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
          ? JSON.stringify(enrollmentReview(enrollment), null, 2)
          : `${enrollmentReviewText(enrollment)}\nApprove only after inspecting these settings and files, using --approve with this exact fingerprint and --output outside Git.`,
      );
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(cliErrorMessage(error, 'enroll'));
  process.exitCode = 1;
}
