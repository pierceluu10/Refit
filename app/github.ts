import { createSign } from 'node:crypto';
import type { InstallationTokens } from './types.ts';

export const GITHUB_API = 'https://api.github.com';

const API_VERSION = '2022-11-28';
const USER_AGENT = 'aptitude-app';
const JSON_TYPE = 'application/json';
const NO_CONTENT = 204;
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
// GitHub rejects app JWTs issued in the future or expiring more than 10 minutes out.
const JWT_BACKDATE_MS = MINUTE_MS;
const JWT_LIFETIME_MS = 9 * MINUTE_MS;
const TOKEN_REFRESH_MARGIN_MS = 5 * MINUTE_MS;
const REPOS_PER_PAGE = 100;

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

type RepositoryPage = { total_count: number; repositories: { full_name: string }[] };

export async function listInstallationRepos(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const names: string[] = [];
  for (let page = 1; ; page++) {
    const result = await githubRequest<RepositoryPage>(
      token,
      'GET',
      `/installation/repositories?per_page=${REPOS_PER_PAGE}&page=${page}`,
      undefined,
      fetchImpl,
    );
    names.push(...result.repositories.map((repo) => repo.full_name));
    if (result.repositories.length === 0 || names.length >= result.total_count) return names;
  }
}
