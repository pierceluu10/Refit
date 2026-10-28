import { afterEach, expect, it, vi } from 'vitest';
import { captureWatchTarget } from './vendor-watch.ts';

afterEach(() => vi.unstubAllGlobals());

const SPECIFICATION = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 't', version: '1' },
  paths: {},
});

it('keeps each source hash, records a failed source without stopping the others and flags a change', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.endsWith('openapi.json')
        ? new Response(SPECIFICATION, { headers: { 'content-type': 'application/json' } })
        : new Response('gone', { status: 404, headers: { 'content-type': 'text/html' } }),
    ),
  );
  const target = {
    provider: 'resend',
    sources: {
      specification: 'https://example.com/openapi.json',
      documentation: [{ label: 'Changelog', url: 'https://example.com/changelog' }],
    },
    captures: null,
  };
  const first = await captureWatchTarget(target);
  expect(first.changed).toBe(false);
  expect(first.captures).toEqual([
    { kind: 'specification', url: 'https://example.com/openapi.json', hash: expect.any(String) },
    {
      kind: 'documentation',
      url: 'https://example.com/changelog',
      error: 'Documentation download failed with HTTP 404.',
    },
  ]);
  // The same content later is unchanged; different content is a change.
  expect((await captureWatchTarget({ ...target, captures: first.captures })).changed).toBe(false);
  expect(
    (
      await captureWatchTarget({
        ...target,
        captures: [{ kind: 'specification', url: 'https://example.com/openapi.json', hash: 'old' }],
      })
    ).changed,
  ).toBe(true);
});
