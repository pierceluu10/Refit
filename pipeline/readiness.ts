import { lstat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { readCommittedRepository } from './committed-repository.ts';
import { resolveDockerImage } from './docker-sandbox.ts';
import { readPreparationInputs } from './dependency-inputs.ts';
import { preparationStop } from './preparation-stops.ts';
import type { BreakingOperationImpact } from './provider-operations.ts';
import { unmappedBreakingChanges } from './openapi-diff.ts';
import { runPipeline } from './run.ts';
import { stripeWebhookConstructor } from './stripe-webhook-payloads.ts';
import { migrationReviewReason } from './migration-review.ts';
import { hasErrorCode } from './state-files.ts';
import { PipelineInputError } from './types.ts';
import {
  parseWorkflowConfiguration,
  readWorkflowConfiguration,
  REPOSITORY_CONFIGURATION,
} from './workflow-configuration.ts';
import { contractCommand } from './contract-commands.ts';
import { DEFAULT_CONTRACTS_DIRECTORY, readStripeContract } from './enrollment-contracts.ts';
import {
  proposalContent,
  proposalSummary,
  proposeStripeConfiguration,
  type StripeProposal,
} from './enrollment-proposal.ts';

const MAX_UNMAPPED_EXAMPLES = 3;
// How many called operations the migration-coverage detail names before "and N more".
const MAX_NAMED_OPERATIONS = 3;
const SUBMODULE = /^Validation does not accept submodules;/;
const GENERATED_TITLE = 'Generated configuration';
// Stops that mean the repository has no Stripe code to generate a configuration for.
const NOT_STRIPE = new Set(['no-package-json', 'no-stripe-dependency']);
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
  // Present when no .refit.json is committed and doctor checked the generated configuration.
  generated?: Pick<StripeProposal, 'apiVersion' | 'target' | 'checks' | 'configuration'>;
  sdkCoverage: {
    observedCalls: number;
    mappedCalls: number;
    localHelperCalls: number;
    unmappedMethods: string[];
    unmappedExamples: { file: string; line: number; method: string }[];
  } | null;
  scope: string[];
}

// Names the file or program a check could not use, when the error says which.
function missingFileDetail(title: string, error: unknown) {
  const { path, syscall, code } = error as { path?: unknown; syscall?: unknown; code?: unknown };
  if (typeof path !== 'string') return `${title} could not access a required file or executable.`;
  if (typeof syscall === 'string' && syscall.startsWith('spawn'))
    return `${title} needs ${path}, which is not installed or not on PATH.`;
  return code === 'ENOENT' || code === 'ENOTDIR'
    ? `${title} needs ${path}, which does not exist.`
    : `${title} cannot read ${path}.`;
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
      check.detail = missingFileDetail(title, error);
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

// What Refit cannot migrate, in one sentence: how many changes, between which versions, and the
// operations the code calls with one call site each.
function migrationCoverageDetail(
  changes: number,
  impacts: BreakingOperationImpact[],
  apiVersion: { before: string | null; after: string | null },
) {
  const count = changes || impacts.reduce((total, impact) => total + impact.changes.length, 0);
  const versions =
    apiVersion.before && apiVersion.after && apiVersion.before !== apiVersion.after
      ? ` from API version ${apiVersion.before} to ${apiVersion.after}`
      : '';
  const operations = impacts.slice(0, MAX_NAMED_OPERATIONS).map((impact) => {
    const call = impact.usages[0];
    return `${impact.httpMethod.toUpperCase()} ${impact.path}${call ? ` at ${call.file}:${call.line}` : ''}`;
  });
  const more = impacts.length - operations.length;
  return `The contracts list ${count} breaking change${count === 1 ? '' : 's'}${versions} that no Refit rule migrates${
    impacts.length
      ? `, including changes to ${impacts.length} operation${impacts.length === 1 ? '' : 's'} the code calls: ${operations.join(', ')}${more ? ` and ${more} more` : ''}`
      : ''
  }.`;
}

// Each method Refit does not map, at its first call, so the person knows which calls to check.
function unmappedCallsDetail(
  packageName: string,
  calls: number,
  unmapped: { resource: string; method: string; file: string; line: number }[],
) {
  const methods = unmapped.filter(
    (call, index) =>
      unmapped.findIndex(
        (other) => other.resource === call.resource && other.method === call.method,
      ) === index,
  );
  const named = methods
    .slice(0, MAX_UNMAPPED_EXAMPLES)
    .map((call) => `${call.resource}.${call.method} at ${call.file}:${call.line}`);
  const more = methods.length - named.length;
  return `Refit traced ${calls} ${packageName} API call${calls === 1 ? '' : 's'}, and it maps none of their methods to an operation in the contracts: ${named.join(', ')}${more ? ` and ${more} more` : ''}.`;
}

async function committedRepositoryCheck(repository: string) {
  const snapshot = await inspectCheck(
    'repository',
    'Committed repository',
    'Commit or stash the files it names, then run refit doctor again. Doctor needs the Git repository root with a committed HEAD; submodules and symlinks that resolve outside the repository are unsupported.',
    () => readCommittedRepository(repository),
  );
  if (snapshot.value)
    snapshot.check.detail = `Clean committed root at ${snapshot.value.revision.slice(0, 12)}.`;
  else if (SUBMODULE.test(snapshot.check.detail))
    snapshot.check.action =
      "Commit the submodule's files into this repository, or remove the submodule, then run refit doctor again.";
  return snapshot;
}

// What doctor checks in a repository that commits no .refit.json: the configuration enrollment
// generates for it, read from the saved contracts, or why there is none. A repository without
// Stripe keeps the guidance to add an agent.
async function generatedWorkflow(directory: string, contracts: string) {
  const { proposal, stops } = await proposeStripeConfiguration(directory);
  if (!proposal) {
    const stripe = !stops.some((stop) => NOT_STRIPE.has(stop.id));
    return {
      workflow: null,
      checks: stripe
        ? stops.map((stop): ReadinessCheck => ({
            ...stop,
            title: GENERATED_TITLE,
            status: 'blocked',
          }))
        : [
            {
              id: 'configuration',
              title: 'Workflow configuration',
              status: 'blocked' as const,
              detail: `No ${REPOSITORY_CONFIGURATION} in ${directory} yet, and Refit found no Stripe package to generate one for.`,
              action: `Run refit agents to see which provider agents apply, then refit agents --add <id> to write ${REPOSITORY_CONFIGURATION}.`,
            },
          ],
    };
  }
  const versions = [...new Set([proposal.apiVersion.value, proposal.target])];
  const unsaved: string[] = [];
  for (const version of versions)
    await readStripeContract(contracts, version).catch((error: unknown) => {
      if (!(error instanceof PipelineInputError)) throw error;
      unsaved.push(version);
    });
  if (unsaved.length)
    return {
      workflow: null,
      checks: [
        {
          id: 'contracts',
          title: 'Stripe contracts',
          status: 'blocked' as const,
          detail: `The generated configuration compares Stripe API versions ${versions.join(' and ')}, and ${unsaved.join(' and ')} ${unsaved.length === 1 ? 'is' : 'are'} not saved in ${contracts} yet.`,
          action: `Run refit stripe-snapshot ${unsaved.map((version) => `--version ${version}`).join(' ')}, then refit doctor again.`,
        },
      ],
    };
  return {
    workflow: {
      proposal,
      content: proposalContent(proposal),
      // Relative contract paths in the generated file resolve inside the contracts directory.
      path: join(resolve(contracts), REPOSITORY_CONFIGURATION),
    },
    checks: [],
  };
}

export async function inspectRepositoryReadiness(options: {
  repository?: string;
  config?: string;
  integration?: string;
  contracts?: string;
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
  const missing = await lstat(configurationPath).then(
    () => false,
    (error: unknown) => hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR'),
  );
  const repositoryExists = await lstat(dirname(configurationPath)).then(
    () => true,
    () => false,
  );
  const generated =
    missing && !options.config && repositoryExists
      ? await generatedWorkflow(
          dirname(configurationPath),
          options.contracts ?? DEFAULT_CONTRACTS_DIRECTORY,
        )
      : undefined;
  if (generated && !generated.workflow) {
    // Every blocker at once, so a repository that also has, say, a submodule hears it now.
    const snapshot = await committedRepositoryCheck(dirname(configurationPath));
    if (snapshot.check.status === 'blocked') report.checks.push(snapshot.check);
    report.checks.push(...generated.checks);
    return report;
  }
  if (missing && !generated) {
    report.checks.push({
      id: 'configuration',
      title: 'Workflow configuration',
      status: 'blocked',
      detail: options.config
        ? `${configurationPath} does not exist.`
        : `${dirname(configurationPath)} does not exist.`,
      action: options.config
        ? `Check the --config path, or omit --config to use the repository's ${REPOSITORY_CONFIGURATION}.`
        : 'Check the --repository path, or run refit doctor from inside the repository.',
    });
    return report;
  }
  const configuration = await inspectCheck(
    'configuration',
    'Workflow configuration',
    `Supply --config with a valid workflow file, or commit ${REPOSITORY_CONFIGURATION} in the repository root.`,
    async () =>
      generated?.workflow
        ? parseWorkflowConfiguration(
            generated.workflow.content,
            generated.workflow.path,
            options.integration,
          )
        : readWorkflowConfiguration(configurationPath, options.integration),
  );
  report.checks.push(configuration.check);
  const choice = /choose one with --integration: ([^,.]+)/.exec(configuration.check.detail);
  if (choice)
    configuration.check.action = `Run refit doctor --integration ${choice[1]}, and once for each other integration listed.`;
  if (!configuration.value) return report;
  const workflow = configuration.value;
  if (workflow.integration) report.integration = workflow.integration;
  configuration.check.detail = generated?.workflow
    ? proposalSummary(generated.workflow.proposal)
    : 'Workflow fields and check command arrays are valid.';
  if (generated?.workflow)
    report.generated = {
      apiVersion: generated.workflow.proposal.apiVersion,
      target: generated.workflow.proposal.target,
      checks: generated.workflow.proposal.checks,
      configuration: generated.workflow.proposal.configuration,
    };
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
    committedRepositoryCheck(repository),
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
  if (scan.check.status === 'blocked') {
    const missing: { side: 'before' | 'after'; path: string }[] = [];
    for (const side of ['before', 'after'] as const) {
      const path = side === 'after' ? workflow.after : workflow.before;
      if (
        path &&
        (await lstat(path).then(
          () => false,
          () => true,
        ))
      )
        missing.push({ side, path: relative(report.repository, path) });
    }
    // Contracts are read in parallel, so the error names either; this names both, in order.
    if (missing.length) {
      scan.check.detail = `Missing contract${missing.length > 1 ? 's' : ''}: ${missing.map(({ path }) => path).join(', ')}.`;
      scan.check.action = `Save the contract${missing.length > 1 ? 's' : ''}: ${missing.map(({ side, path }) => contractCommand(workflow.integration, side, path)).join(' and ')}. Then run refit doctor again.`;
    }
  }
  if (snapshot.value) {
    report.repository = snapshot.value.directory;
    report.revision = snapshot.value.revision;
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
        action: evidence.findings.some((finding) => finding.requestParameter)
          ? 'Run refit run --human to see where each removed parameter is still sent, and change those calls yourself: Refit replaces only the owner-approved Stripe payment_method_types lists in docs/STRIPE-PAYMENT-METHOD-TYPES.md, including the keep-listed opt-in.'
          : 'Repair skipped sources and establish SDK or incoming-event provenance before activation.',
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
        detail: evidence.adapter.stripeSubscriptionPeriods
          ? `The configured price ${evidence.adapter.stripeSubscriptionPeriods.priceId} matches a supported guarded handler. The proposed patch checks signed event versions; runtime checks have not run.`
          : `Webhook subscription-period reads accept both the old and the new payload shape, so the endpoint version can change separately. ${evidence.findings.some((finding) => finding.subscriptionPeriod?.rareCase === 'flagged') ? 'Subscriptions with items on different billing periods are not handled; set stripeSubscriptionPeriods to choose which item counts.' : 'Items on different billing periods use the item the application already selects or the configured price policy.'} Runtime checks have not run.`,
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
          : evidence.apiVersion.application === null && evidence.apiVersion.before
            ? `Confirm your client and account use ${evidence.apiVersion.before}, then add "apiVersion": "${evidence.apiVersion.before}" to ${workflow.integration ? `the ${workflow.integration} integration in ` : ''}${REPOSITORY_CONFIGURATION}.`
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
        detail: migrationCoverageDetail(
          unsupportedChanges.length,
          evidence.operationImpacts,
          evidence.apiVersion,
        ),
        action:
          'Run refit run --human to see each change and where the code reaches it, and migrate those calls by hand. Refit has no reviewed rule for these changes, so it stops before validation.',
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
      detail:
        !operationCalls.length && !helpers.size
          ? `Refit traced no ${evidence.adapter.packageName} API call in this code, so it cannot tell what the migration changes. Calls made inside another library, or through a client Refit cannot follow, are not counted.`
          : missingMappings
            ? unmappedCallsDetail(evidence.adapter.packageName, operationCalls.length, unmapped)
            : `${mappedCalls} of ${operationCalls.length} observed SDK API calls have configured mappings. ${helpers.size ? `${helpers.size} local webhook signature constructor${helpers.size === 1 ? '' : 's'} recognized; incoming version and policy require separate review. ` : ''}${unmapped.length ? 'Unmapped calls are outside automatic coverage.' : 'This count does not prove complete code coverage.'}`,
      action: missingMappings
        ? !operationCalls.length
          ? `If the code reaches ${evidence.adapter.packageName} only through another library, upgrade that library instead. Otherwise run refit run --human to see which clients Refit found, and call the API through one it can follow.`
          : `Check these calls against the ${evidence.adapter.packageName} changes${evidence.apiVersion.before && evidence.apiVersion.after ? ` from ${evidence.apiVersion.before} to ${evidence.apiVersion.after}` : ''} by hand. Refit cannot tell what the migration changes for a method it does not map, so it stops before validation.`
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
    } else if (dependencies.check.status === 'blocked') {
      dependencies.check.action =
        preparationStop(dependencies.check.detail)?.action ?? dependencies.check.action;
      if (report.generated)
        dependencies.check.action += ` This repository commits no ${REPOSITORY_CONFIGURATION}: to change its settings, commit the generated one first (refit doctor --json prints it as generated.configuration).`;
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
