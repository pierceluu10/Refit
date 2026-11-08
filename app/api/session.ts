import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { redactSecrets } from '../../harness/secrets.ts';
import type { LoginConfig } from '../config.ts';
import { GitHubApiError, githubRequest, USER_AGENT } from '../github.ts';
import { sameSecret } from './auth.ts';
import type { SessionRepos } from './auth.ts';
import { sendJson } from './routes.ts';

export const LOGIN_PATH = '/api/auth/login';
export const CALLBACK_PATH = '/api/auth/callback';
export const LOGOUT_PATH = '/api/auth/logout';
export const SESSION_PATH = '/api/session';
export const AUTH_PATHS = [LOGIN_PATH, CALLBACK_PATH, LOGOUT_PATH, SESSION_PATH];

const LOCAL_ORIGIN = 'http://localhost';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const EXCHANGE_URL = 'https://github.com/login/oauth/access_token';
const DASHBOARD_PATH = '/app';
const LOGIN_FAILED_PATH = '/app?login=failed';

const SESSION_COOKIE = 'refit_session';
const STATE_COOKIE = 'refit_login_state';
const SESSION_PURPOSE = 'session';
const STATE_PURPOSE = 'state';
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
// GitHub expires a user token after 8 hours, so a longer cookie would only hold a dead token.
const SESSION_TTL_MS = 8 * HOUR_MS;
const STATE_TTL_MS = 10 * MINUTE_MS;
// Long enough that one dashboard page, which makes several calls at once, asks GitHub only once.
const VIEWER_CACHE_MS = MINUTE_MS;

const CIPHER = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const STATE_BYTES = 32;

const OK = 200;
const NO_CONTENT = 204;
const FOUND = 302;
const METHOD_NOT_ALLOWED = 405;
const SERVICE_UNAVAILABLE = 503;
const GITHUB_UNAUTHORIZED = 401;

export class GitHubLoginError extends Error {
  constructor(reason: string) {
    super(`GitHub login failed: ${reason}`);
    this.name = 'GitHubLoginError';
  }
}

export type ViewerRepos = (userToken: string) => Promise<string[]>;

export type SessionDeps = {
  viewerRepos: ViewerRepos;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export type Sessions = {
  route: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;
  // The signed-in person's GitHub token, decrypted on the server only.
  userToken: (request: IncomingMessage) => string | undefined;
  repos: SessionRepos;
  viewerRepos: ViewerRepos;
};

type Session = { login: string; token: string };

// Sealed rather than only signed: the value holds the user's GitHub token, which the browser must not read.
// The purpose is bound in as associated data, so a state cookie can never pass as a session.
function createSealer(secret: string, now: () => number) {
  const key = createHash('sha256').update(secret).digest();
  return {
    seal(purpose: string, value: unknown, ttlMs: number): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(CIPHER, key, iv).setAAD(Buffer.from(purpose));
      const payload = JSON.stringify({ value, expiresAt: now() + ttlMs });
      const data = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
    },
    open<T>(purpose: string, sealed: string | undefined): T | undefined {
      if (!sealed) return undefined;
      const bytes = Buffer.from(sealed, 'base64url');
      if (bytes.length < IV_BYTES + TAG_BYTES) return undefined;
      const decipher = createDecipheriv(CIPHER, key, bytes.subarray(0, IV_BYTES))
        .setAAD(Buffer.from(purpose))
        .setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      let plain: Buffer;
      try {
        plain = Buffer.concat([
          decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)),
          decipher.final(),
        ]);
      } catch {
        return undefined; // forged, tampered or sealed with another secret
      }
      const { value, expiresAt } = JSON.parse(plain.toString('utf8')) as {
        value: T;
        expiresAt: number;
      };
      return now() < expiresAt ? value : undefined;
    },
  };
}

function readCookie(request: IncomingMessage, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [key, value] = part.trim().split('=');
    if (key === name) return value;
  }
  return undefined;
}

const hostOf = (request: IncomingMessage) => request.headers.host ?? '';
const isLocal = (request: IncomingMessage) =>
  LOCAL_HOSTS.has(URL.parse(`http://${hostOf(request)}`)?.hostname ?? '');

// GitHub only redirects to a registered callback URL, so a forged Host header can't send a login elsewhere.
const callbackUrl = (request: IncomingMessage) =>
  `${isLocal(request) ? 'http' : 'https'}://${hostOf(request)}${CALLBACK_PATH}`;

// Lax, not Strict: GitHub's redirect back to the callback is a cross-site navigation.
function cookie(
  request: IncomingMessage,
  name: string,
  value: string,
  path: string,
  maxAgeMs: number,
): string {
  const secure = isLocal(request) ? '' : '; Secure';
  const maxAge = Math.floor(maxAgeMs / SECOND_MS);
  return `${name}=${value}; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=${maxAge}${secure}`;
}

function cacheViewerRepos(viewerRepos: ViewerRepos, now: () => number): ViewerRepos {
  const cache = new Map<string, { repos: Promise<string[]>; expiresAt: number }>();
  return (userToken) => {
    const hit = cache.get(userToken);
    if (hit && now() < hit.expiresAt) return hit.repos;
    for (const [key, entry] of cache) if (now() >= entry.expiresAt) cache.delete(key);
    const repos = viewerRepos(userToken);
    cache.set(userToken, { repos, expiresAt: now() + VIEWER_CACHE_MS });
    repos.catch(() => cache.delete(userToken));
    return repos;
  };
}

async function exchangeCode(
  config: LoginConfig,
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const response = await fetchImpl(EXCHANGE_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const body = (response.ok ? await response.json() : {}) as {
    access_token?: string;
    error?: string;
  };
  if (!body.access_token) throw new GitHubLoginError(body.error ?? `answered ${response.status}`);
  return body.access_token;
}

const redirect = (response: ServerResponse, location: string, cookies: string[]) =>
  void response
    .writeHead(FOUND, { Location: location, 'Set-Cookie': cookies, 'Cache-Control': 'no-store' })
    .end();

export function createSessions(config: LoginConfig | undefined, deps: SessionDeps): Sessions {
  const { fetchImpl = fetch, now = Date.now } = deps;
  const sealer = config && createSealer(config.sessionSecret, now);
  const viewerRepos = cacheViewerRepos(deps.viewerRepos, now);

  const session = (request: IncomingMessage) =>
    sealer?.open<Session>(SESSION_PURPOSE, readCookie(request, SESSION_COOKIE));

  const repos: SessionRepos = async (request) => {
    const token = session(request)?.token;
    if (!token) return undefined;
    try {
      return new Set(await viewerRepos(token));
    } catch (error) {
      // An expired or revoked token reads as signed out.
      if (error instanceof GitHubApiError && error.status === GITHUB_UNAUTHORIZED) return undefined;
      throw error;
    }
  };

  const startLogin = (request: IncomingMessage, response: ServerResponse) => {
    if (!config || !sealer) {
      sendJson(response, SERVICE_UNAVAILABLE, { error: 'Login is not configured' });
      return;
    }
    const state = randomBytes(STATE_BYTES).toString('base64url');
    const query = new URLSearchParams({
      client_id: config.clientId,
      state,
      redirect_uri: callbackUrl(request),
    });
    const sealed = sealer.seal(STATE_PURPOSE, state, STATE_TTL_MS);
    redirect(response, `${AUTHORIZE_URL}?${query}`, [
      cookie(request, STATE_COOKIE, sealed, CALLBACK_PATH, STATE_TTL_MS),
    ]);
  };

  const finishLogin = async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    const clearState = cookie(request, STATE_COOKIE, '', CALLBACK_PATH, 0);
    const expected = sealer?.open<string>(STATE_PURPOSE, readCookie(request, STATE_COOKIE));
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    if (!config || !sealer || !expected || !state || !code || !sameSecret(state, expected)) {
      redirect(response, LOGIN_FAILED_PATH, [clearState]);
      return;
    }
    try {
      const token = await exchangeCode(config, code, callbackUrl(request), fetchImpl);
      const { login } = await githubRequest<{ login: string }>(
        token,
        'GET',
        '/user',
        undefined,
        fetchImpl,
      );
      const sealed = sealer.seal(SESSION_PURPOSE, { login, token }, SESSION_TTL_MS);
      redirect(response, DASHBOARD_PATH, [
        clearState,
        cookie(request, SESSION_COOKIE, sealed, '/', SESSION_TTL_MS),
      ]);
    } catch (error) {
      if (!(error instanceof GitHubLoginError || error instanceof GitHubApiError)) throw error;
      console.error(`login failed: ${redactSecrets(error.message)}`);
      redirect(response, LOGIN_FAILED_PATH, [clearState]);
    }
  };

  // shortcut: clears the cookie but doesn't revoke the GitHub token, so a copied cookie works until it expires; call DELETE /applications/{client_id}/token if that matters.
  const logout = (request: IncomingMessage, response: ServerResponse) => {
    response
      .writeHead(NO_CONTENT, { 'Set-Cookie': cookie(request, SESSION_COOKIE, '', '/', 0) })
      .end();
  };

  const serveSession = async (request: IncomingMessage, response: ServerResponse) => {
    const current = session(request);
    const allowed = current && (await repos(request));
    if (!current || !allowed) {
      sendJson(response, OK, { signedIn: false, canSignIn: Boolean(config) });
      return;
    }
    const orgs = [...new Set([...allowed].map((repo) => repo.split('/')[0]))].sort();
    sendJson(response, OK, { signedIn: true, login: current.login, orgs });
  };

  const handlers: Record<
    string,
    {
      method: string;
      handle: (
        request: IncomingMessage,
        response: ServerResponse,
        url: URL,
      ) => void | Promise<void>;
    }
  > = {
    [LOGIN_PATH]: { method: 'GET', handle: startLogin },
    [CALLBACK_PATH]: { method: 'GET', handle: finishLogin },
    [LOGOUT_PATH]: { method: 'POST', handle: logout },
    [SESSION_PATH]: { method: 'GET', handle: serveSession },
  };

  return {
    route: async (request, response) => {
      const url = URL.parse(request.url ?? '/', LOCAL_ORIGIN);
      const handler = url && handlers[url.pathname];
      if (!handler) return false;
      if (request.method !== handler.method) {
        response.writeHead(METHOD_NOT_ALLOWED, { Allow: handler.method }).end();
      } else await handler.handle(request, response, url);
      return true;
    },
    userToken: (request) => session(request)?.token,
    repos,
    viewerRepos,
  };
}
