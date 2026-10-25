import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverStripeRevision, fetchStripeSnapshot } from './snapshots.ts';
import {
  digest,
  MAX_SPECIFICATION_BYTES,
  parseDocumentObject,
  parseSpecification,
  parseSpecificationInput,
} from './specifications.ts';
import { fetchSpecificationResponse, readBoundedResponse } from './network.ts';
import { PipelineInputError } from './types.ts';
import type { Snapshot } from './specifications.ts';

const DOWNLOAD_TIMEOUT_MS = 30_000;
export type SpecificationSource =
  { kind: 'stripe-latest' } | { kind: 'file'; path: string } | { kind: 'https'; url: string };

export interface SourceSnapshot {
  formatVersion: 1;
  kind: 'refit-source-snapshot';
  provider: string;
  revision: string;
  url: string;
  hash: string;
  content: string;
  etag?: string;
}
export type CapturedSpecification = Snapshot | SourceSnapshot;

export async function captureSpecification(
  source: SpecificationSource,
  provider: string,
  previous?: CapturedSpecification,
): Promise<CapturedSpecification> {
  if (source.kind === 'stripe-latest') {
    if (provider !== 'stripe')
      throw new PipelineInputError('Stripe discovery requires the Stripe adapter.');
    const revision = await discoverStripeRevision();
    if (previous?.kind === 'refit-snapshot' && previous.revision === revision) return previous;
    return fetchStripeSnapshot(revision);
  }
  let content: string;
  let url: string;
  let etag: string | undefined;
  if (source.kind === 'file') {
    const path = resolve(source.path);
    if ((await stat(path)).size > MAX_SPECIFICATION_BYTES)
      throw new PipelineInputError('Specification source exceeds the size limit.');
    content = await readFile(path, 'utf8');
    // Enrollment stores generated contracts as Refit snapshots; keep their verified provenance.
    const value = parseDocumentObject(content, path);
    if (value.kind === 'refit-snapshot' || value.kind === 'refit-source-snapshot') {
      parseSpecificationInput(content, path);
      return value as unknown as CapturedSpecification;
    }
    url = pathToFileURL(path).href;
  } else {
    const parsed = new URL(source.url);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      parsed.search
    )
      throw new PipelineInputError(
        'Specification sources require a public HTTPS URL without credentials, fragments or query parameters.',
      );
    url = parsed.href;
    const previousEtag =
      previous?.kind === 'refit-source-snapshot' &&
      previous.url === url &&
      previous.provider === provider &&
      previous.etag &&
      /^[^\r\n]{1,1024}$/.test(previous.etag)
        ? previous.etag
        : undefined;
    const response = await fetchSpecificationResponse(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      ...(previousEtag ? { headers: { 'If-None-Match': previousEtag } } : {}),
    });
    if (response.status === 304 && previousEtag && previous) {
      await response.body?.cancel();
      return previous;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new PipelineInputError(`Specification download failed with HTTP ${response.status}.`);
    }
    content = await readBoundedResponse(response, MAX_SPECIFICATION_BYTES, 'Specification');
    const tag = response.headers.get('etag');
    if (tag && /^[^\r\n]{1,1024}$/.test(tag)) etag = tag;
  }
  if (Buffer.byteLength(content) > MAX_SPECIFICATION_BYTES)
    throw new PipelineInputError('Specification source exceeds the size limit.');
  parseSpecification(content, url);
  const hash = digest(content);
  return {
    formatVersion: 1 as const,
    kind: 'refit-source-snapshot' as const,
    provider,
    revision: hash,
    url,
    hash,
    content,
    ...(etag ? { etag } : {}),
  };
}
