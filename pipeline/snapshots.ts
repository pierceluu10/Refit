import {
  MAX_SPECIFICATION_BYTES,
  parseSpecification,
  stripeSpecificationUrl,
  type Snapshot,
} from './specifications.ts';
import { PipelineInputError } from './types.ts';
import { readBoundedResponse } from './network.ts';

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
  const content = await readBoundedResponse(response, MAX_SPECIFICATION_BYTES, 'Stripe snapshot');
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
