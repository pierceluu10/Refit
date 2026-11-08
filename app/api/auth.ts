import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const BEARER = /^Bearer (\S+)$/;

// What a caller may read: every repo (the service token) or only the repos in the set.
export const ALL_REPOS = 'all';
export type Access = typeof ALL_REPOS | ReadonlySet<string>;
export type SessionRepos = (request: IncomingMessage) => Promise<ReadonlySet<string> | undefined>;

export const canRead = (access: Access, repo: string) => access === ALL_REPOS || access.has(repo);

// Equal-length digests, so timingSafeEqual can't throw and a secret's length can't leak.
const digest = (value: string) => createHash('sha256').update(value).digest();

export const sameSecret = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

export function isServiceToken(
  authorization: string | undefined,
  expected: string | undefined = process.env.REFIT_SERVICE_TOKEN,
): boolean {
  const token = BEARER.exec(authorization ?? '')?.[1];
  if (!token || !expected) return false;
  return sameSecret(token, expected);
}

// A session wins over the service token: the dev proxy adds that token to every /api request.
export async function resolveAccess(
  request: IncomingMessage,
  sessionRepos: SessionRepos | undefined,
  serviceToken?: string,
): Promise<Access | undefined> {
  const repos = await sessionRepos?.(request);
  if (repos) return repos;
  return isServiceToken(request.headers.authorization, serviceToken) ? ALL_REPOS : undefined;
}
