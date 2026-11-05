import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  GITHUB_API,
  GitHubApiError,
  createAppJwt,
  createInstallationTokens,
  githubRequest,
  headTree,
  listInstallationIds,
  listInstallationRepos,
  listViewerRepos,
} from './github.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const APP_ID = '12345';
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const MINUTE = 60_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

const headersOf = (fetchImpl: ReturnType<typeof vi.fn>, call = 0) =>
  (fetchImpl.mock.calls[call][1] as RequestInit).headers as Record<string, string>;

describe('createAppJwt', () => {
  it('signs RS256 with iss and a clock-drift-tolerant window', () => {
    const jwt = createAppJwt(APP_ID, privateKey, NOW);
    const [header, payload, signature] = jwt.split('.');
    expect(decode(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = decode(payload);
    expect(claims).toEqual({
      iss: APP_ID,
      iat: (NOW - MINUTE) / 1000,
      exp: (NOW + 9 * MINUTE) / 1000,
    });
    expect(claims.exp * 1000 - NOW).toBeLessThanOrEqual(10 * MINUTE);
    const valid = verify(
      'RSA-SHA256',
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, 'base64url'),
    );
    expect(valid, `signature of ${jwt} did not verify`).toBe(true);
  });
});

describe('githubRequest', () => {
  it('sends GitHub headers and a JSON body', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: 1 }));
    const result = await githubRequest('tok', 'POST', '/x', { a: 1 }, fetchImpl);
    expect(result).toEqual({ ok: 1 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${GITHUB_API}/x`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect(init.headers).toEqual({
      Authorization: 'Bearer tok',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'aptitude-app',
      'Content-Type': 'application/json',
    });
  });

  it('omits Content-Type and body without a body and returns undefined for 204', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    expect(await githubRequest('tok', 'DELETE', '/x', undefined, fetchImpl)).toBeUndefined();
    expect(headersOf(fetchImpl)).not.toHaveProperty('Content-Type');
    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body).toBeUndefined();
  });

  it('throws GitHubApiError with GitHub message and no token', async () => {
    const secret = 'ghs_supersecret';
    const fetchImpl = vi.fn(async () => json({ message: 'Not Found' }, 404));
    const error = await githubRequest(secret, 'GET', '/repos/a/b', undefined, fetchImpl).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(GitHubApiError);
    const apiError = error as GitHubApiError;
    expect(apiError).toMatchObject({ status: 404, method: 'GET', path: '/repos/a/b' });
    expect(apiError.message).toBe('GitHub GET /repos/a/b failed with 404: Not Found');
    expect(apiError.message).not.toContain(secret);
    expect(JSON.stringify(apiError)).not.toContain(secret);
  });

  it('throws GitHubApiError when the error body is not JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(githubRequest('tok', 'GET', '/x', undefined, fetchImpl)).rejects.toThrow(
      'GitHub GET /x failed with 502',
    );
  });
});

describe('createInstallationTokens', () => {
  const tokenResponse = (token: string, expiresAt: number) =>
    json({ token, expires_at: new Date(expiresAt).toISOString() }, 201);

  it('requests a token with the app JWT and caches it until 5 minutes before expiry', async () => {
    let clock = NOW;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse('first', NOW + 60 * MINUTE))
      .mockResolvedValueOnce(tokenResponse('second', NOW + 120 * MINUTE));
    const tokens = createInstallationTokens(APP_ID, privateKey, fetchImpl, () => clock);

    expect(await tokens.token(7)).toBe('first');
    expect(await tokens.token(7)).toBe('first');
    expect(fetchImpl, 'second call should hit the cache').toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${GITHUB_API}/app/installations/7/access_tokens`);
    expect(init.method).toBe('POST');
    const authorization = (init.headers as Record<string, string>).Authorization;
    expect(authorization).toMatch(/^Bearer /);
    const jwt = authorization.slice('Bearer '.length);
    expect(decode(jwt.split('.')[1]).iss).toBe(APP_ID);

    clock = NOW + 54 * MINUTE;
    expect(await tokens.token(7), '6 minutes before expiry still cached').toBe('first');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    clock = NOW + 55 * MINUTE;
    expect(await tokens.token(7), '5 minutes before expiry refetches').toBe('second');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const refreshJwt = headersOf(fetchImpl, 1).Authorization.slice('Bearer '.length);
    expect(decode(refreshJwt.split('.')[1]).iat).toBe((clock - MINUTE) / 1000);
  });

  it('caches per installation', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse('one', NOW + 60 * MINUTE))
      .mockResolvedValueOnce(tokenResponse('two', NOW + 60 * MINUTE));
    const tokens = createInstallationTokens(APP_ID, privateKey, fetchImpl, () => NOW);
    expect(await tokens.token(1)).toBe('one');
    expect(await tokens.token(2)).toBe('two');
    expect(await tokens.token(1)).toBe('one');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('listInstallationRepos', () => {
  it('paginates until total_count is collected', async () => {
    const names = Array.from({ length: 150 }, (_, index) => `org/repo-${index}`);
    const page = (from: number, to: number) =>
      json({
        total_count: names.length,
        repositories: names.slice(from, to).map((full_name) => ({ full_name })),
      });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(page(0, 100))
      .mockResolvedValueOnce(page(100, 150));

    expect(await listInstallationRepos('tok', fetchImpl)).toEqual(names);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      `${GITHUB_API}/installation/repositories?per_page=100&page=1`,
      `${GITHUB_API}/installation/repositories?per_page=100&page=2`,
    ]);
    expect(headersOf(fetchImpl).Authorization).toBe('Bearer tok');
  });

  it('stops on an empty page even if total_count claims more', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ total_count: 5, repositories: [{ full_name: 'a/b' }] }))
      .mockResolvedValueOnce(json({ total_count: 5, repositories: [] }));
    expect(await listInstallationRepos('tok', fetchImpl)).toEqual(['a/b']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('listViewerRepos', () => {
  it("lists repos only from this App's installations the user can reach", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const path = url.slice(GITHUB_API.length);
      if (path.startsWith('/user/installations?')) {
        return json({
          total_count: 2,
          installations: [
            { id: 1, app_id: Number(APP_ID) },
            { id: 2, app_id: 99999 },
          ],
        });
      }
      if (path.startsWith('/user/installations/1/repositories?')) {
        return json({ total_count: 1, repositories: [{ full_name: 'org/mine' }] });
      }
      throw new Error(`unexpected ${path}`);
    });
    expect(await listViewerRepos('ghu_user', APP_ID, fetchImpl as typeof fetch)).toEqual([
      'org/mine',
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('headTree', () => {
  const TOKEN = 'ghs_test';

  it('reads the tree of the branch as it is now, with one call', async () => {
    const fetchImpl = vi.fn(async () => json({ sha: 'commit', commit: { tree: { sha: 'tree' } } }));
    expect(await headTree(TOKEN, 'org/repo', fetchImpl as unknown as typeof fetch)).toBe('tree');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe(
      `${GITHUB_API}/repos/org/repo/commits/HEAD`,
    );
  });

  it('answers undefined for a repo with no commits', async () => {
    const fetchImpl = vi.fn(async () => json({ message: 'Git Repository is empty.' }, 409));
    expect(
      await headTree(TOKEN, 'org/empty', fetchImpl as unknown as typeof fetch),
    ).toBeUndefined();
  });

  it.each([403, 404, 500])(
    'throws on %i, so a failed read can never pass as a tree',
    async (status) => {
      const fetchImpl = vi.fn(async () => json({ message: 'nope' }, status));
      await expect(
        headTree(TOKEN, 'org/repo', fetchImpl as unknown as typeof fetch),
      ).rejects.toBeInstanceOf(GitHubApiError);
    },
  );
});

describe('listInstallationIds', () => {
  it('pages through every installation and leaves out the suspended ones', async () => {
    const full: { id: number; suspended_at: string | null }[] = Array.from(
      { length: 100 },
      (_, index) => ({ id: index, suspended_at: null }),
    );
    full[1] = { id: 1, suspended_at: '2026-11-01T00:00:00Z' };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(full))
      .mockResolvedValueOnce(json([{ id: 500, suspended_at: null }]));
    const ids = await listInstallationIds(APP_ID, privateKey, fetchImpl, () => NOW);
    expect(ids).toHaveLength(100);
    expect(ids).not.toContain(1);
    expect(ids).toContain(500);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0]).toBe(`${GITHUB_API}/app/installations?per_page=100&page=2`);
    expect(headersOf(fetchImpl).Authorization).toMatch(/^Bearer .+\..+\..+$/);
  });
});
