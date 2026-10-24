import ts from 'typescript-compiler';

// `new Proxy(target, { get: (_, key) => client[key] })`, or the same with `Reflect.get(client, key)`
// or `Reflect.get(client, key, receiver)`, forwards every read to `client`; returns that expression.
// The trap may first fill `client` (`client ??= make()` or `if (!client) client = make()`); that
// write is checked wherever `client` is. It may name the client in a `const` first
// (`const client = getStripe()`), and may bind methods to that same client before returning them.
// Any other trap or trap body is not one.
export function proxyClient(expression: ts.Expression): ts.Expression | undefined {
  const unwrap = (node: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
      ? unwrap(node.expression)
      : node;
  const proxy = unwrap(expression);
  if (
    !ts.isNewExpression(proxy) ||
    !ts.isIdentifier(proxy.expression) ||
    proxy.expression.text !== 'Proxy' ||
    proxy.arguments?.length !== 2
  )
    return;
  const handler = unwrap(proxy.arguments[1]);
  if (!ts.isObjectLiteralExpression(handler) || handler.properties.length !== 1) return;
  const [trap] = handler.properties;
  const get =
    ts.isMethodDeclaration(trap) && !trap.asteriskToken
      ? trap
      : ts.isPropertyAssignment(trap) &&
          (ts.isArrowFunction(unwrap(trap.initializer)) ||
            ts.isFunctionExpression(unwrap(trap.initializer)))
        ? (unwrap(trap.initializer) as ts.ArrowFunction | ts.FunctionExpression)
        : undefined;
  if (!get || !trap.name || !ts.isIdentifier(trap.name) || trap.name.text !== 'get') return;
  if (get.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return;
  const key = get.parameters[1]?.name;
  if (!key || !ts.isIdentifier(key) || !get.body) return;
  const named = (node: ts.Node | undefined, name: string | undefined) => {
    const current = node && ts.isExpression(node) ? unwrap(node) : node;
    return Boolean(current && name && ts.isIdentifier(current) && current.text === name);
  };
  // `const name = value;`, one declaration.
  const local = (statement: ts.Statement | undefined) => {
    if (
      !statement ||
      !ts.isVariableStatement(statement) ||
      !(statement.declarationList.flags & ts.NodeFlags.Const) ||
      statement.declarationList.declarations.length !== 1
    )
      return;
    const [declaration] = statement.declarationList.declarations;
    return ts.isIdentifier(declaration.name) && declaration.initializer
      ? { name: declaration.name.text, value: declaration.initializer }
      : undefined;
  };
  // The body is `[fill;] [const client = value;] return read;`, or ends with the read bound for
  // methods: `const result = read; return typeof result === 'function' ? result.bind(client) :
  // result;` or `… if (typeof result === 'function') return result.bind(client); return result;`.
  const statements = ts.isBlock(get.body) ? [...get.body.statements] : [];
  const last = statements.pop();
  let body = ts.isBlock(get.body)
    ? last && ts.isReturnStatement(last) && last.expression
    : get.body;
  if (!body) return;
  const isFunction = (node: ts.Expression, name?: string) =>
    ts.isBinaryExpression(node) &&
    [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(
      node.operatorToken.kind,
    ) &&
    ts.isTypeOfExpression(node.left) &&
    (name === undefined || named(node.left.expression, name)) &&
    ts.isStringLiteral(node.right) &&
    node.right.text === 'function';
  const binding = (node: ts.Node | undefined, name: string) => {
    const call = node && ts.isExpression(node) ? unwrap(node) : undefined;
    if (
      !call ||
      !ts.isCallExpression(call) ||
      call.questionDotToken ||
      call.arguments.length !== 1 ||
      !ts.isPropertyAccessExpression(call.expression) ||
      call.expression.questionDotToken ||
      call.expression.name.text !== 'bind' ||
      !named(call.expression.expression, name)
    )
      return;
    const receiver = unwrap(call.arguments[0]);
    return ts.isIdentifier(receiver) ? receiver.text : undefined;
  };
  const previous = statements.at(-1);
  const check =
    previous &&
    ts.isIfStatement(previous) &&
    !previous.elseStatement &&
    isFunction(previous.expression)
      ? (statements.pop() as ts.IfStatement)
      : undefined;
  let bound: string | undefined;
  if (check || ts.isConditionalExpression(unwrap(body))) {
    const result = local(statements.pop());
    if (!result) return;
    const returned = unwrap(body);
    if (check) {
      const then =
        ts.isBlock(check.thenStatement) && check.thenStatement.statements.length === 1
          ? check.thenStatement.statements[0]
          : check.thenStatement;
      if (
        !isFunction(check.expression, result.name) ||
        !named(returned, result.name) ||
        !ts.isReturnStatement(then)
      )
        return;
      bound = binding(then.expression, result.name);
    } else if (ts.isConditionalExpression(returned)) {
      if (!isFunction(returned.condition, result.name) || !named(returned.whenFalse, result.name))
        return;
      bound = binding(returned.whenTrue, result.name);
    }
    if (!bound) return;
    body = result.value;
  }
  const client = local(statements.at(-1)) ? local(statements.pop()) : undefined;
  if (statements.length > 1) return;
  const [fill] = statements;
  const read = unwrap(body);
  const receiver = get.parameters[2]?.name;
  const base =
    ts.isElementAccessExpression(read) &&
    !read.questionDotToken &&
    named(read.argumentExpression, key.text)
      ? unwrap(read.expression)
      : ts.isCallExpression(read) &&
          ts.isPropertyAccessExpression(read.expression) &&
          ts.isIdentifier(read.expression.expression) &&
          read.expression.expression.text === 'Reflect' &&
          read.expression.name.text === 'get' &&
          named(read.arguments[1], key.text) &&
          (read.arguments.length === 2 ||
            (read.arguments.length === 3 &&
              // The trap's receiver, or the client itself (an ordinary read of the client).
              ((receiver && ts.isIdentifier(receiver) && named(read.arguments[2], receiver.text)) ||
                (ts.isIdentifier(unwrap(read.arguments[0])) &&
                  named(read.arguments[2], (unwrap(read.arguments[0]) as ts.Identifier).text)))))
        ? unwrap(read.arguments[0])
        : undefined;
  if (!base) return;
  // Methods may be bound only to the very object they were read from.
  if (bound !== undefined && !named(base, bound)) return;
  if (client && !named(base, client.name)) return;
  const target = client ? unwrap(client.value) : base;
  if (fill && !fills(fill, target)) return;
  return target;
}

// `client ??= make();` or `if (!client) client = make();` with no else.
function fills(statement: ts.Statement, target: ts.Expression) {
  if (!ts.isIdentifier(target)) return false;
  const same = (node: ts.Expression) => ts.isIdentifier(node) && node.text === target.text;
  const write = (node: ts.Statement, operator: ts.SyntaxKind) => {
    const inner = ts.isBlock(node) && node.statements.length === 1 ? node.statements[0] : node;
    return (
      ts.isExpressionStatement(inner) &&
      ts.isBinaryExpression(inner.expression) &&
      inner.expression.operatorToken.kind === operator &&
      same(inner.expression.left)
    );
  };
  if (write(statement, ts.SyntaxKind.QuestionQuestionEqualsToken)) return true;
  return (
    ts.isIfStatement(statement) &&
    !statement.elseStatement &&
    ts.isPrefixUnaryExpression(statement.expression) &&
    statement.expression.operator === ts.SyntaxKind.ExclamationToken &&
    same(statement.expression.operand) &&
    write(statement.thenStatement, ts.SyntaxKind.EqualsToken)
  );
}

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
  const wrappers = new Set<ts.Symbol>();

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
      ts.isCallExpression(current) &&
      !current.questionDotToken &&
      current.arguments.length === 1
    ) {
      const binding = reference(unwrap(current.expression));
      const make = unwrap(current.arguments[0]);
      if (
        binding &&
        wrappers.has(binding) &&
        (ts.isArrowFunction(make) || ts.isFunctionExpression(make)) &&
        !make.asteriskToken &&
        !make.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
      )
        return combine(returns(make).map((entry) => (entry ? value(entry, found) : 'null'))) ===
          'client'
          ? 'client'
          : undefined;
    }
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
      (ts.isConditionalExpression(initializer) ||
        ts.isBinaryExpression(initializer) ||
        ts.isCallExpression(initializer))
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
  // `lazy(() => new Stripe(key))`: a one-parameter function whose only return is a forwarding Proxy
  // over its own local, which only ever holds nothing or the parameter's result. A call to it with
  // a function that returns a client is that client.
  for (const [binding, wrapper] of candidateFactories) {
    const [parameter] = wrapper.parameters;
    if (
      wrapper.parameters.length !== 1 ||
      parameter.dotDotDotToken ||
      !ts.isIdentifier(parameter.name) ||
      asyncFactories.has(binding)
    )
      continue;
    const made = symbol(parameter.name);
    const [result, ...rest] = returns(wrapper);
    const target = result && !rest.length ? proxyClient(result) : undefined;
    const local = target && ts.isIdentifier(target) ? symbol(target) : undefined;
    const declaration = local && candidateHolders.get(local);
    if (
      !made ||
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      declaration.getSourceFile() !== wrapper.getSourceFile() ||
      declaration.pos < wrapper.pos ||
      declaration.end > wrapper.end
    )
      continue;
    const fromParameter = (entry: ts.Expression) => {
      const call = unwrap(entry);
      return (
        ts.isCallExpression(call) &&
        !call.questionDotToken &&
        call.arguments.length === 0 &&
        reference(unwrap(call.expression)) === made
      );
    };
    if (
      [declaration.initializer, ...(writes.get(local!) ?? [])].every(
        (entry) => !entry || nullish(unwrap(entry)) || fromParameter(entry),
      )
    )
      wrappers.add(binding);
  }

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
