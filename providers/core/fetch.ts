// Fetching is an input to the agent, never the classifier. These helpers turn a
// page into readable text and let tests replay saved snapshots.

import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderSource } from './types.ts';

export type PageLink = { url: string; text: string };

export type FetchedPage = {
  url: string;
  status: number;
  ok: boolean;
  fetchedAt: string;
  contentType: string;
  /** Readable text. Truncated at the fetcher's limit, if it has one. */
  text: string;
  error?: string;
  /** Links found in the raw page, absolute, for the list_links tool. Live fetches only. */
  links?: PageLink[];
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

const PRIVATE_V4 =
  /^(0|10|127)\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|^(22[4-9]|23\d|24\d|25[0-5])\./;

/** True for loopback, private, link-local, shared (CGNAT), multicast and reserved addresses. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return PRIVATE_V4.test(ip);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return PRIVATE_V4.test(mapped[1]);
  return (
    ip === '::' ||
    ip === '::1' ||
    /^f[cd]/.test(ip) || // unique local
    /^fe[89ab]/.test(ip) || // link-local
    /^ff/.test(ip) || // multicast
    ip.startsWith('::ffff:') // mapped, in hex form
  );
}

export function isFetchableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    // "localhost." and "localhost" are the same host; so are their subdomains.
    const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
    // No local or private network targets: the agent picks URLs, so guard against SSRF.
    return !(
      host === '' ||
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.internal') ||
      host.endsWith('.local') ||
      host.endsWith('.home.arpa') ||
      host.startsWith('[') ||
      (/^\d+\.\d+\.\d+\.\d+$/.test(host) && isPrivateAddress(host))
    );
  } catch {
    return false;
  }
}

/** Resolves a host name to its addresses, as dns.lookup does. Tests pass a fixed one. */
export type HostLookup = (host: string) => Promise<string[]>;

export const systemLookup: HostLookup = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

function acceptFor(format?: ProviderSource['format']): string {
  if (format === 'github-releases') return 'application/vnd.github+json';
  // Feed-first, so servers that negotiate content (e.g. shopify.dev) return the feed itself.
  if (format === 'rss')
    return 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8';
  if (format === 'json') return 'application/json';
  return 'text/html,application/xhtml+xml,application/xml,application/json,text/plain;q=0.9,*/*;q=0.8';
}

const MAX_LINKS = 1500;

/** Absolute http(s) links in a raw page: HTML anchors, feed and sitemap links, Markdown links. */
export function extractLinks(raw: string, baseUrl: string): PageLink[] {
  const found = new Map<string, string>();
  const add = (href: string, text: string) => {
    if (found.size >= MAX_LINKS) return;
    let url: string;
    try {
      const parsed = new URL(decodeEntities(href.trim()), baseUrl);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return;
      parsed.hash = '';
      url = parsed.toString();
    } catch {
      return;
    }
    const label = tidy(text).replace(/\s+/g, ' ').slice(0, 120);
    if (!found.has(url) || (!found.get(url) && label)) found.set(url, label);
  };
  for (const m of raw.matchAll(
    /<a\b[^>]*?\bhref\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
  ))
    add(m[1], decodeEntities(m[2].replace(/<[^>]+>/g, ' ')));
  for (const m of raw.matchAll(/<(?:loc|link)>\s*(https?:\/\/[^<\s]+)\s*<\/(?:loc|link)>/gi))
    add(m[1], '');
  for (const m of raw.matchAll(/<link\b[^>]*?\bhref\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>/gi))
    add(m[1], '');
  for (const m of raw.matchAll(/\[([^\]\n]{0,200})\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g))
    add(m[2], m[1]);
  return [...found].map(([url, text]) => ({ url, text }));
}

type SafeResponse = { response: Response; finalUrl: string } | { error: string };

/** GitHub endpoints the optional token is sent to: release lists, for their rate limit. */
const GITHUB_TOKEN_PATH = /^\/repos\/[^/]+\/[^/]+\/releases(\/|$)/;

/**
 * One GET that follows redirects by hand, so every hop is checked before it is
 * requested: public https, and a host whose addresses are all public. githubToken
 * goes to api.github.com release lists only.
 */
async function safeGet(
  url: string,
  headers: Record<string, string>,
  options: { timeoutMs?: number; githubToken?: string; lookup?: HostLookup },
): Promise<SafeResponse> {
  const resolve = options.lookup ?? systemLookup;
  let target = url;
  for (let hop = 0; hop <= 5; hop++) {
    if (!isFetchableUrl(target)) return { error: `only public https URLs (${target})` };
    const parsed = new URL(target);
    let addresses: string[];
    try {
      addresses = await resolve(parsed.hostname.replace(/\.+$/, ''));
    } catch (error) {
      return {
        error: `could not resolve ${parsed.hostname}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (addresses.length === 0 || addresses.some(isPrivateAddress))
      return { error: `only public https URLs (${parsed.hostname} resolves to a private address)` };
    const sent = { ...headers };
    if (
      options.githubToken &&
      parsed.hostname === 'api.github.com' &&
      GITHUB_TOKEN_PATH.test(parsed.pathname)
    ) {
      sent.authorization = `Bearer ${options.githubToken}`;
    }
    const response = await fetch(target, {
      headers: sent,
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      target = new URL(location, target).toString();
      continue;
    }
    return { response, finalUrl: target };
  }
  return { error: 'too many redirects' };
}

/**
 * Live HTTP. maxChars bounds what one page can add to the agent's context.
 * Redirects are followed by hand so every hop is checked as public https.
 * githubToken, when given, is sent to api.github.com release lists only (it
 * lifts the 60-requests-an-hour limit on release feeds), never to any other
 * path or host. Use a token that can read public repositories only.
 */
export function httpFetcher(
  options: {
    maxChars?: number;
    timeoutMs?: number;
    githubToken?: string;
    lookup?: HostLookup;
  } = {},
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
        const got = await safeGet(
          url,
          { 'user-agent': USER_AGENT, accept: acceptFor(format) },
          options,
        );
        if ('error' in got) return failed(got.error);
        const { response, finalUrl } = got;
        const contentType = response.headers.get('content-type') ?? '';
        const raw = await response.text();
        const page: FetchedPage = {
          url,
          status: response.status,
          ok: response.ok,
          fetchedAt,
          contentType,
          text: toText(raw, contentType, format).slice(0, maxChars),
          error: response.ok ? undefined : `HTTP ${response.status}`,
        };
        if (format !== 'github-releases' && format !== 'json' && !contentType.includes('json')) {
          const links = extractLinks(raw, finalUrl);
          if (links.length) page.links = links;
        }
        return page;
      } catch (error) {
        return failed(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export type JsonResult =
  | { ok: true; status: number; url: string; data: unknown }
  | { ok: false; status: number; url: string; error: string };

/** Reads JSON documents, such as package registry metadata. Tests pass recorded ones. */
export interface JsonFetcher {
  json(url: string): Promise<JsonResult>;
}

/**
 * Live JSON over the same checked GET as httpFetcher. maxBytes bounds one
 * document (a big package's full npm metadata is a few megabytes).
 */
export function httpJsonFetcher(
  options: {
    timeoutMs?: number;
    maxBytes?: number;
    githubToken?: string;
    lookup?: HostLookup;
  } = {},
): JsonFetcher {
  const maxBytes = options.maxBytes ?? 40_000_000;
  return {
    async json(url) {
      try {
        const got = await safeGet(
          url,
          { 'user-agent': USER_AGENT, accept: 'application/json' },
          {
            timeoutMs: options.timeoutMs ?? 60_000,
            githubToken: options.githubToken,
            lookup: options.lookup,
          },
        );
        if ('error' in got) return { ok: false, status: 0, url, error: got.error };
        const { response } = got;
        if (!response.ok) {
          await response.body?.cancel();
          return { ok: false, status: response.status, url, error: `HTTP ${response.status}` };
        }
        const length = Number(response.headers.get('content-length') ?? 0);
        if (length > maxBytes) {
          await response.body?.cancel();
          return { ok: false, status: response.status, url, error: `over ${maxBytes} bytes` };
        }
        const body = await response.text();
        if (body.length > maxBytes)
          return { ok: false, status: response.status, url, error: `over ${maxBytes} bytes` };
        return { ok: true, status: response.status, url, data: JSON.parse(body) as unknown };
      } catch (error) {
        return {
          ok: false,
          status: 0,
          url,
          error: error instanceof Error ? error.message : String(error),
        };
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
