import type { PullRequest } from '../api/pulls.ts';
import { compareCommits, githubRequest } from '../github.ts';

const BOT = 'Bot';

export type RepoRequest = <T>(method: string, path: string, body?: unknown) => Promise<T>;

export const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

export const repoRequest =
  (token: string, repo: string, fetchImpl?: typeof fetch): RepoRequest =>
  (method, path, body) =>
    githubRequest(token, method, `/repos/${encodePath(repo)}${path}`, body, fetchImpl);

export const postComment = (request: RepoRequest, pull: number, body: string) =>
  request('POST', `/issues/${pull}/comments`, { body });

// Same rule as pushedByPerson in app/webhooks.ts: merges (the Update branch button, Refit's own
// update commits) and bots don't count, and an author GitHub can't link to an account does.
export async function hasPersonCommits(
  token: string,
  repo: string,
  pull: Pick<PullRequest, 'base' | 'head'>,
  fetchImpl?: typeof fetch,
): Promise<boolean> {
  const commits = await compareCommits(token, repo, pull.base.ref, pull.head.sha, fetchImpl);
  return commits.some((commit) => commit.parents.length < 2 && commit.author?.type !== BOT);
}
