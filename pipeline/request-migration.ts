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
// `rename` marks an exact `['card']` in a local variable that only reaches confirmed SDK calls of
// the operations whose removal has the owner-approved card replacement: the same site as a
// direct `create({ payment_method_types: ['card'] })`, so the card rule can rename it.
export function untracedRemovedParameters(
  nodes: ts.Node[],
  removals: RequestParameterRemoval[],
  sdkOperation: (
    call: ts.CallExpression,
  ) => { resource: string; method: string; confirmed: boolean } | undefined,
  file: (node: ts.Node) => string,
) {
  const removed = new Map(
    removals.filter((removal) => removal.cardReplacement).map((entry) => [entry.parameter, entry]),
  );
  const removalFor = (parameter: string, call: ts.CallExpression) => {
    const operation = sdkOperation(call);
    return operation
      ? removals.find(
          (entry) =>
            entry.parameter === parameter &&
            entry.resource === operation.resource &&
            entry.method === operation.method,
        )
      : undefined;
  };
  const argument = (node: ts.Node) =>
    ts.isCallExpression(node.parent) && node.parent.arguments.includes(node as ts.Expression);
  // The traced SDK calls a local, non-exported variable is passed to, when every other use is a
  // property access that is not the parameter itself; undefined when any use is anything else.
  const localCalls = (object: ts.Expression, parameter: string) => {
    let value: ts.Node = object;
    while (
      ts.isParenthesizedExpression(value.parent) ||
      ts.isAsExpression(value.parent) ||
      ts.isSatisfiesExpression(value.parent)
    )
      value = value.parent;
    const declaration = value.parent;
    if (
      !ts.isVariableDeclaration(declaration) ||
      declaration.initializer !== value ||
      !ts.isIdentifier(declaration.name) ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      // `var` is function-scoped, so its uses can sit outside the enclosing block.
      !(declaration.parent.flags & ts.NodeFlags.BlockScoped) ||
      !ts.isVariableStatement(declaration.parent.parent) ||
      declaration.parent.parent.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      )
    )
      return undefined;
    const name = declaration.name.text;
    const calls: ts.CallExpression[] = [];
    let local = true;
    const visit = (node: ts.Node): void => {
      if (!local) return;
      if (ts.isIdentifier(node) && node.text === name && node !== declaration.name) {
        const parent = node.parent;
        if (argument(node) && sdkOperation(parent as ts.CallExpression))
          calls.push(parent as ts.CallExpression);
        else
          local =
            ts.isPropertyAccessExpression(parent) &&
            parent.expression === node &&
            parent.name.text !== parameter;
      } else ts.forEachChild(node, visit);
    };
    visit(declaration.parent.parent.parent);
    return local ? calls : undefined;
  };
  const cardOnly = (node: ts.ObjectLiteralElementLike) =>
    ts.isPropertyAssignment(node) &&
    ts.isArrayLiteralExpression(node.initializer) &&
    node.initializer.elements.length === 1 &&
    ts.isStringLiteralLike(node.initializer.elements[0]) &&
    node.initializer.elements[0].text === 'card';
  const sites: {
    property: ts.ObjectLiteralElementLike;
    removal: RequestParameterRemoval;
    rename?: true;
  }[] = [];
  for (const node of nodes) {
    if (!(ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node))) continue;
    const name = propertyName(node.name);
    const removal = name === undefined ? undefined : removed.get(name);
    if (
      !removal ||
      (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.initializer)) ||
      !ts.isObjectLiteralExpression(node.parent) ||
      ts.isPropertyAssignment(node.parent.parent) ||
      // A traced SDK body is checked against its own operation by the analyzer.
      (argument(node.parent) && sdkOperation(node.parent.parent as ts.CallExpression)) ||
      TEST_PATH.test(file(node))
    )
      continue;
    const calls = localCalls(node.parent, removal.parameter);
    // Only SDK calls that still accept the parameter, such as `stripe.paymentLinks.create(params)`.
    if (calls?.every((call) => !removalFor(removal.parameter, call))) continue;
    const targets = calls?.map((call) => removalFor(removal.parameter, call));
    const rename =
      cardOnly(node) &&
      targets?.every((target) => target?.cardReplacement) &&
      calls!.every((call) => sdkOperation(call)!.confirmed);
    sites.push({ property: node, removal: targets?.[0] ?? removal, ...(rename ? { rename } : {}) });
  }
  return sites;
}
