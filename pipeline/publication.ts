import { GitHubRequestError, requestGitHub } from './github.ts';
import { authenticateGitHubApp, type GitHubAppConfiguration } from './github-app.ts';
import {
  code,
  createReviewArtifacts,
  NEEDS_REVIEW_PREFIX,
  NO_OP_CHECK,
  plainText,
  summaryList,
} from './review.ts';
import { digest, isObject } from './specifications.ts';
import { PipelineInputError, type Finding } from './types.ts';
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
  migrationReviewReasons,
  REMOVED_REQUEST_PARAMETER_REVIEW_REASON,
} from './migration-review.ts';
import type { ReadinessCheck } from './readiness.ts';
import { WEBHOOK_REVIEW_REASON } from './stripe-webhook-payloads.ts';

const MAX_BODY_CHARACTERS = 60_000;
// Ends Refit's comment when it closes a draft the base no longer needs; a person who reopens that
// draft keeps it open.
const RESOLVED_MARKER = '<!-- refit-resolved -->';
const WEEKLY_STATUS_MARKER = '<!-- refit-weekly-status -->';
const SHORT_SHA = 7;
const SHA = /^[a-f0-9]{40}$/;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
// The commit Refit last pushed to a draft branch, recorded in the draft: the lease for its next
// update. While Refit moves the branch, the record also names the commit it is moving to.
const PUSHED_MARKER = '<!-- refit-pushed:';
const PUSHED_RECORD = /\n?<!-- refit-pushed: ([a-f0-9]{40}(?: [a-f0-9]{40})*) -->/g;
const PROVIDER_MARKER = '<!-- refit-provider:';
const BASE_MOVED_MARKER = '<!-- refit-base-moved:';
const SUPERSEDED_MARKER = '<!-- refit-superseded -->';
const OTHERS_COMMITS =
  'The draft branch has commits Refit did not write, so Refit left it as it is.';
const UPDATE_REFS =
  'mutation($repositoryId: ID!, $refUpdates: [RefUpdate!]!) { updateRefs(input: { repositoryId: $repositoryId, refUpdates: $refUpdates }) { clientMutationId } }';
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
  // Close Refit's older open drafts for the same provider and integration once this one is up to
  // date. Off by default (owner decision, 2026-10-24).
  supersedeDrafts?: boolean;
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
  const graphql = (query: string, variables: Record<string, unknown>) =>
    requestGitHub(token, 'POST', '/graphql', { query, variables });
  return { authentication, request, graphql };
}

type Session = Awaited<ReturnType<typeof publicationSession>>;

// One draft per repository, base, integration and target version: a rerun, a retry or a push to
// the base updates that draft instead of opening another. A contract whose version is the same as
// the baseline's (some providers never change info.version) is named by its breaking changes
// instead, so an upstream edit that changes none of them keeps the same draft.
export function draftKey(
  report: Pick<
    Awaited<ReturnType<typeof runPipeline>>,
    'provider' | 'apiVersion' | 'changes' | 'operationChanges' | 'requestChanges'
  >,
) {
  const { before, after } = report.apiVersion;
  if (after && after !== before) return `draft:${report.provider}:${after}`;
  const changes = [report.changes, report.operationChanges, report.requestChanges ?? []].map(
    (list) => list.map((change) => change.id).sort(),
  );
  return `draft:${report.provider}:changes:${digest(JSON.stringify(changes))}`;
}

function pushedCommits(body: unknown) {
  if (typeof body !== 'string') return undefined;
  return [...body.matchAll(PUSHED_RECORD)].at(-1)?.[1].split(' ');
}

function withPushed(body: string, ...commits: string[]) {
  return `${body.replace(PUSHED_RECORD, '')}\n${PUSHED_MARKER} ${commits.join(' ')} -->`;
}

const short = (commit: string) => commit.slice(0, SHORT_SHA);

function draftBranch(
  key: string,
  authentication: Session['authentication'],
  options: PublicationConfiguration,
) {
  const identity = `:base:${options.base}${authentication ? `:app:${authentication.publisher.appId}` : ''}${options.integration ? `:integration:${options.integration}` : ''}`;
  return `refit/${digest(`${key}${identity}`).slice(0, 32)}`;
}

// The pull requests from a draft branch into the base. A merged one decides; otherwise the open
// one, or the newest closed one. GitHub allows one open pull request per head and base. A draft
// Refit closed itself, as superseded, is not a person's decline: the next run opens a new one.
async function draftPull(
  request: Session['request'],
  options: PublicationConfiguration,
  branch: string,
  authentication: Session['authentication'],
) {
  const pull = await latestDraftPull(request, options, branch);
  if (!pull || !authentication || pull.state !== 'closed' || typeof pull.merged_at === 'string')
    return pull;
  const issue = object(await request('GET', `/issues/${pullUrl(pull, options).number}`));
  return isObject(issue.closed_by) && issue.closed_by.login === authentication.publisher.login
    ? undefined
    : pull;
}

async function latestDraftPull(
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

async function reference(request: Session['request'], name: string, optional = false) {
  try {
    const result = object(await request('GET', `/git/ref/heads/${encodeURIComponent(name)}`));
    if (!isObject(result.object) || result.object.type !== 'commit')
      throw new PipelineInputError('GitHub branch does not reference a commit.');
    return sha(result.object.sha);
  } catch (error) {
    if (optional && error instanceof GitHubRequestError && error.status === 404) return null;
    throw error;
  }
}

// Every item of a GitHub list, page by page.
async function listAll(
  request: Session['request'],
  path: string,
  incomplete: string,
  query: Record<string, string> = {},
) {
  const items: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const parameters = new URLSearchParams({ ...query, per_page: `${PAGE_SIZE}`, page: `${page}` });
    const list = await request('GET', `${path}?${parameters}`);
    if (!Array.isArray(list)) break;
    items.push(...list);
    if (list.length < PAGE_SIZE) return items;
  }
  throw new PipelineInputError(incomplete);
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

// Whether the branch tip is the last commit Refit pushed, as the draft records it. A draft from an
// earlier release has no record; its tip counts as Refit's when it is Refit's own commit.
async function ownHead(
  pull: Record<string, unknown>,
  head: string,
  request: Session['request'],
  authentication: Session['authentication'],
) {
  const pushed = pushedCommits(pull.body);
  if (pushed) return pushed.includes(head);
  return writtenByPublisher(object(await request('GET', `/git/commits/${head}`)), authentication);
}

// A draft a person closed or merged for this target stays as they left it, and one with commits a
// person added, or opened by someone else, stays theirs: Refit never force-pushes over them.
async function heldDraft(
  pull: Record<string, unknown>,
  request: Session['request'],
  context: Parameters<typeof draftOutcome>[3],
) {
  if (pull.state === 'closed')
    return draftOutcome(
      typeof pull.merged_at === 'string' ? 'merged' : 'closed',
      pull,
      sha(object(pull.head).sha),
      context,
    );
  // GitHub may report a pull request's head a moment late; the branch itself decides.
  const head = sha(await reference(request, context.branch));
  const { authentication } = context;
  if (!authentication) return undefined;
  if (object(pull.user).login !== authentication.publisher.login)
    return draftOutcome('existing', pull, head, context, {
      leftUnchanged:
        'Someone else opened this pull request from the Refit branch, so Refit left it as it is.',
    });
  if (await ownHead(pull, head, request, authentication)) return undefined;
  return draftOutcome('existing', pull, head, context, { leftUnchanged: OTHERS_COMMITS });
}

// When publication finds its branch held for someone else's commits, the draft also says if the
// base has moved under it, and what needs updating.
async function heldDraftNoted(
  pull: Record<string, unknown>,
  request: Session['request'],
  context: Parameters<typeof draftOutcome>[3],
  needs: string,
) {
  const held = await heldDraft(pull, request, context);
  if (held?.leftUnchanged === OTHERS_COMMITS)
    await noteBaseMoved(pull, held.head, request, context, needs);
  return held;
}

// One comment, edited when the base moves again, so a held draft does not collect one per run.
async function noteBaseMoved(
  pull: Record<string, unknown>,
  head: string,
  request: Session['request'],
  context: Parameters<typeof draftOutcome>[3],
  needs: string,
) {
  const { options, revision, authentication } = context;
  const comparison = object(await request('GET', `/compare/${revision}...${head}`));
  if (comparison.status === 'ahead' || comparison.status === 'identical') return;
  const number = pullUrl(pull, options).number;
  const marker = `${BASE_MOVED_MARKER} ${revision} -->`;
  const own = await ownComment(request, number, authentication, BASE_MOVED_MARKER);
  if (typeof own?.body === 'string' && own.body.includes(marker)) return;
  const body = `\`${options.base}\` has moved to \`${short(revision)}\` since this draft was last updated, and the draft branch has commits Refit did not write. Refit force-pushes only over its own last commit, so it left the branch as it is. ${needs} To update the draft, merge \`${options.base}\` into this branch and resolve any conflicts; the check results in the description ran on the earlier base.\n\n${marker}`;
  if (own) await request('PATCH', `/issues/comments/${Number(own.id)}`, { body });
  else await request('POST', `/issues/${number}/comments`, { body });
}

// Moves Refit's draft branch only while it still points at `from`, the commit Refit last pushed:
// an atomic lease, like git push --force-with-lease (owner decision, 2026-10-24). False when
// someone else moved the branch first; true when GitHub reports an error but the move landed.
async function leaseBranch(session: Session, branch: string, from: string, to: string) {
  const repository = object(await session.request('GET', ''));
  const result = object(
    await session.graphql(UPDATE_REFS, {
      repositoryId: repository.node_id,
      refUpdates: [{ name: `refs/heads/${branch}`, beforeOid: from, afterOid: to, force: true }],
    }),
  );
  if (!result.errors && isObject(result.data) && isObject(result.data.updateRefs)) return true;
  const current = await reference(session.request, branch);
  if (current === to) return true;
  if (current !== from) return false;
  throw new PipelineInputError(
    `GitHub did not move the migration branch: ${
      Array.isArray(result.errors) && isObject(result.errors[0])
        ? String(result.errors[0].message).slice(0, 300)
        : 'it returned no result'
    }. Inspect the remote branch before retrying.`,
  );
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
  const own = await draftPull(request, options, branch, authentication);
  const files = report.findings
    .filter((finding) => finding.confidence === 'confirmed')
    .map((finding) => finding.file);
  const held =
    own &&
    (await heldDraftNoted(
      own,
      request,
      { options, branch, revision, authentication },
      files.length
        ? `Refit's scan of \`${options.base}\` at \`${short(revision)}\` finds usages to migrate in ${summaryList([...new Set(files)].sort().map(code))}; check that the draft covers each of them.`
        : '',
    ));
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
  const base = async () => (await reference(request, options.base)) === context.revision;
  if (!(await base()))
    throw new PipelineInputError(
      'GitHub base differs from the monitored commit. Update the local checkout before closing a draft.',
    );
  const pull = await draftPull(request, options, branch, authentication);
  if (!pull || pull.state !== 'open' || (await heldDraft(pull, request, context))) return undefined;
  const { number } = pullUrl(pull, options);
  if (await ownComment(request, number, authentication, RESOLVED_MARKER)) return undefined;
  if (!(await base()))
    throw new PipelineInputError('GitHub base changed while checking the draft. Retry the run.');
  // Closed first: the comment then marks only drafts Refit actually closed.
  const closed = object(await request('PATCH', `/pulls/${number}`, { state: 'closed' }));
  await request('POST', `/issues/${number}/comments`, { body: `${reason}\n\n${RESOLVED_MARKER}` });
  return draftOutcome('closed', closed, sha(object(pull.head).sha), context);
}

// Reviewed findings are never edited, so the rescan of the migrated code finds each again; its line
// is where the draft's code has it. A finding the rescan does not match keeps its original line.
function draftLine(report: Report, finding: Finding) {
  const sites = 'unresolvedSites' in report.patch ? (report.patch.unresolvedSites ?? []) : [];
  const same = (site: Pick<Finding, 'file' | 'changeId' | 'expression'>) =>
    site.file === finding.file &&
    site.changeId === finding.changeId &&
    site.expression === finding.expression;
  const originals = report.findings.filter(same);
  const migrated = sites.filter(same);
  return originals.length === migrated.length
    ? migrated[originals.indexOf(finding)].line
    : finding.line;
}

// Where a reason applies in the migrated code; `line` 0 names a whole file.
type ReviewSite = { file: string; line: number; detail?: string };

const firstSentence = (text: string) => text.split(/(?<=\.)\s/)[0];

// Owner decision 1 (Pierce, 2026-10-24, pierceluu10/Refit#300): with --publish-unresolved, wherever
// Refit used to stop it publishes its best patch as a [Needs review] draft. This lists every reason
// the draft needs review, each with what the reviewer must check; an empty list is a validated
// draft. It returns undefined, and nothing publishes, when the option is off, when checks ran on the
// patch and the run did not pass (a regression, an error, or a generated check that fails on the
// original code), or when the checkout changed during validation. `doctor` holds refit doctor's review findings.
export function publicationWaiver(
  report: Report,
  allowUnresolved: boolean | undefined,
  doctor: readonly ReadinessCheck[] = [],
) {
  if (!allowUnresolved) return undefined;
  const { validation, patch } = report;
  // The checks failed or could not finish on the original code, so they never ran on the patch.
  const baselineFailed =
    ['baseline-failed', 'error'].includes(validation.status) &&
    validation.baseline.status !== 'passed' &&
    validation.patched.status === 'not-run';
  const failure = validation.dependencyFailure;
  if (
    validation.status !== 'passed' &&
    !(validation.status === 'untested' && failure) &&
    !baselineFailed
  )
    return undefined;
  const deterministic = patch.generator === 'deterministic';
  const targetVersion = report.apiVersion.after ?? 'the target API version';
  const changed = new Set(
    [...patch.diff.matchAll(/^\+\+\+ ("b\/.+")$/gm)].map((match) =>
      (JSON.parse(match[1]) as string).slice(2),
    ),
  );
  const checks = code(validation.baselineCommand.join(' '));
  const generatedRan = validation.generated
    ? validation.generated.entryPoints.length - validation.generated.notRunnable.length
    : 0;
  const unmapped = unmappedBreakingChanges(
    report.specificationDiff,
    report.changes,
    report.findings,
    report.operationChanges,
    report.requestChanges,
    report.expandedFields,
  ).filter(isObject);
  const impacts: ReviewSite[] = report.operationImpacts.flatMap((impact) =>
    impact.usages.map((usage) => ({
      file: usage.file,
      line: usage.line,
      detail: `${impact.httpMethod.toUpperCase()} ${impact.path}`,
    })),
  );
  return [
    ...(failure
      ? [
          {
            gate: 'dependency-preparation' as const,
            reason:
              validation.baseline.status === 'passed'
                ? `Refit did not run the checks on this patch: preparing its upgraded dependencies failed because ${failure.summary}. They passed on the original code.`
                : `Refit ran no checks: preparing the dependencies failed because ${failure.summary}.`,
            check: failure.action,
            failure,
          },
        ]
      : []),
    ...(baselineFailed
      ? [
          {
            gate: 'baseline-failed' as const,
            // An error is a check that could not finish, such as one stopped at the time limit.
            reason: `${checks} ${validation.baseline.status === 'error' ? 'did not finish' : 'does not pass'} on the original code, so the checks say nothing about this patch and Refit did not run them on it.`,
            check: `Make ${checks} ${validation.baseline.status === 'error' ? 'finish and pass' : 'pass'} on the base branch, then run it on this branch before merging.`,
          },
        ]
      : []),
    ...(validation.status === 'passed' &&
    validation.command.join(' ') === NO_OP_CHECK &&
    !generatedRan
      ? [
          {
            gate: 'no-checks' as const,
            reason: `The configured check ${code(NO_OP_CHECK)} runs no code, so nothing in this patch was tested.`,
            check: `Run your tests or type check on this branch, or set a real check command in ${code('.refit.json')}.`,
          },
        ]
      : []),
    // Owner decision 8: AI patches always ship for review, whatever their checks show.
    ...(patch.generator === 'openai'
      ? [
          {
            gate: 'ai-patch' as const,
            reason:
              'Refit asked an AI model for this patch. Checks that pass do not show that it keeps what the code does.',
            check:
              'Read each AI-written line listed under Why this needs review as you would a teammate’s.',
          },
        ]
      : []),
    ...migrationReviewReasons(report, deterministic).map((entry) =>
      entry.reason === WEBHOOK_REVIEW_REASON
        ? {
            gate: 'webhook-api-version' as const,
            reason: plainText(firstSentence(entry.reason)),
            check: `Set the webhook endpoint API version to ${code(targetVersion)} when you deploy, or confirm it already is.`,
            targetVersion,
            handlers: entry.findings
              .filter((finding) => changed.has(finding.file))
              .map((finding) => ({
                file: finding.file,
                line: draftLine(report, finding),
                eventTypes: finding.webhook!.eventTypes,
              })),
          }
        : entry.reason === REMOVED_REQUEST_PARAMETER_REVIEW_REASON
          ? {
              gate: 'removed-request-parameter' as const,
              reason: plainText(firstSentence(entry.reason)),
              check: 'Change or remove each call under Removed request parameters left for you.',
              targetVersion,
              calls: entry.findings.map((finding) => ({
                file: finding.file,
                line: draftLine(report, finding),
                call: finding.expression.slice(0, finding.expression.indexOf(' ')),
                parameter: finding.requestParameter!.parameter,
              })),
            }
          : {
              gate: 'source-evidence' as const,
              reason: plainText(firstSentence(entry.reason)),
              check: entry.findings.length
                ? 'Migrate or check each usage listed here by hand; Refit left them unchanged.'
                : 'Check the skipped files for usages this patch does not migrate.',
              sites: (entry.findings.length
                ? entry.findings.map((finding) => ({
                    file: finding.file,
                    line: draftLine(report, finding),
                    detail: finding.expression,
                  }))
                : (report.skippedFiles ?? []).map((file) => ({ file, line: 0 }))) as ReviewSite[],
            },
    ),
    ...(report.apiVersion.applicability === 'matches-before'
      ? []
      : [
          {
            gate: 'api-version' as const,
            reason: plainText(report.apiVersion.reason),
            check: `Confirm which API version this code and account use before merging; the patch assumes ${code(report.apiVersion.before ?? 'the before contract')}.`,
          },
        ]),
    ...(unmapped.length || impacts.length
      ? [
          {
            gate: 'contract-changes' as const,
            reason:
              'Traced code reaches breaking changes in the target contract that no Refit rule migrates.',
            check:
              'Migrate each change listed here by hand, or confirm the code does not depend on it.',
            sites: impacts,
            changes: unmapped.map(
              (change) =>
                `${change.operation} ${change.path} ${change.text}${change.reachReason ? `: ${change.reachReason}` : ''}`,
            ),
          },
        ]
      : []),
    ...doctor.map((check) => ({
      gate: 'doctor' as const,
      reason: `refit doctor, ${plainText(check.title)}: ${plainText(check.detail)}`,
      check: plainText(check.action ?? 'Check this finding before merging.'),
    })),
  ];
}

export type ReviewReason = NonNullable<ReturnType<typeof publicationWaiver>>[number];

export async function publishDraft(
  report: Report,
  options: ReturnType<typeof publicationConfiguration>,
  doctor: readonly ReadinessCheck[] = [],
) {
  const apiVersion = report.apiVersion;
  const reviewReason = migrationReviewReason(report, report.patch.generator === 'deterministic');
  const reviews = publicationWaiver(report, options.allowUnresolved, doctor);
  if (reviewReason && !reviews) throw new PipelineInputError(reviewReason);
  if (
    !apiVersion ||
    (apiVersion.applicability !== 'matches-before' && !reviews) ||
    apiVersionSourceBlocked(apiVersion)
  )
    throw new PipelineInputError(
      `Draft publication is blocked. ${apiVersion?.reason ?? 'API-version evidence is missing.'}`,
    );
  const artifacts = createReviewArtifacts(report, 'github', options.integration, reviews);
  if (
    !reviews &&
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
    (report.validation.status !== 'passed' && !reviews) ||
    (report.patch.unresolvedFindings !== 0 && !options.allowUnresolved) ||
    !report.publicationFiles.length
  )
    throw new PipelineInputError(
      'Draft publication requires passing baseline/patched checks, changed files and zero unresolved findings (or --publish-unresolved).',
    );
  const provider = `${PROVIDER_MARKER} ${report.provider} -->`;
  const target = apiVersion.after ?? 'the target contract';
  return publishFiles(options, {
    revision: report.validation.revision,
    key: draftKey(report),
    files: report.publicationFiles,
    title: artifacts.manifest.title,
    body: `${artifacts.files['pull-request.md']}\n${provider}`,
    message: artifacts.commitMessage,
    ...(options.supersedeDrafts
      ? {
          supersedes: {
            // Refit's other migration drafts for this provider and integration, such as an older
            // target version's. A draft that names no provider, from an earlier release, stays.
            matches: (other: string) =>
              other.includes(MIGRATION_MARKER) &&
              other.includes(provider) &&
              (options.integration
                ? other.includes(`${INTEGRATION_MARKER}${options.integration} -->`)
                : !other.includes(INTEGRATION_MARKER)),
            note: `Refit keeps one draft per integration and updates it in place; that draft migrates this code to ${target} on the current \`${options.base}\`.`,
          },
        }
      : {}),
  });
}

// GitHub's timeline shows the force-push but not why. Someone who reviewed the replaced commit
// learns what changed under their review.
async function noteReplacedCommit(
  request: Session['request'],
  number: number,
  replaced: { from: string; baseMoved: boolean },
  to: string,
  context: Parameters<typeof draftOutcome>[3],
) {
  const { options, revision, authentication } = context;
  const reviews = await listAll(
    request,
    `/pulls/${number}/reviews`,
    'Draft review search is incomplete; inspect the pull request before retrying.',
  );
  const reviewed = reviews.some(
    (review) =>
      isObject(review) &&
      review.commit_id === replaced.from &&
      isObject(review.user) &&
      review.user.login !== authentication?.publisher.login,
  );
  if (!reviewed) return;
  const reason = replaced.baseMoved
    ? `\`${options.base}\` moved to \`${short(revision)}\``
    : 'the migration changed';
  await request('POST', `/issues/${number}/comments`, {
    body: `Refit replaced the reviewed commit \`${short(replaced.from)}\` with \`${short(to)}\` because ${reason}. Those reviews refer to \`${short(replaced.from)}\`; the description now shows the checks for \`${short(to)}\`.`,
  });
}

// Refit's own comment on a pull request that carries `marker`.
async function ownComment(
  request: Session['request'],
  number: number,
  authentication: Session['authentication'],
  marker: string,
) {
  const list = await listAll(
    request,
    `/issues/${number}/comments`,
    'Draft comment search is incomplete; inspect the pull request before retrying.',
  );
  return list.find(
    (comment): comment is Record<string, unknown> =>
      isObject(comment) &&
      isObject(comment.user) &&
      comment.user.login === authentication?.publisher.login &&
      typeof comment.body === 'string' &&
      comment.body.includes(marker),
  );
}

// Closes the publisher's other open drafts on this base that this draft replaces, each with a
// comment linking it. A draft with commits a person added stays open, and so does one a person
// marked ready for review or reopened after Refit closed it.
async function closeSuperseded(
  session: Session,
  options: PublicationConfiguration,
  branch: string,
  number: number,
  supersedes: { matches: (body: string) => boolean; note: string },
) {
  const { authentication, request } = session;
  const pulls = await listAll(
    request,
    '/pulls',
    'Existing PR search is incomplete; review repository pagination before retrying.',
    { state: 'open', base: options.base },
  );
  const closed: number[] = [];
  for (const pull of pulls) {
    if (
      !isObject(pull) ||
      pull.number === number ||
      pull.draft !== true ||
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
    if (
      !(await ownHead(pull, sha(await reference(request, pull.head.ref)), request, authentication))
    )
      continue;
    if (await ownComment(request, other, authentication, SUPERSEDED_MARKER)) continue;
    // Closed first: the comment then marks only drafts Refit actually closed.
    await request('PATCH', `/pulls/${other}`, { state: 'closed' });
    await request('POST', `/issues/${other}/comments`, {
      body: `Superseded by #${number}. ${supersedes.note}\n\n${SUPERSEDED_MARKER}`,
    });
    closed.push(other);
  }
  return closed;
}

// Publishes validated files as one commit on a Refit branch from the validated revision and opens
// a draft pull request. The branch follows the change's key, so a rerun finds its draft: Refit
// moves its own branch to the new commit, only while it still points at the commit Refit last
// pushed, and refreshes the description; it leaves a branch with commits a person added as it is,
// and never reopens or replaces a draft a person closed or merged. Refit never marks a pull
// request ready or merges it.
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
  const checkBase = async () => {
    if ((await reference(request, options.base)) !== revision)
      throw new PipelineInputError(
        'GitHub base changed or does not match the validated revision. Revalidate the current base.',
      );
  };
  const context = { options, branch, revision, authentication };
  const needs = `Refit's patch for \`${options.base}\` at \`${short(revision)}\` changes ${summaryList(change.files.map((file) => code(file.path)))}.`;
  // Someone else moved the branch during publication: leave it, and tell the draft if the base moved.
  const leaveBranch = async () => {
    const latest = await draftPull(request, options, branch, authentication);
    const held = latest && (await heldDraftNoted(latest, request, context, needs));
    if (held) return held;
    throw new PipelineInputError('Migration branch changed during publication.');
  };
  await checkBase();
  let pull = await draftPull(request, options, branch, authentication);
  const held = pull && (await heldDraftNoted(pull, request, context, needs));
  if (held) return held;
  const baseCommit = object(await request('GET', `/git/commits/${revision}`));
  const baseTree = sha(object(baseCommit.tree).sha);
  if (withPushed(change.body, revision).length > MAX_BODY_CHARACTERS)
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
  let head = await reference(request, branch, true);
  let updated = false;
  if (!head) {
    const commit = await createCommit();
    await checkBase();
    try {
      await request('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: commit });
    } catch (error) {
      if (!(error instanceof GitHubRequestError) || error.status !== 422) throw error;
    }
    head = sha(await reference(request, branch));
  } else {
    const current = object(await request('GET', `/git/commits/${head}`));
    if (!isCandidate(current)) {
      // Without the App, Refit cannot tell its own commits from a person's.
      if (pull && !authentication)
        return draftOutcome('existing', pull, head, context, {
          leftUnchanged:
            'Refit updates an existing draft only when it publishes as the GitHub App.',
        });
      const own = pull
        ? await ownHead(pull, head, request, authentication)
        : writtenByPublisher(current, authentication);
      if (!own) {
        if (pull) return leaveBranch();
        throw new PipelineInputError(
          'Existing migration branch differs from the validated candidate. Refusing to overwrite it.',
        );
      }
      // Refit's own commit on an older base or an older patch: replace it. The draft's current
      // record gains the new commit first, so a run cut short between the two writes, or another
      // Refit run updating the same draft, still recognises the branch.
      // shortcut: a run that stalls between this read and its write can still drop another run's
      // commit from the record and hold the draft; serialize runs per draft if that ever shows up.
      const replacement = await createCommit();
      await checkBase();
      const number = pull && pullUrl(pull, options).number;
      if (number) {
        const latest = object(await request('GET', `/pulls/${number}`));
        if (!(await ownHead(latest, head, request, authentication))) return leaveBranch();
        const record = new Set([...(pushedCommits(latest.body) ?? [head]), replacement]);
        await request('PATCH', `/pulls/${number}`, {
          body: withPushed(String(latest.body), ...record),
        });
      }
      if (!(await leaseBranch(session, branch, head, replacement))) return leaveBranch();
      const replaced = {
        from: head,
        baseMoved: !Array.isArray(current.parents) || object(current.parents[0]).sha !== revision,
      };
      head = replacement;
      updated = true;
      // Described and announced right after the move, so a later failure leaves neither stale.
      if (number) {
        pull = object(
          await request('PATCH', `/pulls/${number}`, {
            title: change.title,
            body: withPushed(change.body, head),
          }),
        );
        await noteReplacedCommit(request, number, replaced, head, context);
      }
    }
  }
  const body = withPushed(change.body, head);
  if (!isCandidate(object(await request('GET', `/git/commits/${head}`))))
    throw new PipelineInputError(
      'Existing migration branch differs from the validated candidate. Refusing to overwrite it.',
    );
  await checkBase();
  if ((await reference(request, branch)) !== head)
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
      pull = await draftPull(request, options, branch, authentication);
      if (!pull) throw error;
    }
  } else if (pull.title !== change.title || pull.body !== body) {
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
