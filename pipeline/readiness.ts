import { basename, dirname, join, resolve } from 'node:path';
import { readCommittedRepository } from './committed-repository.ts';
import { resolveDockerImage } from './docker-sandbox.ts';
import { readPreparationInputs } from './dependency-inputs.ts';
import { unmappedBreakingChanges } from './openapi-diff.ts';
import { runPipeline } from './run.ts';
import { stripeWebhookConstructor } from './stripe-webhook-payloads.ts';
import { migrationReviewReason } from './migration-review.ts';
import { hasErrorCode } from './state-files.ts';
import { PipelineInputError } from './types.ts';
import { readWorkflowConfiguration, REPOSITORY_CONFIGURATION } from './workflow-configuration.ts';

const MAX_UNMAPPED_EXAMPLES = 3;
const FILE_ERROR_CODES = ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'];

export interface ReadinessCheck {
  id: string;
  title: string;
  status: 'passed' | 'review' | 'blocked';
  detail: string;
  action: string | null;
}

export interface ReadinessReport {
  formatVersion: 1;
  kind: 'refit-readiness';
  status: 'ready-for-validation' | 'needs-attention';
  configuration: string;
  integration?: string;
  repository: string | null;
  revision: string | null;
  provider: { id: string; packageName: string } | null;
  image: string | null;
  currentSourceChecked: boolean;
  checks: ReadinessCheck[];
  sdkCoverage: {
    observedCalls: number;
    mappedCalls: number;
    localHelperCalls: number;
    unmappedMethods: string[];
    unmappedExamples: { file: string; line: number; method: string }[];
  } | null;
  scope: string[];
}

async function inspectCheck<T>(
  id: string,
  title: string,
  action: string,
  inspect: () => Promise<T>,
) {
  const check: ReadinessCheck = { id, title, status: 'passed', detail: '', action: null };
  try {
    return { check, value: await inspect() };
  } catch (error) {
    if (error instanceof PipelineInputError) check.detail = error.message;
    else if (FILE_ERROR_CODES.some((code) => hasErrorCode(error, code)))
      check.detail = `${title} could not access a required file or executable.`;
    else if (
      error instanceof Error &&
      'cmd' in error &&
      (('killed' in error && error.killed) ||
        hasErrorCode(error, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'))
    )
      check.detail = `${title} exceeded the inspection time or output limit.`;
    else if (
      error instanceof Error &&
      'cmd' in error &&
      'code' in error &&
      typeof error.code === 'number'
    )
      check.detail = `${title} inspection command failed with exit code ${error.code}.`;
    else throw error;
    check.status = 'blocked';
    check.action = action;
    return { check, value: undefined };
  }
}

export async function inspectRepositoryReadiness(options: {
  repository?: string;
  config?: string;
  integration?: string;
}): Promise<ReadinessReport> {
  const configurationPath = options.config
    ? resolve(options.config)
    : join(resolve(options.repository ?? process.cwd()), REPOSITORY_CONFIGURATION);
  const report: ReadinessReport = {
    formatVersion: 1,
    kind: 'refit-readiness',
    status: 'needs-attention',
    configuration: configurationPath,
    repository: options.repository ? resolve(options.repository) : null,
    revision: null,
    provider: null,
    image: null,
    currentSourceChecked: false,
    checks: [],
    sdkCoverage: null,
    scope: [
      'Readiness permits an attempt at validation; it does not prove migration correctness or test quality.',
      'No application code, dependency installation, model request, source download, GitHub request or publication is performed.',
      'Only bounded ESM/CommonJS client patterns, supported repository aliases and configured SDK mappings are inspected; other usage can remain undetected.',
      'The configuration is not approved or activated by this command. SDK/API-version rollout and effective account versions still need review.',
    ],
  };
  const configuration = await inspectCheck(
    'configuration',
    'Workflow configuration',
    `Supply --config with a valid workflow file, or commit ${REPOSITORY_CONFIGURATION} in the repository root.`,
    () => readWorkflowConfiguration(configurationPath, options.integration),
  );
  report.checks.push(configuration.check);
  if (!configuration.value) return report;
  const workflow = configuration.value;
  if (workflow.integration) report.integration = workflow.integration;
  configuration.check.detail = 'Workflow fields and check command arrays are valid.';
  const repository =
    options.repository ??
    workflow.repository ??
    (basename(configurationPath) === REPOSITORY_CONFIGURATION ? dirname(configurationPath) : null);
  if (!repository) {
    report.checks.push({
      id: 'repository',
      title: 'Committed repository',
      status: 'blocked',
      detail: 'This external workflow does not select a local repository.',
      action: 'Supply --repository with the clean Git repository root.',
    });
    return report;
  }
  report.repository = resolve(repository);
  const [snapshot, scan, image] = await Promise.all([
    inspectCheck(
      'repository',
      'Committed repository',
      'Use the Git repository root with a committed HEAD and clean git status, including untracked files; tracked symlinks and submodules are unsupported.',
      () => readCommittedRepository(repository),
    ),
    inspectCheck(
      'analysis',
      'Contracts and adapter',
      'Check specification paths, provider mappings and replacement rules. Install oasdiff for full comparison; workers default to full comparison unless fullDiff is false.',
      () =>
        runPipeline({
          repository,
          before: workflow.before,
          after: workflow.after ?? workflow.before,
          providerConfig: workflow.providerConfig,
          apiVersion: workflow.apiVersion,
          apiVersionPolicy: workflow.apiVersionPolicy,
          fullDiff: workflow.fullDiff ?? true,
        }),
    ),
    inspectCheck(
      'docker',
      'Local Docker image',
      'Start the Docker daemon and explicitly install the configured image. Refit never pulls a validation image automatically.',
      () => resolveDockerImage(workflow.image),
    ),
  ]);
  report.checks.push(snapshot.check, scan.check);
  if (snapshot.value) {
    report.repository = snapshot.value.directory;
    report.revision = snapshot.value.revision;
    snapshot.check.detail = `Clean committed root at ${snapshot.value.revision.slice(0, 12)}.`;
  }
  if (scan.value) {
    const evidence = scan.value;
    report.provider = { id: evidence.provider, packageName: evidence.adapter.packageName };
    report.currentSourceChecked = !workflow.latestStripe;
    const originReview = migrationReviewReason(evidence, true);
    const webhookReview = migrationReviewReason(
      {
        adapter: evidence.adapter,
        findings: evidence.findings.filter((finding) => finding.webhook),
      },
      true,
    );
    if (originReview && !webhookReview)
      report.checks.push({
        id: 'source-provenance',
        title: 'Migration source evidence',
        status: 'blocked',
        detail: originReview,
        action:
          'Repair skipped sources and establish SDK or incoming-event provenance before activation.',
      });
    if (webhookReview)
      report.checks.push({
        id: 'webhook-migration',
        title: 'Webhook payload migration',
        status: 'blocked',
        detail:
          'Affected snapshot webhook payload reads need separate incoming API-version and migration-policy review.',
        action:
          'Confirm endpoint/event versions and the intended subscription-item policy before activation.',
      });
    else if (evidence.findings.some((finding) => finding.webhook?.migration))
      report.checks.push({
        id: 'webhook-migration',
        title: 'Webhook payload migration',
        status: 'passed',
        detail: `The configured price ${evidence.adapter.stripeSubscriptionPeriods!.priceId} matches a supported guarded handler. The proposed patch checks signed event versions; runtime checks have not run.`,
        action: null,
      });
    if (evidence.sourceResolution.status === 'review')
      report.checks.push({
        id: 'source-resolution',
        title: 'Shared client resolution',
        status: 'blocked',
        detail: evidence.sourceResolution.warnings.join(' '),
        action:
          'Resolve the repository tsconfig/jsconfig aliases and local extends inputs, then inspect the affected client usage before activation.',
      });
    scan.check.detail = `${evidence.repository.scannedFiles} source files inspected; adapter contracts resolved. ${workflow.latestStripe ? 'Latest Stripe source was not fetched; only the baseline was inspected.' : 'Both supplied contracts were inspected.'}`;
    report.checks.push({
      id: 'api-version',
      title: 'Application API version',
      status: evidence.apiVersion.applicability === 'matches-before' ? 'passed' : 'blocked',
      detail: `${evidence.apiVersion.reason} ${evidence.apiVersion.source.reason} Policy: ${evidence.apiVersion.policy}.`,
      action:
        evidence.apiVersion.applicability === 'matches-before'
          ? null
          : 'Verify the application client/account version and configure an exact before-contract API-version pin.',
    });
    if (workflow.latestStripe && !evidence.provenance.before)
      report.checks.push({
        id: 'source-baseline',
        title: 'Live source baseline',
        status: 'blocked',
        detail: 'Latest Stripe discovery requires a pinned Refit baseline snapshot.',
        action:
          'Capture a reviewed Stripe baseline with refit stripe-snapshot before configuring latestStripe.',
      });
    const unsupportedChanges = unmappedBreakingChanges(
      evidence.specificationDiff,
      evidence.changes,
      evidence.findings,
      evidence.operationChanges,
      evidence.requestChanges,
      evidence.expandedFields,
    );
    if (unsupportedChanges.length || evidence.operationImpacts.length)
      report.checks.push({
        id: 'migration-coverage',
        title: 'Supported migration coverage',
        status: 'blocked',
        detail:
          'The supplied contracts contain unresolved breaking changes without a supported migration rule.',
        action:
          'Inspect the scan evidence and define a reviewed adapter migration rule before attempting automatic validation or publication.',
      });
    if (evidence.specificationDiff.engine === 'direct-properties')
      report.checks.push({
        id: 'contract-coverage',
        title: 'Contract comparison coverage',
        status: 'review',
        detail: 'Full comparison is disabled. Only supported removed properties were compared.',
        action: 'Enable fullDiff and install oasdiff to inspect broader breaking contract changes.',
      });
    const helpers = new Set(
      evidence.adapter.packageName === 'stripe'
        ? evidence.sdkCalls.filter(stripeWebhookConstructor)
        : [],
    );
    const operationCalls = evidence.sdkCalls.filter((call) => !helpers.has(call));
    const unmapped = operationCalls.filter(
      (call) =>
        !evidence.adapter.operations.some(
          (operation) => operation.resource === call.resource && operation.method === call.method,
        ),
    );
    report.sdkCoverage = {
      observedCalls: evidence.sdkCalls.length,
      mappedCalls: operationCalls.length - unmapped.length,
      localHelperCalls: helpers.size,
      unmappedMethods: [
        ...new Set(unmapped.map((call) => `${call.resource}.${call.method}`)),
      ].sort(),
      unmappedExamples: unmapped.slice(0, MAX_UNMAPPED_EXAMPLES).map((call) => ({
        file: call.file,
        line: call.line,
        method: `${call.resource}.${call.method}`,
      })),
    };
    const mappedCalls = operationCalls.length - unmapped.length;
    const missingMappings = !mappedCalls && (operationCalls.length > 0 || !helpers.size);
    report.checks.push({
      id: 'sdk-coverage',
      title: 'SDK call mapping',
      status: missingMappings ? 'blocked' : unmapped.length ? 'review' : 'passed',
      detail: `${mappedCalls} of ${operationCalls.length} observed SDK API calls have configured mappings. ${helpers.size ? `${helpers.size} local webhook signature constructor${helpers.size === 1 ? '' : 's'} recognized; incoming version and policy require separate review. ` : ''}${unmapped.length ? 'Unmapped calls are outside automatic coverage.' : 'This count does not prove complete code coverage.'}`,
      action: missingMappings
        ? 'Confirm the SDK constructor/import mapping and supported client pattern, then inspect scan evidence before attempting a migration.'
        : unmapped.length
          ? 'Review unmapped methods against provider documentation and add verified adapter mappings where supported.'
          : null,
    });
    const unknownLocks = evidence.repository.dependencies.filter(
      (dependency) => dependency.lock.status !== 'locked',
    );
    if (unknownLocks.length)
      report.checks.push({
        id: 'sdk-version',
        title: 'Recorded SDK version',
        status: 'review',
        detail: `${unknownLocks.length} SDK declaration${unknownLocks.length === 1 ? '' : 's'} lack a resolved supported npm, pnpm or yarn lockfile version.`,
        action:
          'Review the actual installed SDK version and replacement method availability; dependency declarations alone are not installation evidence.',
      });
  }
  if (workflow.prepareDependencies && snapshot.value) {
    const dependencies = await inspectCheck(
      'dependencies',
      'Dependency preparation inputs',
      'Commit matching root manifests and a supported public-registry lockfile, or use a custom dependency image.',
      () => readPreparationInputs(snapshot.value!),
    );
    if (dependencies.value) {
      const workspaces = Object.keys(dependencies.value.inputs.workspaceHashes ?? {}).length;
      dependencies.check.detail = `${dependencies.value.inputs.packages} locked package records${workspaces ? ` and ${workspaces} committed workspace manifests` : ''} passed preparation input checks. Installation and engine compatibility were not tested.`;
    }
    report.checks.push(dependencies.check);
  } else if (!workflow.prepareDependencies)
    report.checks.push({
      id: 'dependencies',
      title: 'Validation dependencies',
      status: 'review',
      detail: 'A custom validation image must supply the dependencies used by the check commands.',
      action:
        'Run baseline validation to verify that the image contains the required runtime and dependencies.',
    });
  report.image = image.value ?? null;
  if (image.value)
    image.check.detail = `Existing image resolved to ${image.value}. No container was started.`;
  report.checks.push(image.check);
  report.status = report.checks.some((check) => check.status === 'blocked')
    ? 'needs-attention'
    : 'ready-for-validation';
  return report;
}
