import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { PipelineInputError, type Removal } from './types.ts';
import { parseDocument } from 'yaml';

type JsonObject = Record<string, unknown>;
export const MAX_SPECIFICATION_BYTES = 64 * 1024 * 1024;
export const STRIPE_SPECIFICATION_ROOT = 'https://raw.githubusercontent.com/stripe/openapi/';
export const STRIPE_SPECIFICATION_PATH = 'openapi/spec3.json';
export const COMMIT_REVISION = /^[a-f0-9]{40}$/;

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

export function parseObject(content: string, label: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (cause) {
    throw new PipelineInputError(`${label} is not valid JSON.`, { cause });
  }
  if (!isObject(parsed)) throw new PipelineInputError(`${label} must be a JSON object.`);
  return parsed;
}

export function digest(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function readSpecification(path: string) {
  if ((await stat(path)).size > MAX_SPECIFICATION_BYTES)
    throw new PipelineInputError(`${path} exceeds the 64 MiB specification input limit.`);
  const content = await readFile(path, 'utf8');
  const value = parseApiDocument(content, path);
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
  return { ...parseSpecification(content, path), provenance: null };
}

export function parseSpecification(content: string, label: string) {
  const document = parseApiDocument(content, label);
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
    schemas: isObject(components) && isObject(components.schemas) ? components.schemas : {},
    document,
  };
}

function parseApiDocument(content: string, label: string): JsonObject {
  if (content.trimStart().startsWith('{') || content.trimStart().startsWith('['))
    return parseObject(content, label);
  const parsed = parseDocument(content, { strict: true, uniqueKeys: true });
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
  if (!isObject(value)) throw new PipelineInputError(`${label} must be an OpenAPI object.`);
  return value;
}

function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
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
