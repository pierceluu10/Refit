import { setTimeout as delay } from 'node:timers/promises';
import type { MigrationTask } from '../../shared/types.ts';
import type { StoredRun } from '../../memory/types.ts';
import { listRefitPullRequests } from '../api/pulls.ts';
import type { PullRequest } from '../api/pulls.ts';
import type { InstallationTokens } from '../types.ts';
import { hasPersonCommits, postComment, repoRequest } from './pulls.ts';
import type { RepoRequest } from './pulls.ts';

// GitHub computes mergeability lazily, so a first read can come back null while it works.
const MERGEABLE_ATTEMPTS = 3;
const MERGEABLE_RETRY_MS = 2000;
const CONFLICTED_STATE = 'dirty';
const COMMENTS_PER_PAGE = 100;

export type ConflictDeps = {
  installationId: number;
  tokens: InstallationTokens;
  findTask: (pr: string) => Promise<MigrationTask | undefined>;
  rerun: (task: MigrationTask) => Promise<void>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<unknown>;
};

export type ConflictResult = { rerun: number[]; blocked: number[]; unknown: number[] };

type PullState = PullRequest & { mergeable: boolean | null; mergeable_state: string };

const isConflicted = (pull: PullState) =>
  pull.mergeable === false || pull.mergeable_state === CONFLICTED_STATE;

async function readPull(
  request: RepoRequest,
  number: number,
  sleep: (ms: number) => Promise<unknown>,
): Promise<PullState> {
  for (let attempt = 1; ; attempt++) {
    const pull = await request<PullState>('GET', `/pulls/${number}`);
    if (pull.mergeable !== null || isConflicted(pull) || attempt === MERGEABLE_ATTEMPTS) {
      return pull;
    }
    await sleep(MERGEABLE_RETRY_MS);
  }
}

// One comment per head sha also stops a second push from paying for a re-run that's already queued.
// shortcut: reads the first 100 comments, and a re-run that fails keeps this sha's marker so that sha
// isn't retried; page through comments and clear the marker if either shows up in practice.
async function conflictNoted(request: RepoRequest, pull: PullState, marker: string) {
  const comments = await request<{ body: string }[]>(
    'GET',
    `/issues/${pull.number}/comments?per_page=${COMMENTS_PER_PAGE}`,
  );
  return comments.some((comment) => comment.body.includes(marker));
}

export async function refreshConflicts(repo: string, deps: ConflictDeps): Promise<ConflictResult> {
  const { installationId, tokens, findTask, rerun, fetchImpl, sleep = delay } = deps;
  const token = await tokens.token(installationId);
  const request = repoRequest(token, repo, fetchImpl);
  const result: ConflictResult = { rerun: [], blocked: [], unknown: [] };

  for (const { number } of await listRefitPullRequests(token, repo, 'open', fetchImpl)) {
    const pull = await readPull(request, number, sleep);
    if (!isConflicted(pull)) {
      if (pull.mergeable === null) result.unknown.push(number);
      continue;
    }
    const marker = `<!-- refit:conflict ${pull.head.sha} -->`;
    const noted = await conflictNoted(request, pull, marker);
    const note = async (text: string) => {
      if (!noted) await postComment(request, number, `${text}\n\n${marker}`);
    };
    const base = pull.base.ref;

    if (await hasPersonCommits(token, repo, pull, fetchImpl)) {
      await note(
        `This PR conflicts with ${base}. A person committed to it and Refit won't overwrite those commits, so it needs resolving by hand.`,
      );
      result.blocked.push(number);
      continue;
    }
    const task = await findTask(pull.html_url);
    if (!task) {
      await note(
        `This PR conflicts with ${base}. Refit has no stored run for it, so it can't re-run the change; it needs resolving by hand.`,
      );
      result.blocked.push(number);
      continue;
    }
    if (noted) continue;
    await note(`This PR conflicts with ${base}. Refit is re-running it on a fresh checkout.`);
    await rerun(task);
    result.rerun.push(number);
  }
  return result;
}

// Typed as MigrationTask to match memory's StoredRun; at runtime it may be an ExternalTask.
export const findTaskForPr =
  (listRuns: () => Promise<StoredRun[]>) =>
  async (pr: string): Promise<MigrationTask | undefined> => {
    let latest: StoredRun | undefined;
    for (const run of await listRuns()) {
      if (run.record.pr !== pr) continue;
      if (!latest || run.recordedAt > latest.recordedAt) latest = run;
    }
    return latest?.task;
  };
