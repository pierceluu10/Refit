import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentTool } from '../../shared/types.ts';
import { fetchPage, resolveFetch, type NetworkOptions } from './fetch.ts';
import { pageTitle, pageToText, type PageStore } from './pages.ts';
import { rank, splitPassages } from './text.ts';
import { defineTool, num, str, bool } from './tool.ts';

export type DocsPage = {
  url: string;
  title: string;
  /** Short notes or excerpts from the page, written when the snapshot was taken. */
  passages: string[];
};

export type DocsIndex = {
  provider: string;
  retrieved: string;
  note?: string;
  pages: DocsPage[];
};

export type DocPassage = {
  url: string;
  title: string;
  text: string;
  /** snapshot: the provider's curated index; saved: a page saved earlier; run: a page a tool read in this run; live: fetched now. */
  source: 'snapshot' | 'live' | 'saved' | 'run';
  retrieved?: string;
};

export type SearchDocsOptions = NetworkOptions & {
  /** Override the snapshot index (tests, or a provider that builds one in memory). */
  index?: DocsIndex;
  /** Fetch the best-matching pages live and rank their current text too. Default true. */
  live?: boolean;
  /** A specific docs page to fetch and search, in addition to the index. */
  url?: string;
  /** More docs pages to fetch and search. */
  urls?: string[];
  /** A docs site (host or URL): its sitemap is read to find the pages that best match the query. */
  site?: string;
  /** Docs pages known for the provider (inventory hints, knowledge.json): the best-matching ones are read live. */
  docsUrls?: string[];
  /** Pages the provider's tools read during this run; searched, and pages read here are added. */
  store?: PageStore;
  /** A folder of saved pages (a watcher's fixtures/live with manifest.json), searched offline. */
  savedDir?: string;
  limit?: number;
};

const PROVIDER_NAME = /^[a-z0-9-]+$/;
const LIVE_PAGES = 2;
const SITEMAP_PAGES = 3;

export function loadDocsIndex(provider: string): DocsIndex | undefined {
  if (!PROVIDER_NAME.test(provider)) return undefined;
  const url = new URL(`../${provider}/tools-data/docs-index.json`, import.meta.url);
  const path = fileURLToPath(url);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as DocsIndex;
}

type SavedManifest = {
  fetchedAt?: string;
  sources?: { id?: string; url: string; file: string; ok?: boolean }[];
};

const savedMemory = new Map<string, DocPassage[]>();

/** Passages of the pages saved in a folder with a manifest.json (url, file per page). */
export function loadSavedPassages(dir: string): DocPassage[] {
  const memo = savedMemory.get(dir);
  if (memo) return memo;
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) return [];
  let manifest: SavedManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as SavedManifest;
  } catch {
    return [];
  }
  const retrieved = manifest.fetchedAt?.slice(0, 10);
  const passages: DocPassage[] = [];
  for (const source of manifest.sources ?? []) {
    if (source.ok === false || /[/\\]/.test(source.file)) continue;
    const file = join(dir, source.file);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const passage of splitPassages(text)) {
      passages.push({
        url: source.url,
        title: source.id ?? source.url,
        text: passage,
        source: 'saved',
        retrieved,
      });
    }
  }
  savedMemory.set(dir, passages);
  return passages;
}

/** URLs listed in a sitemap (or sitemap index) document. */
export function sitemapUrls(xml: string): { pages: string[]; sitemaps: string[] } {
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) =>
    m[1].replace(/&amp;/g, '&'),
  );
  return /<sitemapindex\b/i.test(xml)
    ? { pages: [], sitemaps: locs }
    : { pages: locs, sitemaps: [] };
}

const urlWords = (url: string) =>
  url.replace(/^https?:\/\/[^/]+/, '').replace(/[/_.\-#?=&]+/g, ' ');

/** Pages of a docs site that best match a query, found through its sitemap. */
export async function discoverPages(
  site: string,
  query: string,
  network: NetworkOptions,
  count = SITEMAP_PAGES,
): Promise<{ urls: string[]; note: string }> {
  let base: URL;
  try {
    base = new URL(/^https?:\/\//.test(site) ? site : `https://${site}`);
  } catch {
    return { urls: [], note: `"${site}" is not a site or URL` };
  }
  // Docs often live under a path with their own sitemap (example.com/docs/sitemap.xml), so that
  // comes first, then the site's, then whatever robots.txt points to.
  const path = base.pathname.replace(/\/+$/, '');
  const tried = [
    ...(path ? [`${base.origin}${path}/sitemap.xml`] : []),
    `${base.origin}/sitemap.xml`,
  ];
  let first = await fetchPage(tried[0], network);
  for (const candidate of tried.slice(1)) {
    if (first.ok) break;
    first = await fetchPage(candidate, network);
  }
  if (!first.ok) {
    const robots = await fetchPage(`${base.origin}/robots.txt`, network);
    const listed = robots.ok ? /^sitemap:\s*(\S+)/im.exec(robots.text)?.[1] : undefined;
    if (listed) {
      tried.push(listed);
      first = await fetchPage(listed, network);
    }
  }
  if (!first.ok) return { urls: [], note: `no sitemap found (tried ${tried.join(', ')})` };
  let { pages, sitemaps } = sitemapUrls(first.text);
  if (sitemaps.length) {
    const children = rank(`${query} docs api reference`, sitemaps, urlWords)
      .map((r) => r.item)
      .concat(sitemaps)
      .filter((url, i, all) => all.indexOf(url) === i)
      .slice(0, 3);
    for (const child of children) {
      const page = await fetchPage(child, network);
      if (page.ok) pages = pages.concat(sitemapUrls(page.text).pages);
    }
  }
  const sameHost = pages.filter((url) => {
    try {
      return new URL(url).hostname === base.hostname;
    } catch {
      return false;
    }
  });
  const prefix = base.pathname.replace(/\/+$/, '');
  const scoped = prefix
    ? sameHost.filter((url) => new URL(url).pathname.startsWith(prefix))
    : sameHost;
  const pool = scoped.length ? scoped : sameHost;
  const best = rank(query, pool, urlWords)
    .slice(0, count)
    .map((r) => r.item);
  return {
    urls: best,
    note: best.length
      ? `read ${best.length} page(s) the sitemap of ${base.hostname} matched`
      : `the sitemap of ${base.hostname} lists ${pool.length} page(s), none matching the query by URL`,
  };
}

/** Search a provider's docs. Snapshot passages always; live page text when the network is available. */
export async function searchDocs(
  provider: string,
  query: string,
  options: SearchDocsOptions = {},
): Promise<DocPassage[]> {
  return (await searchDocsWithNotes(provider, query, options)).passages;
}

export async function searchDocsWithNotes(
  provider: string,
  query: string,
  options: SearchDocsOptions = {},
): Promise<{ passages: DocPassage[]; notes: string[] }> {
  const index = options.index ?? loadDocsIndex(provider);
  const limit = options.limit ?? 5;
  const notes: string[] = [];
  const candidates: DocPassage[] = (index?.pages ?? []).flatMap((page) =>
    page.passages.map((text) => ({
      url: page.url,
      title: page.title,
      text,
      source: 'snapshot' as const,
      retrieved: index?.retrieved,
    })),
  );
  if (options.savedDir) candidates.push(...loadSavedPassages(options.savedDir));
  for (const page of options.store?.pages ?? []) {
    for (const text of splitPassages(page.text)) {
      candidates.push({ url: page.url, title: page.title, text, source: 'run' });
    }
  }

  const wantLive = options.live !== false && resolveFetch(options) !== null;
  if (wantLive) {
    const known = [
      ...(index?.pages ?? []).map((p) => ({
        url: p.url,
        words: `${p.title} ${p.url} ${p.passages.join(' ')}`,
      })),
      ...(options.docsUrls ?? []).map((url) => ({ url, words: `${url} ${urlWords(url)}` })),
    ];
    const urls = rank(query, known, (k) => k.words)
      .slice(0, LIVE_PAGES)
      .map((entry) => entry.item.url);
    const asked = [options.url, ...(options.urls ?? [])].filter(
      (url): url is string => !!url && /^https?:\/\//.test(url),
    );
    urls.unshift(...asked);
    if (options.site) {
      const found = await discoverPages(options.site, query, options);
      notes.push(found.note);
      urls.push(...found.urls);
    }
    const titles = new Map((index?.pages ?? []).map((p) => [p.url, p.title]));
    const unique = [...new Set(urls)].filter((url) => !options.store?.get(url));
    const pages = await Promise.all(
      unique.map(async (url) => ({ url, result: await fetchPage(url, options) })),
    );
    for (const { url, result } of pages) {
      if (!result.ok) {
        if (asked.includes(url)) notes.push(`could not read ${url} (${result.error})`);
        continue;
      }
      // The page's main content with headings kept: navigation, scripts and app payloads dropped.
      const text = pageToText(result.text, result.contentType, result.url);
      const title = titles.get(url) ?? pageTitle(result.text, text, url);
      options.store?.add({ url, title, text, origin: 'fetched now' });
      for (const passage of splitPassages(text)) {
        candidates.push({ url, title, text: passage, source: 'live' });
      }
    }
  }

  const ranked = rank(query, candidates, (p) => `${p.title} ${p.text}`);
  const seen = new Set<string>();
  const results: DocPassage[] = [];
  for (const { item } of ranked) {
    const key = item.text.slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(item);
    if (results.length >= limit) break;
  }
  return { passages: results, notes };
}

function sourceLabel(passage: DocPassage): string {
  if (passage.source === 'saved') return `saved ${passage.retrieved ?? 'earlier'}`;
  if (passage.source === 'run') return 'read this run';
  return passage.source;
}

export function formatPassages(
  provider: string,
  query: string,
  passages: DocPassage[],
  index?: DocsIndex,
  extra: { notes?: string[]; docsUrls?: string[] } = {},
): string {
  const notes = (extra.notes ?? []).map((note) => `Note: ${note}`);
  if (passages.length === 0) {
    const pages = [
      ...(index?.pages ?? []).slice(0, 8).map((p) => `- ${p.title}: ${p.url}`),
      ...(extra.docsUrls ?? []).slice(0, 8).map((url) => `- ${url}`),
    ];
    return [
      `No ${provider} docs passages matched "${query}". Try other words, or read these pages directly:`,
      ...(pages.length
        ? pages
        : [
            '- (no snapshot index for this provider: pass "urls" with docs pages, or "site" with the docs host)',
          ]),
      ...notes,
    ].join('\n');
  }
  const lines = passages.map((p, i) => {
    const text = p.text.length > 900 ? `${p.text.slice(0, 900)}...` : p.text;
    return `[${i + 1}] ${p.title} (${sourceLabel(p)}) ${p.url}\n${text}`;
  });
  const footer = index
    ? `\nSnapshot passages were taken on ${index.retrieved}; live passages are fetched now. Confirm anything important on the linked page.`
    : '\nConfirm anything important on the linked page.';
  return [lines.join('\n\n'), ...notes].join('\n') + footer;
}

export function createSearchDocsTool(
  provider: string,
  options: SearchDocsOptions & { name?: string } = {},
): AgentTool {
  const { name, ...searchOptions } = options;
  return defineTool({
    name: name ?? `${provider}_search_docs`,
    description: `Search ${provider} documentation and return the most relevant passages with links: a dated local snapshot when there is one, pages saved or read earlier in this run, and, when online, current pages, including any "urls" you pass or pages found through a docs "site" sitemap. Use it to check how an API, field or version behaves before or after editing.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to look for, e.g. an operation, field or error.',
        },
        url: { type: 'string', description: 'Optional docs page to fetch and search as well.' },
        urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'More docs pages to fetch and search.',
        },
        site: {
          type: 'string',
          description:
            'A docs host or URL whose sitemap is used to find matching pages, e.g. docs.example.com.',
        },
        live: { type: 'boolean', description: 'Fetch current pages too (default true).' },
        limit: { type: 'number', description: 'Maximum passages to return (default 5).' },
      },
      required: ['query'],
    },
    run: async (input) => {
      const query = str(input, 'query');
      if (!query) return 'Pass a "query" describing what to look for in the docs.';
      const index = searchOptions.index ?? loadDocsIndex(provider);
      const urls = Array.isArray(input.urls)
        ? input.urls.filter((u): u is string => typeof u === 'string')
        : undefined;
      const { passages, notes } = await searchDocsWithNotes(provider, query, {
        ...searchOptions,
        index,
        url: str(input, 'url') ?? searchOptions.url,
        urls: urls ?? searchOptions.urls,
        site: str(input, 'site') ?? searchOptions.site,
        live: bool(input, 'live') ?? searchOptions.live,
        limit: num(input, 'limit') ?? searchOptions.limit,
      });
      return formatPassages(provider, query, passages, index, {
        notes,
        docsUrls: searchOptions.docsUrls,
      });
    },
  });
}
