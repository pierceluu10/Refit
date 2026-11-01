import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentTool } from '../../shared/types.ts';
import { fetchText, resolveFetch, type NetworkOptions } from './fetch.ts';
import { htmlToText, rank, splitPassages } from './text.ts';
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

export type DocPassage = { url: string; title: string; text: string; source: 'snapshot' | 'live' };

export type SearchDocsOptions = NetworkOptions & {
  /** Override the snapshot index (tests, or a provider that builds one in memory). */
  index?: DocsIndex;
  /** Fetch the best-matching pages live and rank their current text too. Default true. */
  live?: boolean;
  /** A specific docs page to fetch and search, in addition to the index. */
  url?: string;
  limit?: number;
};

const PROVIDER_NAME = /^[a-z0-9-]+$/;

export function loadDocsIndex(provider: string): DocsIndex | undefined {
  if (!PROVIDER_NAME.test(provider)) return undefined;
  const url = new URL(`../${provider}/tools-data/docs-index.json`, import.meta.url);
  const path = fileURLToPath(url);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as DocsIndex;
}

/** Search a provider's docs. Snapshot passages always; live page text when the network is available. */
export async function searchDocs(
  provider: string,
  query: string,
  options: SearchDocsOptions = {},
): Promise<DocPassage[]> {
  const index = options.index ?? loadDocsIndex(provider);
  const limit = options.limit ?? 5;
  const snapshot: DocPassage[] = (index?.pages ?? []).flatMap((page) =>
    page.passages.map((text) => ({
      url: page.url,
      title: page.title,
      text,
      source: 'snapshot' as const,
    })),
  );
  const candidates = [...snapshot];

  const wantLive = options.live !== false && resolveFetch(options) !== null;
  if (wantLive) {
    const pageScores = rank(
      query,
      index?.pages ?? [],
      (p) => `${p.title} ${p.url} ${p.passages.join(' ')}`,
    );
    const urls = pageScores.slice(0, 2).map((entry) => entry.item.url);
    if (options.url && /^https?:\/\//.test(options.url)) urls.unshift(options.url);
    const titles = new Map((index?.pages ?? []).map((p) => [p.url, p.title]));
    const pages = await Promise.all(
      [...new Set(urls)].map(async (url) => ({ url, result: await fetchText(url, options) })),
    );
    for (const { url, result } of pages) {
      if (!result.ok) continue;
      const text = /<\w+[^>]*>/.test(result.text) ? htmlToText(result.text) : result.text;
      for (const passage of splitPassages(text)) {
        candidates.push({ url, title: titles.get(url) ?? url, text: passage, source: 'live' });
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
  return results;
}

export function formatPassages(
  provider: string,
  query: string,
  passages: DocPassage[],
  index?: DocsIndex,
): string {
  if (passages.length === 0) {
    const pages = (index?.pages ?? []).slice(0, 8).map((p) => `- ${p.title}: ${p.url}`);
    return [
      `No ${provider} docs passages matched "${query}". Try other words, or read these pages directly:`,
      ...(pages.length ? pages : ['- (no snapshot index for this provider)']),
    ].join('\n');
  }
  const lines = passages.map((p, i) => {
    const text = p.text.length > 900 ? `${p.text.slice(0, 900)}...` : p.text;
    return `[${i + 1}] ${p.title} (${p.source}) ${p.url}\n${text}`;
  });
  const footer = index
    ? `\nSnapshot passages were taken on ${index.retrieved}; live passages are fetched now. Confirm anything important on the linked page.`
    : '';
  return `${lines.join('\n\n')}${footer}`;
}

export function createSearchDocsTool(provider: string, options: SearchDocsOptions = {}): AgentTool {
  return defineTool({
    name: `${provider}_search_docs`,
    description: `Search ${provider} documentation (a dated local snapshot plus, when online, the current pages) and return the most relevant passages with links. Use it to check how an API, field or version behaves before or after editing.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to look for, e.g. an operation, field or error.',
        },
        url: { type: 'string', description: 'Optional docs page to fetch and search as well.' },
        live: { type: 'boolean', description: 'Fetch current pages too (default true).' },
        limit: { type: 'number', description: 'Maximum passages to return (default 5).' },
      },
      required: ['query'],
    },
    run: async (input) => {
      const query = str(input, 'query');
      if (!query) return 'Pass a "query" describing what to look for in the docs.';
      const index = options.index ?? loadDocsIndex(provider);
      const passages = await searchDocs(provider, query, {
        ...options,
        index,
        url: str(input, 'url') ?? options.url,
        live: bool(input, 'live') ?? options.live,
        limit: num(input, 'limit') ?? options.limit,
      });
      return formatPassages(provider, query, passages, index);
    },
  });
}
