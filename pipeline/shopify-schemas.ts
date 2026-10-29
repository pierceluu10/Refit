import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
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

// Downloads one Admin (or Storefront) API version's schema by introspection from Shopify's public
// documentation proxy. It needs no store or credentials and performs no store operation.
export async function fetchShopifySnapshot(
  version: string,
  api: 'admin' | 'storefront' = 'admin',
): Promise<ShopifySnapshot> {
  const url = shopifySchemaUrl(version, api);
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

export const SHOPIFY_APIS = ['admin', 'storefront', 'customer-account'] as const;
export type ShopifyApi = (typeof SHOPIFY_APIS)[number];

// A schema Refit pins (data/shopify-schema-versions.json): where it was read and the SHA-256 of
// its introspection as saved, gzipped, in data/shopify-schemas/<api>/<version>.json.gz. Shopify's
// proxy serves only supported versions, so older ones come from Shopify's own npm packages
// (`@shopify/hydrogen-react` ships the Storefront and Customer Account schemas of its quarter,
// `@shopify/dev-mcp` 1.1.0 ships Admin 2025-01), named with the tarball's npm integrity.
export interface ShopifySchemaPin {
  api: ShopifyApi;
  version: string;
  sha256: string;
  source:
    | { url: string; fetchedAt: string }
    | { package: string; release: string; path: string; integrity: string };
}

const PINS = new URL('../data/shopify-schema-versions.json', import.meta.url);
const SAVED = new URL('../data/shopify-schemas/', import.meta.url);

export function shopifySchemaPins(): ShopifySchemaPin[] {
  const value: unknown = JSON.parse(readFileSync(PINS, 'utf8'));
  if (!isObject(value) || value.formatVersion !== 1 || !Array.isArray(value.schemas))
    throw new PipelineInputError(
      'data/shopify-schema-versions.json needs formatVersion 1 and schemas.',
    );
  for (const pin of value.schemas)
    if (
      !isObject(pin) ||
      !SHOPIFY_APIS.includes(pin.api as ShopifyApi) ||
      typeof pin.version !== 'string' ||
      !/^\d{4}-(?:01|04|07|10)$/.test(pin.version) ||
      typeof pin.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(pin.sha256) ||
      !isObject(pin.source)
    )
      throw new PipelineInputError(`Invalid Shopify schema pin ${JSON.stringify(pin)}.`);
  return value.schemas as ShopifySchemaPin[];
}

// The pinned versions of one API, oldest first.
export function pinnedShopifyVersions(api: ShopifyApi) {
  return shopifySchemaPins()
    .filter((pin) => pin.api === api)
    .map((pin) => pin.version)
    .sort();
}

export const shopifySchemaFile = (api: ShopifyApi, version: string) =>
  new URL(`${api}/${version}.json.gz`, SAVED);

// The pinned introspection of one API version, refused unless it matches its recorded hash.
export function pinnedShopifySchema(api: ShopifyApi, version: string) {
  const pin = shopifySchemaPins().find((entry) => entry.api === api && entry.version === version);
  if (!pin) throw new PipelineInputError(`Shopify ${api} ${version} is not pinned.`);
  const content = gunzipSync(readFileSync(shopifySchemaFile(api, version))).toString('utf8');
  if (digest(content) !== pin.sha256)
    throw new PipelineInputError(
      `data/shopify-schemas/${api}/${version}.json.gz does not match its pinned SHA-256.`,
    );
  return { pin, content, schema: shopifySchema(content) };
}

// Introspection as Refit saves it: `{"data":{"__schema":...}}`, compact, whichever wrapper the
// source used.
export function normalizedIntrospection(text: string) {
  const value: unknown = JSON.parse(text);
  const data = isObject(value) && isObject(value.data) ? value.data : value;
  if (!isObject(data) || !isObject(data.__schema))
    throw new PipelineInputError('The file does not contain a GraphQL introspection result.');
  const content = JSON.stringify({ data: { __schema: data.__schema } });
  shopifySchema(content);
  return content;
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
