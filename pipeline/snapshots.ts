import {
  MAX_SPECIFICATION_BYTES,
  COMMIT_REVISION,
  STRIPE_SPECIFICATION_PATH,
  isObject,
  parseSpecification,
  stripeSpecificationUrl,
  type Snapshot,
} from './specifications.ts';
import { PipelineInputError } from './types.ts';
import { readBoundedResponse } from './network.ts';

const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_DISCOVERY_BYTES = 1024 * 1024;

export async function discoverStripeRevision() {
  const query = new URLSearchParams({ path: STRIPE_SPECIFICATION_PATH, per_page: '1' });
  const url = `https://api.github.com/repos/stripe/openapi/commits?${query}`;
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new PipelineInputError(`Stripe revision discovery failed with HTTP ${response.status}.`);
  }
  const commits: unknown = JSON.parse(
    await readBoundedResponse(response, MAX_DISCOVERY_BYTES, 'Stripe revision discovery'),
  );
  if (
    !Array.isArray(commits) ||
    commits.length !== 1 ||
    !isObject(commits[0]) ||
    typeof commits[0].sha !== 'string' ||
    !COMMIT_REVISION.test(commits[0].sha)
  )
    throw new PipelineInputError('Stripe revision discovery did not return one pinned commit.');
  return commits[0].sha;
}

export function encodeSnapshot(snapshot: Snapshot) {
  const encoded = `${JSON.stringify(snapshot)}\n`;
  if (Buffer.byteLength(encoded) > MAX_SPECIFICATION_BYTES)
    throw new PipelineInputError('Encoded snapshot exceeds the 64 MiB input limit.');
  return encoded;
}

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
