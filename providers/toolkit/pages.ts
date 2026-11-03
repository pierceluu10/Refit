// Pages as text for the generic tools: HTML, Markdown, RSS/Atom feeds and GitHub release lists
// become readable text with headings kept, so changelogs can be split into entries. A PageStore
// keeps every page the tools fetched in a run, so the docs search can search them later.

import { rank } from './text.ts';

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '-',
  ndash: '-',
  hellip: '...',
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const n =
        code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

function tidy(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/[ \t\f\v ]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** HTML to text that keeps headings (as `#`) and list items (as `-`). Navigation is dropped. */
export function htmlPageToText(html: string): string {
  const main = /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(html);
  const body = main && main[1].length > 500 ? main[1] : html;
  const text = body
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, inner: string) => inner)
    .replace(/<(script|style|noscript|svg|head|nav|aside|footer|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, level: string) => `\n${'#'.repeat(Number(level))} `)
    .replace(
      /<\/(p|div|section|article|header|li|ul|ol|h[1-6]|tr|table|pre|blockquote|dt|dd)>/gi,
      '\n',
    )
    .replace(/<\/?(a|code|span|strong|em|b|i|u|kbd|var|abbr|sup|sub|mark|small|time)\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, ' ');
  return tidy(decodeEntities(text));
}

type FeedEntry = { title: string; date?: string; link?: string; body: string };

function tag(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return match ? match[1].trim() : undefined;
}

function feedText(fragment: string | undefined): string {
  if (!fragment) return '';
  const inner = fragment.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1');
  const decoded = /<\/?[a-z][^>]*>/i.test(inner) ? inner : decodeEntities(inner);
  return /<\/?[a-z][^>]*>/i.test(decoded) ? htmlPageToText(decoded) : tidy(decoded);
}

/** RSS 2.0 or Atom entries, newest first as the feed lists them. */
export function parseFeed(xml: string): FeedEntry[] {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  return blocks.map((block) => {
    const href = /<link\b[^>]*href="([^"]+)"/i.exec(block)?.[1];
    return {
      title: feedText(tag(block, 'title')),
      date: tag(block, 'pubDate') ?? tag(block, 'updated') ?? tag(block, 'published'),
      link: href ?? feedText(tag(block, 'link')),
      body: feedText(tag(block, 'content') ?? tag(block, 'description') ?? tag(block, 'summary')),
    };
  });
}

type GitHubRelease = {
  tag_name?: string;
  name?: string | null;
  published_at?: string | null;
  html_url?: string;
  body?: string | null;
  prerelease?: boolean;
  draft?: boolean;
};

export function githubReleasesText(releases: GitHubRelease[]): string {
  return releases
    .filter((release) => !release.draft)
    .map((release) =>
      [
        `## ${release.name || release.tag_name} (${release.tag_name ?? '?'}, published ${release.published_at?.slice(0, 10) ?? '?'}${release.prerelease ? ', prerelease' : ''})`,
        release.html_url ?? '',
        (release.body ?? '').trim(),
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
}

export type PageKind = 'html' | 'feed' | 'github-releases' | 'json' | 'markdown' | 'text';

export function detectKind(raw: string, contentType = '', url = ''): PageKind {
  const type = contentType.toLowerCase();
  const head = raw.trimStart().slice(0, 400);
  if (/^\[\s*\{/.test(head) && /"tag_name"/.test(raw.slice(0, 4000))) return 'github-releases';
  if (type.includes('json') || /^[[{]/.test(head)) return 'json';
  if (/(rss|atom)/.test(type) || /<(rss|feed)\b/i.test(head) || /\.(rss|atom)$/i.test(url)) {
    return 'feed';
  }
  if (type.includes('xml') && /<(rss|feed)\b/i.test(raw.slice(0, 2000))) return 'feed';
  if (type.includes('html') || /^<(!doctype|html|head|body|div)/i.test(head)) return 'html';
  if (type.includes('markdown') || /\.(md|markdown|mdx)$/i.test(url.split('?')[0])) {
    return 'markdown';
  }
  // A fragment with no doctype and no content type, as some servers and test doubles send.
  if (
    /<\/?(p|div|h[1-6]|ul|ol|li|span|table|section|article|main|br)\b[^>]*>/i.test(
      raw.slice(0, 2000),
    )
  ) {
    return 'html';
  }
  return 'text';
}

/** Raw response text to readable text, by content type and shape. */
export function pageToText(raw: string, contentType = '', url = ''): string {
  const kind = detectKind(raw, contentType, url);
  switch (kind) {
    case 'github-releases':
      try {
        return githubReleasesText(JSON.parse(raw) as GitHubRelease[]);
      } catch {
        return tidy(raw);
      }
    case 'feed':
      return parseFeed(raw)
        .map((entry) =>
          [`## ${entry.title}${entry.date ? ` (${entry.date})` : ''}`, entry.link, entry.body]
            .filter(Boolean)
            .join('\n'),
        )
        .join('\n\n');
    case 'html':
      return htmlPageToText(raw);
    case 'json':
      try {
        return JSON.stringify(JSON.parse(raw), null, 1);
      } catch {
        return raw.trim();
      }
    default:
      return raw.replace(/\r/g, '').trim();
  }
}

export function pageTitle(raw: string, text: string, url: string): string {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(raw.slice(0, 20_000))?.[1];
  if (title && !/<(rss|feed)\b/i.test(raw.slice(0, 400))) return decodeEntities(title).trim();
  const heading = /^#{1,2} (.+)$/m.exec(text)?.[1];
  return heading?.trim() || url;
}

// ---------------------------------------------------------------------------------------------
// Changelog entries

export type Entry = { heading: string; text: string; version?: string; date?: string };

const VERSION_IN_HEADING =
  /(?:^|[\s[(@/v])v?(\d+\.\d+(?:\.\d+)?(?:[-.]?[0-9A-Za-z.]+)?)(?=$|[\s\]),:])/;
const ISO_DATE = /\b(\d{4}-\d{2}-\d{2})\b/;
const MONTHS =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const LONG_DATE = new RegExp(
  `\\b((?:${MONTHS})\\.? \\d{1,2}(?:st|nd|rd|th)?,? \\d{4}|\\d{1,2}(?:st|nd|rd|th)? (?:${MONTHS})\\.?,? \\d{4})\\b`,
  'i',
);

/** The ISO date a heading or line mentions, if any (ISO or "March 3, 2026" / "3 March 2026"). */
export function findDate(text: string): string | undefined {
  const iso = ISO_DATE.exec(text);
  if (iso) return iso[1];
  const long = LONG_DATE.exec(text);
  if (!long) return undefined;
  const parsed = new Date(
    `${long[1]
      .replace(/\./g, '')
      .replace(/,/g, '')
      .replace(/(\d)(st|nd|rd|th)\b/i, '$1')} UTC`,
  );
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
}

export function findVersion(heading: string): string | undefined {
  return VERSION_IN_HEADING.exec(heading)?.[1];
}

/**
 * Split changelog text into entries at headings: Markdown `#` headings, underlined headings, or a
 * line that is only a version or a date. Text before the first heading is kept as its own entry.
 */
export function splitEntries(text: string): Entry[] {
  const lines = text.split('\n');
  const entries: Entry[] = [];
  // Split at the heading level that carries versions or dates ("## 1.2.0"), so the "### Fixes"
  // under each one stays in its entry. Without such headings, every heading splits.
  let splitLevel = 4;
  const levels = lines
    .map((line) => /^(#{1,4}) (.+)$/.exec(line))
    .filter((m): m is RegExpExecArray => !!m && !!(findVersion(m[2]) || findDate(m[2])))
    .map((m) => m[1].length);
  if (levels.length) splitLevel = Math.min(...levels);
  let heading = '';
  let body: string[] = [];
  const flush = () => {
    const content = body.join('\n').trim();
    if (!heading && !content) return;
    entries.push({
      heading,
      text: content,
      version: heading ? findVersion(heading) : undefined,
      date: heading ? findDate(heading) : undefined,
    });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1] ?? '';
    const level = /^(#{1,4}) \S/.exec(line)?.[1].length;
    const markdown = level !== undefined && level <= splitLevel;
    const underlined = line.trim() !== '' && /^(=+|-+)\s*$/.test(next) && next.trim().length >= 3;
    const bare =
      line.length < 80 &&
      /^\s*\[?v?\d+\.\d+(?:\.\d+)?[^\s]*\]?(?:\s*[-(–]\s*.{0,40})?\s*$/.test(line) &&
      !/^\s*[-*]/.test(line);
    if (markdown || underlined || bare) {
      flush();
      heading = line.replace(/^#+\s*/, '').trim();
      body = [];
      if (underlined) i++;
      continue;
    }
    body.push(line);
  }
  flush();
  return entries;
}

// ---------------------------------------------------------------------------------------------
// The pages fetched in a run

export type StoredPage = {
  url: string;
  title: string;
  text: string;
  /** Where the text came from: fetched now, or saved earlier (with its date). */
  origin: string;
};

export class PageStore {
  private readonly byUrl = new Map<string, StoredPage>();

  add(page: StoredPage): void {
    if (!page.text.trim()) return;
    this.byUrl.set(page.url, page);
  }

  get(url: string): StoredPage | undefined {
    return this.byUrl.get(url);
  }

  get pages(): StoredPage[] {
    return [...this.byUrl.values()];
  }

  get size(): number {
    return this.byUrl.size;
  }

  /** Rank the stored pages' titles and URLs against a query, for choosing pages to read. */
  rankPages(query: string): StoredPage[] {
    return rank(query, this.pages, (page) => `${page.title} ${page.url}`).map((r) => r.item);
  }
}
