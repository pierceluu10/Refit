import { createSign } from 'node:crypto';
import type { InstallationTokens } from './types.ts';

export const GITHUB_API = 'https://api.github.com';

const API_VERSION = '2022-11-28';
const USER_AGENT = 'aptitude-app';
const JSON_TYPE = 'application/json';
const NO_CONTENT = 204;
// GitHub's answer for a repo with no commits yet, or one it's still creating.
const NO_COMMITS = 409;
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
// GitHub rejects app JWTs issued in the future or expiring more than 10 minutes out.
const JWT_BACKDATE_MS = MINUTE_MS;
const JWT_LIFETIME_MS = 9 * MINUTE_MS;
const TOKEN_REFRESH_MARGIN_MS = 5 * MINUTE_MS;
const PER_PAGE = 100;

export class GitHubApiError extends Error {
  status: number;
  method: string;
  path: string;

  constructor(method: string, path: string, status: number, detail?: string) {
    super(`GitHub ${method} ${path} failed with ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'GitHubApiError';
    this.status = status;
    this.method = method;
    this.path = path;
  }
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

export function createAppJwt(appId: string, privateKey: string, now = Date.now()): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iat: Math.floor((now - JWT_BACKDATE_MS) / SECOND_MS),
      exp: Math.floor((now + JWT_LIFETIME_MS) / SECOND_MS),
      iss: appId,
    }),
  );
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

async function errorDetail(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { message?: unknown };
    return typeof body.message === 'string' ? body.message : undefined;
  } catch {
    return undefined; // non-JSON error body
  }
}

export async function githubRequest<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': USER_AGENT,
  };
  if (body !== undefined) headers['Content-Type'] = JSON_TYPE;
  const response = await fetchImpl(`${GITHUB_API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new GitHubApiError(method, path, response.status, await errorDetail(response));
  }
  if (response.status === NO_CONTENT) return undefined as T;
  return (await response.json()) as T;
}

type AccessToken = { token: string; expires_at: string };

export function createInstallationTokens(
  appId: string,
  privateKey: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): InstallationTokens {
  const cache = new Map<number, { token: string; expiresAt: number }>();
  return {
    async token(installationId) {
      const cached = cache.get(installationId);
      if (cached && now() < cached.expiresAt - TOKEN_REFRESH_MARGIN_MS) return cached.token;
      const created = await githubRequest<AccessToken>(
        createAppJwt(appId, privateKey, now()),
        'POST',
        `/app/installations/${installationId}/access_tokens`,
        undefined,
        fetchImpl,
      );
      cache.set(installationId, {
        token: created.token,
        expiresAt: Date.parse(created.expires_at),
      });
      return created.token;
    },
  };
}

type Page = { total_count: number } & Record<string, unknown>;

async function listAll<T>(
  token: string,
  path: string,
  key: string,
  fetchImpl: typeof fetch,
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page++) {
    const result = await githubRequest<Page>(
      token,
      'GET',
      `${path}?per_page=${PER_PAGE}&page=${page}`,
      undefined,
      fetchImpl,
    );
    const batch = result[key] as T[];
    items.push(...batch);
    if (batch.length === 0 || items.length >= result.total_count) return items;
  }
}

type Repository = { full_name: string };

export async function listInstallationRepos(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const repos = await listAll<Repository>(
    token,
    '/installation/repositories',
    'repositories',
    fetchImpl,
  );
  return repos.map((repo) => repo.full_name);
}

/** Every installation of this App that can still be read. A suspended one refuses tokens. */
export async function listInstallationIds(
  appId: string,
  privateKey: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<number[]> {
  const ids: number[] = [];
  for (let page = 1; ; page++) {
    const batch = await githubRequest<{ id: number; suspended_at: string | null }[]>(
      createAppJwt(appId, privateKey, now()),
      'GET',
      `/app/installations?per_page=${PER_PAGE}&page=${page}`,
      undefined,
      fetchImpl,
    );
    ids.push(...batch.filter((item) => !item.suspended_at).map((item) => item.id));
    if (batch.length < PER_PAGE) return ids;
  }
}

/**
 * The tree of the default branch's newest commit: one call and no clone. Always the branch as it is
 * now, never a push's own commit, so a late webhook can't make an old tree look current. Undefined
 * when there are no commits. `HEAD` isn't one of the ref forms GitHub documents, but it resolves.
 */
export async function headTree(
  token: string,
  repo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  try {
    const head = await githubRequest<{ commit: { tree: { sha: string } } }>(
      token,
      'GET',
      `/repos/${repo}/commits/HEAD`,
      undefined,
      fetchImpl,
    );
    return head.commit.tree.sha;
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === NO_COMMITS) return undefined;
    throw error;
  }
}

// Every repo the signed-in user can reach through this App's installations. Needs a user-to-server
// token; installations of other apps are dropped in case the token came from somewhere else.
export async function listViewerRepos(
  userToken: string,
  appId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const installations = await listAll<{ id: number; app_id: number }>(
    userToken,
    '/user/installations',
    'installations',
    fetchImpl,
  );
  const repos: string[] = [];
  for (const installation of installations.filter((item) => String(item.app_id) === appId)) {
    const page = await listAll<Repository>(
      userToken,
      `/user/installations/${installation.id}/repositories`,
      'repositories',
      fetchImpl,
    );
    repos.push(...page.map((repo) => repo.full_name));
  }
  return repos;
}

export const BOT = 'Bot';

export type ComparedCommit = { parents: unknown[]; author: { type: string } | null };

// memory/README.md: a person's own commit is a non-merge commit not authored by a bot, which leaves
// out Aptitude's commits, other bots' and the Update branch button's merge.
export const isPersonCommit = (commit: ComparedCommit) =>
  commit.parents.length < 2 && commit.author?.type !== BOT;

const comparePath = (repo: string, base: string, head: string) =>
  `/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;

// The commits reachable from head but not base. shortcut: GitHub returns at most 250.
export async function compareCommits(
  token: string,
  repo: string,
  base: string,
  head: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ComparedCommit[]> {
  const result = await githubRequest<{ commits: ComparedCommit[] }>(
    token,
    'GET',
    comparePath(repo, base, head),
    undefined,
    fetchImpl,
  );
  return result.commits;
}

// For endpoints that answer with a bare array, a page at a time.
async function listEvery<T>(token: string, path: string, fetchImpl: typeof fetch): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page++) {
    const batch = await githubRequest<T[]>(
      token,
      'GET',
      `${path}?per_page=${PER_PAGE}&page=${page}`,
      undefined,
      fetchImpl,
    );
    items.push(...batch);
    if (batch.length < PER_PAGE) return items;
  }
}

// `patch` is missing for binary and very large files; `sha` is the file's blob after the change.
export type ChangedFile = { filename: string; status: string; sha: string; patch?: string };

export const listPullCommits = (
  token: string,
  repo: string,
  number: number,
  fetchImpl: typeof fetch = fetch,
) => listEvery<ComparedCommit>(token, `/repos/${repo}/pulls/${number}/commits`, fetchImpl);

// What the PR changes against its base. GitHub measures from the merge base, so what main gained
// meanwhile, through Update branch or not, doesn't show here.
export const listPullFiles = (
  token: string,
  repo: string,
  number: number,
  fetchImpl: typeof fetch = fetch,
) => listEvery<ChangedFile>(token, `/repos/${repo}/pulls/${number}/files`, fetchImpl);

export async function commitFiles(
  token: string,
  repo: string,
  sha: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ChangedFile[]> {
  const commit = await githubRequest<{ files: ChangedFile[] }>(
    token,
    'GET',
    `/repos/${repo}/commits/${encodeURIComponent(sha)}`,
    undefined,
    fetchImpl,
  );
  return commit.files;
}

export type FileComparison = { status: string; files: ChangedFile[] };

// GitHub's only form is BASE...HEAD, which diffs from their merge base; BASE..HEAD answers 404. So this
// is a diff of the two trees only while status is `ahead` or `identical`: base is head's ancestor.
// shortcut: GitHub lists at most 300 files here.
export async function compareFiles(
  token: string,
  repo: string,
  base: string,
  head: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FileComparison> {
  const { status, files } = await githubRequest<FileComparison>(
    token,
    'GET',
    comparePath(repo, base, head),
    undefined,
    fetchImpl,
  );
  return { status, files };
}

export type PullComment = {
  user: { login: string; type: string } | null;
  body: string | null;
  at: string;
};

type Commented = Omit<PullComment, 'at'> & { created_at: string };
type Reviewed = Omit<PullComment, 'at'> & { submitted_at?: string };

// Everything people said on a PR: its conversation, review summaries and comments on lines.
export async function listPullComments(
  token: string,
  repo: string,
  number: number,
  fetchImpl: typeof fetch = fetch,
): Promise<PullComment[]> {
  const [conversation, reviews, onLines] = await Promise.all([
    listEvery<Commented>(token, `/repos/${repo}/issues/${number}/comments`, fetchImpl),
    listEvery<Reviewed>(token, `/repos/${repo}/pulls/${number}/reviews`, fetchImpl),
    listEvery<Commented>(token, `/repos/${repo}/pulls/${number}/comments`, fetchImpl),
  ]);
  const said = ({ user, body, created_at }: Commented) => ({ user, body, at: created_at });
  return [
    ...conversation.map(said),
    ...onLines.map(said),
    // A review still pending has no submitted_at.
    ...reviews.flatMap(({ user, body, submitted_at }) =>
      submitted_at ? [{ user, body, at: submitted_at }] : [],
    ),
  ];
}
