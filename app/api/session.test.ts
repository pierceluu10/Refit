import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAuditStore, setAuditStore } from '../../compliance/audit.ts';
import type { AuditStore } from '../../compliance/audit.ts';
import type { RunView } from '../../shared/types.ts';
import { GITHUB_API, listViewerRepos } from '../github.ts';
import { loadParts } from '../parts.ts';
import type { PartsDeps } from '../parts.ts';
import { createReportStore } from '../reports.ts';
import { createWebhookServer } from '../server.ts';
import type { WebhookServerDeps } from '../server.ts';
import { BRANCH_PREFIX } from '../types.ts';
import type { PullRequest } from './pulls.ts';
import { DATA_PATHS } from './routes.ts';
import { AUTH_PATHS, CALLBACK_PATH, LOGIN_PATH, LOGOUT_PATH, SESSION_PATH } from './session.ts';

const APP_ID = '4242';
const OTHER_APP_ID = 9999;
const SERVICE_TOKEN = 'illustrative-service-token';
const LOGIN = {
  clientId: 'illustrative-client-id',
  clientSecret: 'illustrative-client-secret',
  sessionSecret: 'illustrative-session-secret-of-enough-length',
};
const SIGNATURE_BYTE = 20;
const HOUR_MS = 3_600_000;
const NINE_HOURS_MS = 9 * HOUR_MS;
const CACHE_EXPIRED_MS = 61_000;

const ORG_A = { id: 11, login: 'org-a', repo: 'org-a/api' };
const ORG_B = { id: 22, login: 'org-b', repo: 'org-b/api' };
const ORGS = [ORG_A, ORG_B];

type Person = { code: string; token: string; login: string; orgs: typeof ORGS };
const ALICE: Person = { code: 'code-a', token: 'ghu_alice', login: 'alice', orgs: [ORG_A] };
const BOB: Person = { code: 'code-b', token: 'ghu_bob', login: 'bob', orgs: [ORG_B] };
const PEOPLE = [ALICE, BOB];

const [recordedPull] = JSON.parse(
  readFileSync(new URL('fixtures/pulls.list.json', import.meta.url), 'utf8'),
) as PullRequest[];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const refitPull = (repo: string): PullRequest => ({
  ...recordedPull,
  title: `Refit PR in ${repo}`,
  html_url: `https://github.com/${repo}/pull/1`,
  head: { ...recordedPull.head, ref: `${BRANCH_PREFIX}example`, repo: { full_name: repo } },
});

function fakeGitHub() {
  const calls: string[] = [];
  let exchangeReply: Response | undefined;
  const revoked = new Set<string>();
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    calls.push(target);
    if (target === 'https://github.com/login/oauth/access_token') {
      if (exchangeReply) return exchangeReply;
      const { code } = JSON.parse(String(init?.body)) as { code: string };
      const person = PEOPLE.find((candidate) => candidate.code === code);
      return person
        ? json({ access_token: person.token, token_type: 'bearer' })
        : json({ error: 'bad_verification_code' });
    }
    const path = target.slice(GITHUB_API.length);
    const authorization = (init?.headers as Record<string, string>).Authorization;
    const pulls = /^\/repos\/([^/]+\/[^/]+)\/pulls\?/.exec(path);
    if (pulls) return json([refitPull(pulls[1])]);
    const person = PEOPLE.find(({ token }) => authorization === `Bearer ${token}`);
    if (!person || revoked.has(person.token)) return json({ message: 'Bad credentials' }, 401);
    if (path === '/user') return json({ login: person.login });
    if (path.startsWith('/user/installations?')) {
      const installations = [
        ...person.orgs.map(({ id, login }) => ({
          id,
          app_id: Number(APP_ID),
          account: { login },
          suspended_at: null,
        })),
        { id: 77, app_id: OTHER_APP_ID, account: { login: 'other-app' }, suspended_at: null },
      ];
      return json({ total_count: installations.length, installations });
    }
    const repos = /^\/user\/installations\/(\d+)\/repositories\?/.exec(path);
    const org = repos && person.orgs.find(({ id }) => id === Number(repos[1]));
    if (org) return json({ total_count: 1, repositories: [{ full_name: org.repo }] });
    throw new Error(`unrouted ${target}`);
  }) as typeof fetch;
  return {
    calls,
    fetchImpl,
    revoke: (token: string) => revoked.add(token),
    failExchangeWith: (reply: Response) => {
      exchangeReply = reply;
    },
  };
}

const run = (repo: string) => ({ repo, runId: `run-${repo}` }) as unknown as RunView;

let server: Server | undefined;
let stateDir: string;
let previousAudit: AuditStore | undefined;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'refit-session-'));
  const audit = new MemoryAuditStore();
  for (const { repo } of ORGS) {
    await audit.append({
      at: '2026-11-05T12:00:00Z',
      repo,
      changeId: `change-${repo}`,
      action: 'detected',
      evidence: [`evidence for ${repo}`],
      actor: 'refit',
    });
  }
  previousAudit = setAuditStore(audit);
});

afterEach(async () => {
  setAuditStore(previousAudit);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await new Promise<void>((resolve, reject) =>
    server ? server.close((error) => (error ? reject(error) : resolve())) : resolve(),
  );
  server = undefined;
  await rm(stateDir, { recursive: true, force: true });
});

async function start(login: PartsDeps['login'] = LOGIN) {
  vi.stubEnv('REFIT_SERVICE_TOKEN', SERVICE_TOKEN);
  const github = fakeGitHub();
  const reports = createReportStore(join(stateDir, 'reports'));
  for (const { id, repo } of ORGS) {
    await reports.save(id, {
      repo,
      scannedAt: '2026-11-05T12:00:00Z',
      items: [],
      costUsd: 0.25,
      errors: [],
    });
  }
  const parts = loadParts({
    reports,
    tokens: { token: async (id) => `ghs_installation_${id}` },
    listRuns: async () => [],
    viewerRepos: (token) => listViewerRepos(token, APP_ID, github.fetchImpl),
    login,
    fetchImpl: github.fetchImpl,
  });
  server = createWebhookServer({
    webhookSecret: 'illustrative-webhook-secret',
    listRunViews: async ({ repo }: { repo?: string }) =>
      ORGS.filter((org) => !repo || org.repo === repo).map((org) => run(org.repo)),
    viewerRepos: parts.viewerRepos,
    isServiceToken: parts.isServiceToken,
    routes: parts.routes,
    userToken: parts.userToken,
  } as unknown as WebhookServerDeps);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { headers, redirect: 'manual' });

  const beginLogin = async () => {
    const response = await get(LOGIN_PATH);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    return {
      location,
      state: location.searchParams.get('state') ?? '',
      stateCookie: cookiePair(response, 'refit_login_state'),
      setCookie: response.headers.getSetCookie().join('\n'),
    };
  };

  const signIn = async ({ code }: Person) => {
    const { state, stateCookie } = await beginLogin();
    const query = new URLSearchParams({ code, state });
    const response = await get(`${CALLBACK_PATH}?${query}`, { cookie: stateCookie });
    expect(response.status, await response.clone().text()).toBe(302);
    expect(response.headers.get('location')).toBe('/app');
    return cookiePair(response, 'refit_session');
  };

  return { base, port, get, github, beginLogin, signIn };
}

function cookiePair(response: Response, name: string): string {
  const line = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  if (!line) throw new Error(`no ${name} cookie in ${response.headers.getSetCookie().join('; ')}`);
  return line.split(';')[0];
}

// Flips one byte inside the sealed value, which the GCM tag must reject.
function tamper(pair: string): string {
  const [name, value] = pair.split('=');
  const bytes = Buffer.from(value, 'base64url');
  bytes[SIGNATURE_BYTE] ^= 1;
  return `${name}=${bytes.toString('base64url')}`;
}

describe('cross-org isolation on every data route', () => {
  it('leaves no route unlisted: every /api path in app/ is a data path or an auth path', async () => {
    const appDir = new URL('..', import.meta.url).pathname;
    const files = (await readdir(appDir, { recursive: true })).filter(
      (file) =>
        file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.includes('node_modules'),
    );
    const literals = new Set<string>();
    for (const file of files) {
      const source = await readFile(join(appDir, file), 'utf8');
      for (const match of source.matchAll(/['"`](\/api\/[\w./-]+)/g)) literals.add(match[1]);
    }
    expect(literals.size).toBeGreaterThan(0);
    const known = new Set([...DATA_PATHS, ...AUTH_PATHS]);
    expect([...literals].filter((path) => !known.has(path))).toEqual([]);
  });

  for (const person of PEOPLE) {
    const other = ORGS.find((org) => !person.orgs.includes(org))!;
    for (const path of DATA_PATHS) {
      it(`${person.login} can't read ${other.login} through ${path}`, async () => {
        const { get, signIn } = await start();
        const cookie = await signIn(person);
        for (const query of ['', `?repo=${other.repo}`, `?repo=${other.repo}&limit=100`]) {
          const response = await get(`${path}${query}`, { cookie });
          const text = await response.text();
          expect(response.status, `${path}${query}: ${text}`).toBeLessThan(500);
          expect(text, `${path}${query}`).not.toContain(other.login);
        }
      });
    }
  }

  it('still shows each person their own reports, runs, PRs and audit log', async () => {
    const { get, signIn } = await start();
    const cookie = await signIn(ALICE);
    const read = async (path: string) => {
      const response = await get(path, { cookie });
      const text = await response.text();
      expect(response.status, `${path}: ${text}`).toBe(200);
      return text;
    };
    expect(JSON.parse(await read('/api/repos'))).toEqual([ORG_A.repo]);
    expect(JSON.parse(await read(`/api/report?repo=${ORG_A.repo}`))).toMatchObject({
      repo: ORG_A.repo,
    });
    expect(JSON.parse(await read('/api/runs'))).toMatchObject([{ repo: ORG_A.repo }]);
    expect(JSON.parse(await read('/api/prs'))).toMatchObject([{ repo: ORG_A.repo }]);
    expect(JSON.parse(await read('/api/audit'))).toMatchObject([{ repo: ORG_A.repo }]);
    expect(await read('/api/audit.csv')).toContain(`evidence for ${ORG_A.repo}`);
  });

  it("answers another org's report exactly like one that doesn't exist", async () => {
    const { get, signIn } = await start();
    const cookie = await signIn(ALICE);
    const hidden = await get(`/api/report?repo=${ORG_B.repo}`, { cookie });
    const missing = await get('/api/report?repo=org-a/never-scanned', { cookie });
    expect(hidden.status).toBe(404);
    expect(await hidden.text()).toBe(await missing.text());
  });

  it('refuses every data route without a session, with a forged one, or with a state cookie', async () => {
    const { get, signIn, beginLogin } = await start();
    const session = await signIn(ALICE);
    const { stateCookie } = await beginLogin();
    const stateAsSession = `refit_session=${stateCookie.split('=')[1]}`;
    for (const path of DATA_PATHS) {
      expect((await get(path)).status, `${path} anonymous`).toBe(401);
      expect((await get(path, { cookie: tamper(session) })).status, `${path} forged`).toBe(401);
      expect((await get(path, { cookie: stateAsSession })).status, `${path} state`).toBe(401);
    }
  });

  it('keeps the service token reading every org, for internal calls', async () => {
    const { get } = await start();
    const response = await get('/api/repos', { authorization: `Bearer ${SERVICE_TOKEN}` });
    expect(await response.json()).toEqual([ORG_A.repo, ORG_B.repo]);
  });

  it('applies the session, not the service token, when the dev proxy sends both', async () => {
    const { get, signIn } = await start();
    const cookie = await signIn(ALICE);
    for (const path of DATA_PATHS) {
      const response = await get(path, { cookie, authorization: `Bearer ${SERVICE_TOKEN}` });
      expect(await response.text(), path).not.toContain(ORG_B.login);
    }
  });
});

describe('GitHub login', () => {
  it('redirects to GitHub with a state bound to an httpOnly cookie', async () => {
    const { beginLogin, port } = await start();
    const { location, state, setCookie } = await beginLogin();
    expect(location.origin + location.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(location.searchParams.get('client_id')).toBe(LOGIN.clientId);
    expect(location.searchParams.get('redirect_uri')).toBe(
      `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    );
    expect(state.length).toBeGreaterThan(40);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain('Secure');
    expect(setCookie).not.toContain(state);
  });

  it('marks cookies Secure and the callback https outside localhost', async () => {
    const { port } = await start();
    const headers = await new Promise<Record<string, unknown>>((resolve, reject) => {
      httpRequest(
        { port, host: '127.0.0.1', path: LOGIN_PATH, headers: { Host: 'refit.example.test' } },
        (response) => {
          response.resume();
          resolve(response.headers);
        },
      )
        .on('error', reject)
        .end();
    });
    expect(String(headers['set-cookie'])).toContain('; Secure');
    expect(String(headers.location)).toContain(
      encodeURIComponent(`https://refit.example.test${CALLBACK_PATH}`),
    );
  });

  it('rejects a callback whose state does not match, without calling GitHub', async () => {
    const { get, github, beginLogin } = await start();
    const { stateCookie } = await beginLogin();
    const response = await get(`${CALLBACK_PATH}?code=${ALICE.code}&state=forged`, {
      cookie: stateCookie,
    });
    expect(response.headers.get('location')).toBe('/app?login=failed');
    expect(response.headers.getSetCookie().join()).not.toContain('refit_session=');
    expect(github.calls).toEqual([]);
  });

  it('rejects a callback with no state cookie', async () => {
    const { get, github, beginLogin } = await start();
    const { state } = await beginLogin();
    const response = await get(`${CALLBACK_PATH}?code=${ALICE.code}&state=${state}`);
    expect(response.headers.get('location')).toBe('/app?login=failed');
    expect(github.calls).toEqual([]);
  });

  it('sends a refused code back to the dashboard and logs no secret', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { get, beginLogin } = await start();
    const { state, stateCookie } = await beginLogin();
    const response = await get(`${CALLBACK_PATH}?code=wrong&state=${state}`, {
      cookie: stateCookie,
    });
    expect(response.headers.get('location')).toBe('/app?login=failed');
    expect(response.headers.getSetCookie().join()).not.toContain('refit_session=');
    const logged = errors.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('bad_verification_code');
    expect(logged).not.toContain(LOGIN.clientSecret);
  });

  it("treats GitHub's non-JSON outage page as a failed login", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { get, github, beginLogin } = await start();
    github.failExchangeWith(new Response('<html>down</html>', { status: 503 }));
    const { state, stateCookie } = await beginLogin();
    const response = await get(`${CALLBACK_PATH}?code=${ALICE.code}&state=${state}`, {
      cookie: stateCookie,
    });
    expect(response.headers.get('location')).toBe('/app?login=failed');
  });

  it("never puts the GitHub token in the browser's cookie in the clear", async () => {
    const { signIn } = await start();
    const session = await signIn(ALICE);
    const decoded = Buffer.from(session.split('=')[1], 'base64url').toString('latin1');
    expect(decoded).not.toContain(ALICE.token);
  });

  it('reports who is signed in and which orgs they have', async () => {
    const { get, signIn } = await start();
    const cookie = await signIn(ALICE);
    expect(await (await get(SESSION_PATH, { cookie })).json()).toEqual({
      signedIn: true,
      login: ALICE.login,
      orgs: [ORG_A.login],
    });
    expect(await (await get(SESSION_PATH)).json()).toEqual({ signedIn: false, canSignIn: true });
  });

  it('logs out with POST only and clears the cookie', async () => {
    const { base, get, signIn } = await start();
    const cookie = await signIn(ALICE);
    const refused = await get(LOGOUT_PATH, { cookie });
    expect(refused.status).toBe(405);
    expect(refused.headers.get('allow')).toBe('POST');
    const response = await fetch(`${base}${LOGOUT_PATH}`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(response.status).toBe(204);
    expect(response.headers.getSetCookie().join()).toMatch(/refit_session=;.*Max-Age=0/);
  });

  it('ends the session once the cookie expires', async () => {
    const signedInAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(signedInAt);
    const { get, signIn } = await start();
    const cookie = await signIn(ALICE);
    expect((await get('/api/repos', { cookie })).status).toBe(200);
    clock.mockReturnValue(signedInAt + NINE_HOURS_MS);
    expect((await get('/api/repos', { cookie })).status).toBe(401);
  });

  it('asks GitHub once per page load and notices a revoked token after the cache', async () => {
    const signedInAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(signedInAt);
    const { get, github, signIn } = await start();
    const cookie = await signIn(ALICE);
    await Promise.all(DATA_PATHS.map((path) => get(path, { cookie })));
    const lookups = () => github.calls.filter((url) => url.includes('/user/installations?')).length;
    expect(lookups()).toBe(1);
    github.revoke(ALICE.token);
    clock.mockReturnValue(signedInAt + CACHE_EXPIRED_MS);
    expect((await get('/api/repos', { cookie })).status).toBe(401);
  });

  it('answers 503 and stays usable when login is not configured', async () => {
    const { get } = await start(null as unknown as PartsDeps['login']);
    expect((await get(LOGIN_PATH)).status).toBe(503);
    expect(await (await get(SESSION_PATH)).json()).toEqual({ signedIn: false, canSignIn: false });
    const repos = await get('/api/repos', { authorization: `Bearer ${SERVICE_TOKEN}` });
    expect(repos.status).toBe(200);
  });
});
