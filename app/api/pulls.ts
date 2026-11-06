import { githubRequest } from '../github.ts';
import { BRANCH_PREFIX } from '../types.ts';

const PER_PAGE = 100;
const MAX_PAGES = 10;

// Only the fields Refit reads; GitHub sends many more.
export type PullRequest = {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  draft: boolean;
  merged_at: string | null;
  updated_at: string;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string };
};

// Refit's PRs are the ones from its own branch prefix on the repo itself; a fork can name a branch anything.
// shortcut: reads the 1000 most recently updated PRs; follow Link headers if a repo ever has more.
export async function listRefitPullRequests(
  token: string,
  repo: string,
  state: 'open' | 'all',
  fetchImpl: typeof fetch = fetch,
): Promise<PullRequest[]> {
  const pulls: PullRequest[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await githubRequest<PullRequest[]>(
      token,
      'GET',
      `/repos/${repo}/pulls?state=${state}&sort=updated&direction=desc&per_page=${PER_PAGE}&page=${page}`,
      undefined,
      fetchImpl,
    );
    pulls.push(
      ...batch.filter(
        (pull) => pull.head.ref.startsWith(BRANCH_PREFIX) && pull.head.repo?.full_name === repo,
      ),
    );
    if (batch.length < PER_PAGE) break;
  }
  return pulls;
}
