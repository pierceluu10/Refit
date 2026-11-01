// Reading tools shared by the watcher and the knowledge drafter. They hand the
// agent page text and let it check its own quotes. They never decide relevance.

import type { LoopTool } from './agent.ts';
import { containsQuote, lineDiff, type FetchedPage, type Fetcher } from './fetch.ts';
import type { ProviderSource } from './types.ts';

export const PAGE_CHUNK_CHARS = 15_000;

export class PageReader {
  readonly pages = new Map<string, FetchedPage>();
  readonly fetcher: Fetcher;
  readonly sources: ProviderSource[];
  constructor(fetcher: Fetcher, sources: ProviderSource[]) {
    this.fetcher = fetcher;
    this.sources = sources;
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

  async read(url: string, format?: ProviderSource['format']): Promise<FetchedPage> {
    const cached = this.pages.get(url);
    if (cached) return cached;
    const page = await this.fetcher.fetch(url, format);
    this.pages.set(url, page);
    return page;
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
        const more =
          end < page.text.length ? `\n[more: call again with offset ${end}]` : '\n[end of page]';
        return {
          content: `URL: ${page.url}\nStatus: ${page.status}\nRead at: ${page.fetchedAt}\nCharacters ${offset}-${end} of ${page.text.length}\n\n${chunk}${more}`,
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
