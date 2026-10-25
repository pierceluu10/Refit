import { lstat, readFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { declaresVersion } from './api-version.ts';
import { readCommittedRepository } from './committed-repository.ts';
import { resolveDockerImage } from './docker-sandbox.ts';
import { readPreparationInputs } from './dependency-inputs.ts';
import { preparationStop } from './preparation-stops.ts';
import type { BreakingOperationImpact } from './provider-operations.ts';
import { unmappedBreakingChanges } from './openapi-diff.ts';
import { runPipeline } from './run.ts';
import { stripeWebhookConstructor } from './stripe-webhook-payloads.ts';
import { migrationReviewReason, targetReached } from './migration-review.ts';
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
  generatedVersionCheck,
  proposalContent,
  proposalSummary,
  proposeStripeConfiguration,
  unreadableExtendsReason,
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
  // Present when no .refit.json is committed and doctor stopped before checking a generated one.
  missing?: true;
  sdkCoverage: {
    observedCalls: number;
    mappedCalls: number;
    localHelperCalls: number;
    unmappedMethods: string[];
    unmappedExamples: { file: string; line: number; method: string }[];
  } | null;
  scope: string[];
}

// What a blocked check does to a hosted run under owner decision 1 (2026-10-24, pierceluu10/Refit#300).
// `setup` still stops before scanning: there is no workflow, contract, checkout or sandbox to run.
// The workflow finds a `workflow` check's cause itself and records it as a review reason or an
// untested patch. Only doctor sees a `review` check, so it joins the draft's review reasons.
const BLOCKED_CHECKS = new Map<string, 'setup' | 'workflow' | 'review'>([
  ['configuration', 'setup'],
  ['contracts', 'setup'],
  ['repository', 'setup'],
  ['analysis', 'setup'],
  ['docker', 'setup'],
  ['source-baseline', 'setup'],
  ['source-provenance', 'workflow'],
  ['webhook-migration', 'workflow'],
  ['api-version', 'workflow'],
  ['migration-coverage', 'workflow'],
  ['dependencies', 'workflow'],
  ['source-resolution', 'review'],
  ['sdk-coverage', 'review'],
]);

export class UnclassifiedCheckError extends Error {}

// The blocked checks of a report by what they do under owner decision 1. A repository whose
// generated configuration doctor could not check has no workflow to run, so all of its are setup.
export function sortBlockedChecks(report: ReadinessReport) {
  const sorted = {
    setup: [] as ReadinessCheck[],
    workflow: [] as ReadinessCheck[],
    review: [] as ReadinessCheck[],
  };
  for (const check of report.checks.filter((entry) => entry.status === 'blocked')) {
    const kind = report.missing ? 'setup' : BLOCKED_CHECKS.get(check.id);
    if (!kind)
      throw new UnclassifiedCheckError(
        `refit doctor check ${check.id} can block, but owner decision 1 does not say whether it stops a run.`,
      );
    sorted[kind].push(check);
  }
  return sorted;
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
async function generatedWorkflow(directory: string, contracts: string, allowUntested?: boolean) {
  const { proposal, stops } = await proposeStripeConfiguration(directory, { allowUntested });
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
  // Versions the service already watches this target from, such as a merged Refit draft's target.
  // Code that declares one passes the API-version check, as it passes the approval check.
  acceptedApiVersions?: string[];
  // Owner decision 1: check the generated configuration whose checks cannot run (no lockfile or no
  // checks) instead of reporting why none is generated.
  allowUntested?: boolean;
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
          options.allowUntested,
        )
      : undefined;
  if (generated && !generated.workflow) {
    report.missing = true;
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
    if (evidence.sourceResolution.status === 'review') {
      // The scan read these paths under its size limits, from the same directory.
      const unreadable = unreadableExtendsReason(
        await Promise.all(
          (evidence.repository.configurations ?? []).map(async ({ path }) => ({
            path,
            content: await readFile(join(repository, path), 'utf8'),
          })),
        ),
      );
      const warnings = evidence.sourceResolution.warnings.filter(
        (warning) => !unreadable?.files.some((file) => warning.startsWith(`${file}:`)),
      );
      report.checks.push({
        id: 'source-resolution',
        title: 'Shared client resolution',
        status: 'blocked',
        detail: [
          ...(unreadable
            ? [
                `Refit cannot verify how imports resolve, because ${unreadable.named}, so it stops at clients shared between files.`,
              ]
            : []),
          ...warnings,
        ].join(' '),
        action:
          unreadable && !warnings.length
            ? unreadable.action
            : 'Resolve the repository tsconfig/jsconfig aliases and local extends inputs, then inspect the affected client usage before activation.',
      });
    }
    scan.check.detail = `${evidence.repository.scannedFiles} source files inspected; adapter contracts resolved. ${workflow.latestStripe ? 'Latest Stripe source was not fetched; only the baseline was inspected.' : 'Both supplied contracts were inspected.'}`;
    const watched =
      evidence.apiVersion.applicability === 'matches-before'
        ? undefined
        : options.acceptedApiVersions?.find((version) =>
            declaresVersion(evidence.apiVersion.source, version),
          );
    const versionPassed = evidence.apiVersion.applicability === 'matches-before' || watched;
    report.checks.push({
      id: 'api-version',
      title: 'Application API version',
      status: versionPassed ? 'passed' : 'blocked',
      detail: `${evidence.apiVersion.reason} ${report.generated ? generatedVersionCheck(evidence.apiVersion.source) : `${evidence.apiVersion.source.reason} Policy: ${evidence.apiVersion.policy}.`}${watched ? ` The code declares ${watched}, which this service already watches, so this check passes; the next poll decides whether the code reached that target.` : ''}`,
      action: versionPassed
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
    // A merged draft leaves the fields it migrated unread; the watcher then advances its baseline.
    if (!targetReached(evidence) && (unsupportedChanges.length || evidence.operationImpacts.length))
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
        detail: `Refit cannot tell which ${evidence.adapter.packageName} release ${unknownLocks.map((dependency) => `${dependency.file} (${dependency.version})`).join(', ')} install${unknownLocks.length === 1 ? 's' : ''}: ${[...new Set(unknownLocks.map((dependency) => dependency.lock.reason))].join(' ')}`,
        action: `Check which ${evidence.adapter.packageName} release you install before merging a migration: a declared range is not the installed release, and a migration may use methods only newer releases have.`,
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
      if (report.generated) {
        // The generated file names its contracts relative to itself, so they are committed with it.
        const versions = [...new Set([report.generated.apiVersion.value, report.generated.target])];
        dependencies.check.action += ` This repository commits no ${REPOSITORY_CONFIGURATION}: to change its settings, commit the generated one first (refit doctor --json prints it as generated.configuration) together with the contracts it names: run refit stripe-snapshot ${versions.map((version) => `--version ${version}`).join(' ')} --contracts . in the repository and commit refit/.`;
      }
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
