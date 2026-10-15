import { componentReference, isObject, resolvableComponentSchema } from './specifications.ts';
import type { ProviderAdapter } from './providers.ts';
import { PipelineInputError, type Removal } from './types.ts';

const SUPPORTED_SCALAR_TYPES = new Set(['boolean', 'integer', 'number', 'string']);

export interface PropertyMove {
  schema: string;
  removed: string;
  accessor: string;
  fallbackNull: boolean;
  expandable: boolean;
}

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

function propertySchema(schemas: Record<string, unknown>, schema: string, property: string) {
  const definition = schemas[schema];
  if (!isObject(definition) || !isObject(definition.properties)) return undefined;
  const value = definition.properties[property];
  return isObject(value) ? value : undefined;
}

// An intermediate segment is a direct or single-member anyOf reference to an object component.
function objectComponent(schemas: Record<string, unknown>, value: Record<string, unknown>) {
  const options = Array.isArray(value.anyOf) ? value.anyOf : [value];
  if (options.length !== 1 || !isObject(options[0])) return undefined;
  const reference = componentReference(options[0].$ref);
  return reference ? resolvableComponentSchema(schemas, reference) : undefined;
}

function resolvePath(schemas: Record<string, unknown>, schema: string, path: string[]) {
  let current: string | undefined = schema;
  const optional: boolean[] = [];
  for (const [index, segment] of path.entries()) {
    const value: Record<string, unknown> | undefined = current
      ? propertySchema(schemas, current, segment)
      : undefined;
    if (!value) return undefined;
    if (index === path.length - 1) return { target: value, optional };
    const definition = schemas[current!] as Record<string, unknown>;
    const required = Array.isArray(definition.required) && definition.required.includes(segment);
    optional.push(value.nullable === true || !required);
    current = objectComponent(schemas, value);
  }
  return undefined;
}

// Same declared shape, ignoring prose and nullability, which callers compare separately.
function shape(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(shape).join(',')}]`;
  if (!isObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value)
    .filter((key) => key !== 'description' && key !== 'nullable')
    .sort()
    .map((key) => `${JSON.stringify(key)}:${shape(value[key])}`)
    .join(',')}}`;
}

// An expandable `string | object` whose new location holds only the ID string. Unexpanded
// responses always returned that string, and moves of expandable fields stop where a request
// expands the old field.
function narrowsExpandable(removed: Record<string, unknown>, target: Record<string, unknown>) {
  const members = Array.isArray(removed.anyOf) ? removed.anyOf : [];
  return (
    isObject(removed['x-expansionResources']) &&
    members.length === 2 &&
    target.type === 'string' &&
    !shape(target).includes('"$ref"') &&
    members.some((member) => shape(member) === shape(target)) &&
    members.some((member) => isObject(member) && componentReference(member.$ref))
  );
}

function moveError(rename: { schema: string; removed: string; replacement: string }) {
  return new PipelineInputError(
    `Configured move ${rename.schema}.${rename.removed} → ${rename.schema}.${rename.replacement} requires a path that is new in the after contract, object intermediates and a value with the same declared shape and compatible nullability.`,
  );
}

export function validatePropertyRenames(
  provider: ProviderAdapter,
  changes: Removal[],
  beforeSchemas: Record<string, unknown>,
  afterSchemas: Record<string, unknown>,
) {
  const moves: PropertyMove[] = [];
  for (const rename of provider.propertyRenames ?? []) {
    if (
      !changes.some(
        (change) => change.schema === rename.schema && change.property === rename.removed,
      )
    )
      continue;

    if (rename.replacement.includes('.')) {
      const path = rename.replacement.split('.');
      const removed = propertySchema(beforeSchemas, rename.schema, rename.removed);
      const resolved = resolvePath(afterSchemas, rename.schema, path);
      if (!removed || !resolved || resolvePath(beforeSchemas, rename.schema, path))
        throw moveError(rename);
      const anyOptional = resolved.optional.some(Boolean);
      const removedNullable = removed.nullable === true;
      const definition = beforeSchemas[rename.schema] as Record<string, unknown>;
      // An optional, non-nullable field read as undefined when absent, as a missing parent does.
      const removedOptional = !(
        Array.isArray(definition.required) && definition.required.includes(rename.removed)
      );
      if (
        (shape(removed) !== shape(resolved.target) &&
          !narrowsExpandable(removed, resolved.target)) ||
        (!removedNullable &&
          ((anyOptional && !removedOptional) || resolved.target.nullable === true))
      )
        throw moveError(rename);
      moves.push({
        schema: rename.schema,
        removed: rename.removed,
        accessor: path
          .map((segment, index) =>
            index === 0 ? segment : `${resolved.optional[index - 1] ? '?.' : '.'}${segment}`,
          )
          .join(''),
        fallbackNull: anyOptional && removedNullable,
        expandable: shape(removed).includes('"$ref"'),
      });
      continue;
    }

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
  return moves;
}
