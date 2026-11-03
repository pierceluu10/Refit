// Reading tools shared by the watcher and the knowledge drafter. They hand the
// agent page text and let it check its own quotes. They never decide relevance.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoopTool } from './agent.ts';
import {
  containsQuote,
  lineDiff,
  type FetchedPage,
  type Fetcher,
  type SnapshotManifest,
} from './fetch.ts';
import type { ProviderSource } from './types.ts';

export const PAGE_CHUNK_CHARS = 15_000;

export class PageReader {
  readonly pages = new Map<string, FetchedPage>();
  /** The character ranges of each page the agent was shown, by URL, as [start, end). */
  readonly shownRanges = new Map<string, [number, number][]>();
  readonly fetcher: Fetcher;
  readonly sources: ProviderSource[];
  constructor(fetcher: Fetcher, sources: ProviderSource[]) {
    this.fetcher = fetcher;
    this.sources = sources;
  }

  /** Adds a page the agent did not fetch itself, such as a package registry summary. */
  add(page: FetchedPage): void {
    this.pages.set(page.url, page);
  }

  /** Records that the agent saw characters [start, end) of a page, so a saved fixture keeps them. */
  shown(url: string, start: number, end: number): void {
    if (end <= start) return;
    this.shownRanges.set(url, [...(this.shownRanges.get(url) ?? []), [start, end]]);
  }

  /** The text the agent was shown of a page: its shown ranges, merged, with gaps marked. */
  shownText(url: string): string {
    const page = this.pages.get(url);
    if (!page) return '';
    const ranges = [...(this.shownRanges.get(url) ?? [])].sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const [start, end] of ranges) {
      const last = merged.at(-1);
      if (last && start <= last[1]) last[1] = Math.max(last[1], end);
      else merged.push([start, end]);
    }
    let text = '';
    let at = 0;
    for (const [start, end] of merged) {
      if (start > at) text += `${text ? '\n' : ''}[... ${start - at} characters not shown ...]\n`;
      text += page.text.slice(start, Math.min(end, page.text.length));
      at = end;
    }
    if (at < page.text.length && merged.length)
      text += `\n[... ${page.text.length - at} characters not shown ...]`;
    return text;
  }

  resolve(
    input: Record<string, unknown>,
  ): { url: string; format?: ProviderSource['format'] } | undefined {
    const id = typeof input.source_id === 'string' ? input.source_id : undefined;
    if (id) {
      const source = this.sources.find((candidate) => candidate.id === id);
      return source ? { url: source.url, format: source.format } : undefined;
    }
    const url = typeof input.url === 'string' ? input.url : undefined;
    if (!url) return undefined;
    const known = this.sources.find((candidate) => candidate.url === url);
    return { url, format: known?.format };
  }

  private readonly inflight = new Map<string, Promise<FetchedPage>>();

  async read(url: string, format?: ProviderSource['format']): Promise<FetchedPage> {
    const cached = this.pages.get(url);
    if (cached) return cached;
    // Reads of one page that start together share one fetch.
    let pending = this.inflight.get(url);
    if (!pending) {
      pending = this.fetcher.fetch(url, format).then((page) => {
        this.pages.set(url, page);
        return page;
      });
      this.inflight.set(url, pending);
      void pending.finally(() => this.inflight.delete(url)).catch(() => {});
    }
    return pending;
  }

  /** The URL under which a page was read, ignoring a #fragment and a trailing slash. */
  pageFor(url: string): string | undefined {
    if (this.pages.get(url)?.text) return url;
    const bare = (u: string) => u.replace(/#.*$/, '').replace(/\/+$/, '');
    const want = bare(url);
    for (const [pageUrl, page] of this.pages)
      if (page.text && bare(pageUrl) === want) return pageUrl;
    return undefined;
  }

  /** Where a quote appears among the pages read so far. */
  findQuote(quote: string, url?: string): string[] {
    const hits: string[] = [];
    for (const [pageUrl, page] of this.pages) {
      if (url && pageUrl !== url) continue;
      if (containsQuote(page.text, quote)) hits.push(pageUrl);
    }
    return hits;
  }

  get readUrls(): string[] {
    return [...this.pages.entries()].filter(([, page]) => page.ok).map(([url]) => url);
  }
}

/**
 * Saves every page a run read as a snapshot that snapshotFetcher replays. Each
 * page keeps only the parts the agent was shown (at most maxChars), with the
 * gaps marked, so quotes from the run still check offline and the fixture is
 * not a mirror of the docs.
 */
export function savePages(
  reader: PageReader,
  dir: string,
  options: { provider: string; maxChars?: number; note?: string; fetchedAt?: string },
): SnapshotManifest {
  mkdirSync(dir, { recursive: true });
  const maxChars = options.maxChars ?? 120_000;
  const used = new Set<string>();
  const sources: SnapshotManifest['sources'] = [];
  for (const [url, page] of reader.pages) {
    const text = reader.shownText(url).slice(0, maxChars);
    let base =
      url
        .replace(/^https:\/\//, '')
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase()
        .slice(0, 90) || 'page';
    for (let n = 2; used.has(base); n++) base = `${base.slice(0, 86)}-${n}`;
    used.add(base);
    const file = `${base}.txt`;
    writeFileSync(join(dir, file), text.endsWith('\n') || !text ? text : `${text}\n`);
    sources.push({
      id: base,
      url,
      status: page.status,
      ok: page.ok,
      file,
      chars: text.length,
      truncated: text !== page.text,
      sha256: createHash('sha256').update(text).digest('hex'),
      ...(page.error ? { error: page.error } : {}),
    });
  }
  const manifest: SnapshotManifest = {
    provider: options.provider,
    fetchedAt: options.fetchedAt ?? new Date().toISOString(),
    note:
      options.note ??
      `Every page one run read, cut to what the agent was shown (at most ${maxChars} characters). Test input only.`,
    sources,
  };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function pageTools(reader: PageReader): LoopTool[] {
  return [
    {
      name: 'list_sources',
      description:
        "List the provider's known starting pages (changelog, release notes, SDK releases, deprecations, specs). You may also read any other public https page you find linked from them.",
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        return {
          content: reader.sources
            .map(
              (source) =>
                `${source.id} [${source.kind}] ${source.url}${source.note ? ` - ${source.note}` : ''}`,
            )
            .join('\n'),
        };
      },
    },
    {
      name: 'read_page',
      description: `Read a page as plain text, ${PAGE_CHUNK_CHARS} characters at a time. Pass source_id for a listed source, or url for any public https page. Use offset to read further.`,
      input_schema: {
        type: 'object',
        properties: {
          source_id: { type: 'string', description: 'Id from list_sources.' },
          url: { type: 'string', description: 'Any public https URL.' },
          offset: { type: 'integer', minimum: 0, description: 'Character offset to start from.' },
        },
        additionalProperties: false,
      },
      async run(input) {
        const target = reader.resolve(input);
        if (!target) return { content: 'Give a known source_id or a url.', isError: true };
        const page = await reader.read(target.url, target.format);
        if (!page.ok && !page.text) {
          return {
            content: `Could not read ${page.url}: ${page.error ?? `HTTP ${page.status}`}`,
            isError: true,
          };
        }
        const offset =
          typeof input.offset === 'number' && input.offset > 0 ? Math.floor(input.offset) : 0;
        const chunk = page.text.slice(offset, offset + PAGE_CHUNK_CHARS);
        const end = offset + chunk.length;
        reader.shown(page.url, offset, end);
        const more =
          end < page.text.length ? `\n[more: call again with offset ${end}]` : '\n[end of page]';
        const links = page.links?.length
          ? `\n[${page.links.length} links on this page: list_links shows them]`
          : '';
        return {
          content: `URL: ${page.url}\nStatus: ${page.status}\nRead at: ${page.fetchedAt}\nCharacters ${offset}-${end} of ${page.text.length}\n\n${chunk}${more}${links}`,
        };
      },
    },
    {
      name: 'search_page',
      description:
        'Find a word or phrase in a page (case-insensitive) and get the character offset of each match with the text around it, so read_page can jump there. Useful for long changelogs: search "2.0.0", "BREAKING" or "deprecat".',
      input_schema: {
        type: 'object',
        properties: {
          source_id: { type: 'string', description: 'Id from list_sources.' },
          url: { type: 'string', description: 'Any public https URL.' },
          query: { type: 'string' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async run(input) {
        const target = reader.resolve(input);
        const query = typeof input.query === 'string' ? input.query.trim().toLowerCase() : '';
        if (!target || !query)
          return { content: 'Give a query and a known source_id or a url.', isError: true };
        const page = await reader.read(target.url, target.format);
        if (!page.text)
          return {
            content: `Could not read ${page.url}: ${page.error ?? `HTTP ${page.status}`}`,
            isError: true,
          };
        const lower = page.text.toLowerCase();
        const hits: string[] = [];
        let total = 0;
        for (let at = lower.indexOf(query); at !== -1; at = lower.indexOf(query, at + 1)) {
          total++;
          if (hits.length >= 25) continue;
          const start = Math.max(0, at - 80);
          const snippet = page.text.slice(start, at + query.length + 160).replace(/\s+/g, ' ');
          reader.shown(page.url, start, Math.min(page.text.length, at + query.length + 160));
          hits.push(`- offset ${at}: ...${snippet}...`);
        }
        return {
          content: total
            ? `${total} match${total === 1 ? '' : 'es'} in ${page.url} (${page.text.length} characters)${total > hits.length ? `, first ${hits.length} shown` : ''}:\n${hits.join('\n')}`
            : `No match for "${query}" in ${page.url} (${page.text.length} characters).`,
        };
      },
    },
    {
      name: 'list_links',
      description:
        'List the links on a page (absolute URLs with their link text), optionally only those whose URL or text contains a word you give. Use it to follow a changelog, deprecations or migration link from a docs page, sitemap or llms.txt.',
      input_schema: {
        type: 'object',
        properties: {
          source_id: { type: 'string', description: 'Id from list_sources.' },
          url: { type: 'string', description: 'Any public https URL.' },
          contains: { type: 'string', description: 'Keep links whose URL or text has this.' },
        },
        additionalProperties: false,
      },
      async run(input) {
        const target = reader.resolve(input);
        if (!target) return { content: 'Give a known source_id or a url.', isError: true };
        const page = await reader.read(target.url, target.format);
        if (!page.ok && !page.text)
          return {
            content: `Could not read ${page.url}: ${page.error ?? `HTTP ${page.status}`}`,
            isError: true,
          };
        const word = typeof input.contains === 'string' ? input.contains.toLowerCase() : '';
        const links = (page.links ?? []).filter(
          (link) =>
            !word ||
            link.url.toLowerCase().includes(word) ||
            link.text.toLowerCase().includes(word),
        );
        if (!page.links?.length)
          return {
            content: `No links were kept for ${page.url} (saved pages and JSON keep none). Its text may still name URLs: read_page shows it.`,
          };
        const shown = links.slice(0, 200);
        return {
          content: `${links.length} of ${page.links.length} links on ${page.url}${word ? ` contain "${word}"` : ''}${links.length > shown.length ? `, first ${shown.length} shown` : ''}:\n${shown
            .map((link) => `- ${link.url}${link.text ? ` (${link.text})` : ''}`)
            .join('\n')}`,
        };
      },
    },
    {
      name: 'check_quote',
      description:
        'Check that a quote appears word for word (ignoring whitespace and curly quotes) in a page you already read. Use it before submitting.',
      input_schema: {
        type: 'object',
        properties: {
          quote: { type: 'string' },
          url: { type: 'string', description: 'Limit the check to this page.' },
        },
        required: ['quote'],
        additionalProperties: false,
      },
      async run(input) {
        const quote = typeof input.quote === 'string' ? input.quote : '';
        const hits = reader.findQuote(quote, typeof input.url === 'string' ? input.url : undefined);
        return {
          content: hits.length
            ? `Found in: ${hits.join(', ')}`
            : 'Not found in any page read so far.',
        };
      },
    },
    {
      name: 'diff_pages',
      description:
        'Line diff between two pages, for example two versions of an OpenAPI spec or GraphQL schema. Shows lines only in before (-) and only in after (+).',
      input_schema: {
        type: 'object',
        properties: {
          before_url: { type: 'string' },
          after_url: { type: 'string' },
        },
        required: ['before_url', 'after_url'],
        additionalProperties: false,
      },
      async run(input) {
        const before = await reader.read(String(input.before_url));
        const after = await reader.read(String(input.after_url));
        if (!before.text || !after.text) {
          return {
            content: `Could not read both pages (${before.error ?? 'ok'}; ${after.error ?? 'ok'}).`,
            isError: true,
          };
        }
        return { content: lineDiff(before.text, after.text) };
      },
    },
  ];
}
