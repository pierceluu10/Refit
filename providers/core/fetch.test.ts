import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractLinks,
  fallbackFetcher,
  httpFetcher,
  httpJsonFetcher,
  truncatingFetcher,
  type Fetcher,
} from './fetch.ts';

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

describe('extractLinks', () => {
  it('collects absolute links from anchors, sitemaps and Markdown', () => {
    const html =
      '<a href="/docs/changelog">Change<b>log</b></a> <a href="https://other.example/x#top">X</a> <a href="mailto:a@b.c">mail</a> <loc>https://docs.example.com/deprecations</loc> [Upgrade guide](https://docs.example.com/upgrade) [rel](/v2)';
    expect(extractLinks(html, 'https://docs.example.com/start')).toEqual([
      { url: 'https://docs.example.com/docs/changelog', text: 'Change log' },
      { url: 'https://other.example/x', text: 'X' },
      { url: 'https://docs.example.com/deprecations', text: '' },
      { url: 'https://docs.example.com/upgrade', text: 'Upgrade guide' },
      { url: 'https://docs.example.com/v2', text: 'rel' },
    ]);
  });

  it('keeps the links of a live HTML page for list_links', async () => {
    stubFetch({
      'https://docs.example.com/': () =>
        new Response('<main><a href="/changelog">Changelog</a></main>', {
          headers: { 'content-type': 'text/html' },
        }),
    });
    const page = await httpFetcher().fetch('https://docs.example.com/');
    expect(page.links).toEqual([{ url: 'https://docs.example.com/changelog', text: 'Changelog' }]);
  });
});

describe('httpJsonFetcher', () => {
  it('parses JSON, reports a 404, and refuses redirects to private hosts', async () => {
    stubFetch({
      'https://registry.example.com/pkg': () =>
        new Response('{"name":"pkg"}', { headers: { 'content-type': 'application/json' } }),
      'https://registry.example.com/moved': () =>
        new Response(null, { status: 302, headers: { location: 'https://10.0.0.1/pkg' } }),
    });
    const json = httpJsonFetcher();
    expect(await json.json('https://registry.example.com/pkg')).toEqual({
      ok: true,
      status: 200,
      url: 'https://registry.example.com/pkg',
      data: { name: 'pkg' },
    });
    expect(await json.json('https://registry.example.com/none')).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(await json.json('https://registry.example.com/moved')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/only public https/),
    });
  });

  it('refuses a document over its size cap', async () => {
    stubFetch({
      'https://registry.example.com/big': () =>
        new Response(JSON.stringify({ data: 'x'.repeat(200) }), {
          headers: { 'content-type': 'application/json' },
        }),
    });
    expect(
      await httpJsonFetcher({ maxBytes: 100 }).json('https://registry.example.com/big'),
    ).toMatchObject({ ok: false, error: 'over 100 bytes' });
  });
});
