// Fetching is an input to the agent, never the classifier. These helpers turn a
// page into readable text and let tests replay saved snapshots.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderSource } from './types.ts';

export type FetchedPage = {
  url: string;
  status: number;
  ok: boolean;
  fetchedAt: string;
  contentType: string;
  /** Readable text. Truncated at the fetcher's limit, if it has one. */
  text: string;
  error?: string;
};

export interface Fetcher {
  fetch(url: string, format?: ProviderSource['format']): Promise<FetchedPage>;
}

export const USER_AGENT = 'AptitudeWatcher/0.1 (+https://github.com/pierceluu10/Refit)';

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const n =
        code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

/** HTML or XML to plain text, keeping block boundaries as line breaks. */
export function htmlToText(html: string): string {
  // Docs sites put the page body in <main>; the rest is navigation.
  const main = /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(html);
  const body = main && main[1].length > 500 ? main[1] : html;
  const text = body
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, inner: string) => inner)
    .replace(/<(script|style|noscript|svg|head|nav|aside|footer)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, level: string) => `\n${'#'.repeat(Number(level))} `)
    .replace(
      /<\/(p|div|section|article|header|footer|li|ul|ol|h[1-6]|tr|table|pre|blockquote|item|entry|title|pubDate|updated|description|summary)>/gi,
      '\n',
    )
    // Inline tags join their text to the words around them; block tags break.
    .replace(/<\/?(a|code|span|strong|em|b|i|u|kbd|var|abbr|sup|sub|mark|small)\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, ' ');
  // RSS feeds often carry HTML escaped inside <description>; decode and strip once more.
  const decoded = decodeEntities(text);
  const stripped = /<\/?[a-z][^>]*>/i.test(decoded)
    ? decodeEntities(decoded.replace(/<[^>]+>/g, ' '))
    : decoded;
  return tidy(stripped);
}

export function tidy(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/[ \t\f\v ]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

type GitHubRelease = {
  tag_name?: string;
  name?: string;
  published_at?: string;
  html_url?: string;
  body?: string;
  prerelease?: boolean;
};

/** GitHub's releases API (JSON) as a readable, chronological text list. */
export function githubReleasesToText(json: string): string {
  const releases = JSON.parse(json) as GitHubRelease[];
  if (!Array.isArray(releases)) return tidy(json);
  return tidy(
    releases
      .map((release) =>
        [
          `## ${release.name || release.tag_name} (${release.tag_name ?? '?'}, published ${release.published_at ?? '?'}${release.prerelease ? ', prerelease' : ''})`,
          release.html_url ?? '',
          release.body ?? '',
        ].join('\n'),
      )
      .join('\n\n'),
  );
}

export function toText(
  raw: string,
  contentType: string,
  format?: ProviderSource['format'],
): string {
  const type = contentType.toLowerCase();
  const chosen =
    format ??
    (type.includes('json')
      ? 'json'
      : type.includes('xml') || type.includes('rss') || type.includes('atom')
        ? 'rss'
        : type.includes('html')
          ? 'html'
          : type.includes('markdown')
            ? 'markdown'
            : /^\s*</.test(raw)
              ? 'html'
              : 'text');
  switch (chosen) {
    case 'github-releases':
      return githubReleasesToText(raw);
    case 'html':
    case 'rss':
      return htmlToText(raw);
    case 'json':
      try {
        return JSON.stringify(JSON.parse(raw), null, 1);
      } catch {
        return raw;
      }
    default:
      return tidy(raw);
  }
}

export function isFetchableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname;
    // No local or private network targets: the agent picks URLs, so guard against SSRF.
    return !(
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.internal') ||
      /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host) ||
      host.startsWith('[')
    );
  } catch {
    return false;
  }
}

function acceptFor(format?: ProviderSource['format']): string {
  if (format === 'github-releases') return 'application/vnd.github+json';
  // Feed-first, so servers that negotiate content (e.g. shopify.dev) return the feed itself.
  if (format === 'rss')
    return 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8';
  return 'text/html,application/xhtml+xml,application/xml,application/json,text/plain;q=0.9,*/*;q=0.8';
}

/**
 * Live HTTP. maxChars bounds what one page can add to the agent's context.
 * Redirects are followed by hand so every hop is checked as public https.
 * githubToken, when given, is sent to api.github.com only (it lifts the
 * 60-requests-an-hour limit on release feeds) and never to any other host.
 */
export function httpFetcher(
  options: { maxChars?: number; timeoutMs?: number; githubToken?: string } = {},
): Fetcher {
  const maxChars = options.maxChars ?? 200_000;
  return {
    async fetch(url, format) {
      const fetchedAt = new Date().toISOString();
      const failed = (error: string, status = 0): FetchedPage => ({
        url,
        status,
        ok: false,
        fetchedAt,
        contentType: '',
        text: '',
        error,
      });
      try {
        let target = url;
        for (let hop = 0; hop <= 5; hop++) {
          if (!isFetchableUrl(target)) return failed(`only public https URLs (${target})`);
          const headers: Record<string, string> = {
            'user-agent': USER_AGENT,
            accept: acceptFor(format),
          };
          if (options.githubToken && new URL(target).hostname === 'api.github.com') {
            headers.authorization = `Bearer ${options.githubToken}`;
          }
          const response = await fetch(target, {
            headers,
            redirect: 'manual',
            signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
          });
          const location = response.headers.get('location');
          if (response.status >= 300 && response.status < 400 && location) {
            target = new URL(location, target).toString();
            continue;
          }
          const contentType = response.headers.get('content-type') ?? '';
          const raw = await response.text();
          return {
            url,
            status: response.status,
            ok: response.ok,
            fetchedAt,
            contentType,
            text: toText(raw, contentType, format).slice(0, maxChars),
            error: response.ok ? undefined : `HTTP ${response.status}`,
          };
        }
        return failed('too many redirects');
      } catch (error) {
        return failed(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

/** Cuts every page to maxChars, so a run only shows the model the top (newest) part of each page. */
export function truncatingFetcher(inner: Fetcher, maxChars: number): Fetcher {
  return {
    async fetch(url, format) {
      const page = await inner.fetch(url, format);
      if (page.text.length <= maxChars) return page;
      return {
        ...page,
        text: `${page.text.slice(0, maxChars)}\n[page cut at ${maxChars} characters for this run]`,
      };
    },
  };
}

/** Tries `primary` first (e.g. a saved snapshot) and falls back to `secondary` (e.g. live HTTP). */
export function fallbackFetcher(primary: Fetcher, secondary: Fetcher): Fetcher {
  return {
    async fetch(url, format) {
      const page = await primary.fetch(url, format);
      return page.ok ? page : secondary.fetch(url, format);
    },
  };
}

export type SnapshotManifest = {
  provider: string;
  fetchedAt: string;
  note: string;
  sources: {
    id: string;
    url: string;
    status: number;
    ok: boolean;
    file: string;
    chars: number;
    truncated: boolean;
    sha256: string;
    error?: string;
  }[];
};

/** Replays pages saved by recordSnapshot. Unknown URLs come back as a 404 the agent can see. */
export function snapshotFetcher(dir: string): Fetcher {
  const manifestPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as SnapshotManifest;
  const byUrl = new Map(manifest.sources.map((source) => [source.url, source]));
  return {
    async fetch(url) {
      const entry = byUrl.get(url);
      if (!entry || !existsSync(join(dir, entry.file))) {
        return {
          url,
          status: 404,
          ok: false,
          fetchedAt: manifest.fetchedAt,
          contentType: 'text/plain',
          text: '',
          error: 'not in the saved snapshot',
        };
      }
      return {
        url,
        status: entry.status,
        ok: entry.ok,
        fetchedAt: manifest.fetchedAt,
        contentType: 'text/plain',
        text: readFileSync(join(dir, entry.file), 'utf8'),
        error: entry.error,
      };
    },
  };
}

/**
 * Live-reads every source and saves the text as a fixture. snapshotChars keeps
 * fixtures small: they are test inputs in a public repo, not mirrors of the docs.
 */
export async function recordSnapshot(
  provider: { id: string; sources: ProviderSource[] },
  dir: string,
  options: { fetcher?: Fetcher; snapshotChars?: number } = {},
): Promise<SnapshotManifest> {
  const fetcher = options.fetcher ?? httpFetcher();
  const limit = options.snapshotChars ?? 24_000;
  mkdirSync(dir, { recursive: true });
  const sources: SnapshotManifest['sources'] = [];
  for (const source of provider.sources) {
    const page = await fetcher.fetch(source.url, source.format);
    const text = page.text.slice(0, limit);
    const file = `${source.id}.txt`;
    writeFileSync(join(dir, file), text.endsWith('\n') ? text : `${text}\n`);
    sources.push({
      id: source.id,
      url: source.url,
      status: page.status,
      ok: page.ok,
      file,
      chars: text.length,
      truncated: page.text.length > limit,
      sha256: createHash('sha256').update(text).digest('hex'),
      error: page.error,
    });
  }
  const manifest: SnapshotManifest = {
    provider: provider.id,
    fetchedAt: new Date().toISOString(),
    note: `Live read of each source, saved as text and cut to ${limit} characters. Test input only.`,
    sources,
  };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Normalises text for quote matching: whitespace, quote marks and dashes. */
export function normaliseForQuote(text: string): string {
  return text
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function containsQuote(haystack: string, quote: string): boolean {
  const needle = normaliseForQuote(quote);
  return needle.length > 0 && normaliseForQuote(haystack).includes(needle);
}

/** A small line diff for spec snapshots: lines only in `before`, lines only in `after`. */
export function lineDiff(before: string, after: string, maxLines = 400): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const inA = new Set(a);
  const inB = new Set(b);
  const removed = a.filter((line) => line.trim() && !inB.has(line));
  const added = b.filter((line) => line.trim() && !inA.has(line));
  const out = [...removed.map((line) => `- ${line}`), ...added.map((line) => `+ ${line}`)];
  const shown = out.slice(0, maxLines);
  if (out.length > maxLines) shown.push(`... ${out.length - maxLines} more lines`);
  return shown.length ? shown.join('\n') : '(no line differences)';
}
