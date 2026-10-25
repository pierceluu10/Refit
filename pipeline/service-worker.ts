import type { AiOptions } from './ai-budget.ts';
import { saveStripeContract } from './enrollment-contracts.ts';
import { proposeStripeConfiguration } from './enrollment-proposal.ts';
import { authenticateGitHubRead, type GitHubAppConfiguration } from './github-app.ts';
import { withGitHubCheckout } from './github-checkout.ts';
import { requestGitHub } from './github.ts';
import { publicationConfiguration } from './publication.ts';
import { inspectRepositoryReadiness, sortBlockedChecks } from './readiness.ts';
import { loadApprovedRepository } from './repository-enrollment.ts';
import type { ServiceTarget } from './service-configuration.ts';
import { isObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import type { SlackSend } from './slack.ts';
import { watchedApiVersions, watchOnce } from './watch.ts';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { hasErrorCode } from './state-files.ts';
import { REPOSITORY_CONFIGURATION } from './workflow-configuration.ts';

// Confirms through the GitHub API that the App can still read an active repository before any work.
export async function confirmRepositoryAccess(app: GitHubAppConfiguration, repository: string) {
  const authentication = await authenticateGitHubRead(app, repository);
  const record = await requestGitHub(authentication.token, 'GET', `/repos/${repository}`);
  if (
    !isObject(record) ||
    typeof record.full_name !== 'string' ||
    record.full_name.toLowerCase() !== repository.toLowerCase() ||
    !Number.isSafeInteger(record.id) ||
    Number(record.id) <= 0 ||
    record.archived !== false ||
    record.disabled !== false
  )
    throw new PipelineInputError(
      'Configured repository is unavailable, archived, disabled or has mismatched identity.',
    );
  // The default branch and size (in kilobytes) are passed through unchecked for callers that use them.
  return {
    installationId: authentication.installationId,
    id: Number(record.id),
    token: authentication.token,
    defaultBranch: record.default_branch,
    size: record.size,
  };
}

// A repository that commits no .refit.json runs the configuration Refit generates from its code,
// which reads two Stripe contracts. Each is downloaded once into `contracts` and checked against
// the pinned table; with no proposal, enrollment itself names the stop. Returns whether the
// repository runs a generated configuration.
export async function saveGeneratedContracts(repository: string, contracts: string) {
  const committed = await lstat(join(repository, REPOSITORY_CONFIGURATION)).then(
    () => true,
    (error: unknown) => {
      if (hasErrorCode(error, 'ENOENT')) return false;
      throw error;
    },
  );
  if (committed) return false;
  const { proposal } = await proposeStripeConfiguration(repository);
  if (!proposal) return false;
  for (const version of new Set([proposal.apiVersion.value, proposal.target]))
    await saveStripeContract(contracts, version);
  return true;
}

export type ServicePoll = Awaited<ReturnType<typeof pollServiceTarget>>;

export function summarizePoll(result: ServicePoll) {
  if (result.status === 'readiness-blocked')
    return {
      status: 'needs-attention',
      output: result.output,
      message: `refit doctor found setup problems: ${result.stops
        .map((check) => check.title)
        .join(', ')}. Scanning and checks did not run.`,
    };
  return {
    status:
      result.status === 'processed'
        ? result.result.manifest.status
        : result.status === 'documentation-changed'
          ? result.status
          : result.previousStatus,
    output: result.output,
    message:
      result.status === 'processed'
        ? [
            result.result.manifest.reason,
            ...(result.result.manifest.error
              ? [`${result.result.manifest.error.name}: ${result.result.manifest.error.message}`]
              : []),
            ...(result.documentationBaselines?.length
              ? [
                  `Now monitoring ${result.documentationBaselines.length} documentation source${result.documentationBaselines.length === 1 ? '' : 's'}.`,
                ]
              : []),
            ...(result.documentationChanges?.length
              ? [
                  `${result.documentationChanges.length} provider documentation change${result.documentationChanges.length === 1 ? '' : 's'} saved for review.`,
                ]
              : []),
          ].join(' ')
        : result.status === 'documentation-changed'
          ? `Provider documentation changed. Refit saved a unified diff and did not start a migration. The prior API workflow status remains ${result.previousStatus}.`
          : `Saved worker result reused; checks were not rerun.${result.previousReason ? ` That run recorded: ${result.previousReason}` : ''}${result.weeklyStatus ? ` Weekly status posted on ${result.weeklyStatus}.` : ''}`,
  };
}

export async function pollServiceTarget(options: {
  target: ServiceTarget;
  app: GitHubAppConfiguration;
  stateDirectory: string;
  signal: AbortSignal;
  aiPatch?: AiOptions;
  repairAttempts: number;
  publishDraft?: boolean;
  // Owner decision 1: stops become [Needs review] drafts (--publish-unresolved).
  publishUnresolved?: boolean;
  weeklyStatus?: boolean;
  supersedeDrafts?: boolean;
  retry?: boolean;
  // Runs refit doctor on the approved checkout first; blocked setup stops before scanning. With
  // publishUnresolved only setup checks stop, and the checks only doctor sees join the draft.
  inspectReadiness?: boolean;
  // Where the Stripe contracts of a generated configuration are kept.
  contracts?: string;
  notify?: SlackSend;
  onProgress?: (message: string) => void;
}) {
  const { target } = options;
  const targetGitHub = { repository: target.repository, base: target.base, app: options.app };
  const runtime = {
    signal: options.signal,
    aiPatch: options.aiPatch,
    repairAttempts: options.repairAttempts,
    publication: options.publishDraft
      ? {
          ...publicationConfiguration(target.repository, target.base, undefined, options.app),
          ...(options.supersedeDrafts ? { supersedeDrafts: true } : {}),
          ...(options.publishUnresolved ? { allowUnresolved: true } : {}),
        }
      : undefined,
    ...(options.publishUnresolved ? { allowUnresolved: true } : {}),
    ...(options.notify ? { notify: { send: options.notify, repository: target.repository } } : {}),
  };
  if (target.workflow)
    return watchOnce({
      configuration: { ...target.workflow, repository: undefined, ...runtime },
      source: target.source,
      documentationSources: target.documentationSources,
      stateDirectory: options.stateDirectory,
      syncGitHub: targetGitHub,
      retry: options.retry,
      weeklyStatus: options.weeklyStatus,
      onProgress: options.onProgress,
    });
  if (
    target.approval.repository !== target.repository.toLowerCase() ||
    target.approval.base !== target.base
  )
    throw new PipelineInputError('Repository approval does not match the service target.');
  return withGitHubCheckout(
    {
      directory: join(options.stateDirectory, 'github'),
      target: targetGitHub,
      signal: options.signal,
      onProgress: options.onProgress,
    },
    async (checkout) => {
      if (options.contracts) await saveGeneratedContracts(checkout.directory, options.contracts);
      options.signal.throwIfAborted();
      const acceptedApiVersions = await watchedApiVersions(options.stateDirectory);
      const profile = await loadApprovedRepository({
        repository: checkout.directory,
        approval: target.approval,
        integration: target.integration,
        stateDirectory: options.stateDirectory,
        acceptedApiVersions,
        contracts: options.contracts,
      });
      options.signal.throwIfAborted();
      options.onProgress?.(
        `Approved repository configuration verified: ${profile.fingerprint.slice(0, 12)}.`,
      );
      const readiness = options.inspectReadiness
        ? await inspectRepositoryReadiness({
            repository: checkout.directory,
            integration: target.integration,
            contracts: options.contracts,
            acceptedApiVersions,
          })
        : undefined;
      options.signal.throwIfAborted();
      const sorted =
        readiness?.status === 'needs-attention' && options.publishUnresolved
          ? sortBlockedChecks(readiness)
          : undefined;
      const stops = sorted
        ? sorted.setup
        : (readiness?.checks.filter((check) => check.status === 'blocked') ?? []);
      if (readiness && stops.length)
        return { status: 'readiness-blocked' as const, output: null, readiness, stops, checkout };
      const source = target.source ?? profile.source;
      const doctor = sorted?.review ?? [];
      const result = await watchOnce({
        configuration: {
          ...profile.workflow,
          repository: checkout.directory,
          ...runtime,
          ...(doctor.length ? { doctor } : {}),
        },
        source,
        documentationSources: target.documentationSources,
        stateDirectory: options.stateDirectory,
        retry: options.retry,
        weeklyStatus: options.weeklyStatus,
        onProgress: options.onProgress,
      });
      // The approved checks, which model fixes reuse for this repository.
      const { image, command, baselineCommand, prepareDependencies, compareTypeErrors } =
        profile.workflow;
      return {
        ...result,
        ...(readiness ? { readiness } : {}),
        checkout,
        checks: { image, command, baselineCommand, prepareDependencies, compareTypeErrors },
        // Fetched contracts and documentation can change without a new commit.
        liveContract: source.kind !== 'file' || target.documentationSources.length > 0,
      };
    },
  );
}
