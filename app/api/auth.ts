import { createHash, timingSafeEqual } from 'node:crypto';

const BEARER = /^Bearer (\S+)$/;

// Equal-length digests, so timingSafeEqual can't throw and a token's length can't leak.
const digest = (value: string) => createHash('sha256').update(value).digest();

export function isServiceToken(
  authorization: string | undefined,
  expected: string | undefined = process.env.REFIT_SERVICE_TOKEN,
): boolean {
  const token = BEARER.exec(authorization ?? '')?.[1];
  if (!token || !expected) return false;
  return timingSafeEqual(digest(token), digest(expected));
}
