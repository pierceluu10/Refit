import { GitHubRequestError, requestGitHub } from './github.ts';
import { authenticateGitHubApp, type GitHubAppConfiguration } from './github-app.ts';
import { createReviewArtifacts } from './review.ts';
import { digest, isObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import type { validateMigration } from './validation.ts';
import type { runPipeline } from './run.ts';
import { migrationIdentity } from './migration-identity.ts';
import { unmappedBreakingChanges } from './openapi-diff.ts';
import { apiVersionSourceBlocked } from './api-version.ts';

const MAX_BODY_CHARACTERS = 60_000;
const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/;
const BRANCH =
  /^(?!\/)(?!.*(?:\.\.|@\{|\/\/|\.lock(?:\/|$)))[^\s~^:?*\[\\\x00-\x1f\x7f]+(?<![/.])$/;
type Report = Awaited<ReturnType<typeof validateMigration>>;
type PublicationConfiguration = { repository: string; base: string } & (
  { token: string; app?: never } | { app: GitHubAppConfiguration; token?: never }
);

export function validateGitHubTarget(repository: string | undefined, base: string | undefined) {
  if (
    !repository ||
    !REPOSITORY.test(repository) ||
    !base ||
    !BRANCH.test(base) ||
    base.startsWith('-') ||
    base.split('/').some((part) => part.startsWith('.'))
  )
    throw new PipelineInputError(
      'Draft publication requires --github owner/repository and a valid --base branch.',
    );
  return { repository, base };
}

export function publicationConfiguration(
  repository: string | undefined,
  base: string | undefined,
  token: string | undefined,
  app?: GitHubAppConfiguration,
): PublicationConfiguration {
  const target = validateGitHubTarget(repository, base);
  if (app) return { ...target, app };
  if (!token?.trim())
    throw new PipelineInputError('Draft publication requires GITHUB_TOKEN or --github-app.');
  return { ...target, token: token.trim() };
}

function sha(value: unknown): string {
  if (typeof value !== 'string' || !SHA.test(value))
    throw new PipelineInputError('GitHub returned an invalid Git object ID.');
  return value;
}

function object(value: unknown) {
  if (!isObject(value)) throw new PipelineInputError('GitHub returned an invalid response object.');
  return value;
}

async function publicationSession(options: PublicationConfiguration) {
  const authentication = options.app
    ? await authenticateGitHubApp(options.app, options.repository)
    : undefined;
  const token = authentication?.token ?? options.token;
  if (!token) throw new PipelineInputError('GitHub publication credentials are unavailable.');
  const request = (method: 'GET' | 'POST', path: string, body?: unknown) =>
    requestGitHub(token, method, `/repos/${options.repository}${path}`, body);
  return { authentication, request };
}

export async function findExistingMigration(
  report: Awaited<ReturnType<typeof runPipeline>>,
  revision: string,
  options: PublicationConfiguration,
) {
  if (!options.app) return undefined;
  const { authentication, request } = await publicationSession(options);
  const remote = object(await request('GET', `/git/ref/heads/${encodeURIComponent(options.base)}`));
  if (object(remote.object).sha !== sha(revision))
    throw new PipelineInputError(
      'GitHub base differs from the monitored commit. Update the local checkout before generating a migration.',
    );
  const query = new URLSearchParams({ state: 'open', base: options.base, per_page: '100' });
  const pulls = await request('GET', `/pulls?${query}`);
  if (!Array.isArray(pulls) || pulls.length >= 100)
    throw new PipelineInputError(
      'Existing PR search is incomplete; review repository pagination before starting another migration.',
    );
  const marker = `<!-- refit-migration:${migrationIdentity(report, revision)} -->`;
  const matches = pulls
    .filter(
      (pull) =>
        isObject(pull) &&
        isObject(pull.user) &&
        pull.user.login === authentication?.publisher.login &&
        pull.state === 'open' &&
        pull.draft === true &&
        isObject(pull.base) &&
        pull.base.ref === options.base &&
        pull.base.sha === revision &&
        isObject(pull.head) &&
        typeof pull.head.ref === 'string' &&
        pull.head.ref.startsWith('refit/') &&
        isObject(pull.head.repo) &&
        pull.head.repo.full_name === options.repository &&
        typeof pull.body === 'string' &&
        (pull.body.includes(marker) || pull.body.includes(`"runId": "${report.runId}"`)) &&
        Number.isSafeInteger(pull.number) &&
        Number(pull.number) > 0,
    )
    .sort((left, right) => Number(left.number) - Number(right.number));
  const pull = matches[0];
  if (!pull) return undefined;
  const head = sha(object(pull.head).sha);
  const commit = object(await request('GET', `/git/commits/${head}`));
  if (
    !Array.isArray(commit.parents) ||
    commit.parents.length !== 1 ||
    object(commit.parents[0]).sha !== revision
  )
    throw new PipelineInputError(
      'Existing migration has a different base history; review it before starting another proposal.',
    );
  const current = object(
    await request('GET', `/git/ref/heads/${encodeURIComponent(String(object(pull.head).ref))}`),
  );
  if (
    object(current.object).sha !== head ||
    pull.html_url !== `https://github.com/${options.repository}/pull/${pull.number}`
  )
    throw new PipelineInputError(
      'Existing migration changed during discovery. Retry the read-only check.',
    );
  const latestBase = object(
    await request('GET', `/git/ref/heads/${encodeURIComponent(options.base)}`),
  );
  if (object(latestBase.object).sha !== revision)
    throw new PipelineInputError(
      'GitHub base changed during migration discovery. Refresh the local checkout.',
    );
  return {
    status: 'existing' as const,
    url: pull.html_url as string,
    number: pull.number as number,
    draft: true,
    state: 'open',
    branch: object(pull.head).ref as string,
    revision,
    head,
    reviewRequired: true,
    publisher: authentication!.publisher,
    duplicateCount: matches.length,
    validation: 'not-rerun' as const,
  };
}

export async function publishDraft(
  report: Report,
  options: ReturnType<typeof publicationConfiguration>,
) {
  const apiVersion = report.apiVersion;
  if (
    !apiVersion ||
    apiVersion.applicability !== 'matches-before' ||
    apiVersionSourceBlocked(apiVersion)
  )
    throw new PipelineInputError(
      `Draft publication is blocked. ${apiVersion?.reason ?? 'API-version evidence is missing.'}`,
    );
  const artifacts = createReviewArtifacts(report, 'github');
  if (
    unmappedBreakingChanges(
      report.specificationDiff,
      report.changes,
      report.findings,
      report.operationChanges,
    ).length
  )
    throw new PipelineInputError(
      'Draft publication is blocked by unmapped breaking contract changes.',
    );
  if (
    report.validation.status !== 'passed' ||
    report.patch.unresolvedFindings !== 0 ||
    !report.publicationFiles.length
  )
    throw new PipelineInputError(
      'Draft publication requires passing baseline/patched checks, changed files and zero unresolved findings.',
    );
  const revision = sha(report.validation.revision);
  const { authentication, request } = await publicationSession(options);
  const identity = authentication ? `:app:${authentication.publisher.appId}` : '';
  const branch = `refit/${digest(`${report.runId}:${report.validation.patchHash}${identity}`).slice(0, 32)}`;
  if (branch === options.base)
    throw new PipelineInputError('Migration branch cannot be the base branch.');
  const reference = async (name: string, optional = false) => {
    try {
      const result = object(await request('GET', `/git/ref/heads/${encodeURIComponent(name)}`));
      if (!isObject(result.object) || result.object.type !== 'commit')
        throw new PipelineInputError('GitHub branch does not reference a commit.');
      return sha(result.object.sha);
    } catch (error) {
      if (optional && error instanceof GitHubRequestError && error.status === 404) return null;
      throw error;
    }
  };
  const checkBase = async () => {
    if ((await reference(options.base)) !== revision)
      throw new PipelineInputError(
        'GitHub base changed or does not match the validated revision. Revalidate the current base.',
      );
  };
  await checkBase();
  const baseCommit = object(await request('GET', `/git/commits/${revision}`));
  const baseTree = sha(object(baseCommit.tree).sha);
  const body = artifacts.files['pull-request.md'];
  if (body.length > MAX_BODY_CHARACTERS)
    throw new PipelineInputError(
      'Draft description exceeds the publication size limit. Save a local review bundle instead.',
    );
  const tree = sha(
    object(
      await request('POST', '/git/trees', {
        base_tree: baseTree,
        tree: report.publicationFiles.map((file) => ({ ...file, type: 'blob' })),
      }),
    ).sha,
  );
  let head = await reference(branch, true);
  if (!head) {
    const commit = sha(
      object(
        await request('POST', '/git/commits', {
          message: `fix: migrate affected ${report.provider} API usage`,
          tree,
          parents: [revision],
          ...(authentication
            ? { author: authentication.author, committer: authentication.author }
            : {}),
        }),
      ).sha,
    );
    await checkBase();
    try {
      await request('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: commit });
    } catch (error) {
      if (!(error instanceof GitHubRequestError) || error.status !== 422) throw error;
    }
    head = await reference(branch);
  }
  const commit = object(await request('GET', `/git/commits/${head}`));
  if (
    object(commit.tree).sha !== tree ||
    !Array.isArray(commit.parents) ||
    commit.parents.length !== 1 ||
    object(commit.parents[0]).sha !== revision
  )
    throw new PipelineInputError(
      'Existing migration branch differs from the validated candidate. Refusing to overwrite it.',
    );
  const query = new URLSearchParams({
    state: 'all',
    head: `${options.repository.split('/')[0]}:${branch}`,
    base: options.base,
    per_page: '100',
  });
  const existingPull = async () => {
    const pulls = await request('GET', `/pulls?${query}`);
    if (!Array.isArray(pulls) || pulls.length > 1)
      throw new PipelineInputError(
        'Ambiguous existing migration pull requests; inspect GitHub before retrying.',
      );
    return pulls.length ? object(pulls[0]) : undefined;
  };
  let pull = await existingPull();
  let reused = Boolean(pull);
  await checkBase();
  if ((await reference(branch)) !== head)
    throw new PipelineInputError('Migration branch changed during publication.');
  if (!pull) {
    try {
      pull = object(
        await request('POST', '/pulls', {
          title: artifacts.manifest.title,
          body,
          head: branch,
          base: options.base,
          draft: true,
          maintainer_can_modify: false,
        }),
      );
    } catch (error) {
      if (!(error instanceof GitHubRequestError) || error.status !== 422) throw error;
      pull = await existingPull();
      if (!pull) throw error;
      reused = true;
    }
  }
  if (
    typeof pull.number !== 'number' ||
    !Number.isSafeInteger(pull.number) ||
    pull.number <= 0 ||
    pull.html_url !== `https://github.com/${options.repository}/pull/${pull.number}` ||
    object(pull.head).sha !== head ||
    object(pull.base).ref !== options.base ||
    typeof pull.draft !== 'boolean' ||
    (pull.state !== 'open' && pull.state !== 'closed') ||
    (!reused && !pull.draft) ||
    (authentication && object(pull.user).login !== authentication.publisher.login)
  )
    throw new PipelineInputError(
      'GitHub pull request response does not match the requested migration. Inspect the remote branch before retrying.',
    );
  return {
    status: reused ? 'existing' : 'created',
    url: pull.html_url as string,
    number: pull.number as number,
    draft: pull.draft as boolean,
    state: pull.state as string,
    branch,
    revision,
    head,
    reviewRequired: true,
    ...(authentication ? { publisher: authentication.publisher } : {}),
  };
}
