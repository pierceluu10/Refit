import ts from 'typescript-compiler';
import { local } from './request-removals.ts';
import { isObject } from './specifications.ts';
import { STRIPE_PACK } from './rule-pack.ts';

// The code behind each request-move family in a rule pack (pipeline/rule-pack.ts): a removed request
// parameter whose documented replacement sends the same request. Every move is checked against both
// recorded contracts before any edit.
export const REQUEST_MOVE_RULES = new Set<string>(
  STRIPE_PACK.requestMoves.map((move) => move.rule),
);

export function requestMoveFor(rule: string) {
  return STRIPE_PACK.requestMoves.find((move) => move.rule === rule);
}

// A schema without its documentation (`description`, `title`), to compare shapes across versions.
// Property names inside `properties` are kept, whatever they are called.
function shape(schema: unknown, document: Record<string, unknown>): unknown {
  if (Array.isArray(schema)) return schema.map((entry) => shape(entry, document));
  const resolved = local(schema, document);
  if (!resolved) return schema;
  return Object.fromEntries(
    Object.entries(resolved)
      .filter(([key]) => key !== 'description' && key !== 'title')
      .map(([key, value]) => [
        key,
        key === 'properties' && isObject(value)
          ? Object.fromEntries(
              Object.entries(value).map(([name, entry]) => [name, shape(entry, document)]),
            )
          : shape(value, document),
      ]),
  );
}

function properties(schema: unknown, document: Record<string, unknown>) {
  const resolved = local(schema, document);
  return resolved && isObject(resolved.properties) ? resolved.properties : undefined;
}

function isString(schema: unknown, document: Record<string, unknown>) {
  const resolved = local(schema, document);
  return Boolean(resolved && resolved.type === 'string' && !resolved.enum);
}

// The pack move of a removed parameter, named by its replacement, when both contracts agree with it:
// a rename needs the same shape under the new name; a wrap needs a required string in the before
// body, and an after body whose replacement holds that string beside a `type` accepting the
// discriminator.
export function requestMove(
  operationId: string,
  parameter: string,
  before: { schema: Record<string, unknown>; document: Record<string, unknown> },
  after: { schema: Record<string, unknown>; document: Record<string, unknown> },
): string | undefined {
  const move = STRIPE_PACK.requestMoves.find(
    (entry) => entry.parameter === parameter && entry.operations.includes(operationId),
  );
  if (!move) return;
  const old = isObject(before.schema.properties) ? before.schema.properties[parameter] : undefined;
  const target = isObject(after.schema.properties) ? after.schema.properties : {};
  if (move.family === 'request-rename') {
    const renamed = target[move.replacement];
    return old &&
      renamed &&
      JSON.stringify(shape(old, before.document)) === JSON.stringify(shape(renamed, after.document))
      ? move.replacement
      : undefined;
  }
  const required = Array.isArray(before.schema.required) ? before.schema.required : [];
  const holder = properties(target[move.replacement], after.document);
  const type = holder && local(holder.type, after.document);
  return isString(old, before.document) &&
    required.includes(parameter) &&
    holder &&
    isString(holder[parameter], after.document) &&
    type &&
    Array.isArray(type.enum) &&
    type.enum.includes(move.discriminator)
    ? move.replacement
    : undefined;
}

function staticName(name: ts.PropertyName) {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

// The edit that moves `property` (the removed parameter in a direct object-literal body) to the
// pack move named by its replacement, or why it stays for review.
export function requestMoveEdit(
  property: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
  replacement: string,
): { start: number; end: number; replacement: string; rule: string } | { reason: string } {
  const body = property.parent;
  const names: string[] = [];
  for (const sibling of body.properties) {
    const name =
      ts.isPropertyAssignment(sibling) || ts.isShorthandPropertyAssignment(sibling)
        ? staticName(sibling.name)
        : undefined;
    if (name === undefined)
      return { reason: 'Request spreads, methods and computed properties require review.' };
    names.push(name);
  }
  const parameter = staticName(property.name)!;
  if (names.filter((name) => name === parameter).length > 1)
    return { reason: 'Duplicate request properties require review.' };
  if (ts.isShorthandPropertyAssignment(property) && property.objectAssignmentInitializer)
    return { reason: 'Request shorthand initializers require review.' };
  const move = STRIPE_PACK.requestMoves.find(
    (entry) => entry.replacement === replacement && entry.parameter === parameter,
  )!;
  if (move.family === 'request-rename') {
    if (names.includes(replacement))
      return { reason: `The request already sends ${replacement}; merging them needs review.` };
    // The same value under its new name: the key changes, the value is kept as written.
    return ts.isShorthandPropertyAssignment(property)
      ? {
          start: property.getStart(),
          end: property.getEnd(),
          replacement: `${replacement}: ${property.name.getText()}`,
          rule: move.rule,
        }
      : {
          start: property.name.getStart(),
          end: property.name.getEnd(),
          replacement: ts.isStringLiteral(property.name)
            ? `${property.name.getText()[0]}${replacement}${property.name.getText()[0]}`
            : replacement,
          rule: move.rule,
        };
  }
  if (names.includes(replacement))
    return {
      reason: `The request already sends ${replacement}; merging the ${parameter} needs review.`,
    };
  const value = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
  // The body's own quote style: its first string quote, else single quotes.
  const quote = /["']/.exec(body.getText())?.[0] ?? "'";
  return {
    start: property.getStart(),
    end: property.getEnd(),
    replacement: `${replacement}: { type: ${quote}${move.discriminator}${quote}, ${parameter}: ${value.getText()} }`,
    rule: move.rule,
  };
}
