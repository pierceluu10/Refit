import { describe, expect, it } from 'vitest';
import { loadDeadApis } from './list.ts';
import { textMatches, tokensOf, urlMatches } from './match.ts';

const list = loadDeadApis();
const matchers = list.entries.flatMap((entry) =>
  entry.matchers.map((matcher) => ({ entry: entry.id, matcher })),
);

/** Which dead entries a line would flag by name. */
function flags(text: string): string[] {
  return matchers
    .filter(({ matcher }) => {
      if (matcher.kind === 'string' || matcher.kind === 'regex') return textMatches(matcher, text);
      if (matcher.kind === 'url') return urlMatches(matcher, text);
      return false;
    })
    .map(({ entry }) => entry);
}

describe('string matchers are whole tokens', () => {
  // Each of these is a live name that sits inside or next to a dead one, found by the spot-check.
  it.each([
    'claude-sonnet-4-6',
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-8',
    'claude-sonnet-5-5',
    'anthropic.claude-sonnet-4-20250514-v1:0',
    'claude-sonnet-4-20250514@20250514',
    'gemini-embedding-001',
    'gemini-pro-latest',
    'gemini-2.5-flash-lite',
    'gemini-3.1-flash-lite-image',
    'ChatGoogleGenerativeAI',
    'text-embedding-ada-002',
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4.1',
    'gpt-5.6-sol',
    'EmbeddedCheckoutProvider',
    'interaction.completed',
    'openai/gpt-oss-120b',
    '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
  ])('does not flag the live name %s', (name) => {
    expect(flags(`model: "${name}"`)).toEqual([]);
  });

  it.each([
    ['claude-sonnet-4-20250514', 'AN-1.claude-sonnet-4-20250514'],
    ['claude-sonnet-4', 'AN-1.claude-sonnet-4-20250514'],
    ['gpt-4', 'OA-1.gpt-4'],
    ['gemini-2.0-flash', 'GE-1.gemini-2.0-flash'],
    ['llama-3.3-70b-versatile', 'GR-1.llama-3.3-70b-versatile'],
  ])('flags %s', (name, entry) => {
    expect(flags(`model: "${name}"`)).toContain(entry);
  });

  it('reads a name inside a provider path or a method URL', () => {
    expect(flags('groq/llama-3.3-70b-versatile')).toContain('GR-1.llama-3.3-70b-versatile');
    const url = 'https://x.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
    expect(flags(url)).toContain('GE-1.gemini-2.0-flash');
  });

  it('honours a wildcard within one token only', () => {
    expect(flags('claude-instant-1.2').length).toBeGreaterThan(0);
    expect(flags('claude-instant-2').length).toBe(0);
  });

  it('keeps sentence punctuation out of a token', () => {
    expect(tokensOf('use gpt-4. Then o1: done')).toEqual(['use', 'gpt-4', 'Then', 'o1', 'done']);
  });
});

describe('url matchers', () => {
  it('tells Universal Analytics from GA4', () => {
    const dead = 'https://www.google-analytics.com/collect?v=1&tid=UA-1234-1';
    expect(flags(dead).length).toBeGreaterThan(0);
    for (const alive of [
      'https://www.google-analytics.com/g/collect',
      'https://www.google-analytics.com/mp/collect?measurement_id=G-X',
    ]) {
      expect(flags(alive), alive).toEqual([]);
    }
  });

  it('stops at a path boundary, and allows a query after it', () => {
    const matcher = { kind: 'url', value: '/v1/edits' } as const;
    expect(urlMatches(matcher, 'https://api.openai.com/v1/edits')).toBe(true);
    expect(urlMatches(matcher, '"/v1/edits?x=1"')).toBe(true);
    expect(urlMatches(matcher, '/v1/edits-foo')).toBe(false);
    expect(urlMatches(matcher, '/v1/edits/thing')).toBe(false);
    const resource = { kind: 'url', value: '/v1/threads*' } as const;
    expect(urlMatches(resource, 'https://api.openai.com/v1/threads/thread_1/runs')).toBe(true);
    expect(urlMatches(resource, '/v1/threads-old')).toBe(false);
  });
});

describe('a UA property id', () => {
  it('is flagged, and a browser hint header is not', () => {
    expect(flags("ga('create', 'UA-12345-1', 'auto')").length).toBeGreaterThan(0);
    expect(flags('headers["Sec-CH-UA-Platform"]')).toEqual([]);
    expect(flags('X-UA-Compatible')).toEqual([]);
  });
});
