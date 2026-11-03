// fetch_changelog: read a provider's changelog, release notes, feed or GitHub releases as dated
// entries the agent can filter. It shows what the page says; the agent decides what matters.

import type { AgentTool } from '../../shared/types.ts';
import { fetchPage, type NetworkOptions } from './fetch.ts';
import { githubRepo, rawGithubUrl } from './packages.ts';
import { findDate, pageToText, splitEntries, type Entry, type PageStore } from './pages.ts';
import { rank } from './text.ts';
import { defineTool, num, str } from './tool.ts';
import { compareVersions, parseVersion } from './versions.ts';

export type KnownSource = { label: string; url: string; note?: string };

const PAGE_CHARS = 12_000;
const ENTRY_CHARS = 1_500;

/** Where to read: a GitHub repo (or owner/repo) becomes its releases API, a blob link its raw file. */
export function changelogTarget(raw: string): { url: string; github?: string } {
  const value = raw.trim();
  const repo = githubRepo(value);
  const isRepoRoot =
    repo &&
    (/^[\w.-]+\/[\w.-]+$/.test(value) ||
      /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?\/?(?:releases\/?)?$/.test(value));
  if (repo && isRepoRoot) {
    return {
      url: `${repo.replace('https://github.com/', 'https://api.github.com/repos/')}/releases?per_page=50`,
      github: repo,
    };
  }
  return { url: rawGithubUrl(value) };
}

export type ChangelogInput = {
  url?: string;
  since?: string;
  query?: string;
  offset?: number;
  limit?: number;
};

function keepSince(entries: Entry[], since: string): { kept: Entry[]; undated: number } {
  const date = /^\d{4}-\d{2}(-\d{2})?$/.test(since) ? since : findDate(since);
  const version = date ? undefined : parseVersion(since) ? since : undefined;
  let undated = 0;
  const kept = entries.filter((entry) => {
    if (date) {
      if (!entry.date) {
        undated++;
        return false;
      }
      return entry.date >= date;
    }
    if (version) {
      if (!entry.version) {
        undated++;
        return false;
      }
      return compareVersions(entry.version, version) > 0;
    }
    return true;
  });
  return { kept, undated };
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[entry cut at ${max} characters]` : text;
}

export async function changelogReport(
  input: ChangelogInput,
  options: NetworkOptions & { store?: PageStore; sources?: KnownSource[]; provider: string },
): Promise<string> {
  const { store, sources = [], provider, ...network } = options;
  if (!input.url) {
    const lines = sources.length
      ? sources.map((s) => `- ${s.label}: ${s.url}${s.note ? ` (${s.note})` : ''}`)
      : ['- none recorded for this provider yet'];
    return [
      `Known ${provider} changelog, release-note and deprecation pages:`,
      ...lines,
      'Pass "url" (a page, an RSS/Atom feed, a CHANGELOG.md, or a GitHub repo as owner/repo for its releases). Add "since" (a date or version) or "query" to narrow it.',
    ].join('\n');
  }
  const target = changelogTarget(input.url);
  let page = await fetchPage(target.url, {
    ...network,
    headers: target.github ? { accept: 'application/vnd.github+json' } : undefined,
  });
  let note = '';
  if (!page.ok && target.github) {
    // The releases API is rate limited without a token; the Atom feed is not, but lists only the latest.
    const feed = `${target.github}/releases.atom`;
    const fallback = await fetchPage(feed, network);
    if (fallback.ok) {
      note = `The releases API answered ${page.error}; this is the releases feed, which lists only the latest entries.`;
      page = fallback;
    }
  }
  if (!page.ok) {
    return `Could not read ${target.url}: ${page.error}. Try another page from the provider's docs, or fetch_url for the raw response.`;
  }
  const text = pageToText(page.text, page.contentType, page.url);
  store?.add({ url: page.url, title: target.github ?? page.url, text, origin: 'fetched now' });
  const header = [`Read ${page.url} (HTTP ${page.status}, ${text.length} characters).`];
  if (note) header.push(note);

  if (text.trim().length < 200) {
    return [
      ...header,
      `The page has almost no readable text${text.trim() ? `: "${text.trim()}"` : ''}. It is probably drawn in the browser by script, so the server sends none.`,
      'Try its RSS or Atom feed, a CHANGELOG.md or GitHub releases (owner/repo), a docs page that links the same entries, or search_docs with the docs "site".',
    ].join('\n');
  }
  const entries = splitEntries(text).filter((entry) => entry.heading || entry.text.length > 40);
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  if (entries.length <= 1) {
    const slice = text.slice(offset, offset + PAGE_CHARS);
    const end = offset + slice.length;
    return [
      ...header,
      'No dated or versioned headings found, so here is the text as is.',
      '',
      slice,
      end < text.length ? `\n[more: call again with offset ${end}]` : '\n[end of page]',
    ].join('\n');
  }

  let chosen = entries;
  const filters: string[] = [];
  if (input.since) {
    const { kept, undated } = keepSince(chosen, input.since);
    chosen = kept;
    filters.push(
      `after ${input.since}: ${kept.length} of ${entries.length} entries${undated ? ` (${undated} without a date or version left out)` : ''}`,
    );
  }
  if (input.query) {
    const ranked = rank(input.query, chosen, (e) => `${e.heading} ${e.text}`).map((r) => r.item);
    filters.push(`matching "${input.query}": ${ranked.length} entries, best first`);
    chosen = ranked;
  }
  const limit = Math.max(1, Math.floor(input.limit ?? 15));
  const shown = chosen.slice(offset, offset + limit);
  const body: string[] = [];
  let used = 0;
  for (const entry of shown) {
    const block = `## ${entry.heading || '(top of page)'}\n${cut(entry.text, ENTRY_CHARS)}`;
    if (used + block.length > PAGE_CHARS && body.length) break;
    body.push(block);
    used += block.length;
  }
  const next = offset + body.length;
  return [
    ...header,
    `${entries.length} entries${filters.length ? `; ${filters.join('; ')}` : ''}. Showing ${body.length} from offset ${offset}.`,
    '',
    body.join('\n\n') || '(no entries left after the filters)',
    next < chosen.length ? `\n[more: call again with offset ${next}]` : '\n[end of entries]',
    'Quote the page word for word when you cite it in the PR.',
  ].join('\n');
}

export function createChangelogTool(
  options: NetworkOptions & { store?: PageStore; sources?: KnownSource[]; provider: string },
): AgentTool {
  return defineTool({
    name: 'fetch_changelog',
    description: `Read a ${options.provider} changelog, release-notes or deprecations page, an RSS/Atom feed, a CHANGELOG.md, or a GitHub repo's releases (owner/repo), split into entries you can filter by "since" (a date or version) and "query". With no url it lists the provider's known pages. Informational; pages it reads become searchable with the docs search.`,
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Page or feed URL, or owner/repo for GitHub releases.',
        },
        since: {
          type: 'string',
          description: 'Keep entries after this date (YYYY-MM-DD) or version.',
        },
        query: {
          type: 'string',
          description: 'Rank entries by these words, e.g. an endpoint or field.',
        },
        offset: { type: 'number', description: 'Entry (or character) offset for the next page.' },
        limit: { type: 'number', description: 'Entries to show (default 15).' },
      },
    },
    run: async (input) =>
      changelogReport(
        {
          url: str(input, 'url') ?? str(input, 'repo'),
          since: str(input, 'since'),
          query: str(input, 'query'),
          offset: num(input, 'offset'),
          limit: num(input, 'limit'),
        },
        options,
      ),
  });
}
