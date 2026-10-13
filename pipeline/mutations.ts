import ts from 'typescript-compiler';

function receiver(node: ts.Node): ts.Identifier | undefined {
  if (ts.isIdentifier(node)) return node;
  if (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  )
    return receiver(node.expression);
}

export function unsafeBindings(
  nodes: ts.Node[],
  checker: ts.TypeChecker,
  clients: Set<ts.Symbol>,
  origins: Map<ts.Symbol, ts.CallExpression>,
  canonical: (symbol: ts.Symbol | undefined) => ts.Symbol | undefined = (symbol) => symbol,
  initialUnsafe: Set<ts.Symbol> = new Set(),
  readOnlyCall: (node: ts.CallExpression) => boolean = () => false,
  arrayIteration: (
    node: ts.CallExpression,
  ) =>
    { callback: ts.Expression; parameter: ts.Identifier; source: ts.Expression } | undefined = () =>
    undefined,
) {
  const links = new Map<ts.Symbol, Set<ts.Symbol>>();
  const unsafe = new Set(initialUnsafe);
  const exposed: ts.Expression[] = [];
  const binding = (node: ts.Node) => {
    const identifier = receiver(node);
    return identifier ? canonical(checker.getSymbolAtLocation(identifier)) : undefined;
  };
  const link = (from: ts.Symbol | undefined, to: ts.Symbol | undefined) => {
    if (!from || !to) return;
    const targets = links.get(from) ?? new Set<ts.Symbol>();
    targets.add(to);
    links.set(from, targets);
  };
  const taint = (node: ts.Node) => {
    const value = binding(node);
    if (value) unsafe.add(value);
  };
  const targets = (node: ts.Node) => {
    if (receiver(node)) taint(node);
    // Passing a call's result does not expose its callee or SDK client.
    else if (ts.isCallExpression(node) || ts.isNewExpression(node))
      for (const argument of node.arguments ?? []) targets(argument);
    else ts.forEachChild(node, targets);
  };
  const aliases = (name: ts.BindingName, source: ts.Symbol | undefined) => {
    if (ts.isIdentifier(name)) {
      const target = canonical(checker.getSymbolAtLocation(name));
      link(source, target);
      link(target, source);
    } else
      for (const element of name.elements)
        if (ts.isBindingElement(element)) aliases(element.name, source);
  };
  for (const node of nodes) {
    if (
      (ts.isReturnStatement(node) || ts.isThrowStatement(node) || ts.isYieldExpression(node)) &&
      node.expression
    )
      exposed.push(node.expression);
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) exposed.push(node.body);
    if (ts.isVariableDeclaration(node) && node.initializer)
      aliases(node.name, binding(node.initializer));
    if (
      ts.isForOfStatement(node) &&
      ts.isVariableDeclarationList(node.initializer) &&
      node.initializer.declarations.length === 1
    )
      aliases(node.initializer.declarations[0].name, binding(node.expression));
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      (ts.isConditionalExpression(node.initializer) || ts.isBinaryExpression(node.initializer))
    )
      targets(node.initializer);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      targets(node.left);
      // Assigning a reference into another object or binding allows later mutation through it.
      targets(node.right);
    }
    if (ts.isDeleteExpression(node)) taint(node.expression);
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    )
      taint(node.operand);
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const iteration = ts.isCallExpression(node) ? arrayIteration(node) : undefined;
      for (const argument of node.arguments ?? [])
        if (iteration?.callback !== argument) targets(argument);
      if (iteration) {
        const source = binding(iteration.source);
        const target = canonical(checker.getSymbolAtLocation(iteration.parameter));
        link(source, target);
        link(target, source);
      }
      if (
        ts.isCallExpression(node) &&
        (ts.isPropertyAccessExpression(node.expression) ||
          ts.isElementAccessExpression(node.expression))
      ) {
        const owner = binding(node.expression.expression);
        if (owner && !clients.has(owner) && !readOnlyCall(node)) unsafe.add(owner);
      }
    }
    if (ts.isPropertyAssignment(node)) taint(node.initializer);
    if (ts.isShorthandPropertyAssignment(node)) {
      const value = canonical(checker.getShorthandAssignmentValueSymbol(node));
      if (value) unsafe.add(value);
    }
    if (ts.isArrayLiteralExpression(node)) for (const element of node.elements) taint(element);
    if (ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) taint(node.expression);
    if (ts.isExportAssignment(node)) targets(node.expression);
  }
  const propagate = (seeds: Set<ts.Symbol>) => {
    const reached = new Set(seeds);
    const pending = [...seeds];
    for (let index = 0; index < pending.length; index++) {
      for (const dependent of links.get(pending[index]) ?? []) {
        if (reached.has(dependent)) continue;
        reached.add(dependent);
        pending.push(dependent);
      }
    }
    return reached;
  };
  const clientAliases = propagate(clients);
  const expose = (expression: ts.Expression): void => {
    if (ts.isIdentifier(expression)) taint(expression);
    else if (
      ts.isPropertyAccessExpression(expression) ||
      ts.isElementAccessExpression(expression)
    ) {
      if (clientAliases.has(binding(expression)!)) taint(expression);
    } else if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isAwaitExpression(expression)
    )
      expose(expression.expression);
    else if (ts.isConditionalExpression(expression)) {
      expose(expression.whenTrue);
      expose(expression.whenFalse);
    } else if (ts.isBinaryExpression(expression)) {
      expose(expression.left);
      expose(expression.right);
    }
  };
  // Returning an entire binding or SDK resource exposes it to callers. Ordinary response
  // field returns remain supported; their value semantics require migration review.
  for (const expression of exposed) expose(expression);
  // A replaced SDK method invalidates its responses, not the reverse.
  for (const [response, call] of origins) link(binding(call.expression), response);
  return propagate(unsafe);
}
