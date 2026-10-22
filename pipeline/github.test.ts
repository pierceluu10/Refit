import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GitHubRateLimitError, GitHubRequestError, requestGitHub } from './github.ts';

const NOW = Date.parse('2026-10-22T08:00:00.000Z');
const SECONDS = 1000;

// A fake GitHub that answers each request with the next queued response.
function fakeGitHub(...responses: Response[]) {
  const requests: { url: string; method: string; body: unknown }[] = [];
  const fetch = vi.fn(async (url: string, options: RequestInit) => {
    requests.push({ url, method: String(options.method), body: options.body });
    const response = responses.shift();
    if (!response) throw new Error('Unexpected GitHub request.');
    return response;
  });
  vi.stubGlobal('fetch', fetch);
  return { requests, fetch };
}

function limited(
  status: number,
  headers: Record<string, string>,
  message = 'API rate limit exceeded',
) {
  return new Response(JSON.stringify({ message }), { status, headers });
}

const ok = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

// Settles the request while advancing the fake clock one second at a time, and returns when it
// finished, in seconds after the start.
async function settle(request: Promise<unknown>) {
  let outcome: { value?: unknown; error?: unknown } | undefined;
  request.then(
    (value) => (outcome = { value }),
    (error: unknown) => (outcome = { error }),
  );
  while (!outcome) await vi.advanceTimersByTimeAsync(SECONDS);
  return { ...outcome, seconds: Math.round((Date.now() - NOW) / SECONDS) };
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('waits the retry-after seconds of a secondary limit, then repeats the same request', async () => {
  const github = fakeGitHub(
    limited(429, { 'retry-after': '30' }, 'You have exceeded a secondary rate limit.'),
    ok({ id: 7 }),
  );
  const result = await settle(
    requestGitHub('token', 'POST', '/repos/example/application/issues', { title: 'Refit' }),
  );
  expect(result).toMatchObject({ value: { id: 7 } });
  // The clock advances a second at a time, so the retry lands in the second after the wait.
  expect(result.seconds).toBeGreaterThanOrEqual(30);
  expect(result.seconds).toBeLessThanOrEqual(31);
  expect(github.requests).toHaveLength(2);
  expect(github.requests[1]).toEqual(github.requests[0]);
  expect(github.requests[0]).toMatchObject({ method: 'POST', body: '{"title":"Refit"}' });
});

it('waits for x-ratelimit-reset when the primary limit is exhausted', async () => {
  const github = fakeGitHub(
    limited(403, {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(NOW / SECONDS + 45),
    }),
    ok({ full_name: 'example/application' }),
  );
  const result = await settle(requestGitHub('token', 'GET', '/repos/example/application'));
  expect(result).toMatchObject({ value: { full_name: 'example/application' } });
  expect(result.seconds).toBeGreaterThanOrEqual(45);
  expect(result.seconds).toBeLessThanOrEqual(46);
  expect(github.fetch).toHaveBeenCalledTimes(2);
});

it('backs off a minute, then two, on secondary limits that name no wait', async () => {
  const secondary = () =>
    limited(403, {}, 'You have exceeded a secondary rate limit. Please wait a few minutes.');
  const github = fakeGitHub(secondary(), secondary(), ok({ id: 1 }));
  const result = await settle(requestGitHub('token', 'GET', '/repos/example/application'));
  expect(result).toMatchObject({ value: { id: 1 } });
  expect(result.seconds).toBeGreaterThanOrEqual(180);
  expect(result.seconds).toBeLessThanOrEqual(182);
  expect(github.fetch).toHaveBeenCalledTimes(3);
});

it('fails at once when the limit resets later than the longest wait', async () => {
  const github = fakeGitHub(
    limited(403, {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(NOW / SECONDS + 3600),
    }),
  );
  const result = await settle(requestGitHub('token', 'GET', '/repos/example/application?page=2'));
  expect(result.seconds).toBeLessThanOrEqual(1);
  expect(result.error).toBeInstanceOf(GitHubRateLimitError);
  expect(result.error).toBeInstanceOf(GitHubRequestError);
  expect(result.error).toMatchObject({
    status: 403,
    waitSeconds: 3600,
    message:
      'GitHub GET /repos/example/application is rate limited (HTTP 403) for 3600 more seconds. Refit waits at most 120 seconds, 2 times; retry after the limit resets.',
  });
  expect(github.fetch).toHaveBeenCalledTimes(1);
});

it('gives up after two retries while the limit persists', async () => {
  const github = fakeGitHub(
    limited(429, { 'retry-after': '5' }),
    limited(429, { 'retry-after': '5' }),
    limited(429, { 'retry-after': '5' }),
  );
  const result = await settle(requestGitHub('token', 'GET', '/repos/example/application'));
  expect(result.error).toBeInstanceOf(GitHubRateLimitError);
  expect(result.error).toMatchObject({ status: 429, waitSeconds: 5 });
  expect(result.seconds).toBeGreaterThanOrEqual(10);
  expect(result.seconds).toBeLessThanOrEqual(12);
  expect(github.fetch).toHaveBeenCalledTimes(3);
});

it('does not retry forbidden or failed requests that are not rate limits', async () => {
  for (const [response, status] of [
    [limited(403, {}, 'Resource not accessible by integration'), 403],
    [limited(403, { 'x-ratelimit-remaining': '4999' }, 'Must have admin rights'), 403],
    [limited(500, { 'retry-after': '1' }, 'Server error'), 500],
    [limited(404, {}, 'Not Found'), 404],
  ] as const) {
    const github = fakeGitHub(response);
    const result = await settle(requestGitHub('token', 'GET', '/repos/example/application'));
    expect(result.error).toBeInstanceOf(GitHubRequestError);
    expect(result.error).not.toBeInstanceOf(GitHubRateLimitError);
    expect(result.error).toMatchObject({ status });
    expect(github.fetch).toHaveBeenCalledTimes(1);
  }
});
