// Fetching is an input to the agent, never the classifier. These helpers turn a
// page into readable text and let tests replay saved snapshots.

import { createHash } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
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

export const USER_AGENT = 'RefitWatcher/0.1 (+https://github.com/pierceluu10/Refit)';

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
  // IPv6 forms that carry an IPv4 address: mapped (::ffff:), compatible (::) and NAT64 (64:ff9b::).
  const dotted = /^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (dotted) return PRIVATE_V4.test(dotted[1]);
  const hex = /^(?:::ffff:|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (hex) {
    const [high, low] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
    return PRIVATE_V4.test(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return (
    ip === '::' ||
    ip === '::1' ||
    /^f[cd]/.test(ip) || // unique local
    /^fe[89ab]/.test(ip) || // link-local
    /^ff/.test(ip) // multicast
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

/** One GET as the fetchers use it. The default is pinnedGet; tests pass a stand-in. */
export type HttpGet = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal; method?: string; body?: string },
) => Promise<Response>;

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A DNS lookup for the connection itself that refuses private addresses, so
 * the address checked is the address connected to: a name that resolves to a
 * public address once and a private one the next time (DNS rebinding) cannot
 * slip between a check and the request.
 */
export function guardedLookup(resolve: typeof dnsLookup = dnsLookup) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    resolve(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, []);
      const list = addresses as LookupAddress[];
      const blocked = list.find((entry) => isPrivateAddress(entry.address));
      if (blocked || list.length === 0) {
        const refused: NodeJS.ErrnoException = new Error(
          `only public https URLs (${hostname} resolves to a private address)`,
        );
        refused.code = 'EPRIVATEADDRESS';
        return callback(refused, []);
      }
      if (options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

/** The most one response body may hold before it is cut off. */
const MAX_BODY_BYTES = 50_000_000;

function decode(body: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return gunzipSync(body);
    case 'deflate':
      return inflateSync(body);
    case 'br':
      return brotliDecompressSync(body);
    default:
      return body;
  }
}

/** A GET over node:https whose connection uses guardedLookup. No redirects are followed. */
export const pinnedGet: HttpGet = (url, init) =>
  new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: init.method ?? 'GET',
        headers: { 'accept-encoding': 'gzip, deflate, br', ...init.headers },
        lookup: guardedLookup() as never,
        signal: init.signal,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            request.destroy(new Error(`response over ${MAX_BODY_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (value === undefined || name === 'content-encoding' || name === 'content-length')
                continue;
              headers.set(name, Array.isArray(value) ? value.join(', ') : value);
            }
            const status = response.statusCode ?? 0;
            const body = decode(Buffer.concat(chunks), response.headers['content-encoding']);
            const empty = status === 204 || status === 304 || (status >= 300 && status < 400);
            resolve(new Response(empty ? null : new Uint8Array(body), { status, headers }));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('error', reject);
    request.end(init.body);
  });

/** GitHub endpoints the optional token is sent to: release lists and advisories, for their rate limit. */
const GITHUB_TOKEN_PATH = /^\/repos\/[^/]+\/[^/]+\/releases(\/|$)|^\/advisories(\/|$)/;

/**
 * One GET that follows redirects by hand, so every hop is checked before it is
 * requested: public https, and a host whose addresses are all public. githubToken
 * goes to api.github.com release lists and advisories only. A body makes it a POST.
 */
async function safeGet(
  url: string,
  headers: Record<string, string>,
  options: {
    timeoutMs?: number;
    githubToken?: string;
    lookup?: HostLookup;
    get?: HttpGet;
    body?: string;
  },
): Promise<SafeResponse> {
  const resolve = options.lookup ?? systemLookup;
  const get = options.get ?? pinnedGet;
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
    // An early check above, and the real one in the connection's own lookup (pinnedGet). The URL
    // goes out as the parser wrote it, so spaces and other characters a model may paste are escaped.
    const response = await get(parsed.href, {
      headers: sent,
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      ...(options.body ? { method: 'POST', body: options.body } : {}),
    });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      if (options.body) return { error: `a POST was redirected to ${location}` };
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
 * githubToken, when given, is sent to api.github.com release lists and advisories only (it
 * lifts the 60-requests-an-hour limit on those feeds), never to any other
 * path or host. Use a token that can read public repositories only.
 */
export function httpFetcher(
  options: {
    maxChars?: number;
    timeoutMs?: number;
    githubToken?: string;
    lookup?: HostLookup;
    get?: HttpGet;
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
  /** A body POSTs it as JSON, for query APIs such as OSV's. */
  json(url: string, body?: unknown): Promise<JsonResult>;
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
    get?: HttpGet;
  } = {},
): JsonFetcher {
  const maxBytes = options.maxBytes ?? 40_000_000;
  return {
    async json(url, body) {
      try {
        const got = await safeGet(
          url,
          {
            'user-agent': USER_AGENT,
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          {
            timeoutMs: options.timeoutMs ?? 60_000,
            githubToken: options.githubToken,
            lookup: options.lookup,
            get: options.get,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
        const text = await response.text();
        if (text.length > maxBytes)
          return { ok: false, status: response.status, url, error: `over ${maxBytes} bytes` };
        return { ok: true, status: response.status, url, data: JSON.parse(text) as unknown };
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

export type CacheOptions = {
  /** Where cached reads live. Defaults to REFIT_WATCH_CACHE_DIR, then ~/.cache/refit/watch. */
  dir?: string;
  ttlMs?: number;
  now?: () => number;
};

export const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** A disk cache for public reads. A cache that cannot be read or written is only a slower fetch. */
function diskCache<T>(options: CacheOptions) {
  const dir =
    options.dir ?? process.env.REFIT_WATCH_CACHE_DIR ?? join(homedir(), '.cache', 'refit', 'watch');
  const ttl = options.ttlMs ?? ONE_DAY_MS;
  const now = options.now ?? Date.now;
  const fileFor = (key: string) =>
    join(dir, `${createHash('sha256').update(key).digest('hex')}.json`);
  return {
    get(key: string): T | undefined {
      try {
        const file = fileFor(key);
        if (now() - statSync(file).mtimeMs >= ttl) return undefined;
        return JSON.parse(readFileSync(file, 'utf8')) as T;
      } catch {
        return undefined;
      }
    },
    set(key: string, value: T): void {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        // Scans run in parallel, so a reader must never see a half-written file.
        const temp = `${fileFor(key)}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify(value));
        renameSync(temp, fileFor(key));
      } catch {
        // Next read fetches again.
      }
    },
  };
}

/** Keeps each page that loaded for a day (by default), so a scan of many repos reads a page once. Failures are never kept. */
export function cachingFetcher(inner: Fetcher, options: CacheOptions = {}): Fetcher {
  const cache = diskCache<FetchedPage>(options);
  return {
    async fetch(url, format) {
      const key = `page ${format ?? ''} ${url}`;
      const kept = cache.get(key);
      if (kept) return kept;
      const page = await inner.fetch(url, format);
      if (page.ok) cache.set(key, page);
      return page;
    },
  };
}

/** The same for JSON documents, such as registry metadata and advisory queries. */
export function cachingJsonFetcher(inner: JsonFetcher, options: CacheOptions = {}): JsonFetcher {
  const cache = diskCache<JsonResult>(options);
  return {
    async json(url, body) {
      const key = `json ${url} ${body === undefined ? '' : JSON.stringify(body)}`;
      const kept = cache.get(key);
      if (kept) return kept;
      const result = await inner.json(url, body);
      if (result.ok) cache.set(key, result);
      return result;
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
