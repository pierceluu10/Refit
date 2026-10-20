import ts from 'typescript-compiler';

type Creation = ts.NewExpression | ts.CallExpression;
type Factory =
  ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;
// 'client': every non-null value the expression can produce is an SDK client; 'null': it only
// produces null or undefined; undefined: anything else.
type Value = 'client' | 'null' | undefined;

// Clients created behind a factory: a function or static method whose every return is a client
// (or null), a module `let` or static property holder that is only ever assigned clients
// (`_stripe ??= new Stripe(key)`), or a constant like `key ? new Stripe(key) : null`. An async factory counts only when every call to it
// is awaited at once. Any other write to the holder or the factory, a generator, or a return of
// anything else leaves the client untraced.
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
  const candidateHolders = new Map<ts.Symbol, ts.VariableDeclaration | ts.PropertyDeclaration>();
  const conditionals: (ts.VariableDeclaration & {
    name: ts.Identifier;
    initializer: ts.Expression;
  })[] = [];
  const writes = new Map<ts.Symbol, ts.Expression[]>();
  const rejected = new Set<ts.Symbol>();
  const asyncFactories = new Set<ts.Symbol>();

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
  const isStatic = (node: ts.MethodDeclaration | ts.PropertyDeclaration) =>
    Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword));
  // `Class.member` names a static holder or factory the way a bare identifier names a module one.
  const reference = (expression: ts.Expression) =>
    ts.isIdentifier(expression)
      ? symbol(expression)
      : ts.isPropertyAccessExpression(expression) &&
          !expression.questionDotToken &&
          ts.isIdentifier(expression.name)
        ? symbol(expression.name)
        : undefined;
  const combine = (values: Value[]): Value =>
    values.includes(undefined) ? undefined : values.includes('client') ? 'client' : 'null';

  // An async factory's call is a promise; only `await factory()` is the client.
  function factoryCall(expression: ts.Expression) {
    const outer = unwrap(expression);
    const awaited = ts.isAwaitExpression(outer);
    const value = ts.isAwaitExpression(outer) ? unwrap(outer.expression) : outer;
    if (!ts.isCallExpression(value) || value.questionDotToken) return;
    const binding = reference(unwrap(value.expression));
    if (!binding || !factories.has(binding)) return;
    return awaited || !asyncFactories.has(binding) ? binding : undefined;
  }
  function value(expression: ts.Expression, found: Creation[] = []): Value {
    const current = unwrap(expression);
    const sdk = creation(current);
    if (sdk) {
      found.push(sdk);
      return 'client';
    }
    if (nullish(current)) return 'null';
    if (ts.isIdentifier(current) || ts.isPropertyAccessExpression(current)) {
      const binding = reference(current);
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
    if (assignment(current) && replacing(current)) {
      const binding = reference(current.left);
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
    if (
      ts.isMethodDeclaration(node) &&
      isStatic(node) &&
      ts.isIdentifier(node.name) &&
      node.body &&
      !node.asteriskToken
    ) {
      const binding = symbol(node.name);
      if (binding) candidateFactories.set(binding, node);
    }
    if (ts.isPropertyDeclaration(node) && isStatic(node) && ts.isIdentifier(node.name)) {
      const binding = symbol(node.name);
      if (binding) candidateHolders.set(binding, node);
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
      asyncFactories.add(binding);
  // A promise from an async factory that is not awaited at once could carry the client anywhere.
  for (const node of nodes) {
    if (!ts.isCallExpression(node)) continue;
    const binding = reference(unwrap(node.expression));
    if (!binding || !asyncFactories.has(binding)) continue;
    let parent = node.parent;
    while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
    if (node.questionDotToken || !ts.isAwaitExpression(parent)) rejected.add(binding);
  }
  // Holders and factories may only be written by a plain replacement of the whole binding.
  for (const node of nodes) {
    if (!ts.isIdentifier(node)) continue;
    const binding = symbol(node);
    if (!binding || !(candidateHolders.has(binding) || candidateFactories.has(binding))) continue;
    let child: ts.Node = node;
    let parent = node.parent;
    // shortcut: element access (`Class['client'] = x`) has no identifier, so such a write goes
    // unseen; upgrade if static holders written that way show up.
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
      child = parent;
      parent = parent.parent;
    }
    const target = child;
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
      if (child === target && replacing(parent))
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
        const holder = reference(current);
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
