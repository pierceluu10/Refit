import { local } from './request-removals.ts';
import { isObject } from './specifications.ts';
import { STRIPE_PACK, type RequestMove } from './rule-pack.ts';

// The code behind each request-move family in a rule pack (pipeline/rule-pack.ts): a removed request
// parameter whose documented replacement sends the same request. Every move is checked against both
// recorded contracts before any edit.
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

type Contract = { schema: Record<string, unknown>; document: Record<string, unknown> };

// The pack move of a removed parameter, named by its replacement, when both contracts agree with it.
export function requestMove(
  operationId: string,
  parameter: string,
  before: Contract,
  after: Contract,
): string | undefined {
  const move = STRIPE_PACK.requestMoves.find(
    (entry) =>
      entry.family !== 'request-enum-value' &&
      entry.parameter === parameter &&
      entry.operations.includes(operationId),
  );
  return move && requestMoveMatches(move, before, after) ? move.replacement : undefined;
}

// Whether both contracts agree with a move: a rename needs the same shape under the new name; a
// wrap needs a required string in the before body, and an after body whose replacement holds that
// string beside a `type` accepting the discriminator; an enum value needs a parameter whose before
// enum has the value and whose after enum has the replacement and not the value, or, with a
// discriminator, whose after schema is an object (no enum) whose discriminator enum has the
// replacement.
export function requestMoveMatches(move: RequestMove, before: Contract, after: Contract) {
  const old = isObject(before.schema.properties)
    ? before.schema.properties[move.parameter]
    : undefined;
  const target = isObject(after.schema.properties) ? after.schema.properties : {};
  if (move.family === 'request-enum-value') {
    const [was, now] = [local(old, before.document), local(target[move.parameter], after.document)];
    if (move.discriminator) {
      const type = local(properties(now, after.document)?.[move.discriminator], after.document);
      return Boolean(
        Array.isArray(was?.enum) &&
        was.enum.includes(move.value) &&
        now &&
        !now.enum &&
        Array.isArray(type?.enum) &&
        type.enum.includes(move.replacement),
      );
    }
    return Boolean(
      Array.isArray(was?.enum) &&
      Array.isArray(now?.enum) &&
      was.enum.includes(move.value) &&
      !now.enum.includes(move.value) &&
      now.enum.includes(move.replacement),
    );
  }
  if (move.family === 'request-rename') {
    const renamed = target[move.replacement];
    return Boolean(
      old &&
      renamed &&
      JSON.stringify(shape(old, before.document)) ===
        JSON.stringify(shape(renamed, after.document)),
    );
  }
  const required = Array.isArray(before.schema.required) ? before.schema.required : [];
  const holder = properties(target[move.replacement], after.document);
  const type = holder && local(holder.type, after.document);
  return Boolean(
    isString(old, before.document) &&
    required.includes(move.parameter) &&
    holder &&
    isString(holder[move.parameter], after.document) &&
    type &&
    Array.isArray(type.enum) &&
    type.enum.includes(move.discriminator),
  );
}
