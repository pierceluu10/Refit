import type { MigrationTask, OpenPullRequest, RunRecord, ScanResult } from '../shared/types.ts';
import { filesFromDiff } from './git.ts';
import { githubRequest } from './github.ts';
import { BRANCH_PREFIX } from './types.ts';
import type {
  FileChange,
  InstallationTokens,
  OpenedFix,
  OpenPullRequestInput,
  OpenedPullRequest,
} from './types.ts';

const FILE_MODE = '100644';
const BLOB = 'blob';
const MAX_SLUG_CHARS = 80;
const LIVE = 'live';

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

// The harness writes prBody and its last rescan beside RunRecord's own fields (HarnessRunRecord).
type WrittenRecord = RunRecord & { prBody?: string; rescan?: Pick<ScanResult, 'findings'> };
// A repo session's task names the list entries it set out to fix (harness/findings.ts, RepoTask).
type ListTask = MigrationTask & { entries?: { id: string }[] };

// An entry the last rescan still found live wasn't fixed, so finding it later isn't a return.
const fixedEntries = (task: ListTask, record: WrittenRecord) =>
  (task.entries ?? [])
    .map((entry) => entry.id)
    .filter(
      (id) =>
        !record.rescan?.findings.some(
          (finding) => finding.entryId === id && finding.matchClass === LIVE,
        ),
    );

// The shared OpenPullRequest for one installation: the record's diff on aptitude/<task-slug>, as a draft.
// A task that already has an open PR (the same change seen on a later push) gets that PR back.
export function createOpenPullRequest(
  tokens: InstallationTokens,
  installationId: number,
  fetchImpl: typeof fetch = fetch,
  remember: (fix: OpenedFix) => Promise<void> = async () => {},
): OpenPullRequest {
  return async (task: ListTask, record: WrittenRecord, repoDir) => {
    const branch = branchFor(task.id);
    const owner = task.repo.split('/')[0];
    const open = await githubRequest<{ html_url: string }[]>(
      await tokens.token(installationId),
      'GET',
      `/repos/${encodePath(task.repo)}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
      undefined,
      fetchImpl,
    );
    if (open.length > 0) return open[0].html_url;
    const title = task.change.title;
    const pull = await openPullRequest(
      tokens,
      installationId,
      {
        repo: task.repo,
        branch,
        title,
        body: record.prBody ?? `${title}\n\nSource: ${task.change.source.url}`,
        commitMessage: `chore(${task.change.provider}): ${title}`,
        files: await filesFromDiff(repoDir, record.diff),
        // Fixed gets a normal PR; needs-a-look stays a draft that says so.
        draft: record.outcome !== 'verified',
      },
      fetchImpl,
    );
    try {
      await remember({
        repo: task.repo,
        number: pull.number,
        url: pull.url,
        sha: pull.sha,
        entryIds: fixedEntries(task, record),
      });
    } catch (error) {
      // The PR exists. Failing here would lose its URL from the run record, which costs more than
      // this PR's humanDiff.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`could not remember ${pull.url}: ${message}`);
    }
    return pull.url;
  };
}
