import { GitHubRequestError, requestGitHub } from './github.ts';
import { authenticateGitHubApp, type GitHubAppConfiguration } from './github-app.ts';
import { createReviewArtifacts, NEEDS_REVIEW_PREFIX } from './review.ts';
import { digest, isObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import type { PublicationFile, validateMigration } from './validation.ts';
import type { runPipeline } from './run.ts';
import {
  INTEGRATION_MARKER,
  MIGRATION_MARKER,
  migrationIdentity,
  REFIT_VERSION,
} from './migration-identity.ts';
import { unmappedBreakingChanges } from './openapi-diff.ts';
import { apiVersionSourceBlocked } from './api-version.ts';
import {
  migrationReviewReason,
  REMOVED_REQUEST_PARAMETER_REVIEW_REASON,
  withoutRequestParameters,
} from './migration-review.ts';
import { WEBHOOK_REVIEW_REASON } from './stripe-webhook-payloads.ts';

const MAX_BODY_CHARACTERS = 60_000;
// Ends Refit's comment when it closes a draft the base no longer needs; a person who reopens that
// draft keeps it open.
const RESOLVED_MARKER = '<!-- refit-resolved -->';
const WEEKLY_STATUS_MARKER = '<!-- refit-weekly-status -->';
const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/;
const BRANCH =
  /^(?!\/)(?!.*(?:\.\.|@\{|\/\/|\.lock(?:\/|$)))[^\s~^:?*\[\\\x00-\x1f\x7f]+(?<![/.])$/;
type Report = Awaited<ReturnType<typeof validateMigration>>;
type PublicationConfiguration = {
  repository: string;
  base: string;
  integration?: string;
  // Publish a draft whose checks passed even though confirmed findings remain unmigrated.
  allowUnresolved?: boolean;
} & ({ token: string; app?: never } | { app: GitHubAppConfiguration; token?: never });

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
  const request = (method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) =>
    requestGitHub(token, method, `/repos/${options.repository}${path}`, body);
  return { authentication, request };
}

type Session = Awaited<ReturnType<typeof publicationSession>>;

// One draft per repository, base, integration and target version: a rerun, a retry or a push to
// the base updates that draft instead of opening another.
export function draftKey(
  report: Pick<Awaited<ReturnType<typeof runPipeline>>, 'provider' | 'apiVersion' | 'snapshots'>,
) {
  return `draft:${report.provider}:${report.apiVersion.after ?? report.snapshots.after}`;
}

function draftBranch(
  key: string,
  authentication: Session['authentication'],
  options: PublicationConfiguration,
) {
  const identity = `:base:${options.base}${authentication ? `:app:${authentication.publisher.appId}` : ''}${options.integration ? `:integration:${options.integration}` : ''}`;
  return `refit/${digest(`${key}${identity}`).slice(0, 32)}`;
}

// The pull requests from a draft branch into the base. A merged one decides; otherwise the open
// one, or the newest closed one. GitHub allows one open pull request per head and base.
async function draftPull(
  request: Session['request'],
  options: PublicationConfiguration,
  branch: string,
) {
  const query = new URLSearchParams({
    state: 'all',
    head: `${options.repository.split('/')[0]}:${branch}`,
    base: options.base,
    per_page: '100',
  });
  const pulls = await request('GET', `/pulls?${query}`);
  if (!Array.isArray(pulls) || pulls.length >= 100 || !pulls.every(isObject))
    throw new PipelineInputError(
      'Existing migration pull request search is incomplete; inspect GitHub before retrying.',
    );
  const open = pulls.filter((pull) => pull.state === 'open');
  if (open.length > 1)
    throw new PipelineInputError(
      'Ambiguous existing migration pull requests; inspect GitHub before retrying.',
    );
  return (
    pulls.find((pull) => typeof pull.merged_at === 'string') ??
    open[0] ??
    pulls.sort((left, right) => Number(right.number) - Number(left.number))[0]
  );
}

// A commit Refit wrote as this App: one parent, and the App bot as author and committer. A person's
// commit, a rebase or a merge from the base fails this, and Refit then leaves the branch alone.
function writtenByPublisher(
  commit: Record<string, unknown>,
  authentication: Session['authentication'],
) {
  return Boolean(
    authentication &&
    Array.isArray(commit.parents) &&
    commit.parents.length === 1 &&
    isObject(commit.author) &&
    commit.author.email === authentication.author.email &&
    isObject(commit.committer) &&
    commit.committer.email === authentication.author.email,
  );
}

function pullUrl(pull: Record<string, unknown>, options: PublicationConfiguration) {
  if (
    !Number.isSafeInteger(pull.number) ||
    Number(pull.number) <= 0 ||
    pull.html_url !== `https://github.com/${options.repository}/pull/${pull.number}`
  )
    throw new PipelineInputError(
      'GitHub pull request response does not match the requested migration. Inspect the remote branch before retrying.',
    );
  return { url: pull.html_url as string, number: pull.number as number };
}

function draftOutcome(
  status: 'created' | 'updated' | 'existing' | 'closed' | 'merged',
  pull: Record<string, unknown>,
  head: string,
  context: {
    options: PublicationConfiguration;
    branch: string;
    revision: string;
    authentication: Session['authentication'];
  },
  extra: { leftUnchanged?: string; superseded?: number[] } = {},
) {
  const { options, authentication } = context;
  return {
    status,
    ...pullUrl(pull, options),
    draft: pull.draft === true,
    state: pull.state as string,
    branch: context.branch,
    revision: context.revision,
    head,
    reviewRequired: true,
    ...(options.integration ? { integration: options.integration } : {}),
    ...(authentication ? { publisher: authentication.publisher } : {}),
    ...extra,
  };
}

// A draft a person closed or merged for this target stays as they left it, and one with commits a
// person added, or opened by someone else, stays theirs: Refit makes no writes to either.
async function heldDraft(
  pull: Record<string, unknown>,
  request: Session['request'],
  context: Parameters<typeof draftOutcome>[3],
) {
  const head = sha(object(pull.head).sha);
  if (pull.state === 'closed')
    return draftOutcome(
      typeof pull.merged_at === 'string' ? 'merged' : 'closed',
      pull,
      head,
      context,
    );
  const { authentication } = context;
  if (!authentication) return undefined;
  if (object(pull.user).login !== authentication.publisher.login)
    return draftOutcome('existing', pull, head, context, {
      leftUnchanged:
        'Someone else opened this pull request from the Refit branch, so Refit left it as it is.',
    });
  if (!writtenByPublisher(object(await request('GET', `/git/commits/${head}`)), authentication))
    return draftOutcome('existing', pull, head, context, {
      leftUnchanged: 'The draft branch has commits Refit did not write, so Refit left it as it is.',
    });
  return undefined;
}

// The weekly note on a draft Refit still owns: false once the draft is closed, merged, someone
// else's, or its branch has commits a person added.
export async function commentOnOwnDraft(
  options: PublicationConfiguration,
  draft: { number: number; branch: string; revision: string },
  note: string,
) {
  const { authentication, request } = await publicationSession(options);
  if (!authentication)
    throw new PipelineInputError('Weekly status comments require the GitHub App.');
  const pull = object(await request('GET', `/pulls/${draft.number}`));
  if (object(pull.head).ref !== draft.branch) return false;
  const context = { options, branch: draft.branch, revision: draft.revision, authentication };
  if (await heldDraft(pull, request, context)) return false;
  await request('POST', `/issues/${draft.number}/comments`, {
    body: `${note}\n\n${WEEKLY_STATUS_MARKER}`,
  });
  return true;
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
  // Checked before generation, so a declined, merged or customer-edited draft spends no AI or
  // validation time.
  const branch = draftBranch(draftKey(report), authentication, options);
  const own = await draftPull(request, options, branch);
  const held =
    own && (await heldDraft(own, request, { options, branch, revision, authentication }));
  if (held) return { ...held, validation: 'not-rerun' as const };
  const query = new URLSearchParams({ state: 'open', base: options.base, per_page: '100' });
  const pulls = await request('GET', `/pulls?${query}`);
  if (!Array.isArray(pulls) || pulls.length >= 100)
    throw new PipelineInputError(
      'Existing PR search is incomplete; review repository pagination before starting another migration.',
    );
  const marker = `${MIGRATION_MARKER}${migrationIdentity(report, revision, options.integration)} -->`;
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
        (pull.body.includes(marker) ||
          (!options.integration &&
            !pull.body.includes(INTEGRATION_MARKER) &&
            pull.body.includes(`"runId": "${report.runId}"`))) &&
        Number.isSafeInteger(pull.number) &&
        Number(pull.number) > 0,
    )
    .sort((left, right) => Number(left.number) - Number(right.number));
  const pull = matches[0];
  if (!pull) return undefined;
  // A later Refit release may migrate what an earlier one left for review: a [Needs review] draft
  // another release wrote is generated and validated again, and publication updates it.
  if (
    String(pull.title).startsWith(NEEDS_REVIEW_PREFIX) &&
    !String(pull.body).includes(`"refit": "${REFIT_VERSION}"`)
  )
    return undefined;
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
    ...(options.integration ? { integration: options.integration } : {}),
    duplicateCount: matches.length,
    validation: 'not-rerun' as const,
  };
}

// Closes Refit's open draft for this target with a comment saying why, once the scanned base no
// longer needs it: the customer migrated the code themselves. A draft with someone else's commits,
// or one a person reopened after Refit closed it, stays open.
export async function closeResolvedDraft(
  report: Awaited<ReturnType<typeof runPipeline>>,
  revision: string,
  options: PublicationConfiguration,
  reason: string,
) {
  if (!options.app) return undefined;
  const { authentication, request } = await publicationSession(options);
  const branch = draftBranch(draftKey(report), authentication, options);
  const context = { options, branch, revision: sha(revision), authentication };
  const base = async () =>
    object(
      object(await request('GET', `/git/ref/heads/${encodeURIComponent(options.base)}`)).object,
    ).sha === context.revision;
  if (!(await base()))
    throw new PipelineInputError(
      'GitHub base differs from the monitored commit. Update the local checkout before closing a draft.',
    );
  const pull = await draftPull(request, options, branch);
  if (!pull || pull.state !== 'open' || (await heldDraft(pull, request, context))) return undefined;
  const { number } = pullUrl(pull, options);
  const comments = await request('GET', `/issues/${number}/comments?per_page=100`);
  if (!Array.isArray(comments) || comments.length >= 100)
    throw new PipelineInputError(
      'Draft comment search is incomplete; inspect the pull request before retrying.',
    );
  if (
    comments.some(
      (comment) =>
        isObject(comment) &&
        isObject(comment.user) &&
        comment.user.login === authentication!.publisher.login &&
        typeof comment.body === 'string' &&
        comment.body.includes(RESOLVED_MARKER),
    )
  )
    return undefined;
  if (!(await base()))
    throw new PipelineInputError('GitHub base changed while checking the draft. Retry the run.');
  await request('POST', `/issues/${number}/comments`, { body: `${reason}\n\n${RESOLVED_MARKER}` });
  const closed = object(await request('PATCH', `/pulls/${number}`, { state: 'closed' }));
  return draftOutcome('closed', closed, sha(object(pull.head).sha), context);
}

// With --publish-unresolved, a draft may publish as [Needs review] when exactly one of these blocks
// it and nothing else does; the PR opens with what the owner must check or do:
// - the incoming webhook API version, which code cannot prove (lists the changed handlers);
// - traced calls that still send a removed request parameter, an owner decision (lists the calls);
// - checks that could not run because dependency preparation failed for a repository-side reason
//   (the patch is untested; names the reason and the fix).
export function publicationWaiver(report: Report, allowUnresolved: boolean | undefined) {
  if (!allowUnresolved) return undefined;
  const deterministic = report.patch.generator === 'deterministic';
  const reason = migrationReviewReason(report, deterministic);
  const targetVersion = report.apiVersion.after ?? 'the target API version';
  if (report.validation.status === 'untested') {
    const failure = report.validation.dependencyFailure;
    if (reason || !failure || !deterministic) return undefined;
    return { gate: 'dependency-preparation' as const, ...failure };
  }
  if (reason === REMOVED_REQUEST_PARAMETER_REVIEW_REASON) {
    if (!deterministic || migrationReviewReason(withoutRequestParameters(report), deterministic))
      return undefined;
    return {
      gate: 'removed-request-parameter' as const,
      targetVersion,
      calls: report.findings
        .filter((finding) => finding.requestParameter)
        .map((finding) => ({
          file: finding.file,
          line: finding.line,
          call: finding.expression.slice(0, finding.expression.indexOf(' ')),
          parameter: finding.requestParameter!.parameter,
        })),
    };
  }
  if (reason !== WEBHOOK_REVIEW_REASON) return undefined;
  const withoutWebhooks = report.findings.map(({ webhook: _webhook, ...finding }) => finding);
  if (migrationReviewReason({ ...report, findings: withoutWebhooks }, deterministic))
    return undefined;
  const changed = new Set(
    [...report.patch.diff.matchAll(/^\+\+\+ ("b\/.+")$/gm)].map((match) =>
      (JSON.parse(match[1]) as string).slice(2),
    ),
  );
  return {
    gate: 'webhook-api-version' as const,
    targetVersion,
    handlers: report.findings
      .filter((finding) => finding.webhook && changed.has(finding.file))
      .map((finding) => ({
        file: finding.file,
        line: finding.line,
        eventTypes: finding.webhook!.eventTypes,
      })),
  };
}

export async function publishDraft(
  report: Report,
  options: ReturnType<typeof publicationConfiguration>,
) {
  const apiVersion = report.apiVersion;
  const reviewReason = migrationReviewReason(report, report.patch.generator === 'deterministic');
  const waiver = publicationWaiver(report, options.allowUnresolved);
  if (reviewReason && !waiver) throw new PipelineInputError(reviewReason);
  if (
    !apiVersion ||
    apiVersion.applicability !== 'matches-before' ||
    apiVersionSourceBlocked(apiVersion)
  )
    throw new PipelineInputError(
      `Draft publication is blocked. ${apiVersion?.reason ?? 'API-version evidence is missing.'}`,
    );
  const artifacts = createReviewArtifacts(report, 'github', options.integration, waiver);
  if (
    unmappedBreakingChanges(
      report.specificationDiff,
      report.changes,
      report.findings,
      report.operationChanges,
      report.requestChanges,
      report.expandedFields,
    ).length
  )
    throw new PipelineInputError(
      'Draft publication is blocked by unmapped breaking contract changes.',
    );
  if (
    (report.validation.status !== 'passed' && waiver?.gate !== 'dependency-preparation') ||
    (report.patch.unresolvedFindings !== 0 && !options.allowUnresolved) ||
    !report.publicationFiles.length
  )
    throw new PipelineInputError(
      'Draft publication requires passing baseline/patched checks, changed files and zero unresolved findings (or --publish-unresolved).',
    );
  const body = artifacts.files['pull-request.md'];
  const target = apiVersion.after ?? 'the target contract';
  return publishFiles(options, {
    revision: report.validation.revision,
    key: draftKey(report),
    files: report.publicationFiles,
    title: artifacts.manifest.title,
    body,
    message: artifacts.commitMessage,
    supersedes: {
      // Refit's other migration drafts for this integration: an older target version, or a draft
      // published before identity followed the target version.
      matches: (other) =>
        other.includes(MIGRATION_MARKER) &&
        (options.integration
          ? other.includes(`${INTEGRATION_MARKER}${options.integration} -->`)
          : !other.includes(INTEGRATION_MARKER)),
      note: `Refit keeps one draft per integration and updates it in place; that draft migrates this code to ${target} on the current \`${options.base}\`.`,
    },
  });
}

// Closes the publisher's other open drafts on this base that this draft replaces, each with a
// comment linking it. A draft with commits a person added stays open.
async function closeSuperseded(
  session: Session,
  options: PublicationConfiguration,
  branch: string,
  number: number,
  supersedes: { matches: (body: string) => boolean; note: string },
) {
  const { authentication, request } = session;
  const query = new URLSearchParams({ state: 'open', base: options.base, per_page: '100' });
  const pulls = await request('GET', `/pulls?${query}`);
  if (!Array.isArray(pulls) || pulls.length >= 100)
    throw new PipelineInputError(
      'Existing PR search is incomplete; review repository pagination before retrying.',
    );
  const closed: number[] = [];
  for (const pull of pulls) {
    if (
      !isObject(pull) ||
      pull.number === number ||
      !isObject(pull.user) ||
      pull.user.login !== authentication?.publisher.login ||
      !isObject(pull.head) ||
      typeof pull.head.ref !== 'string' ||
      !pull.head.ref.startsWith('refit/') ||
      pull.head.ref === branch ||
      !isObject(pull.head.repo) ||
      pull.head.repo.full_name !== options.repository ||
      typeof pull.body !== 'string' ||
      !supersedes.matches(pull.body)
    )
      continue;
    const other = pullUrl(pull, options).number;
    const head = object(await request('GET', `/git/commits/${sha(pull.head.sha)}`));
    if (!writtenByPublisher(head, authentication)) continue;
    await request('POST', `/issues/${other}/comments`, {
      body: `Superseded by #${number}. ${supersedes.note}`,
    });
    await request('PATCH', `/pulls/${other}`, { state: 'closed' });
    closed.push(other);
  }
  return closed;
}

// Publishes validated files as one commit on a Refit branch from the validated revision and opens
// a draft pull request. The branch follows the change's key, so a rerun finds its draft: Refit
// moves its own branch to the new commit and refreshes the description, leaves a branch with
// commits a person added as it is, and never reopens or replaces a draft a person closed or
// merged. Refit never marks a pull request ready or merges it.
export async function publishFiles(
  options: ReturnType<typeof publicationConfiguration>,
  change: {
    revision: string;
    // Identifies the change, so a republished candidate updates its branch and pull request.
    key: string;
    files: PublicationFile[];
    title: string;
    body: string;
    message: string;
    // Older open drafts this one replaces, closed with a link once it is up to date.
    supersedes?: { matches: (body: string) => boolean; note: string };
  },
) {
  if (!change.files.length)
    throw new PipelineInputError('Draft publication requires changed files.');
  const revision = sha(change.revision);
  const session = await publicationSession(options);
  const { authentication, request } = session;
  const branch = draftBranch(change.key, authentication, options);
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
  const context = { options, branch, revision, authentication };
  await checkBase();
  let pull = await draftPull(request, options, branch);
  const held = pull && (await heldDraft(pull, request, context));
  if (held) return held;
  const baseCommit = object(await request('GET', `/git/commits/${revision}`));
  const baseTree = sha(object(baseCommit.tree).sha);
  const body = change.body;
  if (body.length > MAX_BODY_CHARACTERS)
    throw new PipelineInputError(
      'Draft description exceeds the publication size limit. Save a local review bundle instead.',
    );
  const tree = sha(
    object(
      await request('POST', '/git/trees', {
        base_tree: baseTree,
        tree: change.files.map((file) => ({ ...file, type: 'blob' })),
      }),
    ).sha,
  );
  const createCommit = async () =>
    sha(
      object(
        await request('POST', '/git/commits', {
          message: change.message,
          tree,
          parents: [revision],
          ...(authentication
            ? { author: authentication.author, committer: authentication.author }
            : {}),
        }),
      ).sha,
    );
  const isCandidate = (commit: Record<string, unknown>) =>
    object(commit.tree).sha === tree &&
    Array.isArray(commit.parents) &&
    commit.parents.length === 1 &&
    object(commit.parents[0]).sha === revision;
  let head = await reference(branch, true);
  let updated = false;
  if (!head) {
    const commit = await createCommit();
    await checkBase();
    try {
      await request('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: commit });
    } catch (error) {
      if (!(error instanceof GitHubRequestError) || error.status !== 422) throw error;
    }
    head = sha(await reference(branch));
  } else {
    const current = object(await request('GET', `/git/commits/${head}`));
    if (!isCandidate(current)) {
      if (!writtenByPublisher(current, authentication)) {
        // Without the App, Refit cannot tell its own commits from a person's.
        if (pull && !authentication)
          return draftOutcome('existing', pull, head, context, {
            leftUnchanged:
              'Refit updates an existing draft only when it publishes as the GitHub App.',
          });
        throw new PipelineInputError(
          'Existing migration branch differs from the validated candidate. Refusing to overwrite it.',
        );
      }
      // Refit's own single commit on an older base or an older patch: replace it.
      const replacement = await createCommit();
      await checkBase();
      if ((await reference(branch)) !== head)
        throw new PipelineInputError('Migration branch changed during publication.');
      await request('PATCH', `/git/refs/heads/${encodeURIComponent(branch)}`, {
        sha: replacement,
        force: true,
      });
      head = replacement;
      updated = true;
    }
  }
  if (!isCandidate(object(await request('GET', `/git/commits/${head}`))))
    throw new PipelineInputError(
      'Existing migration branch differs from the validated candidate. Refusing to overwrite it.',
    );
  await checkBase();
  if ((await reference(branch)) !== head)
    throw new PipelineInputError('Migration branch changed during publication.');
  let created = false;
  if (!pull) {
    try {
      pull = object(
        await request('POST', '/pulls', {
          title: change.title,
          body,
          head: branch,
          base: options.base,
          draft: true,
          maintainer_can_modify: false,
        }),
      );
      created = true;
    } catch (error) {
      if (!(error instanceof GitHubRequestError) || error.status !== 422) throw error;
      pull = await draftPull(request, options, branch);
      if (!pull) throw error;
    }
  } else if (updated || pull.title !== change.title || pull.body !== body) {
    pull = object(
      await request('PATCH', `/pulls/${pullUrl(pull, options).number}`, {
        title: change.title,
        body,
      }),
    );
    updated = true;
  }
  if (
    // GitHub may report a moved head a moment late; the branch itself was checked above.
    (!updated && object(pull.head).sha !== head) ||
    object(pull.base).ref !== options.base ||
    typeof pull.draft !== 'boolean' ||
    pull.state !== 'open' ||
    (created && !pull.draft) ||
    (authentication && object(pull.user).login !== authentication.publisher.login)
  )
    throw new PipelineInputError(
      'GitHub pull request response does not match the requested migration. Inspect the remote branch before retrying.',
    );
  const number = pullUrl(pull, options).number;
  const superseded =
    change.supersedes && authentication
      ? await closeSuperseded(session, options, branch, number, change.supersedes)
      : [];
  return draftOutcome(created ? 'created' : updated ? 'updated' : 'existing', pull, head, context, {
    ...(superseded.length ? { superseded } : {}),
  });
}
