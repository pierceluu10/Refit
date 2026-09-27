import {
  MAX_SPECIFICATION_BYTES,
  parseSpecification,
  stripeSpecificationUrl,
  type Snapshot,
} from './specifications.ts';
import { PipelineInputError } from './types.ts';

const DOWNLOAD_TIMEOUT_MS = 30_000;

export async function fetchStripeSnapshot(revision: string): Promise<Snapshot> {
  const url = stripeSpecificationUrl(revision);
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new PipelineInputError(
      `Stripe snapshot download failed with HTTP ${response.status} at ${url}.`,
    );
  }
  if (!response.body) throw new PipelineInputError('Stripe snapshot response has no body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SPECIFICATION_BYTES) {
        await reader.cancel();
        throw new PipelineInputError('Stripe snapshot exceeds the 64 MiB download limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const content = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  const specification = parseSpecification(content, url);
  return {
    formatVersion: 1,
    kind: 'refit-snapshot',
    provider: 'stripe',
    revision,
    url,
    hash: specification.hash,
    content,
  };
}
