import type { AiOptions } from './ai-budget.ts';
import type { GitHubAppConfiguration } from './github-app.ts';
import { withGitHubCheckout } from './github-checkout.ts';
import { publicationConfiguration } from './publication.ts';
import { loadApprovedRepository } from './repository-enrollment.ts';
import type { ServiceTarget } from './service-configuration.ts';
import { PipelineInputError } from './types.ts';
import { watchOnce } from './watch.ts';
import { join } from 'node:path';

export async function pollServiceTarget(options: {
  target: ServiceTarget;
  app: GitHubAppConfiguration;
  stateDirectory: string;
  signal: AbortSignal;
  aiPatch?: AiOptions;
  repairAttempts: number;
  publishDraft?: boolean;
  retry?: boolean;
  onProgress?: (message: string) => void;
}) {
  const { target } = options;
  const targetGitHub = { repository: target.repository, base: target.base, app: options.app };
  const runtime = {
    signal: options.signal,
    aiPatch: options.aiPatch,
    repairAttempts: options.repairAttempts,
    publication: options.publishDraft
      ? publicationConfiguration(target.repository, target.base, undefined, options.app)
      : undefined,
  };
  if (target.workflow)
    return watchOnce({
      configuration: { ...target.workflow, repository: undefined, ...runtime },
      source: target.source,
      documentationSources: target.documentationSources,
      stateDirectory: options.stateDirectory,
      syncGitHub: targetGitHub,
      retry: options.retry,
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
      const profile = await loadApprovedRepository({
        repository: checkout.directory,
        approval: target.approval,
        stateDirectory: options.stateDirectory,
      });
      options.signal.throwIfAborted();
      options.onProgress?.(
        `Approved repository configuration verified: ${profile.fingerprint.slice(0, 12)}.`,
      );
      const result = await watchOnce({
        configuration: { ...profile.workflow, repository: checkout.directory, ...runtime },
        source: target.source ?? profile.source,
        documentationSources: target.documentationSources,
        stateDirectory: options.stateDirectory,
        retry: options.retry,
        onProgress: options.onProgress,
      });
      return { ...result, checkout };
    },
  );
}
