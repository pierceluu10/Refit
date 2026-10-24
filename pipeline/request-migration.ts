import ts from 'typescript-compiler';
import type { RequestPropertyRename } from './provider-request-renames.ts';
import type { RequestParameterRemoval } from './request-removals.ts';
import { TEST_PATH } from './source-paths.ts';

function propertyName(name: ts.PropertyName) {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
    ? name.text
    : undefined;
}

export function requestPropertyEdit(call: ts.CallExpression, rule: RequestPropertyRename) {
  const argument = call.arguments[rule.argumentIndex];
  if (!argument || !ts.isObjectLiteralExpression(argument))
    return {
      status: 'review' as const,
      reason: 'Request body is not a direct object literal at the configured SDK argument.',
    };
  const fields = new Map<string, ts.PropertyAssignment | ts.ShorthandPropertyAssignment>();
  for (const property of argument.properties) {
    if (!(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)))
      return {
        status: 'review' as const,
        reason: 'Request spreads, methods and accessors require review.',
      };
    const name = propertyName(property.name);
    if (name === undefined || fields.has(name))
      return {
        status: 'review' as const,
        reason: 'Computed or duplicate request properties require review.',
      };
    fields.set(name, property);
  }
  const source = fields.get(rule.removed);
  if (!source) return { status: 'unaffected' as const };
  if (fields.has(rule.replacement))
    return {
      status: 'review' as const,
      reason: 'Request already supplies both the removed and replacement fields.',
    };
  if (ts.isShorthandPropertyAssignment(source) && source.objectAssignmentInitializer)
    return { status: 'review' as const, reason: 'Request shorthand initializers require review.' };
  return {
    status: 'editable' as const,
    start: source.name.getStart(),
    end: source.name.getEnd(),
    replacement: ts.isShorthandPropertyAssignment(source)
      ? `${rule.replacement}: ${source.name.getText()}`
      : ts.isStringLiteral(source.name)
        ? JSON.stringify(rule.replacement)
        : rule.replacement,
  };
}

// The property sending a removed parameter in a direct object-literal SDK body. Bodies built
// elsewhere are not traced, so absence is not proof the parameter is unused.
export function removedParameterProperty(
  call: ts.CallExpression,
  removal: RequestParameterRemoval,
) {
  const argument = call.arguments[removal.argumentIndex];
  if (!argument || !ts.isObjectLiteralExpression(argument)) return undefined;
  return argument.properties.find(
    (property) =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      propertyName(property.name) === removal.parameter,
  );
}

// Object-literal keys spelling the removed `payment_method_types` outside every traced SDK call
// body. A body built in a variable, assembled by a wrapper or sent by an untraced client still
// sends it once the pin moves, so each one stops for review (docs/STRIPE-PAYMENT-METHOD-TYPES.md).
// Only top-level body keys count: a nested `payment_settings.payment_method_types` is still valid
// on subscriptions and invoices. Test files send no production request, and an object value is a
// schema definition such as Mongoose's `{ type: [String] }`, never a payment method list.
export function untracedRemovedParameters(
  nodes: ts.Node[],
  removals: RequestParameterRemoval[],
  tracedBody: (object: ts.ObjectLiteralExpression) => boolean,
  file: (node: ts.Node) => string,
) {
  const removed = new Map(
    removals.filter((removal) => removal.cardReplacement).map((entry) => [entry.parameter, entry]),
  );
  const sites: { property: ts.ObjectLiteralElementLike; removal: RequestParameterRemoval }[] = [];
  for (const node of nodes) {
    if (!(ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node))) continue;
    const name = propertyName(node.name);
    const removal = name === undefined ? undefined : removed.get(name);
    if (
      !removal ||
      (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.initializer)) ||
      !ts.isObjectLiteralExpression(node.parent) ||
      ts.isPropertyAssignment(node.parent.parent) ||
      tracedBody(node.parent) ||
      TEST_PATH.test(file(node))
    )
      continue;
    sites.push({ property: node, removal });
  }
  return sites;
}
