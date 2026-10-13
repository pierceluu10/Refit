import { afterEach, expect, it, vi } from 'vitest';
import { captureDocumentation, validateDocumentationSnapshot } from './documentation-sources.ts';

const source = { label: 'API changelog', url: 'https://docs.example.com/changelog' };

afterEach(() => {
  vi.unstubAllGlobals();
});

it('captures visible changelog text from HTML and ignores navigation and hidden page chrome', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          '<html><body><nav>Products</nav><main><h1>API changes</h1><p>Removed <code>old_field</code>.</p><script>ignored()</script><div hidden>private UI</div></main><footer>Terms</footer></body></html>',
          { headers: { 'content-type': 'text/html; charset=utf-8', etag: '"revision-1"' } },
        ),
      ),
  );

  const snapshot = await captureDocumentation(source);
  expect(snapshot.content).toBe('API changes\n\nRemoved old_field.');
  expect(snapshot.etag).toBe('"revision-1"');
  expect(validateDocumentationSnapshot(snapshot, source)).toEqual(snapshot);
});

it('normalizes text and sends ETags to reuse unchanged content', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response('First line\r\n\r\nSecond  line', {
        headers: { 'content-type': 'text/markdown', etag: '"revision-2"' },
      }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 304 }));
  vi.stubGlobal('fetch', fetcher);

  const first = await captureDocumentation(source);
  const second = await captureDocumentation(source, first);
  expect(first.content).toBe('First line\n\nSecond line');
  expect(second).toEqual(first);
  expect(fetcher.mock.calls[0][1].redirect).toBe('error');
  expect(fetcher.mock.calls[1][1].headers).toEqual({ 'If-None-Match': '"revision-2"' });
});

it('captures RSS 2.0 release entries as stable, readable text', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          '<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>API</title><item><title>Removed legacy field</title><pubDate>Tue, 13 Oct 2026 12:00:00 GMT</pubDate><link>https://docs.example.com/releases/1</link><content:encoded><![CDATA[<p>Use <code>new_field</code> instead.</p>]]></content:encoded><description>Fallback summary.</description></item><item><title>Added pagination</title><description>List endpoints now support cursors.</description></item></channel></rss>',
          { headers: { 'content-type': 'application/rss+xml' } },
        ),
      ),
  );

  const snapshot = await captureDocumentation(source);
  expect(snapshot.content).toBe(
    '## Removed legacy field\nPublished: Tue, 13 Oct 2026 12:00:00 GMT\nLink: https://docs.example.com/releases/1\n\nUse new_field instead.\n\n## Added pagination\n\nList endpoints now support cursors.',
  );
});

it('captures Atom entries and chooses the alternate link', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          '<feed xmlns="http://www.w3.org/2005/Atom"><title>API</title><entry><title>Renamed a response field</title><updated>2026-10-13T12:00:00Z</updated><link rel="self" href="https://docs.example.com/entry/1"/><link rel="alternate" href="https://docs.example.com/releases/1"/><summary type="html">&lt;p&gt;Read &lt;code&gt;new_field&lt;/code&gt;.&lt;/p&gt;</summary></entry></feed>',
          { headers: { 'content-type': 'application/atom+xml; charset=utf-8' } },
        ),
      ),
  );

  const snapshot = await captureDocumentation(source);
  expect(snapshot.content).toBe(
    '## Renamed a response field\nPublished: 2026-10-13T12:00:00Z\nLink: https://docs.example.com/releases/1\n\nRead new_field.',
  );
});

it('rejects malformed XML, custom entity declarations, unrelated XML and oversized feeds', async () => {
  const oversizedFeed = `<rss><channel>${Array.from(
    { length: 251 },
    (_, index) => `<item><title>Release ${index}</title></item>`,
  ).join('')}</channel></rss>`;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response('<rss><channel>', { headers: { 'content-type': 'application/rss+xml' } }),
    )
    .mockResolvedValueOnce(
      new Response('<!DOCTYPE rss [<!ENTITY x "unsafe">]><rss><channel/></rss>', {
        headers: { 'content-type': 'application/rss+xml' },
      }),
    )
    .mockResolvedValueOnce(
      new Response('<catalog><item>data</item></catalog>', {
        headers: { 'content-type': 'application/xml' },
      }),
    )
    .mockResolvedValueOnce(
      new Response(oversizedFeed, { headers: { 'content-type': 'application/rss+xml' } }),
    );
  vi.stubGlobal('fetch', fetcher);

  await expect(captureDocumentation(source)).rejects.toThrow(/malformed XML/);
  await expect(captureDocumentation(source)).rejects.toThrow(/custom XML entities/);
  await expect(captureDocumentation(source)).rejects.toThrow(/RSS 2.0 or Atom/);
  await expect(captureDocumentation(source)).rejects.toThrow(/at most 250 entries/);
});

it('rejects unsafe URLs, unsupported content types, empty pages and tampered snapshots', async () => {
  await expect(
    captureDocumentation({ ...source, url: 'http://docs.example.com/page' }),
  ).rejects.toThrow(/HTTPS/);
  await expect(
    captureDocumentation({ ...source, url: 'https://user:secret@docs.example.com/page' }),
  ).rejects.toThrow(/HTTPS/);
  await expect(
    captureDocumentation({ ...source, url: 'https://docs.example.com/page?token=secret' }),
  ).rejects.toThrow(/HTTPS/);

  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response('{}', { headers: { 'content-type': 'application/json' } }))
    .mockResolvedValueOnce(
      new Response('<html><body><nav>Only navigation</nav></body></html>', {
        headers: { 'content-type': 'text/html' },
      }),
    )
    .mockResolvedValueOnce(
      new Response('# Original', { headers: { 'content-type': 'text/markdown' } }),
    );
  vi.stubGlobal('fetch', fetcher);
  await expect(captureDocumentation(source)).rejects.toThrow(/HTML, Markdown or plain text/);
  await expect(captureDocumentation(source)).rejects.toThrow(/no visible text/);
  const snapshot = await captureDocumentation(source);
  expect(() => validateDocumentationSnapshot({ ...snapshot, content: '# Forged' }, source)).toThrow(
    /hash/,
  );
});

it('rejects documentation responses larger than the bounded download limit', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response('a'.repeat(1024 * 1024 + 1), {
        headers: { 'content-type': 'text/plain' },
      }),
    ),
  );
  await expect(captureDocumentation(source)).rejects.toThrow(/download limit/);
});
