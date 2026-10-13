import { parse } from 'parse5';
import { digest, isObject } from './specifications.ts';
import { fetchSpecificationResponse, readBoundedResponse } from './network.ts';
import { PipelineInputError } from './types.ts';

const DOWNLOAD_TIMEOUT_MS = 30_000;
export const MAX_DOCUMENTATION_BYTES = 1024 * 1024;
export const MAX_DOCUMENTATION_SOURCES = 8;
const HTML_CONTENT_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const TEXT_CONTENT_TYPES = new Set(['text/plain', 'text/markdown', 'text/x-markdown']);
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
    (!HTML_CONTENT_TYPES.has(contentType) && !TEXT_CONTENT_TYPES.has(contentType))
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
    HTML_CONTENT_TYPES.has(contentType) ? htmlToText(sourceContent) : sourceContent,
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
