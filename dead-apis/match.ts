// What a list matcher means, in one place: the scanner and the list's own tests both use this.
// A string matcher is a whole token, because a name is usually part of a longer live name:
// claude-sonnet-4 and claude-sonnet-4-6, embedding-001 and gemini-embedding-001, gpt-4 and gpt-4o.
import type { DeadApiMatcher } from '../shared/types.ts';

const TOKEN = /[A-Za-z0-9_.:/@-]+/g;
export const escapeRegex = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** The tokens in a piece of text. A trailing dot or colon is sentence punctuation, not a name. */
export const tokensOf = (text: string): string[] =>
  (text.match(TOKEN) ?? []).map((token) => token.replace(/[.:/]+$/, '')).filter(Boolean);

function candidates(token: string): string[] {
  // models/gemini-2.0-flash:generateContent, groq/llama-3.3-70b-versatile, https://x/v1/models/o1.
  // Segments of a path count, but a vertex @date or a bedrock anthropic.… prefix stays attached,
  // and @cf/… and @hf/… are Cloudflare's own model ids, not the provider's.
  if (token.startsWith('@')) return [token];
  const segments = token.split('/').filter(Boolean);
  const named = segments.map((segment) => segment.replace(/:[A-Za-z]\w*$/, ''));
  return [...new Set([token, ...segments, ...named])];
}

const tokenRegex = (value: string, caseSensitive: boolean) =>
  new RegExp(`^${value.split('*').map(escapeRegex).join('.*')}$`, caseSensitive ? '' : 'i');

/** Whether one token is the name a string matcher means. Names are case sensitive unless they say. */
export function tokenMatches(
  matcher: Extract<DeadApiMatcher, { kind: 'string' }>,
  token: string,
): boolean {
  const regex = tokenRegex(matcher.value, matcher.caseSensitive !== false);
  return candidates(token).some((candidate) => regex.test(candidate));
}

/** Whether a line holds a string or regex matcher's name. */
export function textMatches(
  matcher: Extract<DeadApiMatcher, { kind: 'string' | 'regex' }>,
  text: string,
): boolean {
  if (matcher.kind === 'regex') return new RegExp(matcher.value).test(text);
  return tokensOf(text).some((token) => tokenMatches(matcher, token));
}

/**
 * Whether a line holds a URL matcher's address. A value with a host must sit at the start of a host,
 * and a path must end at a path boundary, so /collect doesn't hit /g/collect and /v1/edits doesn't
 * hit /v1/edits-foo. A trailing `*` means the whole resource: /v1/threads* also hits /v1/threads/1.
 * A bare host has to be the whole host: chat.x.com doesn't hit chat.x.com.evil.example, or a path
 * that happens to spell it, as in https://y.com/chat.x.com.
 */
export function urlMatches(
  matcher: Extract<DeadApiMatcher, { kind: 'url' }>,
  text: string,
): boolean {
  const isPath = matcher.value.startsWith('/');
  const bareHost = !isPath && !matcher.value.replace(/^\w+:\/\//, '').includes('/');
  const start = isPath ? '(?<![\\w.-])' : '(?<![\\w-])(?<![\\w.-]/)';
  const before = isPath ? '(?:[a-z0-9.-]+\\.[a-z]{2,})?' : '';
  const resource = matcher.value.endsWith('*');
  const address = escapeRegex(matcher.value.replace(/\*$/, ''));
  const longerHost = bareHost ? '|\\.[\\w-]' : '';
  const end = resource ? `(?![\\w-]${longerHost})` : `(?![\\w-]|/[\\w-]${longerHost})`;
  return new RegExp(`${start}${before}${address}${end}`, 'i').test(text);
}
