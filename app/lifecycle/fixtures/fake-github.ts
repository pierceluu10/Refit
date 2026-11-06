import { readFileSync } from 'node:fs';
import { expect, vi } from 'vitest';
import { GITHUB_API } from '../../github.ts';

export const REPO = 'refit-example-org/billing-api';
export const API = `/repos/${REPO}`;
export const OPEN_PULLS = `GET ${API}/pulls?state=open&sort=updated&direction=desc&per_page=100&page=1`;

export type Call = { method: string; path: string; body: unknown; authorization: string };
export type Reply = { status?: number; body?: unknown };
export type Route = Reply | Reply[] | ((call: Call) => Reply);

const recordedPull = JSON.parse(
  readFileSync(new URL('pull.get.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

type PullOptions = {
  number: number;
  ref?: string;
  sha?: string;
  body?: string | null;
  headRepo?: string;
  mergeable?: boolean | null;
  mergeableState?: string;
};

export const pullUrl = (number: number) => `https://github.com/${REPO}/pull/${number}`;

export function pullFixture(options: PullOptions) {
  const { number, ref = `refit/pull-${number}`, sha = `head-${number}` } = options;
  return {
    ...recordedPull,
    number,
    html_url: pullUrl(number),
    body: options.body ?? null,
    mergeable: options.mergeable === undefined ? true : options.mergeable,
    mergeable_state: options.mergeableState ?? 'clean',
    head: { ref, sha, repo: { full_name: options.headRepo ?? REPO } },
    base: { ref: 'main', sha: 'base-tip' },
  };
}

// Fakes GitHub at the fetch level. A list route replies in order and then repeats its last reply.
export function fakeGitHub(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).slice(GITHUB_API.length);
    const method = init?.method ?? 'GET';
    const headers = init?.headers as Record<string, string>;
    const call: Call = {
      method,
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      authorization: headers.Authorization,
    };
    calls.push(call);
    const route = routes[`${method} ${path}`];
    if (!route) {
      throw new Error(`unrouted ${method} ${path}; calls so far: ${JSON.stringify(calls)}`);
    }
    const reply =
      typeof route === 'function'
        ? route(call)
        : Array.isArray(route)
          ? route.length > 1
            ? route.shift()!
            : route[0]
          : route;
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

export const describeCalls = (calls: Call[]) =>
  calls.map(({ method, path }) => `${method} ${path}`);

export const writesOf = (calls: Call[]) => calls.filter((call) => call.method !== 'GET');

// Refit's hard limit: only ever a fast-forward of the PR's own refit/ branch, and never a close or merge.
export function expectOnlySafeWrites(calls: Call[], allowedBranches: string[] = []) {
  const trace = JSON.stringify(calls, null, 2);
  for (const call of calls) {
    const body = (call.body ?? {}) as { force?: unknown; state?: unknown };
    const line = `${call.method} ${call.path} ${JSON.stringify(call.body)}\nall calls: ${trace}`;
    expect(body.force, line).not.toBe(true);
    expect(body.state, line).not.toBe('closed');
    expect(call.method, line).not.toBe('DELETE');
    expect(call.path, line).not.toMatch(/\/merge(\b|$)/);
    expect(`${call.method} ${call.path}`, line).not.toBe(`POST ${API}/pulls`);
    expect(`${call.method} ${call.path}`, line).not.toBe(`POST ${API}/git/refs`);
    if (call.method !== 'GET' && call.path.includes('/git/refs/')) {
      const branch = call.path.split('/git/refs/heads/')[1];
      expect(allowedBranches, line).toContain(branch);
      expect(branch, line).toMatch(/^refit\//);
    }
  }
}
