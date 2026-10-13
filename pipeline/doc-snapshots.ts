import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchSpecificationResponse, readBoundedResponse } from './network.ts';
import { passagesFromPage, type DocPassage, type PinnedPage } from './passages.ts';
import { digest, isObject, parseObject, MAX_SPECIFICATION_BYTES } from './specifications.ts';
import { PipelineInputError } from './types.ts';

const DOWNLOAD_TIMEOUT_MS = 30_000;
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;

export interface DocSnapshot {
  formatVersion: 1;
  kind: 'refit-docs-snapshot';
  provider: string;
  url: string;
  fetchedAt: string;
  hash: string;
  content: string;
}

function httpsDocumentUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PipelineInputError(
      'Documentation sources require a public HTTPS URL without credentials, fragments or query parameters.',
    );
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
  return parsed.href;
}

function snapshot(provider: string, url: string, content: string): DocSnapshot {
  if (!PROVIDER_ID.test(provider))
    throw new PipelineInputError(
      'Provider ID must start with a lowercase letter and use only lowercase letters, numbers or hyphens.',
    );
  if (Buffer.byteLength(content) > MAX_SPECIFICATION_BYTES)
    throw new PipelineInputError('Documentation source exceeds the size limit.');
  return {
    formatVersion: 1,
    kind: 'refit-docs-snapshot',
    provider,
    url,
    fetchedAt: new Date().toISOString(),
    hash: digest(content),
    content,
  };
}

export async function captureDocSnapshot(
  source: { kind: 'file'; path: string } | { kind: 'https'; url: string },
  provider: string,
) {
  if (source.kind === 'file') {
    const path = resolve(source.path);
    if ((await stat(path)).size > MAX_SPECIFICATION_BYTES)
      throw new PipelineInputError('Documentation source exceeds the size limit.');
    return snapshot(provider, pathToFileURL(path).href, await readFile(path, 'utf8'));
  }
  const url = httpsDocumentUrl(source.url);
  const response = await fetchSpecificationResponse(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: { Accept: 'text/plain, text/markdown, text/html;q=0.8, */*;q=0.1' },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new PipelineInputError(`Documentation download failed with HTTP ${response.status}.`);
  }
  const content = await readBoundedResponse(response, MAX_SPECIFICATION_BYTES, 'Documentation');
  return snapshot(provider, url, content);
}

export function readDocSnapshotValue(value: unknown, label: string): DocSnapshot {
  if (
    !isObject(value) ||
    value.formatVersion !== 1 ||
    value.kind !== 'refit-docs-snapshot' ||
    typeof value.provider !== 'string' ||
    !PROVIDER_ID.test(value.provider) ||
    typeof value.url !== 'string' ||
    !/^(https:|file:)/.test(value.url) ||
    typeof value.fetchedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value.fetchedAt) ||
    typeof value.content !== 'string' ||
    typeof value.hash !== 'string' ||
    value.hash !== digest(value.content)
  )
    throw new PipelineInputError(`${label}: invalid documentation snapshot or content hash.`);
  return {
    formatVersion: 1,
    kind: 'refit-docs-snapshot',
    provider: value.provider,
    url: value.url,
    fetchedAt: value.fetchedAt,
    hash: value.hash,
    content: value.content,
  };
}

export async function readDocSnapshot(path: string) {
  return readDocSnapshotValue(parseObject(await readFile(path, 'utf8'), path), path);
}

export function passagesFromDocSnapshot(snapshot: DocSnapshot): DocPassage[] {
  const page: PinnedPage = {
    provider: snapshot.provider,
    sourceUrl: snapshot.url,
    pageSha256: snapshot.hash,
    kind: 'doc',
    content: snapshot.content,
  };
  return passagesFromPage(page);
}
