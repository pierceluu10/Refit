import { isObject } from './specifications.ts';
import type { ProviderAdapter } from './providers.ts';
import { PipelineInputError, type Removal } from './types.ts';

const SUPPORTED_SCALAR_TYPES = new Set(['boolean', 'integer', 'number', 'string']);

function propertyType(schemas: Record<string, unknown>, schema: string, property: string) {
  const definition = schemas[schema];
  if (!isObject(definition) || !isObject(definition.properties)) return undefined;
  const value = definition.properties[property];
  return isObject(value) && typeof value.type === 'string' ? value.type : undefined;
}

function hasProperty(schemas: Record<string, unknown>, schema: string, property: string) {
  const definition = schemas[schema];
  return isObject(definition) && isObject(definition.properties)
    ? Object.hasOwn(definition.properties, property)
    : false;
}

export function validatePropertyRenames(
  provider: ProviderAdapter,
  changes: Removal[],
  beforeSchemas: Record<string, unknown>,
  afterSchemas: Record<string, unknown>,
) {
  for (const rename of provider.propertyRenames ?? []) {
    if (
      !changes.some(
        (change) => change.schema === rename.schema && change.property === rename.removed,
      )
    )
      continue;

    const removedType = propertyType(beforeSchemas, rename.schema, rename.removed);
    const replacementType = propertyType(afterSchemas, rename.schema, rename.replacement);
    if (
      !removedType ||
      !SUPPORTED_SCALAR_TYPES.has(removedType) ||
      removedType !== replacementType ||
      hasProperty(beforeSchemas, rename.schema, rename.replacement)
    )
      throw new PipelineInputError(
        `Configured rename ${rename.schema}.${rename.removed} → ${rename.schema}.${rename.replacement} requires a newly added replacement field with the same string, integer, number or boolean type.`,
      );
  }
}
