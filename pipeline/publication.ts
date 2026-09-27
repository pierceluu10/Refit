import { readBoundedResponse } from './network.ts';
import { createReviewArtifacts } from './review.ts';
import { digest, isObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import type { validateMigration } from './validation.ts';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_BODY_CHARACTERS = 60_000;
const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/;
const BRANCH =
  /^(?!\/)(?!.*(?:\.\.|@\{|\/\/|\.lock(?:\/|$)))[^\s~^:?*\[\\\x00-\x1f\x7f]+(?<![/.])$/;
type Report = Awaited<ReturnType<typeof validateMigration>>;

export function publicationConfiguration(
  repository: string | undefined,
  base: string | undefined,
  token: string | undefined,
) {
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
  if (!token?.trim()) throw new PipelineInputError('Draft publication requires GITHUB_TOKEN.');
  return { repository, base, token: token.trim() };
}

class GitHubRequestError extends Error {
  override name = 'GitHubRequestError';
  constructor(
    readonly status: number,
    method: string,
    path: string,
  ) {
    super(
      `GitHub ${method} ${path.split('?')[0]} failed with HTTP ${status}. Publication may be partially complete; rerun to reconcile the migration branch.`,
    );
  }
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

export async function publishDraft(
  report: Report,
  options: ReturnType<typeof publicationConfiguration>,
) {
  const artifacts = createReviewArtifacts(report, 'github');
  if (
    report.validation.status !== 'passed' ||
    report.patch.unresolvedFindings !== 0 ||
    !report.publicationFiles.length
  )
    throw new PipelineInputError(
      'Draft publication requires passing baseline/patched checks, changed files and zero unresolved findings.',
    );
  const revision = sha(report.validation.revision);
  const branch = `refit/${digest(`${report.runId}:${report.validation.patchHash}`).slice(0, 32)}`;
  if (branch === options.base)
    throw new PipelineInputError('Migration branch cannot be the base branch.');
  const root = `https://api.github.com/repos/${options.repository}`;
  const request = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(`${root}${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2026-03-10',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new GitHubRequestError(response.status, method, path);
    }
    return JSON.parse(await readBoundedResponse(response, MAX_RESPONSE_BYTES, 'GitHub'));
  };
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
    (!reused && !pull.draft)
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
  };
}
