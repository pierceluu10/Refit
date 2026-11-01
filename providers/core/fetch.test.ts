import { afterEach, describe, expect, it, vi } from 'vitest';
import { fallbackFetcher, httpFetcher, truncatingFetcher, type Fetcher } from './fetch.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

type Call = { url: string; headers: Record<string, string> };

function stubFetch(routes: Record<string, () => Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      const route = routes[url];
      return route ? route() : new Response('missing', { status: 404 });
    }),
  );
  return calls;
}

describe('httpFetcher', () => {
  it('asks feed servers for the feed', async () => {
    const calls = stubFetch({
      'https://example.com/feed.xml': () =>
        new Response('<rss><item><title>Hi</title></item></rss>', {
          headers: { 'content-type': 'application/rss+xml' },
        }),
    });
    const page = await httpFetcher().fetch('https://example.com/feed.xml', 'rss');
    expect(page.ok).toBe(true);
    expect(page.text).toContain('Hi');
    expect(calls[0].headers.accept).toMatch(/^application\/rss\+xml/);
  });

  it('sends the GitHub token to api.github.com only, including across redirects', async () => {
    const calls = stubFetch({
      'https://api.github.com/repos/a/b/releases': () =>
        new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/x' } }),
      'https://elsewhere.example/x': () =>
        new Response('[]', { headers: { 'content-type': 'application/json' } }),
    });
    const fetcher = httpFetcher({ githubToken: 'test-token-not-real' });
    const page = await fetcher.fetch(
      'https://api.github.com/repos/a/b/releases',
      'github-releases',
    );
    expect(page.ok).toBe(true);
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.github.com/repos/a/b/releases',
      'https://elsewhere.example/x',
    ]);
    expect(calls[0].headers.authorization).toBe('Bearer test-token-not-real');
    expect(calls[1].headers.authorization).toBeUndefined();
  });

  it('refuses redirects to private hosts', async () => {
    stubFetch({
      'https://example.com/a': () =>
        new Response(null, {
          status: 301,
          headers: { location: 'https://169.254.169.254/latest' },
        }),
    });
    const page = await httpFetcher().fetch('https://example.com/a');
    expect(page.ok).toBe(false);
    expect(page.error).toMatch(/only public https/);
  });
});

describe('fetcher helpers', () => {
  const pages: Record<string, string> = { 'https://a.example/1': 'x'.repeat(50) };
  const fixed: Fetcher = {
    async fetch(url) {
      const text = pages[url];
      return {
        url,
        status: text ? 200 : 404,
        ok: Boolean(text),
        fetchedAt: '2026-11-01T00:00:00.000Z',
        contentType: 'text/plain',
        text: text ?? '',
      };
    },
  };

  it('cuts pages and says so', async () => {
    const page = await truncatingFetcher(fixed, 10).fetch('https://a.example/1');
    expect(page.text).toBe(`${'x'.repeat(10)}\n[page cut at 10 characters for this run]`);
  });

  it('falls back when the first fetcher has no page', async () => {
    const live: Fetcher = {
      async fetch(url) {
        return {
          url,
          status: 200,
          ok: true,
          fetchedAt: 'now',
          contentType: 'text/plain',
          text: 'live',
        };
      },
    };
    const both = fallbackFetcher(fixed, live);
    expect((await both.fetch('https://a.example/1')).text).toBe('x'.repeat(50));
    expect((await both.fetch('https://a.example/2')).text).toBe('live');
  });
});
