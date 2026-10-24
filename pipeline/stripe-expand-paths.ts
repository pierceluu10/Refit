import ts from 'typescript-compiler';
import { componentReference, isObject, resolvableComponentSchema } from './specifications.ts';
import { STRIPE_MOVE_REVIEW } from './stripe-field-moves.ts';
import type { Removal } from './types.ts';

// A call that keeps `expand: ['latest_invoice.payment_intent']` asks the target version to expand a
// field it no longer has. Stripe's expand guide allows only properties the API reference marks
// Expandable (https://docs.stripe.com/expand, read 2026-10-24), and basil's page moves this exact
// expand to `confirmation_secret`
// (https://docs.stripe.com/changelog/basil/2025-03-31/add-support-for-multiple-partial-payments-on-invoices).
// No offline check sees it, because only Stripe evaluates the request, so it stays unresolved.

export interface RemovedExpandPath {
  node: ts.StringLiteralLike;
  path: string;
  removal: Removal;
}

// The component a property points to: a reference, an expandable `anyOf` (ID or object), or a
// list's items. Undefined for anything else, which ends the walk without a finding.
function propertyTarget(schemas: Record<string, unknown>, value: unknown): string | undefined {
  if (!isObject(value)) return;
  const direct = componentReference(value.$ref);
  if (direct) return direct;
  for (const key of ['anyOf', 'oneOf'])
    if (Array.isArray(value[key])) {
      const references = (value[key] as unknown[])
        .map((entry) => (isObject(entry) ? componentReference(entry.$ref) : undefined))
        .filter((entry): entry is string => entry !== undefined);
      if (references.length === 1) return references[0];
      return;
    }
  if (value.type === 'array') return propertyTarget(schemas, value.items);
  // A list object (`{ object: 'list', data: [...] }`) declared inline.
  if (isObject(value.properties) && isObject(value.properties.data))
    return propertyTarget(schemas, value.properties.data);
}

function isList(value: unknown) {
  return (
    isObject(value) &&
    (value.type === 'array' || (isObject(value.properties) && isObject(value.properties.data)))
  );
}

// The literal `expand` entries of a call's object arguments that walk through a removed field,
// starting at the operation's response schema. Entries Refit cannot follow end silently.
export function removedExpandPaths(
  call: ts.CallExpression,
  schema: string,
  changes: Removal[],
  schemas: Record<string, unknown>,
): RemovedExpandPath[] {
  const found: RemovedExpandPath[] = [];
  for (const argument of call.arguments) {
    if (!ts.isObjectLiteralExpression(argument)) continue;
    for (const property of argument.properties) {
      if (
        !ts.isPropertyAssignment(property) ||
        !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ||
        property.name.text !== 'expand' ||
        !ts.isArrayLiteralExpression(property.initializer)
      )
        continue;
      for (const element of property.initializer.elements) {
        if (!ts.isStringLiteralLike(element)) continue;
        let current: string | undefined = resolvableComponentSchema(schemas, schema);
        let listed = false;
        for (const segment of element.text.split('.')) {
          if (!current) break;
          const definition = schemas[current];
          const properties =
            isObject(definition) && isObject(definition.properties) ? definition.properties : {};
          // A list's items were already entered: `lines.data.price` reads `data` as the list.
          if (segment === 'data' && !Object.hasOwn(properties, 'data') && listed) {
            listed = false;
            continue;
          }
          const removal = changes.find(
            (change) => change.schema === current && change.property === segment,
          );
          if (removal) {
            found.push({ node: element, path: element.text, removal });
            break;
          }
          const value = properties[segment];
          listed = isList(value);
          const next = propertyTarget(schemas, value);
          current = next && resolvableComponentSchema(schemas, next);
        }
      }
    }
  }
  return found;
}

export function removedExpandReason(hit: RemovedExpandPath) {
  const field = `${hit.removal.schema}.${hit.removal.property}`;
  const moved = STRIPE_MOVE_REVIEW[field];
  return `This call expands '${hit.path}', but the target API version removed ${field}. Stripe expands only properties its API reference marks Expandable (https://docs.stripe.com/expand), and no offline check can show how Stripe answers this request on the new version, so this read of the response cannot be migrated automatically and stays for review.${moved ? ` ${moved}` : ''}`;
}
