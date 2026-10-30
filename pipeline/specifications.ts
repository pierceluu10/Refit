import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { PipelineInputError, type Removal } from './types.ts';
import { parseAllDocuments } from 'yaml';

type JsonObject = Record<string, unknown>;
export const MAX_SPECIFICATION_BYTES = 64 * 1024 * 1024;
export const STRIPE_SPECIFICATION_ROOT = 'https://raw.githubusercontent.com/stripe/openapi/';
export const STRIPE_SPECIFICATION_PATH = 'openapi/spec3.json';
export const COMMIT_REVISION = /^[a-f0-9]{40}$/;
// Shopify publishes each supported Admin and Storefront API version's schema through its
// documentation proxy.
const SHOPIFY_SCHEMA_ROOTS = {
  admin: 'https://shopify.dev/admin-graphql-direct-proxy/',
  storefront: 'https://shopify.dev/storefront-graphql-direct-proxy/',
};
const SHOPIFY_VERSION = /^\d{4}-(?:01|04|07|10)$/;

export function shopifySchemaUrl(
  version: string,
  api: keyof typeof SHOPIFY_SCHEMA_ROOTS = 'admin',
) {
  if (!SHOPIFY_VERSION.test(version))
    throw new PipelineInputError('Shopify API version must be YYYY-01, -04, -07 or -10.');
  return `${SHOPIFY_SCHEMA_ROOTS[api]}${version}`;
}

export interface Snapshot {
  formatVersion: 1;
  kind: 'refit-snapshot';
  provider: 'stripe';
  revision: string;
  url: string;
  hash: string;
  content: string;
}

export function stripeSpecificationUrl(revision: string) {
  if (!COMMIT_REVISION.test(revision))
    throw new PipelineInputError(
      'Stripe revision must be a full lowercase 40-character commit SHA.',
    );
  return `${STRIPE_SPECIFICATION_ROOT}${revision}/${STRIPE_SPECIFICATION_PATH}`;
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const COMPONENT_SCHEMA_PREFIX = '#/components/schemas/';

export function componentReference(reference: unknown) {
  if (typeof reference !== 'string' || !reference.startsWith(COMPONENT_SCHEMA_PREFIX))
    return undefined;
  const pointer = reference.slice(COMPONENT_SCHEMA_PREFIX.length);
  if (!pointer || pointer.includes('/') || /~(?![01])/.test(pointer)) return undefined;
  return pointer.replaceAll('~1', '/').replaceAll('~0', '~');
}

export function resolvableComponentSchema(schemas: Record<string, unknown>, name: string) {
  const seen = new Set<string>();
  let current = name;
  while (!seen.has(current)) {
    seen.add(current);
    const definition = schemas[current];
    if (!isObject(definition)) return undefined;
    if (['allOf', 'anyOf', 'oneOf'].some((key) => key in definition)) return undefined;
    if (isObject(definition.properties)) return current;
    const referenced = componentReference(definition.$ref);
    if (!referenced) return undefined;
    current = referenced;
  }
  return undefined;
}

const COMPOSITION_KEYS = ['allOf', 'anyOf', 'oneOf', 'not', 'discriminator'];
const MAX_ALL_OF_DEPTH = 8;

// The properties and required list of an object schema, following references and plain `allOf`
// compositions. Undefined when any part is not a plain object schema, or when two parts declare the
// same property differently.
function objectParts(
  schemas: Record<string, unknown>,
  schema: unknown,
  depth: number,
): { properties: Record<string, unknown>; required: string[] } | undefined {
  if (depth > MAX_ALL_OF_DEPTH || !isObject(schema)) return undefined;
  const referenced = componentReference(schema.$ref);
  if (referenced) return objectParts(schemas, schemas[referenced], depth + 1);
  if (COMPOSITION_KEYS.some((key) => key !== 'allOf' && key in schema)) return undefined;
  if (schema.type !== undefined && schema.type !== 'object') return undefined;
  const parts = [
    ...(Array.isArray(schema.allOf) ? schema.allOf : []),
    ...(isObject(schema.properties)
      ? [{ properties: schema.properties, required: schema.required }]
      : []),
  ];
  if (!parts.length) return undefined;
  const properties: Record<string, unknown> = {};
  const required = new Set<string>();
  for (const part of parts) {
    const resolved =
      isObject(part) &&
      isObject(part.properties) &&
      !('allOf' in part) &&
      !componentReference(part.$ref)
        ? COMPOSITION_KEYS.some((key) => key in part) ||
          (part.type !== undefined && part.type !== 'object')
          ? undefined
          : {
              properties: part.properties,
              required: Array.isArray(part.required)
                ? part.required.filter((item): item is string => typeof item === 'string')
                : [],
            }
        : objectParts(schemas, part, depth + 1);
    if (!resolved) return undefined;
    for (const [name, definition] of Object.entries(resolved.properties)) {
      if (name in properties && JSON.stringify(properties[name]) !== JSON.stringify(definition))
        return undefined;
      properties[name] = definition;
    }
    for (const name of resolved.required) required.add(name);
  }
  return { properties, required: [...required] };
}

// Component schemas with each `allOf` of plain object schemas merged into one object schema, so an
// adapter can map a response such as OpenAI's `Response`. Other compositions are left as they are,
// and the source document is not changed.
export function flattenAllOfSchemas(schemas: Record<string, unknown>) {
  let flattened: Record<string, unknown> | undefined;
  for (const [name, definition] of Object.entries(schemas)) {
    if (!isObject(definition) || !Array.isArray(definition.allOf)) continue;
    const merged = objectParts(schemas, definition, 0);
    if (!merged) continue;
    const { allOf: _allOf, ...rest } = definition;
    flattened ??= { ...schemas };
    flattened[name] = {
      ...rest,
      type: 'object',
      properties: merged.properties,
      ...(merged.required.length ? { required: merged.required } : {}),
    };
  }
  return flattened ?? schemas;
}

// npm and Node ignore a leading byte order mark in JSON files, which Windows editors write.
export function parseJson(content: string): unknown {
  return JSON.parse(content.replace(/^\uFEFF/, ''));
}

export function parseObject(content: string, label: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = parseJson(content);
  } catch (cause) {
    throw new PipelineInputError(`${label} is not valid JSON.`, { cause });
  }
  if (!isObject(parsed)) throw new PipelineInputError(`${label} must be a JSON object.`);
  return parsed;
}

export function digest(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

export const META_GRAPH_CHANGELOG = 'https://developers.facebook.com/docs/graph-api/changelog';

export async function readSpecification(path: string) {
  if ((await stat(path)).size > MAX_SPECIFICATION_BYTES)
    throw new PipelineInputError(`${path} exceeds the 64 MiB specification input limit.`);
  const content = await readFile(path, 'utf8');
  return parseSpecificationInput(content, path);
}

export function parseSpecificationInput(content: string, path: string) {
  if (Buffer.byteLength(content) > MAX_SPECIFICATION_BYTES)
    throw new PipelineInputError(`${path} exceeds the 64 MiB specification input limit.`);
  const value = parseDocumentObject(content, path);
  if (value.kind === 'refit-snapshot') {
    if (
      value.formatVersion !== 1 ||
      value.provider !== 'stripe' ||
      typeof value.revision !== 'string' ||
      typeof value.content !== 'string' ||
      value.url !== stripeSpecificationUrl(value.revision) ||
      value.hash !== digest(value.content)
    )
      throw new PipelineInputError(`${path}: invalid snapshot provenance or content hash.`);
    return {
      ...parseSpecification(value.content, path),
      provenance: { provider: value.provider, revision: value.revision, url: value.url },
    };
  }
  if (value.kind === 'refit-source-snapshot') {
    if (
      value.formatVersion !== 1 ||
      typeof value.provider !== 'string' ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(value.provider) ||
      typeof value.content !== 'string' ||
      value.hash !== digest(value.content) ||
      value.revision !== value.hash ||
      typeof value.url !== 'string' ||
      !/^(https:|file:)/.test(value.url)
    )
      throw new PipelineInputError(`${path}: invalid source snapshot provenance or content hash.`);
    return {
      ...parseSpecification(value.content, path),
      provenance: { provider: value.provider, revision: value.revision, url: value.url },
    };
  }
  if (value.kind === 'refit-graphql-snapshot') {
    if (
      value.formatVersion !== 1 ||
      value.provider !== 'shopify' ||
      typeof value.version !== 'string' ||
      !SHOPIFY_VERSION.test(value.version) ||
      typeof value.content !== 'string' ||
      value.hash !== digest(value.content) ||
      value.url !== shopifySchemaUrl(value.version)
    )
      throw new PipelineInputError(`${path}: invalid Shopify schema snapshot provenance or hash.`);
    // The introspection result stays a string until the Shopify pipeline builds its schema.
    return {
      hash: value.hash,
      schemas: {},
      document: { info: { version: value.version }, graphqlIntrospection: value.content },
      provenance: { provider: 'shopify', revision: value.version, url: value.url },
    };
  }
  // A Meta Graph run's contract: a Graph API version and the reviewed change table it pins
  // (meta-graph-pipeline.ts).
  if (value.kind === 'refit-meta-graph-snapshot') {
    if (
      value.formatVersion !== 1 ||
      value.provider !== 'meta-graph' ||
      typeof value.version !== 'string' ||
      !/^v\d+\.\d+$/.test(value.version) ||
      typeof value.content !== 'string' ||
      value.hash !== digest(value.content) ||
      value.url !== META_GRAPH_CHANGELOG
    )
      throw new PipelineInputError(`${path}: invalid Meta Graph snapshot provenance or hash.`);
    return {
      hash: value.hash,
      schemas: {},
      document: { info: { version: value.version }, metaGraphChanges: value.content },
      provenance: { provider: 'meta-graph', revision: value.version, url: value.url },
    };
  }
  return { ...parseSpecification(content, path), provenance: null };
}

export function parseSpecification(content: string, label: string) {
  const document = parseDocumentObject(content, label);
  const components = document.components;
  if (
    typeof document.openapi !== 'string' ||
    !document.openapi.startsWith('3.') ||
    (!isObject(document.paths) && !(isObject(components) && isObject(components.schemas))) ||
    (components !== undefined && !isObject(components)) ||
    (isObject(components) && components.schemas !== undefined && !isObject(components.schemas))
  ) {
    throw new PipelineInputError(`${label} must contain OpenAPI 3 paths or components.schemas.`);
  }
  return {
    hash: digest(content),
    schemas:
      isObject(components) && isObject(components.schemas)
        ? flattenAllOfSchemas(components.schemas)
        : {},
    document,
  };
}

export function parseDocumentObject(content: string, label: string): JsonObject {
  return parseDocumentObjects(content, label, 1)[0];
}

export function parseDocumentObjects(
  content: string,
  label: string,
  maximum: number,
): JsonObject[] {
  if (content.trimStart().startsWith('{') || content.trimStart().startsWith('['))
    return [parseObject(content, label)];
  const documents = parseAllDocuments(content, { strict: true, uniqueKeys: true });
  if (!documents.length || documents.length > maximum)
    throw new PipelineInputError(`${label} requires 1–${maximum} YAML documents.`);
  return documents.map((parsed) => {
    if (parsed.errors.length || parsed.warnings.length)
      throw new PipelineInputError(`${label} contains invalid or unsupported YAML.`, {
        cause: parsed.errors[0] ?? parsed.warnings[0],
      });
    let value: unknown;
    try {
      value = parsed.toJS({ maxAliasCount: 0 });
    } catch (cause) {
      throw new PipelineInputError(`${label} contains unsupported YAML aliases.`, { cause });
    }
    if (!isObject(value)) throw new PipelineInputError(`${label} must contain an object.`);
    return value;
  });
}

function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

const MAX_ADDED_PROPERTIES = 20;
const MAX_ADDED_DESCRIPTION = 200;

export interface AddedProperty {
  schema: string;
  property: string;
  type?: string;
  description?: string;
}

export function findAddedProperties(
  before: JsonObject,
  after: JsonObject,
  changes: Removal[],
): AddedProperty[] {
  const added: AddedProperty[] = [];
  for (const schema of [...new Set(changes.map((change) => change.schema))].sort()) {
    const previous = before[schema];
    const current = after[schema];
    if (!isObject(previous) || !isObject(previous.properties)) continue;
    if (!isObject(current) || !isObject(current.properties)) continue;
    for (const property of Object.keys(current.properties).sort()) {
      if (Object.hasOwn(previous.properties, property)) continue;
      const definition = current.properties[property];
      added.push({
        schema,
        property,
        ...(isObject(definition) && typeof definition.type === 'string'
          ? { type: definition.type }
          : {}),
        ...(isObject(definition) && typeof definition.description === 'string'
          ? { description: definition.description.slice(0, MAX_ADDED_DESCRIPTION) }
          : {}),
      });
      // Keeps large provider schemas inside the model's input limit.
      if (added.length === MAX_ADDED_PROPERTIES) return added;
    }
  }
  return added;
}

export function findRemovedProperties(
  before: JsonObject,
  after: JsonObject,
  providerId = 'stripe',
): Removal[] {
  const changes: Removal[] = [];
  for (const schema of Object.keys(before).sort()) {
    const previous = before[schema];
    const current = after[schema];
    if (!isObject(previous) || !isObject(previous.properties)) continue;
    // Composed or removed schemas need a complete OpenAPI differ; never infer removal from them.
    if (!isObject(current) || !isObject(current.properties)) continue;
    if (['allOf', 'anyOf', 'oneOf', '$ref'].some((key) => key in previous || key in current))
      continue;
    for (const property of Object.keys(previous.properties).sort()) {
      if (Object.hasOwn(current.properties, property)) continue;
      const pointer = `/components/schemas/${escapePointer(schema)}/properties/${escapePointer(property)}`;
      changes.push({
        id: digest(`${providerId}:property-removed:${pointer}`).slice(0, 24),
        schema,
        property,
        pointer,
        ...(isObject(previous.properties[property]) &&
        previous.properties[property].type === 'string'
          ? { type: 'string' as const }
          : {}),
      });
    }
  }
  return changes;
}
