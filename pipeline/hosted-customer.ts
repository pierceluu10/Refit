// The hosted worker's passes for the zero-setup beta (founder decision, 2026-10-28): reasons for
// closed Refit pull requests, and, with REFIT_HOSTED_CUSTOMER_CI=1, the customer-CI fallback.

import {
  applyCustomerCiEvidence,
  CUSTOMER_CI_BRANCH,
  jobLogReader,
  proposeCustomerCi,
} from './customer-ci.ts';
import {
  authenticateGitHubActions,
  authenticateGitHubComment,
  authenticateGitHubWorkflow,
  type GitHubAppConfiguration,
} from './github-app.ts';
import { GitHubRequestError, requestGitHub } from './github.ts';
import type { openInventoryStore } from './inventory-store.ts';
import { environmentFlag } from './monitoring.ts';
import { customerReason, type openPullOutcomeStore } from './pull-outcomes.ts';
import { isObject } from './specifications.ts';

export function hostedCustomerCi(environment: NodeJS.ProcessEnv) {
  return environmentFlag(environment, 'REFIT_HOSTED_CUSTOMER_CI');
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function syncPullOutcomeReasons(options: {
  app: GitHubAppConfiguration;
  outcomes: ReturnType<typeof openPullOutcomeStore>;
  signal: AbortSignal;
  onProgress?: (message: string) => void;
}) {
  for (const row of await options.outcomes.unchecked()) {
    if (options.signal.aborted) return;
    try {
      const { token } = await authenticateGitHubComment(options.app, row.repository);
      const comments = await requestGitHub(
        token,
        'GET',
        `/repos/${row.repository}/issues/${row.number}/comments?per_page=100`,
      );
      await options.outcomes.setReason(row.repository, row.number, customerReason(comments));
    } catch (error) {
      // A deleted pull request or a removed repository has no reason to read.
      if (error instanceof GitHubRequestError && error.status === 404)
        await options.outcomes.setReason(row.repository, row.number, null);
      else
        options.onProgress?.(
          `Pull request outcome ${row.repository}#${row.number}: ${message(error)}`,
        );
    }
  }
}

// shortcut: proposals are remembered per worker process and every open Refit draft is re-read on
// every pass; both are idempotent (the branch's pull request, the marked comment). Record them in
// PostgreSQL when the beta has more than a handful of repositories.
export async function syncCustomerCi(options: {
  app: GitHubAppConfiguration;
  inventories: ReturnType<typeof openInventoryStore>;
  proposed: Set<string>;
  signal: AbortSignal;
  onProgress?: (message: string) => void;
}) {
  const repositories = [
    ...new Set((await options.inventories.read()).map((row) => row.repository.toLowerCase())),
  ];
  for (const repository of repositories) {
    if (options.signal.aborted) return;
    try {
      if (!options.proposed.has(repository)) {
        const { token } = await authenticateGitHubWorkflow(options.app, repository);
        const result = await proposeCustomerCi({
          request: (method, path, body) => requestGitHub(token, method, path, body),
          repository,
        });
        options.proposed.add(repository);
        if (result.status === 'opened')
          options.onProgress?.(`Opened the Refit validation workflow pull request: ${result.url}`);
      }
      const { token, login } = await authenticateGitHubActions(options.app, repository);
      const request = (method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) =>
        requestGitHub(token, method, path, body);
      const pulls = await request('GET', `/repos/${repository}/pulls?state=open&per_page=100`);
      for (const pull of Array.isArray(pulls) ? pulls : [])
        if (
          isObject(pull) &&
          isObject(pull.head) &&
          typeof pull.head.ref === 'string' &&
          pull.head.ref.startsWith('refit/') &&
          pull.head.ref !== CUSTOMER_CI_BRANCH
        )
          await applyCustomerCiEvidence({
            request,
            log: jobLogReader(token, repository),
            repository,
            pull: Number(pull.number),
            login,
          });
    } catch (error) {
      options.onProgress?.(`Customer CI for ${repository}: ${message(error)}`);
    }
  }
}
