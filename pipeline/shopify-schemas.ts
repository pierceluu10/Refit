import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildClientSchema, getIntrospectionQuery, type GraphQLSchema } from 'graphql';
import { readBoundedResponse } from './network.ts';
import { digest, isObject, shopifySchemaUrl } from './specifications.ts';
import { PipelineInputError } from './types.ts';

const FETCH_TIMEOUT_MS = 120_000;
const MAX_SCHEMA_BYTES = 32 * 1024 * 1024;

export interface ShopifySnapshot {
  formatVersion: 1;
  kind: 'refit-graphql-snapshot';
  provider: 'shopify';
  version: string;
  url: string;
  hash: string;
  content: string;
}

// Downloads one Admin API version's schema by introspection from Shopify's public documentation
// proxy. It needs no store or credentials and performs no store operation.
export async function fetchShopifySnapshot(version: string): Promise<ShopifySnapshot> {
  const url = shopifySchemaUrl(version);
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: getIntrospectionQuery({ descriptions: true, inputValueDeprecation: true }),
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new PipelineInputError(`Shopify schema ${version} returned HTTP ${response.status}.`);
  }
  const body = JSON.parse(await readBoundedResponse(response, MAX_SCHEMA_BYTES, 'Shopify schema'));
  if (!isObject(body) || !isObject(body.data) || !isObject(body.data.__schema))
    throw new PipelineInputError(
      `Shopify did not return a schema for ${version}; only supported versions are published.`,
    );
  const content = JSON.stringify({ data: body.data });
  shopifySchema(content);
  return {
    formatVersion: 1,
    kind: 'refit-graphql-snapshot',
    provider: 'shopify',
    version,
    url,
    hash: digest(content),
    content,
  };
}

const schemas = new Map<string, GraphQLSchema>();

// Builds (once per content hash) the GraphQL schema a snapshot's introspection describes.
export function shopifySchema(introspection: string) {
  const key = digest(introspection);
  const cached = schemas.get(key);
  if (cached) return cached;
  const value: unknown = JSON.parse(introspection);
  if (!isObject(value) || !isObject(value.data) || !isObject(value.data.__schema))
    throw new PipelineInputError(
      'Shopify schema snapshot does not contain an introspection result.',
    );
  const schema = buildClientSchema(
    value.data as unknown as Parameters<typeof buildClientSchema>[0],
  );
  schemas.set(key, schema);
  return schema;
}

// Where the snapshot of one Admin API version lives for a run whose target snapshot is `afterPath`:
// `<version>.json` beside it (the benchmark's snapshots directory), else Refit's cached copy,
// downloaded once from Shopify's public documentation proxy.
export async function shopifySnapshotPath(
  version: string,
  afterPath: string,
  contracts = join(homedir(), '.refit', 'contracts', 'shopify'),
) {
  if (!/^\d{4}-\d{2}$/.test(version))
    throw new PipelineInputError(`${version} is not a dated Shopify API version.`);
  const sibling = join(dirname(afterPath), `${version}.json`);
  if (existsSync(sibling)) return sibling;
  const cached = join(contracts, `${version}.json`);
  if (existsSync(cached)) return cached;
  await mkdir(contracts, { recursive: true });
  const partial = `${cached}.${process.pid}.partial`;
  await writeFile(partial, JSON.stringify(await fetchShopifySnapshot(version)));
  await rename(partial, cached);
  return cached;
}
