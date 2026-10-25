import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  addable,
  addAgents,
  detectProviders,
  scaffoldChecks,
  v1IntegrationId,
} from './agent-catalog.ts';
import { enrollmentReviewText } from './enrollment-review.ts';
import { authenticateGitHubIssues, type GitHubAppConfiguration } from './github-app.ts';
import { withGitHubCheckout } from './github-checkout.ts';
import { GitHubRequestError, requestGitHub } from './github.ts';
import type {
  ApprovalCommand,
  ApprovalIssue,
  ApprovalIssueState,
  ApprovalStore,
} from './hosted-approval-store.ts';
import { hostedTargetId, type openHostedStore } from './hosted-store.ts';
import { inspectRepositoryEnrollment, repositoryApproval } from './repository-enrollment.ts';
import { isObject } from './specifications.ts';
import { saveGeneratedContracts } from './service-worker.ts';
import { PipelineInputError } from './types.ts';
import { REPOSITORY_CONFIGURATION } from './workflow-configuration.ts';

const MARKER = '<!-- refit-approval -->';
const PREFIX = /^[a-f0-9]{12,64}$/;
const SHOWN_PREFIX_LENGTH = 12;
const APPROVER_ROLES = new Set(['admin', 'maintain']);
const NOT_FOUND = 404;
// GitHub rejects issue bodies over 65,536 characters; a longer review is pointed to instead.
const MAX_REVIEW_CHARACTERS = 60_000;

// Named outcomes of a command, stored with it and stated in the reply.
export const APPROVAL_OUTCOMES = {
  approved: 'approved',
  revoked: 'revoked',
  notApproved: 'not-approved',
  ignored: 'ignored',
  edited: 'edited-comment',
  permission: 'no-permission',
  wrongPrefix: 'wrong-prefix',
  stalePrefix: 'stale-prefix',
  changed: 'configuration-changed',
  unreviewed: 'no-reviewed-configuration',
  failed: 'failed',
} as const;

type HostedStore = Awaited<ReturnType<typeof openHostedStore>>;
type Request = (method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) => Promise<unknown>;
type Inspection =
  | { state: 'review'; enrollment: Awaited<ReturnType<typeof inspectRepositoryEnrollment>> }
  | {
      state: 'proposal';
      ids: string[];
      detected: string[];
      scaffold: ReturnType<typeof addAgents>;
    }
  | { state: 'no-providers'; detected: string[] }
  | { state: 'invalid'; message: string };

interface ApprovalContext {
  app: GitHubAppConfiguration;
  // Managed checkouts used only to inspect configuration, one per repository and branch.
  directory: string;
  // Where the Stripe contracts of a generated configuration are kept, as for jobs.
  contracts: string;
  // Owner decision 1 (--publish-unresolved): review the configuration jobs will then generate.
  allowUntested?: boolean;
  store: HostedStore;
  approvals: ApprovalStore;
  signal: AbortSignal;
  // Aborts running jobs of a revoked repository in this process.
  onCancelled: (jobs: number[]) => void;
  onProgress?: (message: string) => void;
}

const code = (value: string) => `\`${value.replaceAll('`', "'")}\``;

// A fence longer than any backtick run in the text, so repository content cannot close it.
function fence(text: string, language = '') {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const marks = '`'.repeat(Math.max(3, longest + 1));
  return `${marks}${language}\n${text}\n${marks}`;
}

// The same inputs `refit enroll` reads, from a fresh checkout of the branch. A repository without
// .refit.json is reviewed with the configuration `refit enroll` generates, or, where none can be
// generated, gets the configuration `refit agents --add` would write for its detected providers.
async function inspect(context: ApprovalContext, repository: string, base: string) {
  return withGitHubCheckout(
    {
      directory: join(context.directory, hostedTargetId(repository, base)),
      target: { repository, base, app: context.app },
      signal: context.signal,
    },
    async (checkout): Promise<Inspection> => {
      const generated = await saveGeneratedContracts(
        checkout.directory,
        context.contracts,
        context.allowUntested,
      );
      if (!generated && !existsSync(join(checkout.directory, REPOSITORY_CONFIGURATION))) {
        const detections = await detectProviders(checkout.directory);
        const detected = detections.map((detection) => detection.agent.name);
        const ids = detections.filter(addable).map((detection) => detection.agent.id);
        if (!ids.length) return { state: 'no-providers', detected };
        const scaffold = addAgents({
          configuration: undefined,
          v1Id: v1IntegrationId(undefined),
          detections,
          ids,
          ...(await scaffoldChecks(checkout.directory)),
        });
        return { state: 'proposal', ids, detected, scaffold };
      }
      try {
        return {
          state: 'review',
          enrollment: await inspectRepositoryEnrollment({
            repository: checkout.directory,
            github: repository,
            base,
            contracts: context.contracts,
            allowUntested: context.allowUntested,
          }),
        };
      } catch (error) {
        if (!(error instanceof PipelineInputError)) throw error;
        return { state: 'invalid', message: error.message };
      }
    },
  );
}

function issueTitle(state: ApprovalIssueState) {
  if (state === 'approved') return 'Refit is approved for this repository';
  if (state === 'review') return 'Approve Refit for this repository';
  return 'Set up Refit for this repository';
}

export function approvalIssueBody(
  inspection: Inspection,
  repository: string,
  base: string,
  approvedBy?: string,
) {
  if (inspection.state === 'review') {
    const { enrollment } = inspection;
    const review = enrollmentReviewText(enrollment);
    const prefix = enrollment.fingerprint.slice(0, SHOWN_PREFIX_LENGTH);
    return [
      MARKER,
      approvedBy
        ? `**Approved** by ${code(approvedBy)} at fingerprint ${code(prefix)}. Refit runs this configuration on ${code(base)}. If it changes, jobs stop for review and this issue shows the new configuration.`
        : `Refit is installed on this repository but runs nothing until someone approves its configuration. This is the review \`refit enroll\` shows for ${code(base)}:`,
      '',
      review.length > MAX_REVIEW_CHARACTERS
        ? `The review is too long to show here (${review.length} characters). Read it with \`refit enroll --repository <checkout> --github ${repository} --base ${base}\`. Its fingerprint is ${code(enrollment.fingerprint)}.`
        : fence(review),
      '',
      ...(approvedBy
        ? ['To withdraw the approval, comment `/refit revoke`.']
        : [
            '**To approve**, someone with the admin or maintain role on this repository comments exactly:',
            '',
            fence(`/refit approve ${prefix}`),
            '',
            'Refit checks the committed configuration again before storing the approval. If it changed since this issue was written, Refit refuses and updates this issue. The approval is the same record `refit hosted approve` stores. AI patches and draft publication stay separate settings of the hosted worker.',
            '',
            'To withdraw an approval later, comment `/refit revoke`. Edited comments are never acted on; post a new comment instead.',
          ]),
    ].join('\n');
  }
  if (inspection.state === 'proposal') {
    const { scaffold } = inspection;
    return [
      MARKER,
      `Refit is installed on this repository, which has no committed ${code(REPOSITORY_CONFIGURATION)} on ${code(base)}. Refit detected ${inspection.detected.join(', ')}. This is the configuration \`refit agents ${inspection.ids.map((id) => `--add ${id}`).join(' ')}\` writes:`,
      '',
      fence(JSON.stringify(scaffold.configuration, null, 2), 'json'),
      '',
      'Before committing it:',
      ...scaffold.adapterFiles.map(
        (file) =>
          `- Add Refit's reviewed adapter ${code(file.source)} as ${code(file.target)}. \`refit agents --add\` copies it.`,
      ),
      ...scaffold.nextSteps.map((step) => `- ${step}`),
      '',
      'After committing it, someone with the admin or maintain role comments `/refit approve`. Refit then replaces this proposal with the review to approve. Nothing runs before approval.',
    ].join('\n');
  }
  if (inspection.state === 'invalid')
    return [
      MARKER,
      `Refit is installed on this repository, but the committed ${code(REPOSITORY_CONFIGURATION)} on ${code(base)} cannot be reviewed:`,
      '',
      fence(inspection.message),
      '',
      'Fix it, then comment `/refit approve` and Refit checks it again. Nothing runs before approval.',
    ].join('\n');
  return [
    MARKER,
    `Refit found no provider SDK it has an agent for on ${code(base)}${inspection.detected.length ? ` (detected without an agent: ${inspection.detected.join(', ')})` : ''}, so there is nothing to approve. Nothing runs.`,
  ].join('\n');
}

async function defaultBranch(request: Request, repository: string) {
  const record = await request('GET', `/repos/${repository}`);
  if (
    !isObject(record) ||
    typeof record.full_name !== 'string' ||
    record.full_name.toLowerCase() !== repository ||
    typeof record.default_branch !== 'string' ||
    record.archived !== false
  )
    throw new PipelineInputError(
      'Repository is unavailable, archived or has mismatched identity; no approval issue was opened.',
    );
  return record.default_branch;
}

async function writeIssue(
  request: Request,
  repository: string,
  issue: number | null,
  title: string,
  body: string,
  state: 'open' | 'closed',
) {
  if (issue !== null) {
    await request('PATCH', `/repos/${repository}/issues/${issue}`, { title, body, state });
    return issue;
  }
  const created = await request('POST', `/repos/${repository}/issues`, { title, body });
  if (!isObject(created) || !Number.isSafeInteger(created.number) || Number(created.number) <= 0)
    throw new PipelineInputError('GitHub did not return the created issue number.');
  return Number(created.number);
}

// Writes what the issue shows for an inspection. No issue is opened for a repository with nothing to
// approve.
async function show(
  context: ApprovalContext,
  request: Request,
  target: { repository: string; installationId: number; base: string; issue: number | null },
  inspection: Inspection,
  approvedBy?: string,
) {
  const state = approvedBy ? 'approved' : inspection.state;
  const issue =
    target.issue === null && state === 'no-providers'
      ? null
      : await writeIssue(
          request,
          target.repository,
          target.issue,
          issueTitle(state),
          approvalIssueBody(inspection, target.repository, target.base, approvedBy),
          approvedBy ? 'closed' : 'open',
        );
  await context.approvals.record({
    repository: target.repository,
    installationId: target.installationId,
    base: target.base,
    issue,
    state,
    fingerprint: inspection.state === 'review' ? inspection.enrollment.fingerprint : null,
    message: null,
  });
  return issue;
}

async function issuesRequest(context: ApprovalContext, repository: string): Promise<Request> {
  const { token } = await authenticateGitHubIssues(context.app, repository);
  return (method, path, body) => requestGitHub(token, method, path, body);
}

// Opens or refreshes the issue for a repository that needs approval. Each inspection is a checkout
// and scan, so it counts against the installation's daily inventory cap; a refused one waits.
async function refresh(context: ApprovalContext, repository: string, installationId: number) {
  const refusal = await context.store.reserveInventory(installationId);
  if (refusal) {
    context.onProgress?.(`[${repository}] Approval issue waits: ${refusal}.`);
    return;
  }
  const previous = await context.approvals.issue(repository);
  try {
    const request = await issuesRequest(context, repository);
    const base = await defaultBranch(request, repository);
    const issue = await show(
      context,
      request,
      { repository, installationId, base, issue: previous?.issue ?? null },
      await inspect(context, repository, base),
    );
    // A job found the approved configuration changed; comment so watchers are notified.
    if (previous?.state === 'approved' && issue !== null)
      await request('POST', `/repos/${repository}/issues/${issue}/comments`, {
        body: `The committed configuration on ${code(base)} changed after it was approved, so Refit stopped running it. This issue shows the current configuration; approve it again to resume.`,
      });
    context.onProgress?.(
      `[${repository}] Approval issue ${issue === null ? 'not needed' : `#${issue} written`}.`,
    );
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    await context.approvals.record({
      repository,
      installationId,
      base: previous?.base ?? null,
      issue: previous?.issue ?? null,
      state: 'failed',
      fingerprint: previous?.fingerprint ?? null,
      message: `${error.name}: ${error.message}`,
    });
    context.onProgress?.(`[${repository}] Approval issue failed: ${error.name}: ${error.message}`);
  }
}

async function approverRole(request: Request, repository: string, login: string) {
  try {
    const permission = await request(
      'GET',
      `/repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`,
    );
    return isObject(permission) && typeof permission.role_name === 'string'
      ? permission.role_name
      : null;
  } catch (error) {
    if (error instanceof GitHubRequestError && error.status === NOT_FOUND) return null;
    throw error;
  }
}

async function approve(
  context: ApprovalContext,
  request: Request,
  command: ApprovalCommand,
  current: ApprovalIssue & { issue: number },
  reply: (body: string) => Promise<unknown>,
) {
  const target = {
    ...current,
    base: current.base ?? (await defaultBranch(request, current.repository)),
  };
  if (!current.fingerprint) {
    const inspection = await inspect(context, current.repository, target.base);
    await show(context, request, target, inspection);
    await reply(
      `This issue showed no reviewed configuration to approve. Refit checked ${code(target.base)} again and updated the issue${inspection.state === 'review' ? '; review it, then approve with the fingerprint it shows' : ''}.`,
    );
    return APPROVAL_OUTCOMES.unreviewed;
  }
  const prefix = command.argument?.toLowerCase() ?? '';
  if (!PREFIX.test(prefix) || !current.fingerprint.startsWith(prefix)) {
    const stale = PREFIX.test(prefix) && current.shown.some((shown) => shown.startsWith(prefix));
    await reply(
      stale
        ? `That fingerprint is from an earlier version of this issue; the configuration changed since. Review the issue as it is now and approve with the fingerprint it shows.`
        : `\`/refit approve\` needs at least ${SHOWN_PREFIX_LENGTH} characters of the fingerprint this issue shows, and that value does not match it. Nothing was approved.`,
    );
    return stale ? APPROVAL_OUTCOMES.stalePrefix : APPROVAL_OUTCOMES.wrongPrefix;
  }
  const inspection = await inspect(context, current.repository, target.base);
  if (inspection.state !== 'review' || inspection.enrollment.fingerprint !== current.fingerprint) {
    await show(context, request, target, inspection);
    await reply(
      `The committed configuration on ${code(target.base)} changed after this issue was written, so Refit did not approve it. The issue now shows the current configuration; review it and approve with its fingerprint.`,
    );
    return APPROVAL_OUTCOMES.changed;
  }
  const enrolled = await context.store.approve(
    repositoryApproval(inspection.enrollment, current.fingerprint),
    command.author,
  );
  await show(context, request, target, inspection, command.author);
  await reply(
    `Approved by ${code(command.author)} at fingerprint ${code(current.fingerprint.slice(0, SHOWN_PREFIX_LENGTH))}. Refit stored the same approval as \`refit hosted approve\`${enrolled.length ? ` and queued ${enrolled.length === 1 ? 'a job' : `${enrolled.length} jobs`}` : ''}. AI patches and draft publication stay separate settings of the hosted worker.`,
  );
  return APPROVAL_OUTCOMES.approved;
}

async function revoke(
  context: ApprovalContext,
  request: Request,
  command: ApprovalCommand,
  current: ApprovalIssue & { issue: number },
  reply: (body: string) => Promise<unknown>,
) {
  const result = await context.store.revoke(current.repository, command.author);
  context.onCancelled(result.running);
  if (!result.revoked) {
    await reply('This repository has no stored approval, so nothing changed.');
    return APPROVAL_OUTCOMES.notApproved;
  }
  const base = current.base ?? (await defaultBranch(request, current.repository));
  await show(
    context,
    request,
    { ...current, base },
    await inspect(context, current.repository, base),
  );
  await reply(
    `Revoked by ${code(command.author)}. Refit removed the approval and cancelled ${result.cancelled.length === 1 ? 'its target' : `${result.cancelled.length} targets`}; nothing runs until someone approves again. The issue shows the current configuration.`,
  );
  return APPROVAL_OUTCOMES.revoked;
}

// Only commands on a repository's approval issue, from its allowed installation, are handled.
async function handle(context: ApprovalContext, command: ApprovalCommand) {
  const current = await context.approvals.issue(command.repository);
  if (
    current?.issue !== command.issue ||
    !(await context.approvals.installed(command.installationId, command.repository))
  )
    return APPROVAL_OUTCOMES.ignored;
  const issue = { ...current, issue: command.issue };
  const request = await issuesRequest(context, command.repository);
  const reply = (body: string) =>
    request('POST', `/repos/${command.repository}/issues/${command.issue}/comments`, { body });
  if (command.edited) {
    await reply(
      'Refit never acts on edited comments, because an edit could change what someone else already read. Post the command as a new comment.',
    );
    return APPROVAL_OUTCOMES.edited;
  }
  const role = await approverRole(request, command.repository, command.author);
  if (!role || !APPROVER_ROLES.has(role)) {
    await reply(
      `Only someone with the admin or maintain role on this repository can ${command.command} Refit; ${code(command.author)} has ${role ? `the ${code(role)} role` : 'no role'}. Nothing changed.`,
    );
    return APPROVAL_OUTCOMES.permission;
  }
  return command.command === 'approve'
    ? approve(context, request, command, issue, reply)
    : revoke(context, request, command, issue, reply);
}

// Handles queued commands first, then opens or refreshes issues for repositories that need one.
export async function processApprovalIssues(context: ApprovalContext) {
  for (
    let command = await context.approvals.claim();
    command && !context.signal.aborted;
    command = await context.approvals.claim()
  ) {
    let outcome: string;
    try {
      outcome = await handle(context, command);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      outcome = `${APPROVAL_OUTCOMES.failed}: ${error.name}: ${error.message}`;
    }
    await context.approvals.finish(command.id, outcome);
    context.onProgress?.(`[${command.repository}] /refit ${command.command}: ${outcome}`);
  }
  for (const due of await context.approvals.due()) {
    if (context.signal.aborted) return;
    await refresh(context, due.repository, due.installationId);
  }
}
