// Reading official texts. Fetching is an input to the agent: it reads the page and decides what it
// says. Pages are cached for a day; anything that couldn't be read is reported, never invented.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Page = { url: string; ok: boolean; status: number; text: string; error?: string };

export interface Fetcher {
  fetch(url: string): Promise<Page>;
}

export const USER_AGENT = 'RefitCompliance/0.1 (+https://github.com/pierceluu10/Refit)';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CHARS = 2_000_000;

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head|nav|footer)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|table|pre|blockquote|dt|dd)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&rsquo;/g, '’')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

// Whitespace and quote marks vary between renderings of the same text; compare without them.
export function normalize(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function containsQuote(pageText: string, quote: string): boolean {
  const q = normalize(quote);
  return q.length > 0 && normalize(pageText).includes(q);
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function httpFetcher(
  options: { cacheDir?: string; fetch?: FetchLike; now?: () => number } = {},
): Fetcher {
  const cacheDir =
    options.cacheDir ??
    join(process.env.REFIT_CACHE_DIR ?? join(process.cwd(), '.refit', 'cache'), 'compliance');
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  return {
    async fetch(url) {
      const file = join(cacheDir, `${createHash('sha256').update(url).digest('hex')}.json`);
      if (existsSync(file)) {
        try {
          const cached = JSON.parse(readFileSync(file, 'utf8')) as { at: number; page: Page };
          if (now() - cached.at < DAY_MS) return cached.page;
        } catch {
          // A corrupt cache entry is refetched.
        }
      }
      let page: Page;
      try {
        const response = await doFetch(url, {
          // The EU Publications Office picks the format and language from these; without them it
          // sends RDF metadata or every language at once.
          headers: {
            'user-agent': USER_AGENT,
            accept: 'application/xhtml+xml,text/html;q=0.9,text/plain;q=0.8,*/*;q=0.5',
            'accept-language': 'en',
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(30_000),
        });
        const type = response.headers.get('content-type') ?? '';
        if (type.includes('pdf')) {
          page = {
            url,
            ok: false,
            status: response.status,
            text: '',
            error:
              'PDF documents are not read by this fetcher yet; find an HTML version or note it as unread',
          };
        } else {
          const raw = await response.text();
          const text = (type.includes('html') || /^\s*</.test(raw) ? htmlToText(raw) : raw).slice(
            0,
            MAX_CHARS,
          );
          // A bot check can answer 2xx with an empty page (EUR-Lex sends 202); that is not a read.
          page =
            response.ok && text.trim()
              ? { url, ok: true, status: response.status, text }
              : {
                  url,
                  ok: false,
                  status: response.status,
                  text: '',
                  error: response.ok
                    ? `HTTP ${response.status} with an empty page; the site may only serve browsers`
                    : `HTTP ${response.status}`,
                };
        }
      } catch (error) {
        page = {
          url,
          ok: false,
          status: 0,
          text: '',
          error: error instanceof Error ? error.message : String(error),
        };
      }
      if (page.ok) {
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(file, JSON.stringify({ at: now(), page }));
      }
      return page;
    },
  };
}

// Replays saved texts by URL. Unknown URLs read as 404, the way a dead link would.
export function fixtureFetcher(pages: Record<string, string>): Fetcher {
  return {
    async fetch(url) {
      const text = pages[url];
      return text === undefined
        ? { url, ok: false, status: 404, text: '', error: 'not in the saved fixtures' }
        : { url, ok: true, status: 200, text };
    },
  };
}

type FixtureIndex = { url: string; file: string }[];

// The saved official-text fixtures under compliance/fixtures/official/.
export function officialFixtures(): Record<string, string> {
  const dir = fileURLToPath(new URL('./fixtures/official/', import.meta.url));
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as FixtureIndex;
  return Object.fromEntries(
    index.map(({ url, file }) => [url, readFileSync(join(dir, file), 'utf8')]),
  );
}
