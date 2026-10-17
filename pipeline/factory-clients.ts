import ts from 'typescript-compiler';

type Creation = ts.NewExpression | ts.CallExpression;
type Factory = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
// 'client': every non-null value the expression can produce is an SDK client; 'null': it only
// produces null or undefined; undefined: anything else.
type Value = 'client' | 'null' | undefined;

// Clients created behind a factory: a function whose every return is a client (or null), a
// module `let` holder that is only ever assigned clients (`_stripe ??= new Stripe(key)`), or a
// constant like `key ? new Stripe(key) : null`. Any other write to the holder or the factory, a
// generator or an async factory, or a return of anything else leaves the client untraced.
export function factoryClients(options: {
  nodes: ts.Node[];
  clients: Set<ts.Symbol>;
  symbol: (node: ts.Node) => ts.Symbol | undefined;
  creation: (node: ts.Node) => Creation | undefined;
}) {
  const { nodes, clients, symbol, creation } = options;
  const factories = new Map<ts.Symbol, Factory>();
  const holders = new Set<ts.Symbol>();
  const creations = new Map<ts.Node, ts.Symbol>();
  const candidateFactories = new Map<ts.Symbol, Factory>();
  const candidateHolders = new Map<ts.Symbol, ts.VariableDeclaration>();
  const conditionals: (ts.VariableDeclaration & {
    name: ts.Identifier;
    initializer: ts.Expression;
  })[] = [];
  const writes = new Map<ts.Symbol, ts.Expression[]>();
  const rejected = new Set<ts.Symbol>();

  function unwrap(expression: ts.Expression): ts.Expression {
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    )
      return unwrap(expression.expression);
    return expression;
  }
  const nullish = (expression: ts.Expression) =>
    expression.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(expression) && expression.text === 'undefined') ||
    ts.isVoidExpression(expression);
  const assignment = (node: ts.Node): node is ts.BinaryExpression =>
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
  const replacing = (node: ts.BinaryExpression) =>
    [
      ts.SyntaxKind.EqualsToken,
      ts.SyntaxKind.QuestionQuestionEqualsToken,
      ts.SyntaxKind.BarBarEqualsToken,
    ].includes(node.operatorToken.kind);
  const combine = (values: Value[]): Value =>
    values.includes(undefined) ? undefined : values.includes('client') ? 'client' : 'null';

  function factoryCall(expression: ts.Expression) {
    const value = unwrap(expression);
    if (!ts.isCallExpression(value) || value.questionDotToken) return;
    const callee = unwrap(value.expression);
    if (!ts.isIdentifier(callee)) return;
    const binding = symbol(callee);
    return binding && factories.has(binding) ? binding : undefined;
  }
  function value(expression: ts.Expression, found: Creation[] = []): Value {
    const current = unwrap(expression);
    const sdk = creation(current);
    if (sdk) {
      found.push(sdk);
      return 'client';
    }
    if (nullish(current)) return 'null';
    if (ts.isIdentifier(current)) {
      const binding = symbol(current);
      return binding && (holders.has(binding) || clients.has(binding)) ? 'client' : undefined;
    }
    if (factoryCall(current)) return 'client';
    if (ts.isConditionalExpression(current))
      return combine([value(current.whenTrue, found), value(current.whenFalse, found)]);
    if (
      ts.isBinaryExpression(current) &&
      [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(
        current.operatorToken.kind,
      )
    )
      return combine([value(current.left, found), value(current.right, found)]);
    if (assignment(current) && replacing(current) && ts.isIdentifier(current.left)) {
      const binding = symbol(current.left);
      return binding && holders.has(binding) ? value(current.right, found) : undefined;
    }
    return undefined;
  }
  function returns(factory: Factory) {
    if (!ts.isBlock(factory.body!)) return [factory.body as ts.Expression];
    const found: (ts.Expression | undefined)[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
      if (ts.isReturnStatement(node)) found.push(node.expression);
      ts.forEachChild(node, visit);
    };
    visit(factory.body!);
    return found;
  }

  for (const node of nodes) {
    if (ts.isFunctionDeclaration(node) && node.name && node.body && !node.asteriskToken) {
      const binding = symbol(node.name);
      if (binding) candidateFactories.set(binding, node);
    }
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) continue;
    const list = node.parent;
    if (!ts.isVariableDeclarationList(list)) continue;
    const binding = symbol(node.name);
    if (!binding) continue;
    const constant = Boolean(list.flags & ts.NodeFlags.Const);
    const initializer = node.initializer && unwrap(node.initializer);
    if (
      constant &&
      initializer &&
      (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) &&
      !initializer.asteriskToken
    )
      candidateFactories.set(binding, initializer);
    else if (
      constant &&
      initializer &&
      (ts.isConditionalExpression(initializer) || ts.isBinaryExpression(initializer))
    )
      conditionals.push(
        node as ts.VariableDeclaration & { name: ts.Identifier; initializer: ts.Expression },
      );
    else if (!constant && !ts.isForInStatement(list.parent) && !ts.isForOfStatement(list.parent))
      candidateHolders.set(binding, node);
  }
  for (const [binding, factory] of candidateFactories)
    if (factory.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword))
      rejected.add(binding);
  // Holders and factories may only be written by a plain replacement of the whole binding.
  for (const node of nodes) {
    if (!ts.isIdentifier(node)) continue;
    const binding = symbol(node);
    if (!binding || !(candidateHolders.has(binding) || candidateFactories.has(binding))) continue;
    let child: ts.Node = node;
    let parent = node.parent;
    while (
      ts.isParenthesizedExpression(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isObjectLiteralExpression(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isShorthandPropertyAssignment(parent) ||
      ts.isSpreadElement(parent) ||
      ts.isSpreadAssignment(parent)
    ) {
      child = parent;
      parent = parent.parent;
    }
    if (assignment(parent) && parent.left === child) {
      if (child === node && replacing(parent))
        writes.set(binding, [...(writes.get(binding) ?? []), parent.right]);
      else rejected.add(binding);
    } else if (
      ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(parent.operator)) ||
      ((ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer === child)
    )
      rejected.add(binding);
  }
  for (const binding of rejected) {
    candidateHolders.delete(binding);
    candidateFactories.delete(binding);
  }
  for (const binding of candidateFactories.keys())
    if (writes.has(binding)) candidateFactories.delete(binding);

  // Grows from nothing, so a holder or factory is accepted only when all of its values are known.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [binding, declaration] of candidateHolders) {
      if (holders.has(binding)) continue;
      const values = [declaration.initializer, ...(writes.get(binding) ?? [])].map((entry) =>
        entry ? value(entry) : 'null',
      );
      if (values.includes('client') && combine(values) === 'client') {
        holders.add(binding);
        changed = true;
      }
    }
    for (const [binding, factory] of candidateFactories) {
      if (factories.has(binding)) continue;
      const values = returns(factory).map((entry) => (entry ? value(entry) : 'null'));
      if (values.includes('client') && combine(values) === 'client') {
        factories.set(binding, factory);
        clients.add(binding);
        changed = true;
      }
    }
    for (const declaration of conditionals) {
      const binding = symbol(declaration.name);
      if (!binding || clients.has(binding) || creation(unwrap(declaration.initializer))) continue;
      const found: Creation[] = [];
      if (value(declaration.initializer, found) === 'client' && found.length) {
        clients.add(binding);
        for (const sdk of found) creations.set(sdk, binding);
        changed = true;
      }
    }
  }
  // Each constructor behind a factory declares that factory's version.
  for (const [binding, factory] of factories) {
    for (const entry of returns(factory)) {
      if (!entry) continue;
      const found: Creation[] = [];
      value(entry, found);
      const holderValues = [entry];
      for (let index = 0; index < holderValues.length; index++) {
        const current = unwrap(holderValues[index]);
        const holder = ts.isIdentifier(current) ? symbol(current) : undefined;
        if (holder && holders.has(holder))
          for (const write of [
            candidateHolders.get(holder)!.initializer,
            ...(writes.get(holder) ?? []),
          ])
            if (write) value(write, found);
        if (ts.isBinaryExpression(current)) holderValues.push(current.left, current.right);
        if (ts.isConditionalExpression(current))
          holderValues.push(current.whenTrue, current.whenFalse);
      }
      for (const sdk of found) if (!creations.has(sdk)) creations.set(sdk, binding);
    }
  }
  return { factories, holders, creations, call: factoryCall };
}
