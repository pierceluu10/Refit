import { componentReference, isObject } from './specifications.ts';

// Owner decision D4 (2026-10-27): an oasdiff change whose old and new schema are structurally
// identical is not breaking, for any OpenAPI provider. docs/SCHEMA-EQUIVALENCE.md records each
// class with its evidence.
export const RENAMED_SUBSCHEMA = 'renamed-subschema';
export const FORMAT_ANNOTATION = 'format-annotation';

// Keywords that document a schema without changing which values it accepts.
const ANNOTATIONS = new Set(['title', 'description', 'example', 'examples', 'externalDocs']);
// Formats a contract may add or drop without accepting or rejecting another value, with the type
// they annotate and why. A format not listed here is compared like any other keyword.
const ANNOTATION_FORMATS: Record<string, { type: string; reason: string }> = {
  // Stripe's request descriptions already said "Three-letter ISO currency code, in lowercase. Must
  // be a supported currency." before the format was added; docs.stripe.com/currencies.
  currency: {
    type: 'string',
    reason:
      'The `currency` format names the rule the field already had, a lowercase three-letter ISO code (https://docs.stripe.com/currencies)',
  },
  // Every integer the field accepted is still an integer number of seconds.
  'unix-time': {
    type: 'integer',
    reason: 'The `unix-time` format names what an integer timestamp field already held',
  },
};
// Stops a comparison that walks too much of a large contract; it then counts as different.
const MAX_COMPARISONS = 200_000;
const SUBSCHEMA = /^(anyOf|oneOf)\[subschema #(\d+)(?:: ([^\]]*))?\]$/;
const REQUEST_PROPERTY = /the `([^`]*)` request property `[^`]+`/;
const REQUEST_PARAMETER = /^for the `([^`]+)` request parameter `([^`]+)`/;
const RESPONSE_PROPERTY =
  /the `([^`]+)` response(?:'s)? property .* (?:for the response status|for status) `([^`]+)`$/;
const SUBSCHEMA_CHANGES = /^(request|response)-property-(any|one)-of-(added|removed)$/;
const TYPE_CHANGES = new Set([
  'request-property-type-changed',
  'request-parameter-type-changed',
  'response-property-type-changed',
]);
const UNORDERED_SCHEMAS = new Set(['anyOf', 'oneOf', 'allOf']);
const UNORDERED_VALUES = new Set(['enum', 'required', 'type']);
const SCHEMA_VALUED = new Set(['items', 'additionalProperties', 'not']);

type Json = Record<string, unknown>;

interface Comparison {
  before: Json;
  after: Json;
  // Component pairs being compared; meeting one again is a cycle and compares equal.
  pending: Set<string>;
  steps: number;
}

function component(document: Json, reference: string) {
  const name = componentReference(reference);
  const schemas =
    isObject(document.components) && isObject(document.components.schemas)
      ? document.components.schemas
      : {};
  return name === undefined ? undefined : schemas[name];
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index]))
    );
  if (isObject(left) && isObject(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => key in right && jsonEqual(left[key], right[key]))
    );
  }
  return left === right;
}

// Whether two lists hold the same members in any order; a greedy pairing that fails counts as
// different, which is the safe answer.
function sameMembers(
  left: unknown[],
  right: unknown[],
  equal: (left: unknown, right: unknown) => boolean,
) {
  if (left.length !== right.length) return false;
  const used = new Set<number>();
  return left.every((member) => {
    const index = right.findIndex((other, position) => !used.has(position) && equal(member, other));
    if (index < 0) return false;
    used.add(index);
    return true;
  });
}

function formatsEqual(left: Json, right: Json) {
  if (left.format === right.format) return true;
  if (left.format !== undefined && right.format !== undefined) return false;
  const format = ANNOTATION_FORMATS[String(left.format ?? right.format)];
  return Boolean(format) && left.type === format.type && right.type === format.type;
}

// Whether two schemas accept the same values, resolving each side's `$ref`s in its own contract.
function schemasEqual(left: unknown, right: unknown, comparison: Comparison): boolean {
  if (++comparison.steps > MAX_COMPARISONS) return false;
  if (!isObject(left) || !isObject(right)) return jsonEqual(left, right);
  if (typeof left.$ref === 'string' || typeof right.$ref === 'string') {
    const key = `${String(left.$ref)}\0${String(right.$ref)}`;
    if (comparison.pending.has(key)) return true;
    const resolvedLeft =
      typeof left.$ref === 'string' ? component(comparison.before, left.$ref) : left;
    const resolvedRight =
      typeof right.$ref === 'string' ? component(comparison.after, right.$ref) : right;
    if (resolvedLeft === undefined || resolvedRight === undefined) return false;
    comparison.pending.add(key);
    const equal = schemasEqual(resolvedLeft, resolvedRight, comparison);
    comparison.pending.delete(key);
    return equal;
  }
  if (!formatsEqual(left, right)) return false;
  const keys = new Set(
    [...Object.keys(left), ...Object.keys(right)].filter(
      (key) => !ANNOTATIONS.has(key) && key !== 'format',
    ),
  );
  const schemaEqual = (one: unknown, other: unknown) => schemasEqual(one, other, comparison);
  for (const key of keys) {
    const [one, other] = [left[key], right[key]];
    if (one === undefined || other === undefined) return false;
    if (UNORDERED_SCHEMAS.has(key)) {
      if (!Array.isArray(one) || !Array.isArray(other) || !sameMembers(one, other, schemaEqual))
        return false;
    } else if (UNORDERED_VALUES.has(key) && Array.isArray(one) && Array.isArray(other)) {
      if (!sameMembers(one, other, jsonEqual)) return false;
    } else if (key === 'properties') {
      if (!isObject(one) || !isObject(other)) return false;
      const names = Object.keys(one);
      if (
        names.length !== Object.keys(other).length ||
        !names.every((name) => name in other && schemaEqual(one[name], other[name]))
      )
        return false;
    } else if (SCHEMA_VALUED.has(key)) {
      if (!schemaEqual(one, other)) return false;
    } else if (!jsonEqual(one, other)) return false;
  }
  return true;
}

function resolve(value: unknown, document: Json) {
  const seen = new Set<string>();
  let current = value;
  while (isObject(current) && typeof current.$ref === 'string') {
    if (seen.has(current.$ref)) return undefined;
    seen.add(current.$ref);
    current = component(document, current.$ref);
  }
  return isObject(current) ? current : undefined;
}

// The schema an oasdiff property path (`a/items/b`, `a/anyOf[subschema #2: Name]/b`) names.
// A subschema segment must name the same member in both contracts: its title when oasdiff gives
// one, otherwise an `anyOf` of the same length in each.
function walk(schema: unknown, path: string[], document: Json, other: (number | undefined)[]) {
  let node = resolve(schema, document);
  for (const [index, segment] of path.entries()) {
    if (!node) return undefined;
    if (!segment) continue;
    const subschema = segment.match(SUBSCHEMA);
    if (subschema) {
      const members = node[subschema[1]];
      if (!Array.isArray(members)) return undefined;
      const member = members[Number(subschema[2]) - 1];
      const title = subschema[3];
      if (title !== undefined) {
        const resolved = resolve(member, document);
        const name = isObject(member) ? componentReference(member.$ref) : undefined;
        if (name !== title && resolved?.title !== title) return undefined;
      } else if (other[index] !== undefined && other[index] !== members.length) return undefined;
      other[index] = members.length;
      node = resolve(member, document);
    } else if (segment === 'items' && node.type === 'array') node = resolve(node.items, document);
    else node = resolve(isObject(node.properties) ? node.properties[segment] : undefined, document);
  }
  return node;
}

function operationOf(document: Json, change: Json) {
  const item = isObject(document.paths) ? document.paths[String(change.path)] : undefined;
  const operation = isObject(item) ? item[String(change.operation).toLowerCase()] : undefined;
  return isObject(item) && isObject(operation) ? { item, operation } : undefined;
}

// The before and after schemas a change names, one pair per media type it is sent or returned as.
function changedSchemas(change: Json, before: Json, after: Json): [Json, Json][] | undefined {
  const text = String(change.text);
  const id = String(change.id);
  const old = operationOf(before, change);
  const current = operationOf(after, change);
  if (!old || !current) return undefined;
  const parameter = id.startsWith('request-parameter-') ? text.match(REQUEST_PARAMETER) : null;
  if (parameter) {
    const find = (found: { item: Json; operation: Json }, document: Json) => {
      const parameters = [
        ...(Array.isArray(found.operation.parameters) ? found.operation.parameters : []),
        ...(Array.isArray(found.item.parameters) ? found.item.parameters : []),
      ].filter(
        (entry) => isObject(entry) && entry.in === parameter[1] && entry.name === parameter[2],
      );
      return parameters.length && isObject(parameters[0])
        ? resolve(parameters[0].schema, document)
        : undefined;
    };
    const [left, right] = [find(old, before), find(current, after)];
    return left && right ? [[left, right]] : undefined;
  }
  const request = id.startsWith('request-property-');
  const match = text.match(request ? REQUEST_PROPERTY : RESPONSE_PROPERTY);
  if (!match) return undefined;
  const contents = (found: { operation: Json }) => {
    if (request) {
      const body = found.operation.requestBody;
      return isObject(body) && isObject(body.content) ? body.content : undefined;
    }
    const responses = found.operation.responses;
    const response = isObject(responses) ? responses[match[2]] : undefined;
    return isObject(response) && isObject(response.content) ? response.content : undefined;
  };
  const [left, right] = [contents(old), contents(current)];
  if (!left || !right) return undefined;
  const types = Object.keys(left);
  if (!types.length || types.length !== Object.keys(right).length) return undefined;
  const path = match[1].split('/');
  const pairs: [Json, Json][] = [];
  for (const type of types) {
    const [one, other] = [left[type], right[type]];
    if (!isObject(one) || !isObject(other)) return undefined;
    const lengths: (number | undefined)[] = [];
    const oldSchema = walk(one.schema, path, before, lengths);
    const newSchema = walk(other.schema, path, after, lengths);
    if (!oldSchema || !newSchema) return undefined;
    pairs.push([oldSchema, newSchema]);
  }
  return pairs;
}

// Marks a subschema or format change `compatible` when the schema it names accepts the same
// values in both contracts once annotations are ignored.
export function equivalentChange(change: Json, before: Json, after: Json) {
  const id = String(change.id);
  const subschema = SUBSCHEMA_CHANGES.test(id);
  if (!subschema && !TYPE_CHANGES.has(id)) return undefined;
  const pairs = changedSchemas(change, before, after);
  if (
    !pairs ||
    !pairs.every(([left, right]) =>
      schemasEqual(left, right, { before, after, pending: new Set(), steps: 0 }),
    )
  )
    return undefined;
  if (subschema)
    return {
      equivalence: RENAMED_SUBSCHEMA,
      reach: 'compatible',
      reachReason:
        'The subschema was replaced by one with the same shape: the schema accepts the same values in both versions once titles and descriptions are ignored.',
    };
  const [[left, right]] = pairs;
  const format = ANNOTATION_FORMATS[String(left.format ?? right.format)];
  return format
    ? {
        equivalence: FORMAT_ANNOTATION,
        reach: 'compatible',
        reachReason: `${format.reason}; the schema accepts the same values in both versions.`,
      }
    : undefined;
}
