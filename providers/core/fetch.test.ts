import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractLinks,
  fallbackFetcher,
  httpFetcher,
  httpJsonFetcher,
  isFetchableUrl,
  isPrivateAddress,
  truncatingFetcher,
  type Fetcher,
  guardedLookup,
  type HostLookup,
  type HttpGet,
} from './fetch.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

// Every host resolves to a documentation address (TEST-NET-3), so no test needs DNS.
const publicLookup: HostLookup = async () => ['203.0.113.7'];
// Requests go through the stubbed global fetch instead of the pinned https transport.
const viaFetch: HttpGet = (url, init) => fetch(url, { ...init, redirect: 'manual' });

describe('the pinned connection lookup', () => {
  type Resolve = (
    host: string,
    options: object,
    callback: (error: Error | null, addresses: { address: string; family: number }[]) => void,
  ) => void;
  const answering =
    (...addresses: string[]): Resolve =>
    (_host, _options, callback) =>
      callback(
        null,
        addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
      );
  const run = (resolve: Resolve, all: boolean) =>
    new Promise<{ error: Error | null; address: unknown }>((done) =>
      guardedLookup(resolve as never)('rebind.example', { all }, (error, address) =>
        done({ error, address }),
      ),
    );

  it('refuses a connection to any private address the name resolves to', async () => {
    const { error } = await run(answering('203.0.113.7', '169.254.169.254'), true);
    expect(error?.message).toMatch(/resolves to a private address/);
  });

  it('hands public addresses to the connection in the form it asked for', async () => {
    expect((await run(answering('203.0.113.7'), true)).address).toEqual([
      { address: '203.0.113.7', family: 4 },
    ]);
    expect((await run(answering('203.0.113.7'), false)).address).toBe('203.0.113.7');
  });
});

describe('the SSRF guard', () => {
  it('refuses local and private hosts however they are written', () => {
    for (const url of [
      'https://localhost./x',
      'https://LOCALHOST/x',
      'https://api.localhost/x',
      'https://metadata.google.internal./computeMetadata',
      'https://printer.local/',
      'https://router.home.arpa/',
      'https://100.64.0.1/',
      'https://2130706433/',
      'https://[::1]/',
    ])
      expect(isFetchableUrl(url), url).toBe(false);
    expect(isFetchableUrl('https://8.8.8.8/')).toBe(true);
    expect(isFetchableUrl('https://docs.example.com/')).toBe(true);
  });

  it('knows private addresses in both families', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.127.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
      '224.0.0.1',
      // IPv6 forms that carry a private IPv4 address: mapped in hex, compatible, NAT64.
      '::ffff:a00:1',
      '::10.0.0.1',
      '64:ff9b::a00:5',
      '64:ff9b::169.254.169.254',
    ])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of [
      '8.8.8.8',
      '100.128.0.1',
      '2606:4700::1111',
      '203.0.113.7',
      '64:ff9b::808:808',
    ])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('refuses a public name that resolves to a private address, before any request', async () => {
    const calls = stubFetch({ 'https://rebind.example/': () => new Response('secret') });
    const page = await httpFetcher({ lookup: async () => ['10.0.0.5'], get: viaFetch }).fetch(
      'https://rebind.example/',
    );
    expect(page.ok).toBe(false);
    expect(page.error).toMatch(/resolves to a private address/);
    expect(calls).toEqual([]);
  });

  it('sends the GitHub token to release lists only, not other GitHub API paths', async () => {
    const calls = stubFetch({
      'https://api.github.com/repos/a/b/contents/secret.txt': () => new Response('{}'),
    });
    await httpJsonFetcher({
      githubToken: 'test-token-not-real',
      lookup: publicLookup,
      get: viaFetch,
    }).json('https://api.github.com/repos/a/b/contents/secret.txt');
    expect(calls[0].headers.authorization).toBeUndefined();
  });
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
    const page = await httpFetcher({ lookup: publicLookup, get: viaFetch }).fetch(
      'https://example.com/feed.xml',
      'rss',
    );
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
    const fetcher = httpFetcher({
      githubToken: 'test-token-not-real',
      lookup: publicLookup,
      get: viaFetch,
    });
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
    const page = await httpFetcher({ lookup: publicLookup, get: viaFetch }).fetch(
      'https://example.com/a',
    );
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
    const page = await httpFetcher({ lookup: publicLookup, get: viaFetch }).fetch(
      'https://docs.example.com/',
    );
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
    const json = httpJsonFetcher({ lookup: publicLookup, get: viaFetch });
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
      await httpJsonFetcher({ maxBytes: 100, lookup: publicLookup, get: viaFetch }).json(
        'https://registry.example.com/big',
      ),
    ).toMatchObject({ ok: false, error: 'over 100 bytes' });
  });
});
