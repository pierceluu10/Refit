import { parse } from 'parse5';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { digest, isObject } from './specifications.ts';
import { fetchSpecificationResponse, readBoundedResponse } from './network.ts';
import { PipelineInputError } from './types.ts';

const DOWNLOAD_TIMEOUT_MS = 30_000;
export const MAX_DOCUMENTATION_BYTES = 1024 * 1024;
export const MAX_DOCUMENTATION_SOURCES = 8;
const HTML_CONTENT_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const TEXT_CONTENT_TYPES = new Set(['text/plain', 'text/markdown', 'text/x-markdown']);
const FEED_CONTENT_TYPES = new Set([
  'application/atom+xml',
  'application/rss+xml',
  'application/xml',
  'text/xml',
]);
const MAX_DOCUMENTATION_FEED_ENTRIES = 250;
const XML_ENTITY_LIMITS = {
  enabled: true,
  maxEntitySize: 1024,
  maxExpansionDepth: 4,
  maxTotalExpansions: MAX_DOCUMENTATION_BYTES,
  maxExpandedLength: MAX_DOCUMENTATION_BYTES,
  maxEntityCount: 100,
};
const IGNORED_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'svg',
  'template',
  'nav',
  'footer',
  'aside',
]);
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'blockquote',
  'br',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'li',
  'main',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
]);
const ETAG = /^[^\r\n]{1,1024}$/;

interface HtmlNode {
  nodeName?: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: HtmlNode[];
}

export interface DocumentationSource {
  label: string;
  url: string;
}

export interface CapturedDocumentation {
  formatVersion: 1;
  kind: 'refit-documentation-snapshot';
  label: string;
  url: string;
  revision: string;
  hash: string;
  content: string;
  contentType: string;
  etag?: string;
}

export function normalizeDocumentationSource(value: unknown): DocumentationSource {
  if (
    !isObject(value) ||
    Object.keys(value).sort().join(',') !== 'label,url' ||
    typeof value.label !== 'string' ||
    typeof value.url !== 'string'
  )
    throw new PipelineInputError('Documentation sources require exactly a label and URL.');
  const label = value.label.trim();
  if (!label || label.length > 100 || /[\u0000-\u001f\u007f]/.test(label))
    throw new PipelineInputError(
      'Documentation source labels must contain 1–100 printable characters.',
    );
  let parsed: URL;
  try {
    parsed = new URL(value.url);
  } catch (cause) {
    throw new PipelineInputError('Documentation sources require a valid public HTTPS URL.', {
      cause,
    });
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.search
  )
    throw new PipelineInputError(
      'Documentation sources require a public HTTPS URL without credentials, fragments or query parameters.',
    );
  return { label, url: parsed.href };
}

export function validateDocumentationSnapshot(
  value: unknown,
  source: DocumentationSource,
): CapturedDocumentation {
  const normalizedSource = normalizeDocumentationSource(source);
  if (
    !isObject(value) ||
    value.formatVersion !== 1 ||
    value.kind !== 'refit-documentation-snapshot' ||
    value.label !== normalizedSource.label ||
    value.url !== normalizedSource.url ||
    typeof value.content !== 'string' ||
    Buffer.byteLength(value.content) > MAX_DOCUMENTATION_BYTES ||
    typeof value.contentType !== 'string' ||
    typeof value.hash !== 'string' ||
    value.hash !== digest(value.content) ||
    value.revision !== value.hash ||
    (value.etag !== undefined && (typeof value.etag !== 'string' || !ETAG.test(value.etag)))
  )
    throw new PipelineInputError('Documentation snapshot provenance or content hash is invalid.');
  return value as unknown as CapturedDocumentation;
}

export async function captureDocumentation(
  source: DocumentationSource,
  previous?: CapturedDocumentation,
): Promise<CapturedDocumentation> {
  const normalizedSource = normalizeDocumentationSource(source);
  const { label, url } = normalizedSource;
  const previousEtag =
    previous?.url === url && previous.label === label && previous.etag && ETAG.test(previous.etag)
      ? previous.etag
      : undefined;
  const response = await fetchSpecificationResponse(
    url,
    {
      redirect: 'error',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      ...(previousEtag ? { headers: { 'If-None-Match': previousEtag } } : {}),
    },
    'Documentation source',
  );
  if (response.status === 304 && previousEtag && previous) {
    await response.body?.cancel();
    return previous;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new PipelineInputError(`Documentation download failed with HTTP ${response.status}.`);
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (
    !contentType ||
    (!HTML_CONTENT_TYPES.has(contentType) &&
      !TEXT_CONTENT_TYPES.has(contentType) &&
      !FEED_CONTENT_TYPES.has(contentType))
  ) {
    await response.body?.cancel();
    throw new PipelineInputError('Documentation sources must return HTML, Markdown or plain text.');
  }
  const sourceContent = await readBoundedResponse(
    response,
    MAX_DOCUMENTATION_BYTES,
    'Documentation source',
  );
  const content = normalizeContent(
    HTML_CONTENT_TYPES.has(contentType)
      ? htmlToText(sourceContent)
      : FEED_CONTENT_TYPES.has(contentType)
        ? feedToText(sourceContent)
        : sourceContent,
  );
  if (!content) throw new PipelineInputError('Documentation source contains no visible text.');
  const hash = digest(content);
  const etag = response.headers.get('etag');
  return {
    formatVersion: 1,
    kind: 'refit-documentation-snapshot',
    label,
    url,
    revision: hash,
    hash,
    content,
    contentType,
    ...(etag && ETAG.test(etag) ? { etag } : {}),
  };
}

function htmlToText(html: string) {
  const document = parse(html, { scriptingEnabled: false }) as unknown as HtmlNode;
  const root = findContentRoot(document) ?? document;
  const output: string[] = [];
  const pending: Array<{ node: HtmlNode; closing: boolean }> = [{ node: root, closing: false }];
  while (pending.length) {
    const { node, closing } = pending.pop()!;
    const tag = node.tagName?.toLowerCase();
    if (closing) {
      if (tag && BLOCK_TAGS.has(tag)) output.push('\n');
      continue;
    }
    if (tag && IGNORED_TAGS.has(tag)) continue;
    if (
      node.attrs?.some(
        (attribute) =>
          attribute.name === 'hidden' ||
          (attribute.name === 'aria-hidden' && attribute.value.toLowerCase() === 'true'),
      )
    )
      continue;
    if (node.nodeName === '#text') {
      output.push(node.value ?? '');
      continue;
    }
    if (tag && BLOCK_TAGS.has(tag)) output.push('\n');
    if (tag && BLOCK_TAGS.has(tag)) pending.push({ node, closing: true });
    for (const child of [...(node.childNodes ?? [])].reverse())
      pending.push({ node: child, closing: false });
  }
  return output.join('');
}

function feedToText(xml: string) {
  const content = xml.replace(/^\uFEFF/, '');
  if (/<!DOCTYPE\b|<!ENTITY\b/i.test(content))
    throw new PipelineInputError('Documentation feeds cannot declare custom XML entities.');
  if (XMLValidator.validate(content) !== true)
    throw new PipelineInputError('Documentation feed contains malformed XML.');

  let parsed: unknown;
  try {
    parsed = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      parseTagValue: false,
      trimValues: true,
      processEntities: XML_ENTITY_LIMITS,
    }).parse(content);
  } catch (cause) {
    throw new PipelineInputError('Documentation feed could not be parsed safely.', { cause });
  }
  if (!isObject(parsed))
    throw new PipelineInputError('Documentation feed has no RSS or Atom root.');
  const root = Object.entries(parsed).find(([key]) => {
    const name = localXmlName(key);
    return name === 'rss' || name === 'feed';
  });
  if (!root || !isObject(root[1]))
    throw new PipelineInputError('Documentation source must be an RSS 2.0 or Atom feed.');

  const isAtom = localXmlName(root[0]) === 'feed';
  const container = isAtom ? root[1] : readXmlField(root[1], 'channel');
  if (!isObject(container))
    throw new PipelineInputError('RSS documentation feed is missing its channel.');
  const rawEntries = readXmlField(container, isAtom ? 'entry' : 'item');
  const entries = rawEntries === undefined ? [] : asXmlArray(rawEntries);
  if (!entries.length || entries.some((entry) => !isObject(entry)))
    throw new PipelineInputError('Documentation feed contains no usable release entries.');
  if (entries.length > MAX_DOCUMENTATION_FEED_ENTRIES)
    throw new PipelineInputError(
      `Documentation feeds may contain at most ${MAX_DOCUMENTATION_FEED_ENTRIES} entries.`,
    );

  return entries
    .map((entry) => {
      const title = xmlFieldText(readXmlField(entry, 'title'));
      if (!title) throw new PipelineInputError('Every documentation feed entry must have a title.');
      const date = xmlFieldText(
        readXmlField(entry, 'published') ??
          readXmlField(entry, 'updated') ??
          readXmlField(entry, 'pubDate') ??
          readXmlField(entry, 'date'),
      );
      const link = xmlLink(entry, isAtom);
      const summary = xmlFieldText(
        readXmlField(entry, 'content:encoded') ??
          readXmlField(entry, 'content') ??
          readXmlField(entry, 'summary') ??
          readXmlField(entry, 'description'),
      );
      return [
        `## ${title}`,
        ...(date ? [`Published: ${date}`] : []),
        ...(link ? [`Link: ${link}`] : []),
        ...(summary ? ['', summary] : []),
      ].join('\n');
    })
    .join('\n\n');
}

function localXmlName(key: string) {
  return key.slice(key.lastIndexOf(':') + 1).toLowerCase();
}

function readXmlField(value: Record<string, unknown>, name: string) {
  const target = name.toLowerCase();
  return Object.entries(value).find(
    ([key]) => key.toLowerCase() === target || localXmlName(key) === target,
  )?.[1];
}

function asXmlArray(value: unknown) {
  return Array.isArray(value) ? value : [value];
}

function xmlFieldText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return htmlToText(String(value));
  if (Array.isArray(value)) return value.map(xmlFieldText).filter(Boolean).join('\n');
  if (!isObject(value)) return '';
  if (typeof value['#text'] === 'string') return htmlToText(value['#text']);
  return Object.entries(value)
    .filter(([key]) => !key.startsWith('@_') && key !== '#text')
    .map(([, child]) => xmlFieldText(child))
    .filter(Boolean)
    .join('\n');
}

function xmlLink(entry: Record<string, unknown>, isAtom: boolean) {
  const value = readXmlField(entry, 'link');
  if (typeof value === 'string') return value.trim();
  if (!isAtom) return '';
  const links = value === undefined ? [] : asXmlArray(value);
  const candidates = links.filter(isObject);
  const selected =
    candidates.find((link) => String(link['@_rel'] ?? '').toLowerCase() === 'alternate') ??
    candidates[0];
  return typeof selected?.['@_href'] === 'string' ? selected['@_href'].trim() : '';
}

function findContentRoot(root: HtmlNode) {
  const find = (node: HtmlNode, tagName: string): HtmlNode | undefined => {
    const pending = [node];
    while (pending.length) {
      const current = pending.pop()!;
      if (current.tagName?.toLowerCase() === tagName) return current;
      for (const child of [...(current.childNodes ?? [])].reverse()) pending.push(child);
    }
  };
  return find(root, 'main') ?? find(root, 'article') ?? find(root, 'body');
}

function normalizeContent(content: string) {
  return content
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .normalize('NFC')
    .replaceAll('\u00a0', ' ')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function documentationSourceId(source: DocumentationSource) {
  const normalizedSource = normalizeDocumentationSource(source);
  return digest(`${normalizedSource.label}\n${normalizedSource.url}`);
}
