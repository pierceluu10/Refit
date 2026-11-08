import type { ExternalTask, RunRecord } from '../shared/types.ts';
import { filesFromDiff } from './git.ts';
import { GitHubApiError, githubRequest } from './github.ts';
import { BRANCH_PREFIX } from './types.ts';
import type {
  FileChange,
  InstallationTokens,
  OpenAnyPullRequest,
  OpenPullRequestInput,
  OpenedPullRequest,
} from './types.ts';

const FILE_MODE = '100644';
const BLOB = 'blob';
const MAX_SLUG_CHARS = 80;
const WORKFLOWS_DIR = '.github/workflows/';
const FORBIDDEN = 403;
const MAX_WORKFLOW_DIFF_CHARS = 8000;

export class UnsafeBranchError extends Error {
  constructor(branch: string, reason: string) {
    super(`Refusing to open a pull request from ${branch}: ${reason}`);
    this.name = 'UnsafeBranchError';
  }
}

export class EmptyChangeError extends Error {
  constructor(repo: string) {
    super(`Refusing to open a pull request on ${repo} with no file changes`);
    this.name = 'EmptyChangeError';
  }
}

export class WorkflowPermissionError extends Error {
  constructor(repo: string) {
    super(
      `GitHub refused changes to ${WORKFLOWS_DIR} on ${repo}, and the change has nothing else. Approve the Workflows permission for this install.`,
    );
    this.name = 'WorkflowPermissionError';
  }
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

function assertSafeBranch(branch: string, base: string): void {
  if (branch === base) throw new UnsafeBranchError(branch, 'it is the base branch');
}

const treeEntry = (change: FileChange) =>
  'delete' in change
    ? { path: change.path, mode: FILE_MODE, type: BLOB, sha: null }
    : { path: change.path, mode: FILE_MODE, type: BLOB, content: change.content };

export async function openPullRequest(
  tokens: InstallationTokens,
  installationId: number,
  input: OpenPullRequestInput,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenedPullRequest> {
  const { branch } = input;
  if (!branch.startsWith(BRANCH_PREFIX)) {
    throw new UnsafeBranchError(branch, `it does not start with ${BRANCH_PREFIX}`);
  }
  if (input.files.length === 0) throw new EmptyChangeError(input.repo);
  if (input.base !== undefined) assertSafeBranch(branch, input.base);

  const token = await tokens.token(installationId);
  const repoPath = `/repos/${encodePath(input.repo)}`;
  const request = <T>(method: string, path: string, body?: unknown) =>
    githubRequest<T>(token, method, `${repoPath}${path}`, body, fetchImpl);

  const base = input.base ?? (await request<{ default_branch: string }>('GET', '')).default_branch;
  assertSafeBranch(branch, base);

  const baseRef = await request<{ object: { sha: string } }>(
    'GET',
    `/git/ref/heads/${encodePath(base)}`,
  );
  const baseSha = baseRef.object.sha;
  const baseCommit = await request<{ tree: { sha: string } }>('GET', `/git/commits/${baseSha}`);
  const tree = await request<{ sha: string }>('POST', '/git/trees', {
    base_tree: baseCommit.tree.sha,
    tree: input.files.map(treeEntry),
  });
  const commit = await request<{ sha: string }>('POST', '/git/commits', {
    message: input.commitMessage,
    tree: tree.sha,
    parents: [baseSha],
  });
  await request('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: commit.sha });
  const pull = await request<{ html_url: string; number: number }>('POST', '/pulls', {
    title: input.title,
    body: input.body,
    head: branch,
    base,
    draft: input.draft ?? true,
  });
  return { url: pull.html_url, number: pull.number, branch, sha: commit.sha };
}

export const branchFor = (taskId: string) =>
  BRANCH_PREFIX +
  taskId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_SLUG_CHARS)
    .replace(/^-+|-+$/g, '');

// The harness writes prBody beside RunRecord's own fields (HarnessRunRecord), and may write a prTitle.
type WrittenRecord = RunRecord & { prBody?: string; prTitle?: string };

// GitHub answers 403 to the whole tree when the install hasn't approved Workflows, which older installs
// may not have. The rest of the change is still worth a PR, so the workflow edits go in its body.
const isWorkflowRefusal = (error: unknown) =>
  error instanceof GitHubApiError &&
  error.status === FORBIDDEN &&
  error.path.endsWith('/git/trees');

function workflowNote(diff: string) {
  const sections = diff
    .split(/^(?=diff --git )/m)
    .filter((section) => section.startsWith(`diff --git a/${WORKFLOWS_DIR}`));
  return [
    `> **Not in this PR:** edits to \`${WORKFLOWS_DIR}\`. This install hasn't approved Refit's Workflows permission, so GitHub refused them. The checks below ran with these edits applied, so apply them by hand or approve the permission and re-run.`,
    '',
    '<details><summary>Workflow edits to apply</summary>',
    '',
    '```diff',
    sections.join('').slice(0, MAX_WORKFLOW_DIFF_CHARS),
    '```',
    '',
    '</details>',
    '',
    '',
  ].join('\n');
}

type Pull = { html_url: string; state: string; merged_at: string | null };

async function pullsOnBranch(
  tokens: InstallationTokens,
  installationId: number,
  task: { id: string; repo: string },
  state: 'open' | 'all',
  fetchImpl: typeof fetch,
): Promise<Pull[]> {
  const head = encodeURIComponent(`${task.repo.split('/')[0]}:${branchFor(task.id)}`);
  return githubRequest<Pull[]>(
    await tokens.token(installationId),
    'GET',
    `/repos/${encodePath(task.repo)}/pulls?state=${state}&head=${head}`,
    undefined,
    fetchImpl,
  );
}

// The shared opener for one installation: the record's diff on refit/<task-slug>, as a draft.
// A task that already has an open PR (the same change seen on a later push) gets that PR back.
export function createOpenPullRequest(
  tokens: InstallationTokens,
  installationId: number,
  fetchImpl: typeof fetch = fetch,
): OpenAnyPullRequest {
  return async (task, record: WrittenRecord, repoDir) => {
    const open = await pullsOnBranch(tokens, installationId, task, 'open', fetchImpl);
    if (open.length > 0) return open[0].html_url;
    const title = record.prTitle ?? task.change.title;
    const body = record.prBody ?? `${title}\n\nSource: ${task.change.source.url}`;
    const files = await filesFromDiff(repoDir, record.diff);
    const pullRequest = (changed: FileChange[], text: string) =>
      openPullRequest(
        tokens,
        installationId,
        {
          repo: task.repo,
          branch: branchFor(task.id),
          title,
          body: text,
          commitMessage: `chore(${task.change.provider}): ${title}`,
          files: changed,
          draft: true,
        },
        fetchImpl,
      );
    const pull = await pullRequest(files, body).catch((error: unknown) => {
      const kept = files.filter((file) => !file.path.startsWith(WORKFLOWS_DIR));
      if (!isWorkflowRefusal(error) || kept.length === files.length) throw error;
      if (kept.length === 0) throw new WorkflowPermissionError(task.repo);
      return pullRequest(kept, `${workflowNote(record.diff)}${body}`);
    });
    return pull.url;
  };
}

export type ExistingPullRequest = { url: string; state: 'open' | 'merged' | 'closed' };

// The PR a task's branch already has, if any: an open one wins, then a merged one, then a closed one.
export function findPullRequestFor(
  tokens: InstallationTokens,
  installationId: number,
  fetchImpl: typeof fetch = fetch,
) {
  return async (task: ExternalTask): Promise<ExistingPullRequest | undefined> => {
    const pulls = await pullsOnBranch(tokens, installationId, task, 'all', fetchImpl);
    const open = pulls.find((pull) => pull.state === 'open');
    if (open) return { url: open.html_url, state: 'open' };
    const merged = pulls.find((pull) => pull.merged_at !== null);
    if (merged) return { url: merged.html_url, state: 'merged' };
    return pulls[0] && { url: pulls[0].html_url, state: 'closed' };
  };
}
