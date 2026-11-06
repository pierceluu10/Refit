import type { ExternalChange, ExternalTask, MigrationTask, RunRecord } from '../../shared/types.ts';
import { listRefitPullRequests } from '../api/pulls.ts';
import type { PullRequest } from '../api/pulls.ts';
import { filesFromDiff } from '../git.ts';
import { EmptyChangeError, UnsafeBranchError } from '../pr.ts';
import { BRANCH_PREFIX } from '../types.ts';
import type { FileChange, InstallationTokens } from '../types.ts';
import { parseMarker, withMarker } from './marker.ts';
import type { LifecycleMarker } from './marker.ts';
import { encodePath, hasPersonCommits, postComment, repoRequest } from './pulls.ts';

const FILE_MODE = '100644';
const BLOB = 'blob';
const VERSION_START = /^v?\d/i;
const DIGITS = /\d+/g;

type AnyTask = MigrationTask | ExternalTask;

// The harness writes prBody beside RunRecord's own fields, and P1's opener reads it from there.
type WrittenRecord = RunRecord & { prBody?: string };

export type BeforeOpenPullRequest = (input: {
  installationId: number;
  task: AnyTask;
  record: RunRecord;
  repoDir: string;
}) => Promise<{ pr?: string }>;

export type FindOpenPullRequest = (
  installationId: number,
  task: AnyTask,
) => Promise<{ url: string; state: 'open' } | undefined>;

type LifecycleDeps = { tokens: InstallationTokens; fetchImpl?: typeof fetch };

type MarkedPull = { pull: PullRequest; marker: LifecycleMarker };

function taskMarker({ change }: AnyTask): LifecycleMarker {
  const { dependency, toVersion } = change as Partial<ExternalChange>;
  return {
    dependency: dependency ?? change.provider,
    kind: change.kind,
    target: toVersion ?? change.id,
    changeId: change.id,
  };
}

const digitsOf = (target: string) => (target.match(DIGITS) ?? []).map(Number);

// Only targets that start as a version compare, so model names and other labels never read as older.
export function isOlderTarget(target: string, than: string): boolean {
  if (!VERSION_START.test(target) || !VERSION_START.test(than)) return false;
  const [left, right] = [digitsOf(target), digitsOf(than)];
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0;
  }
  return false;
}

async function markedPullRequests(
  token: string,
  repo: string,
  fetchImpl?: typeof fetch,
): Promise<MarkedPull[]> {
  const pulls = await listRefitPullRequests(token, repo, 'open', fetchImpl);
  return pulls.flatMap((pull) => {
    const marker = parseMarker(pull.body);
    return marker ? [{ pull, marker }] : [];
  });
}

const sameTarget = (a: LifecycleMarker, b: LifecycleMarker) =>
  a.dependency === b.dependency && a.target === b.target;

// A target that fell back to the change id names one change, not a version on a track. Two of those
// are separate work: replacing one with the other would lose it and re-pay for it on the next scan.
const onVersionTrack = (marker: LifecycleMarker) => marker.target !== marker.changeId;

const supersedes = (next: LifecycleMarker, open: LifecycleMarker) =>
  next.dependency === open.dependency &&
  next.kind === open.kind &&
  next.target !== open.target &&
  onVersionTrack(next) &&
  onVersionTrack(open) &&
  !isOlderTarget(next.target, open.target);

const treeEntry = (change: FileChange) =>
  'delete' in change
    ? { path: change.path, mode: FILE_MODE, type: BLOB, sha: null }
    : { path: change.path, mode: FILE_MODE, type: BLOB, content: change.content };

type PullUpdate = {
  token: string;
  pull: PullRequest;
  task: AnyTask;
  record: RunRecord;
  repoDir: string;
  body: string;
  reason: string;
  fetchImpl?: typeof fetch;
};

// Never a force-push: the new commit always descends from the PR's head, and force stays false.
async function updatePullRequest(update: PullUpdate): Promise<void> {
  const { token, pull, task, record, repoDir, body, reason, fetchImpl } = update;
  const branch = pull.head.ref;
  const base = pull.base.ref;
  if (!branch.startsWith(BRANCH_PREFIX)) {
    throw new UnsafeBranchError(branch, `it does not start with ${BRANCH_PREFIX}`);
  }
  if (branch === base) throw new UnsafeBranchError(branch, 'it is the base branch');
  const files = await filesFromDiff(repoDir, record.diff);
  if (files.length === 0) throw new EmptyChangeError(task.repo);

  const request = repoRequest(token, task.repo, fetchImpl);
  const personCommitted = await hasPersonCommits(token, task.repo, pull, fetchImpl);
  const head = pull.head.sha;
  let parents = [head];
  if (!personCommitted) {
    const baseRef = await request<{ object: { sha: string } }>(
      'GET',
      `/git/ref/heads/${encodePath(base)}`,
    );
    parents = [head, baseRef.object.sha];
  }
  // A person's commits keep the head's tree. Otherwise the base tip's tree resolves conflicts and
  // drops what the old attempt changed.
  const treeSource = parents.at(-1);
  const source = await request<{ tree: { sha: string } }>('GET', `/git/commits/${treeSource}`);
  // shortcut: GitHub rejects deleting a path the tree no longer has, and the run fails; drop such
  // entries once a real run hits this.
  const tree = await request<{ sha: string }>('POST', '/git/trees', {
    base_tree: source.tree.sha,
    tree: files.map(treeEntry),
  });
  const title = task.change.title;
  const commit = await request<{ sha: string }>('POST', '/git/commits', {
    message: `chore(${task.change.provider}): ${title}`,
    tree: tree.sha,
    parents,
  });
  await request('PATCH', `/git/refs/heads/${encodePath(branch)}`, {
    sha: commit.sha,
    force: false,
  });
  await request('PATCH', `/pulls/${pull.number}`, { title, body });
  const history = personCommitted
    ? 'A person committed to this branch, so those commits stay. Any file both touched now holds ' +
      "Refit's version, with theirs in the history."
    : `This commit merges the latest ${base} and replaces the earlier attempt's changes.`;
  await postComment(request, pull.number, `${reason}\n\n${history}`);
}

export function createBeforeOpenPullRequest({
  tokens,
  fetchImpl,
}: LifecycleDeps): BeforeOpenPullRequest {
  return async ({ installationId, task, record, repoDir }) => {
    const marker = taskMarker(task);
    const { title, source } = task.change;
    const written: WrittenRecord = record;
    const body = withMarker(written.prBody ?? `${title}\n\nSource: ${source.url}`, marker);
    // Mutates P1's object because its opener reads prBody from this same record. Done before any
    // request since P1 still opens a PR when this hook throws, and that PR needs its marker too.
    written.prBody = body;

    const token = await tokens.token(installationId);
    const pulls = await markedPullRequests(token, task.repo, fetchImpl);
    const update = { token, task, record, repoDir, body, fetchImpl };
    const { dependency, target } = marker;

    const same = pulls.find((open) => sameTarget(open.marker, marker));
    if (same) {
      const reason = `Refit ran ${dependency} ${target} again, so it updated this PR instead of opening a second one.`;
      await updatePullRequest({ ...update, pull: same.pull, reason });
      return { pr: same.pull.html_url };
    }

    // shortcut: the list is newest-updated first and only this PR moves on; any others that qualify
    // stay open until a person closes them or a later run updates them.
    const older = pulls.find((open) => supersedes(marker, open.marker));
    if (older) {
      const reason =
        `Refit moved this PR's ${dependency} target from ${older.marker.target} to ${target}: ` +
        `${target} supersedes ${older.marker.target} for the same kind of change, so one PR tracks both.`;
      await updatePullRequest({ ...update, pull: older.pull, reason });
      return { pr: older.pull.html_url };
    }
    return {};
  };
}

// P1's branch lookup can't see a PR that an earlier task's branch holds, so a scan asks here too.
export function createFindOpenPullRequest({
  tokens,
  fetchImpl,
}: LifecycleDeps): FindOpenPullRequest {
  return async (installationId, task) => {
    const token = await tokens.token(installationId);
    const pulls = await markedPullRequests(token, task.repo, fetchImpl);
    const marker = taskMarker(task);
    const found = pulls.find((open) => sameTarget(open.marker, marker));
    return found && { url: found.pull.html_url, state: 'open' };
  };
}
