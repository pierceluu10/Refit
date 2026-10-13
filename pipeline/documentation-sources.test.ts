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
