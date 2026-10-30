import ts from 'typescript-compiler';
import type { RequestPropertyRename } from './provider-request-renames.ts';
import {
  CARD_PAYMENT_METHOD_RULE,
  LISTED_PAYMENT_METHODS_RULE,
  MOVED_PAYMENT_METHODS_RULE,
  type RequestParameterRemoval,
} from './request-removals.ts';
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

// Whether the object literal holding `property` also sends `name`, such as a body that already
// has the replacement of the removed parameter it sends.
export function sendsSibling(property: ts.ObjectLiteralElementLike, name: string | undefined) {
  return (
    name !== undefined &&
    ts.isObjectLiteralExpression(property.parent) &&
    property.parent.properties.some(
      (entry) =>
        entry !== property && entry.name !== undefined && propertyName(entry.name) === name,
    )
  );
}

// In-person methods: endive accepts them in `allowed_payment_method_types` only on PaymentIntents
// and SetupIntents (https://docs.stripe.com/changelog/endive/2026-09-30/card-present-and-interac-present-enum-values-for-allowed-payment-method-types,
// read 2026-10-24), and what they offer depends on reader configuration offline checks cannot see.
export const IN_PERSON_METHODS = new Set(['card_present', 'interac_present']);
const MAX_VALUE_HOPS = 4;

// Whether a `payment_method_types` value on a creation call's own object literal may move to
// `allowed_payment_method_types` unchanged (owner decision, 2026-10-24): any expression except one
// that spells an in-person method, itself or through a declaration it names (a const, a property,
// a function), and except an empty or repeated literal list.
export function movablePaymentMethods(
  property: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
  checker: ts.TypeChecker,
) {
  if (ts.isShorthandPropertyAssignment(property) && property.objectAssignmentInitializer)
    return false;
  const value = ts.isPropertyAssignment(property) ? property.initializer : property.name;
  if (ts.isArrayLiteralExpression(value) && value.elements.every(ts.isStringLiteralLike)) {
    const methods = value.elements.map((element) => (element as ts.StringLiteralLike).text);
    if (!methods.length || new Set(methods).size !== methods.length) return false;
  }
  const seen = new Set<ts.Node>();
  const inPerson = (node: ts.Node, hops: number): boolean => {
    if (seen.has(node)) return false;
    seen.add(node);
    if (ts.isStringLiteralLike(node)) return IN_PERSON_METHODS.has(node.text);
    if (ts.isIdentifier(node) && hops < MAX_VALUE_HOPS) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
      const target =
        symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      for (const declaration of target?.declarations ?? [])
        if (
          !declaration.getSourceFile().isDeclarationFile &&
          (ts.isVariableDeclaration(declaration) ||
            ts.isPropertyAssignment(declaration) ||
            ts.isFunctionDeclaration(declaration) ||
            ts.isMethodDeclaration(declaration)) &&
          inPerson(declaration, hops + 1)
        )
          return true;
    }
    return ts.forEachChild(node, (child) => inPerson(child, hops) || undefined) ?? false;
  };
  return !inPerson(value, 0);
}

type PaymentMethodRule =
  | typeof CARD_PAYMENT_METHOD_RULE
  | typeof LISTED_PAYMENT_METHODS_RULE
  | typeof MOVED_PAYMENT_METHODS_RULE;

// The rule that renames a `payment_method_types` property of a creation call body: an exact
// `['card']`; with keep-listed, a literal list of `card` plus other distinct methods or any other
// movable expression. Never one whose body already sends the replacement.
export function paymentMethodRule(
  property: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
  options: { keepListed?: boolean; checker?: ts.TypeChecker },
): PaymentMethodRule | undefined {
  if (sendsSibling(property, 'allowed_payment_method_types')) return undefined;
  const methods =
    ts.isPropertyAssignment(property) &&
    ts.isArrayLiteralExpression(property.initializer) &&
    property.initializer.elements.every(ts.isStringLiteralLike)
      ? property.initializer.elements.map((element) => (element as ts.StringLiteralLike).text)
      : undefined;
  if (methods?.length === 1 && methods[0] === 'card') return CARD_PAYMENT_METHOD_RULE;
  if (!options.keepListed || !options.checker) return undefined;
  if (
    methods &&
    methods.length > 1 &&
    methods.includes('card') &&
    !methods.some((method) => IN_PERSON_METHODS.has(method)) &&
    new Set(methods).size === methods.length
  )
    return LISTED_PAYMENT_METHODS_RULE;
  return movablePaymentMethods(property, options.checker) ? MOVED_PAYMENT_METHODS_RULE : undefined;
}

// Object-literal keys spelling the removed `payment_method_types` outside every traced SDK call
// body. A body built in a variable, assembled by a wrapper or sent by an untraced client still
// sends it once the pin moves, so each one stops for review (docs/STRIPE-PAYMENT-METHOD-TYPES.md).
// Only top-level body keys count: a nested `payment_settings.payment_method_types` is still valid
// on subscriptions and invoices. Test files send no production request, and an object value is a
// schema definition such as Mongoose's `{ type: [String] }`, never a payment method list.
// `rule` marks a value in a local variable that only reaches confirmed SDK calls of the operations
// whose removal has the owner-approved replacement: the same site as a direct
// `create({ payment_method_types: … })`, so the rule a direct body would get renames it (an exact
// `['card']`, or with keep-listed a literal list with card or a movable expression).
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
    rule?: PaymentMethodRule;
    calls?: ts.CallExpression[];
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
    const calls = localCalls(node.parent, removal.parameter);
    // Only SDK calls that still accept the parameter, such as `stripe.paymentLinks.create(params)`.
    if (calls?.every((call) => !removalFor(removal.parameter, call))) continue;
    const targets = calls?.map((call) => removalFor(removal.parameter, call));
    const rule =
      targets?.every((target) => target?.cardReplacement) &&
      calls!.every((call) => sdkOperation(call)!.confirmed)
        ? paymentMethodRule(node, {
            keepListed: targets.every((target) => target?.keepListed),
            checker,
          })
        : undefined;
    sites.push({
      property: node,
      removal: targets?.[0] ?? removal,
      ...(rule ? { rule, calls } : {}),
    });
  }
  return sites;
}
