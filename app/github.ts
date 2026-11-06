import { createSign } from 'node:crypto';
import { InvalidRepoError } from './git.ts';
import { REPO_PATTERN } from './types.ts';
import type { InstallationTokens } from './types.ts';

export const GITHUB_API = 'https://api.github.com';

const API_VERSION = '2022-11-28';
const USER_AGENT = 'refit-app';
const JSON_TYPE = 'application/json';
const JSON_ACCEPT = 'application/vnd.github+json';
const DIFF_ACCEPT = 'application/vnd.github.v3.diff';
const NO_CONTENT = 204;
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

async function githubResponse(
  token: string,
  method: string,
  path: string,
  body: unknown,
  fetchImpl: typeof fetch,
  accept: string = JSON_ACCEPT,
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: accept,
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
  return response;
}

export async function githubRequest<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const response = await githubResponse(token, method, path, body, fetchImpl);
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

// /app/installations answers a bare array, so its last page is the first short one.
export async function listInstallations(
  appJwt: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: number; suspended: boolean }[]> {
  const installations: { id: number; suspended: boolean }[] = [];
  for (let page = 1; ; page++) {
    const batch = await githubRequest<{ id: number; suspended_at: string | null }[]>(
      appJwt,
      'GET',
      `/app/installations?per_page=${PER_PAGE}&page=${page}`,
      undefined,
      fetchImpl,
    );
    installations.push(
      ...batch.map(({ id, suspended_at }) => ({ id, suspended: Boolean(suspended_at) })),
    );
    if (batch.length < PER_PAGE) return installations;
  }
}

export async function installationForRepo(
  appJwt: string,
  repo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  if (!REPO_PATTERN.test(repo)) throw new InvalidRepoError(repo);
  const installation = await githubRequest<{ id: number }>(
    appJwt,
    'GET',
    `/repos/${repo}/installation`,
    undefined,
    fetchImpl,
  );
  return installation.id;
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

export type ComparedCommit = { parents: unknown[]; author: { type: string } | null };

// The commits reachable from head but not base. shortcut: GitHub returns at most 250.
export async function compareCommits(
  token: string,
  repo: string,
  base: string,
  head: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ComparedCommit[]> {
  const path = `/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
  const result = await githubRequest<{ commits: ComparedCommit[] }>(
    token,
    'GET',
    path,
    undefined,
    fetchImpl,
  );
  return result.commits;
}

export async function pullDiff(
  token: string,
  repo: string,
  number: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const path = `/repos/${repo}/pulls/${number}`;
  const response = await githubResponse(token, 'GET', path, undefined, fetchImpl, DIFF_ACCEPT);
  return response.text();
}
