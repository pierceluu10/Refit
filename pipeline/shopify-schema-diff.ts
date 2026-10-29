import {
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isRequiredArgument,
  isRequiredInputField,
  isUnionType,
  type GraphQLArgument,
  type GraphQLField,
  type GraphQLInputField,
  type GraphQLInputType,
  type GraphQLNamedType,
  type GraphQLOutputType,
  type GraphQLSchema,
} from 'graphql';
import { pinnedShopifySchema, pinnedShopifyVersions, type ShopifyApi } from './shopify-schemas.ts';
import { PipelineInputError } from './types.ts';

// What changed between two pinned versions of one Shopify GraphQL API, at schema coordinates
// (`Type`, `Type.field`, `Type.field(argument:)`, `Enum.VALUE`, `Input.field`). Everything is read
// from the two introspections; nothing is inferred from documentation. `breaking` follows
// graphql-js's findBreakingChanges; additions are listed only for enum values (code that switches
// over an enum can miss one) and deprecations (a deprecation is the usual warning before a removal).
export const SCHEMA_CHANGE_IDS = [
  'type-removed',
  'type-kind-changed',
  'field-removed',
  'field-type-changed',
  'argument-removed',
  'argument-added-required',
  'argument-type-changed',
  'input-field-removed',
  'input-field-added-required',
  'input-field-type-changed',
  'enum-value-removed',
  'union-member-removed',
  'interface-removed',
  'enum-value-added',
  'deprecated',
] as const;

export interface SchemaChange {
  id: (typeof SCHEMA_CHANGE_IDS)[number];
  coordinate: string;
  text: string;
  breaking: boolean;
  // For a removal: the reason the earlier version gave when it deprecated the member, if it did.
  deprecationReason?: string;
}

const kind = (type: GraphQLNamedType) =>
  isObjectType(type)
    ? 'object'
    : isInterfaceType(type)
      ? 'interface'
      : isUnionType(type)
        ? 'union'
        : isEnumType(type)
          ? 'enum'
          : isInputObjectType(type)
            ? 'input object'
            : 'scalar';

// graphql-js's rule for output positions: a field may become non-null, never nullable or another type.
function safeOutput(before: GraphQLOutputType, after: GraphQLOutputType): boolean {
  if (isListType(before))
    return (
      (isListType(after) && safeOutput(before.ofType, after.ofType)) ||
      (isNonNullType(after) && safeOutput(before, after.ofType))
    );
  if (isNonNullType(before)) return isNonNullType(after) && safeOutput(before.ofType, after.ofType);
  return (
    (!isListType(after) && !isNonNullType(after) && after.name === before.name) ||
    (isNonNullType(after) && safeOutput(before, after.ofType))
  );
}

// And for input positions: an input may become nullable, never required or another type.
function safeInput(before: GraphQLInputType, after: GraphQLInputType): boolean {
  if (isListType(before)) return isListType(after) && safeInput(before.ofType, after.ofType);
  if (isNonNullType(before))
    return (
      (isNonNullType(after) && safeInput(before.ofType, after.ofType)) ||
      (!isNonNullType(after) && safeInput(before.ofType, after))
    );
  return !isListType(after) && !isNonNullType(after) && after.name === before.name;
}

type Member = GraphQLField<unknown, unknown> | GraphQLArgument | GraphQLInputField;

function removed(
  changes: SchemaChange[],
  id: SchemaChange['id'],
  coordinate: string,
  member: Member | { deprecationReason?: string | null },
) {
  changes.push({
    id,
    coordinate,
    text: `${coordinate} was removed.`,
    breaking: true,
    ...(member.deprecationReason ? { deprecationReason: member.deprecationReason } : {}),
  });
}

function deprecated(
  changes: SchemaChange[],
  coordinate: string,
  before: Member | undefined,
  after: { deprecationReason?: string | null },
) {
  if (after.deprecationReason && before && !before.deprecationReason)
    changes.push({
      id: 'deprecated',
      coordinate,
      text: `${coordinate} is deprecated: ${after.deprecationReason}`,
      breaking: false,
    });
}

function compareArguments(
  changes: SchemaChange[],
  coordinate: string,
  before: readonly GraphQLArgument[],
  after: readonly GraphQLArgument[],
) {
  const next = new Map(after.map((argument) => [argument.name, argument]));
  const earlier = new Map(before.map((argument) => [argument.name, argument]));
  for (const argument of before) {
    const at = `${coordinate}(${argument.name}:)`;
    const match = next.get(argument.name);
    if (!match) removed(changes, 'argument-removed', at, argument);
    else {
      if (!safeInput(argument.type, match.type))
        changes.push({
          id: 'argument-type-changed',
          coordinate: at,
          text: `${at} changed type from ${String(argument.type)} to ${String(match.type)}.`,
          breaking: true,
        });
      deprecated(changes, at, argument, match);
    }
  }
  for (const argument of after)
    if (!earlier.has(argument.name) && isRequiredArgument(argument))
      changes.push({
        id: 'argument-added-required',
        coordinate: `${coordinate}(${argument.name}:)`,
        text: `${coordinate}(${argument.name}:) was added as a required ${String(argument.type)} argument.`,
        breaking: true,
      });
}

export function diffSchemas(before: GraphQLSchema, after: GraphQLSchema): SchemaChange[] {
  const changes: SchemaChange[] = [];
  const types = after.getTypeMap();
  for (const [name, type] of Object.entries(before.getTypeMap())) {
    if (name.startsWith('__')) continue;
    const next = types[name];
    if (!next) {
      changes.push({
        id: 'type-removed',
        coordinate: name,
        text: `${name} was removed.`,
        breaking: true,
      });
      continue;
    }
    if (kind(type) !== kind(next)) {
      changes.push({
        id: 'type-kind-changed',
        coordinate: name,
        text: `${name} changed from ${kind(type)} to ${kind(next)}.`,
        breaking: true,
      });
      continue;
    }
    if (
      (isObjectType(type) || isInterfaceType(type)) &&
      (isObjectType(next) || isInterfaceType(next))
    ) {
      const fields = next.getFields();
      for (const field of Object.values(type.getFields())) {
        const at = `${name}.${field.name}`;
        const match = fields[field.name];
        if (!match) {
          removed(changes, 'field-removed', at, field);
          continue;
        }
        if (!safeOutput(field.type, match.type))
          changes.push({
            id: 'field-type-changed',
            coordinate: at,
            text: `${at} changed type from ${String(field.type)} to ${String(match.type)}.`,
            breaking: true,
          });
        deprecated(changes, at, field, match);
        compareArguments(changes, at, field.args, match.args);
      }
      const interfaces = new Set(next.getInterfaces().map((item) => item.name));
      for (const item of type.getInterfaces())
        if (!interfaces.has(item.name))
          changes.push({
            id: 'interface-removed',
            coordinate: name,
            text: `${name} no longer implements ${item.name}.`,
            breaking: true,
          });
    } else if (isInputObjectType(type) && isInputObjectType(next)) {
      const fields = next.getFields();
      const earlier = type.getFields();
      for (const field of Object.values(earlier)) {
        const at = `${name}.${field.name}`;
        const match = fields[field.name];
        if (!match) removed(changes, 'input-field-removed', at, field);
        else {
          if (!safeInput(field.type, match.type))
            changes.push({
              id: 'input-field-type-changed',
              coordinate: at,
              text: `${at} changed type from ${String(field.type)} to ${String(match.type)}.`,
              breaking: true,
            });
          deprecated(changes, at, field, match);
        }
      }
      for (const field of Object.values(fields))
        if (!earlier[field.name] && isRequiredInputField(field))
          changes.push({
            id: 'input-field-added-required',
            coordinate: `${name}.${field.name}`,
            text: `${name}.${field.name} was added as a required ${String(field.type)} field.`,
            breaking: true,
          });
    } else if (isEnumType(type) && isEnumType(next)) {
      const values = new Map(next.getValues().map((value) => [value.name, value]));
      const earlier = new Set(type.getValues().map((value) => value.name));
      for (const value of type.getValues()) {
        const at = `${name}.${value.name}`;
        const match = values.get(value.name);
        if (!match) removed(changes, 'enum-value-removed', at, value);
        else if (match.deprecationReason && !value.deprecationReason)
          changes.push({
            id: 'deprecated',
            coordinate: at,
            text: `${at} is deprecated: ${match.deprecationReason}`,
            breaking: false,
          });
      }
      for (const value of next.getValues())
        if (!earlier.has(value.name))
          changes.push({
            id: 'enum-value-added',
            coordinate: `${name}.${value.name}`,
            text: `${name}.${value.name} was added.`,
            breaking: false,
          });
    } else if (isUnionType(type) && isUnionType(next)) {
      const members = new Set(next.getTypes().map((member) => member.name));
      for (const member of type.getTypes())
        if (!members.has(member.name))
          changes.push({
            id: 'union-member-removed',
            coordinate: name,
            text: `${member.name} was removed from union ${name}.`,
            breaking: true,
          });
    }
  }
  const order = (change: SchemaChange) =>
    `${change.coordinate}\u0000${change.id}\u0000${change.text}`;
  return changes.sort((left, right) => (order(left) < order(right) ? -1 : 1));
}

// The changes into one pinned version from the pinned version before it, which can be more than
// one quarter earlier where an older schema is not published (data/shopify-schema-versions.json).
export function pinnedShopifyDiff(api: ShopifyApi, version: string) {
  const versions = pinnedShopifyVersions(api);
  const index = versions.indexOf(version);
  if (index < 1)
    throw new PipelineInputError(`Shopify ${api} ${version} has no earlier pinned schema.`);
  const previous = versions[index - 1];
  const before = pinnedShopifySchema(api, previous);
  const after = pinnedShopifySchema(api, version);
  return {
    formatVersion: 1 as const,
    api,
    previous,
    version,
    sha256: { [previous]: before.pin.sha256, [version]: after.pin.sha256 },
    changes: diffSchemas(before.schema, after.schema),
  };
}

export const shopifyDiffFile = (api: ShopifyApi, version: string) =>
  new URL(`../data/shopify-schema-diffs/${api}/${version}.json`, import.meta.url);
