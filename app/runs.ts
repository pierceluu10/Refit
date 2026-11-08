import type { RunView } from '../shared/types.ts';
import { GitHubApiError } from './github.ts';
import { REPO_PATTERN } from './types.ts';
import type { ListRunViews } from './types.ts';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
const BEARER = /^Bearer (\S+)$/;
const GITHUB_UNAUTHORIZED = 401;
// shortcut: reads the wording of records from before #509, which stored a task the cap stopped as failed; delete once those records are gone.
const STOPPED_BY_CAP = /^not attempted: .*run cap left/;

export type RunsDeps = {
  listRunViews: ListRunViews;
  // The dashboard's own token, read on the server only: it reads every run.
  isServiceToken: (authorization: string | undefined) => boolean;
  // The repos a GitHub user-to-server token can reach through this App's installations.
  viewerRepos: (userToken: string) => Promise<string[]>;
};

export type RunsResult =
  { status: 200; runs: RunView[] } | { status: 400; error: string } | { status: 401 };

export function parseRunsQuery(
  query: URLSearchParams,
): { repo?: string; limit: number } | { error: string } {
  const repo = query.get('repo') || undefined;
  if (repo !== undefined && !REPO_PATTERN.test(repo)) return { error: 'repo must be owner/name' };
  const rawLimit = query.get('limit');
  const limit = rawLimit === null || rawLimit === '' ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return { error: `limit must be a whole number from 1 to ${MAX_LIMIT}` };
  }
  return { repo, limit };
}

function withTrueOutcome(run: RunView): RunView {
  const neverStarted = run.outcome === 'failed' && STOPPED_BY_CAP.test(run.summary);
  return neverStarted ? { ...run, outcome: 'waiting-budget' } : run;
}

// The service token sees every run. Any other viewer sees runs only for repos their own GitHub token
// reaches through this App, filtered before the limit.
export async function runsFor(
  query: URLSearchParams,
  authorization: string | undefined,
  deps: RunsDeps,
): Promise<RunsResult> {
  const token = BEARER.exec(authorization ?? '')?.[1];
  if (!token) return { status: 401 };
  const parsed = parseRunsQuery(query);
  if ('error' in parsed) return { status: 400, error: parsed.error };
  const list = async (filter: Parameters<ListRunViews>[0]) =>
    (await deps.listRunViews(filter)).map(withTrueOutcome);
  if (deps.isServiceToken(authorization)) {
    return { status: 200, runs: await list(parsed) };
  }
  let allowed: Set<string>;
  try {
    allowed = new Set(await deps.viewerRepos(token));
  } catch (error) {
    // An expired, revoked or foreign token reads as signed out.
    if (error instanceof GitHubApiError && error.status === GITHUB_UNAUTHORIZED)
      return { status: 401 };
    throw error;
  }
  if (parsed.repo !== undefined) {
    if (!allowed.has(parsed.repo)) return { status: 200, runs: [] };
    return { status: 200, runs: await list(parsed) };
  }
  // shortcut: reads every installation's runs then filters; pass the repo set to memory once it takes one.
  const runs = (await list({})).filter((run) => allowed.has(run.repo));
  return { status: 200, runs: runs.slice(0, parsed.limit) };
}
