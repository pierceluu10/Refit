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
    (property): property is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      propertyName(property.name) === removal.parameter,
  );
}

// An object only turned into text: an argument of `JSON.stringify` or `console.*`, directly or as
// what a `.map` callback returns into such an argument. Text sends no request, so the key in it is
// output, such as `{ payment_method_types: pi.payment_method_types }` logged from a response.
function printedOnly(object: ts.Expression): boolean {
  let value: ts.Node = object;
  for (;;) {
    while (ts.isParenthesizedExpression(value.parent)) value = value.parent;
    const parent = value.parent;
    if (ts.isArrowFunction(parent) && parent.body === value) {
      const call = parent.parent;
      if (
        !ts.isCallExpression(call) ||
        call.arguments[0] !== parent ||
        !ts.isPropertyAccessExpression(call.expression) ||
        call.expression.name.text !== 'map'
      )
        return false;
      value = call;
      continue;
    }
    if (!ts.isCallExpression(parent) || !parent.arguments.includes(value as ts.Expression))
      return false;
    const callee = parent.expression;
    return (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      ((callee.expression.text === 'JSON' && callee.name.text === 'stringify') ||
        callee.expression.text === 'console')
    );
  }
}

// Object-literal keys spelling the removed `payment_method_types` outside every traced SDK call
// body. A body built in a variable, assembled by a wrapper or sent by an untraced client still
// sends it once the pin moves, so each one goes to the agent fixer.
// Only top-level body keys count: a nested `payment_settings.payment_method_types` is still valid
// on subscriptions and invoices. Test files send no production request, and an object value is a
// schema definition such as Mongoose's `{ type: [String] }`, never a payment method list.
export function untracedRemovedParameters(
  nodes: ts.Node[],
  removals: RequestParameterRemoval[],
  sdkOperation: (
    call: ts.CallExpression,
  ) => { resource: string; method: string; confirmed: boolean } | undefined,
  file: (node: ts.Node) => string,
  checker?: ts.TypeChecker,
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
  // `write` is an assignment of the parameter onto the variable, which is the site itself.
  const localCalls = (object: ts.Expression, parameter: string, write?: ts.Node) => {
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
            (parent.name.text !== parameter || parent === write);
      } else ts.forEachChild(node, visit);
    };
    const scope = declaration.parent.parent.parent;
    // A `case` clause's declarations are in scope for every clause of its switch.
    visit(ts.isCaseClause(scope) || ts.isDefaultClause(scope) ? scope.parent : scope);
    return local ? calls : undefined;
  };
  const sites: {
    property: ts.Node;
    removal: RequestParameterRemoval;
  }[] = [];
  for (const node of nodes) {
    // `params.payment_method_types = …` onto a local body: never renamed, and a stop unless that
    // body only reaches calls that still accept the parameter.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      removed.has(node.left.name.text) &&
      !TEST_PATH.test(file(node))
    ) {
      const removal = removed.get(node.left.name.text)!;
      const declaration = checker?.getSymbolAtLocation(node.left.expression)?.valueDeclaration;
      let body =
        declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
      while (body && (ts.isParenthesizedExpression(body) || ts.isAsExpression(body)))
        body = body.expression;
      const calls =
        body && ts.isObjectLiteralExpression(body)
          ? localCalls(body, removal.parameter, node.left)
          : undefined;
      if (calls?.every((call) => !removalFor(removal.parameter, call))) continue;
      sites.push({ property: node.left, removal });
      continue;
    }
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
    if (printedOnly(node.parent)) continue;
    const calls = localCalls(node.parent, removal.parameter);
    // Only SDK calls that still accept the parameter, such as `stripe.paymentLinks.create(params)`.
    if (calls?.every((call) => !removalFor(removal.parameter, call))) continue;
    sites.push({
      property: node,
      removal: calls?.map((call) => removalFor(removal.parameter, call))[0] ?? removal,
    });
  }
  return sites;
}
