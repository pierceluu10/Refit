import { readBoundedResponse } from './network.ts';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const API_ROOT = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const MILLISECONDS_PER_SECOND = 1000;
const RATE_LIMIT_STATUSES = new Set([403, 429]);
// GitHub asks for at least a minute after a secondary limit that names no wait, then longer.
const SECONDARY_LIMIT_SECONDS = 60;
const SECONDARY_LIMIT = /secondary rate limit/i;
// Longer waits, such as an exhausted hourly limit, fail at once with the time GitHub asked for.
const MAX_RATE_LIMIT_WAIT_SECONDS = 120;
const MAX_RATE_LIMIT_RETRIES = 2;

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

export class GitHubRateLimitError extends GitHubRequestError {
  override name = 'GitHubRateLimitError';
  constructor(
    status: number,
    method: string,
    path: string,
    readonly waitSeconds: number,
  ) {
    super(status, method, path);
    this.message = `GitHub ${method} ${path.split('?')[0]} is rate limited (HTTP ${status}) for ${waitSeconds} more seconds. Refit waits at most ${MAX_RATE_LIMIT_WAIT_SECONDS} seconds, ${MAX_RATE_LIMIT_RETRIES} times; retry after the limit resets.`;
  }
}

// Seconds GitHub asks for before a retry, following its documented order, or undefined when the
// response is not a rate limit.
async function rateLimitWait(response: Response, retries: number) {
  if (!RATE_LIMIT_STATUSES.has(response.status)) return undefined;
  const retryAfter = response.headers.get('retry-after')?.trim();
  if (retryAfter && /^\d+$/.test(retryAfter)) return Number(retryAfter);
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  if (response.headers.get('x-ratelimit-remaining') === '0' && Number.isSafeInteger(reset))
    return Math.max(0, Math.ceil(reset - Date.now() / MILLISECONDS_PER_SECOND));
  const secondary =
    response.status === 429 ||
    (response.body !== null &&
      SECONDARY_LIMIT.test(await readBoundedResponse(response, MAX_ERROR_BYTES, 'GitHub error')));
  return secondary ? SECONDARY_LIMIT_SECONDS * 2 ** retries : undefined;
}

export async function requestGitHub(
  token: string,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<unknown> {
  for (let retries = 0; ; retries++) {
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
    if (response.ok)
      return JSON.parse(await readBoundedResponse(response, MAX_RESPONSE_BYTES, 'GitHub'));
    // GitHub rejects rate-limited requests before acting on them, so any method may be retried.
    const wait = await rateLimitWait(response, retries);
    await response.body?.cancel();
    if (wait === undefined) throw new GitHubRequestError(response.status, method, path);
    if (wait > MAX_RATE_LIMIT_WAIT_SECONDS || retries === MAX_RATE_LIMIT_RETRIES)
      throw new GitHubRateLimitError(response.status, method, path, wait);
    await new Promise((resolve) => setTimeout(resolve, wait * MILLISECONDS_PER_SECOND));
  }
}
