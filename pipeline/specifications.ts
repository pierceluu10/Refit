import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PipelineInputError, type Removal } from './types.ts';

type JsonObject = Record<string, unknown>;

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

export function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function readSpecification(path: string) {
  const content = await readFile(path, 'utf8');
  const document = parseObject(content, path);
  const components = document.components;
  if (
    typeof document.openapi !== 'string' ||
    !document.openapi.startsWith('3.') ||
    !isObject(components) ||
    !isObject(components.schemas)
  ) {
    throw new PipelineInputError(`${path} must contain OpenAPI 3 components.schemas.`);
  }
  return { hash: digest(content), schemas: components.schemas };
}

function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

export function findRemovedProperties(before: JsonObject, after: JsonObject): Removal[] {
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
        id: digest(`stripe:property-removed:${pointer}`).slice(0, 24),
        schema,
        property,
        pointer,
      });
    }
  }
  return changes;
}
