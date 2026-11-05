// What a list matcher means, in one place: the scanner and the list's own tests both use this.
// A string matcher is a whole token, because a name is usually part of a longer live name:
// claude-sonnet-4 and claude-sonnet-4-6, embedding-001 and gemini-embedding-001, gpt-4 and gpt-4o.
import type { DeadApiMatcher } from '../shared/types.ts';

const TOKEN = /[A-Za-z0-9_.:/@-]+/g;
const SHELL_DEFAULT_PREFIX = /^(?:[A-Z][A-Z0-9_]*)?-(?=[a-z])/;
const MIN_LITERAL_CHARS = 2;
const BRACE_QUANTIFIER = /\{\d+(?:,\d*)?\}/y;
// A template (/x/${id}, /x/{id}, /x/:id) is a longer path too, and often a live one.
const LONGER_PATH = '/[\\w${:<-]';
export const escapeRegex = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** The tokens in a piece of text. A trailing dot or colon is sentence punctuation, not a name. */
export const tokensOf = (text: string): string[] =>
  (text.match(TOKEN) ?? []).map((token) => token.replace(/[.:/]+$/, '')).filter(Boolean);

function candidates(token: string): string[] {
  // models/gemini-2.0-flash:generateContent, groq/llama-3.3-70b-versatile, https://x/v1/models/o1,
  // openai:gpt-4 and a shell's ${MODEL:-gemini-2.0-flash} or ${MODEL-gemini-2.0-flash}.
  // Segments count, but a vertex @date or a bedrock anthropic.… prefix stays attached,
  // and @cf/… and @hf/… are Cloudflare's own model ids, not the provider's.
  if (token.startsWith('@')) return [token];
  const segments = token.split(/[/:]/).filter(Boolean);
  const defaults = segments.map((segment) => segment.replace(SHELL_DEFAULT_PREFIX, ''));
  return [...new Set([token, ...segments, ...defaults])];
}

const compiledTokens = new Map<string, RegExp>();

function tokenRegex(value: string, caseSensitive: boolean): RegExp {
  const key = `${caseSensitive}|${value}`;
  let regex = compiledTokens.get(key);
  if (!regex) {
    const pattern = `^${value.split('*').map(escapeRegex).join('.*')}$`;
    regex = new RegExp(pattern, caseSensitive ? '' : 'i');
    compiledTokens.set(key, regex);
  }
  return regex;
}

/** Whether one token is the name a string matcher means. Names are case sensitive unless they say. */
export function tokenMatches(
  matcher: Extract<DeadApiMatcher, { kind: 'string' }>,
  token: string,
): boolean {
  const regex = tokenRegex(matcher.value, matcher.caseSensitive !== false);
  return matcher.bare ? regex.test(token) : candidates(token).some((one) => regex.test(one));
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
  const before = isPath ? '(?:[a-z0-9.-]+\\.[a-z]{2,}(?::\\d+)?)?' : '';
  const resource = matcher.value.endsWith('*');
  const address = escapeRegex(matcher.value.replace(/\*$/, ''));
  const longerHost = bareHost ? '|\\.[\\w-]' : '';
  const end = resource ? `(?![\\w-]${longerHost})` : `(?![\\w-]|${LONGER_PATH}${longerHost})`;
  return new RegExp(`${start}${before}${address}${end}`, 'i').test(text);
}

// Any other `{` is a plain character in a JS regex without the u flag.
function quantifierAt(value: string, at: number): string | undefined {
  BRACE_QUANTIFIER.lastIndex = at;
  return BRACE_QUANTIFIER.exec(value)?.[0];
}

/**
 * The text a regex can't match without, one per top-level branch: a match holds at least one of them.
 * Undefined when a branch has none. It lets a scan skip a file without running the regex at all.
 */
export function requiredLiterals(value: string): string[] | undefined {
  const branches: string[] = [];
  let depth = 0;
  let inClass = false;
  let run = '';
  let best = '';
  const flush = () => {
    if (run.length > best.length) best = run;
    run = '';
  };
  for (let at = 0; at < value.length; at += 1) {
    const char = value[at];
    if (char === '\\') {
      at += 1;
      if (depth > 0 || inClass) continue;
      if (/\w/.test(value[at] ?? '')) flush();
      else run += value[at];
    } else if (inClass) {
      inClass = char !== ']';
    } else if (char === '[') {
      flush();
      inClass = true;
    } else if (char === '(') {
      flush();
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    } else if (depth > 0) {
      continue;
    } else if (char === '|') {
      flush();
      branches.push(best);
      best = '';
    } else if (char === '*' || char === '?' || quantifierAt(value, at)) {
      // The character before can be absent, so it isn't required.
      run = run.slice(0, -1);
      flush();
      at += (quantifierAt(value, at) ?? char).length - 1;
    } else if ('^$.+'.includes(char)) {
      flush();
    } else {
      run += char;
    }
  }
  flush();
  branches.push(best);
  return branches.every((one) => one.length >= MIN_LITERAL_CHARS) ? branches : undefined;
}
