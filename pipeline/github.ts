import { readBoundedResponse } from './network.ts';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const API_ROOT = 'https://api.github.com';
const API_VERSION = '2026-03-10';

export class GitHubRequestError extends Error {
  override name = 'GitHubRequestError';
  constructor(
    readonly status: number,
    method: string,
    path: string,
  ) {
    super(
      `GitHub ${method} ${path.split('?')[0]} failed with HTTP ${status}. Publication may be partially complete; inspect the remote repository before retrying.`,
    );
  }
}

export async function requestGitHub(
  token: string,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(`${API_ROOT}${path}`, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': API_VERSION,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new GitHubRequestError(response.status, method, path);
  }
  return JSON.parse(await readBoundedResponse(response, MAX_RESPONSE_BYTES, 'GitHub'));
}
