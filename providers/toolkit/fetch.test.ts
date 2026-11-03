import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearFetchCache,
  fetchPage,
  fetchText,
  isPublicUrl,
  urlProblem,
  type FetchLike,
} from './fetch.ts';

function fake(responses: { status: number; body?: string; location?: string }[]) {
  const calls: { url: string; method?: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => next.body ?? '',
      headers: {
        get: (name: string) =>
          name === 'location'
            ? (next.location ?? null)
            : name === 'content-type'
              ? 'text/html'
              : null,
      },
    };
  };
  return { fetch, calls };
}

beforeEach(() => clearFetchCache());

describe('urlProblem', () => {
  it('allows public http and https URLs', () => {
    expect(urlProblem('https://docs.example.com/changelog')).toBeUndefined();
    expect(urlProblem('http://example.org/a?b=1')).toBeUndefined();
    expect(isPublicUrl('https://registry.npmjs.org/stripe')).toBe(true);
  });

  it('refuses local, private and metadata targets the agent or a repo could name', () => {
    for (const url of [
      'http://localhost:3000/',
      'http://127.0.0.1/',
      'http://2130706433/',
      'http://10.0.0.8/',
      'http://172.16.4.2/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/',
      'http://[::1]/',
      'http://metadata.google.internal/',
      'http://printer.local/',
      'http://intranet/',
    ]) {
      expect(urlProblem(url), url).toMatch(/local or private/);
    }
    expect(urlProblem('file:///etc/passwd')).toMatch(/only http and https/);
    expect(urlProblem('https://user:secret@example.com/')).toMatch(/credentials/);
    expect(urlProblem('not a url')).toMatch(/not a URL/);
  });
});

describe('fetchPage', () => {
  it('returns the status, content type and final URL', async () => {
    const { fetch } = fake([{ status: 200, body: '<p>hi</p>' }]);
    const page = await fetchPage('https://example.com/a', { fetch });
    expect(page).toMatchObject({
      ok: true,
      status: 200,
      contentType: 'text/html',
      url: 'https://example.com/a',
    });
  });

  it('checks every redirect hop, so a public page cannot bounce to a private one', async () => {
    const { fetch, calls } = fake([
      { status: 302, location: 'https://docs.example.com/moved' },
      { status: 301, location: 'http://169.254.169.254/latest/meta-data/' },
      { status: 200, body: 'secret' },
    ]);
    const page = await fetchPage('https://example.com/start', { fetch });
    expect(page.ok).toBe(false);
    expect(page.ok ? '' : page.error).toMatch(/local or private/);
    expect(calls.map((c) => c.url)).toEqual([
      'https://example.com/start',
      'https://docs.example.com/moved',
    ]);
  });

  it('turns a 303 into a GET without the body', async () => {
    const { fetch, calls } = fake([
      { status: 303, location: '/result' },
      { status: 200, body: 'ok' },
    ]);
    const page = await fetchPage('https://example.com/post', { fetch, method: 'POST', body: '{}' });
    expect(page.ok && page.url).toBe('https://example.com/result');
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET']);
  });

  it('caches successes only', async () => {
    const { fetch, calls } = fake([{ status: 500 }, { status: 200, body: 'fine' }]);
    expect((await fetchPage('https://example.com/x', { fetch })).ok).toBe(false);
    expect((await fetchPage('https://example.com/x', { fetch })).ok).toBe(true);
    expect((await fetchPage('https://example.com/x', { fetch })).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('reports offline and thrown errors as information', async () => {
    expect(await fetchText('https://example.com/', { fetch: null })).toEqual({
      ok: false,
      error: 'offline (no fetch available)',
    });
    const failing: FetchLike = async () => {
      throw new Error('socket hang up');
    };
    expect(await fetchText('https://example.com/', { fetch: failing })).toEqual({
      ok: false,
      error: 'socket hang up',
    });
  });
});
