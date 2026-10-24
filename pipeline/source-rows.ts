import ts from 'typescript-compiler';

// Prisma model methods that resolve to one row, and to a list of rows.
const ROW_METHODS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'create',
  'update',
  'upsert',
  'delete',
]);
const LIST_METHODS = new Set(['findMany']);
// Read-only list methods whose callback receives the rows, and those that return one of them.
const ROW_CALLBACKS = new Set(['forEach', 'map', 'some', 'every', 'find', 'findIndex', 'flatMap']);
const ROW_ELEMENTS = new Set(['find', 'at']);
const GLOBALS = new Set(['globalThis', 'global']);

// Rows a Prisma client returns: `const course = await db.course.findUnique(…)`, an element of a
// `findMany` result reached through `find`, `at`, an index, `for…of` or a callback, or a row a
// `$transaction` client returns. Prisma builds them from database columns, so a read on one is
// never a read of a Stripe object. As strict as proving it is one:
// - the client is a `const` created by `new PrismaClient(…)` imported from `@prisma/client`, or a
//   `globalThis` cache of it (`globalThis.prisma || new PrismaClient()`) that nothing else writes;
// - the client is only ever used through its properties (never passed, aliased or given `$use`
//   middleware, which can replace results);
// - a row, its list and its elements are `const`s only read through their properties, indexes,
//   read-only list methods and null checks: never passed, returned, spread or assigned anywhere,
//   so nothing can merge a Stripe object into them. A property of a row is not proven (a JSON
//   column can hold anything).
export function sourceRows(options: {
  symbol: (node: ts.Node) => ts.Symbol | undefined;
  nodes: ts.Node[];
  references: Map<ts.Symbol, ts.Identifier[]>;
  // Names written as `{ name }`, which resolves to the property rather than the value it places.
  shorthand: Set<string>;
}) {
  const { symbol, nodes, references, shorthand } = options;
  const unwrap = (node: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
      ? unwrap(node.expression)
      : node;
  const climb = (node: ts.Expression) => {
    let current = node;
    while (ts.isParenthesizedExpression(current.parent) || ts.isNonNullExpression(current.parent))
      current = current.parent;
    return current;
  };
  // One cache per proof: a binding can be checked as a client, a list and a row.
  const memo =
    (proofs = new Map<ts.Symbol, boolean>()) =>
    (binding: ts.Symbol, prove: () => boolean) => {
      if (!proofs.has(binding)) {
        proofs.set(binding, false);
        proofs.set(binding, prove());
      }
      return proofs.get(binding)!;
    };
  const clients = memo();
  const lists = memo();
  const rows = memo();
  const constant = (declaration: ts.Declaration | undefined) =>
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    ts.isIdentifier(declaration.name) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    Boolean(declaration.parent.flags & ts.NodeFlags.Const)
      ? declaration
      : undefined;
  const assigned = (node: ts.Expression) => {
    const parent = node.parent;
    return (
      (ts.isBinaryExpression(parent) &&
        parent.left === node &&
        parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
      ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(parent.operator)) ||
      ts.isDeleteExpression(parent)
    );
  };
  // `X.name` or `X[…]`, not written.
  const receiver = (reference: ts.Expression) => {
    const current = climb(reference);
    const parent = current.parent;
    return (
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === current &&
      !assigned(parent)
    );
  };
  // `!X`, `if (X)`, `X ? … : …`, `X === null`: a test that neither changes nor passes X.
  const tested = (reference: ts.Expression) => {
    const current = climb(reference);
    const parent = current.parent;
    if (ts.isPrefixUnaryExpression(parent))
      return parent.operator === ts.SyntaxKind.ExclamationToken;
    if (ts.isIfStatement(parent)) return parent.expression === current;
    if (ts.isConditionalExpression(parent)) return parent.condition === current;
    if (!ts.isBinaryExpression(parent)) return false;
    const other = parent.left === current ? parent.right : parent.left;
    return (
      [
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
      ].includes(parent.operatorToken.kind) &&
      (other.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isIdentifier(other) && other.text === 'undefined'))
    );
  };
  const declared = (reference: ts.Identifier) =>
    (ts.isVariableDeclaration(reference.parent) && reference.parent.name === reference) ||
    (ts.isParameter(reference.parent) && reference.parent.name === reference);
  const uses = (binding: ts.Symbol) =>
    shorthand.has(binding.name) ? undefined : (references.get(binding) ?? []);
  // A local's `{ name }` can only appear inside the scope that declares it.
  const shorthands = nodes.filter(ts.isShorthandPropertyAssignment);
  const localUses = (binding: ts.Symbol) => {
    let scope: ts.Node | undefined = binding.valueDeclaration?.parent;
    while (scope && !ts.isBlock(scope) && !ts.isSourceFile(scope) && !ts.isFunctionLike(scope))
      scope = scope.parent;
    const inside = (node: ts.Node) =>
      scope !== undefined &&
      node.getSourceFile() === scope.getSourceFile() &&
      node.pos >= scope.pos &&
      node.end <= scope.end;
    return !scope || shorthands.some((node) => node.name.text === binding.name && inside(node))
      ? undefined
      : (references.get(binding) ?? []);
  };
  // An import or binding of the client's name that does not resolve to it may use it unseen.
  const foreign = (binding: ts.Symbol) =>
    nodes.some(
      (node) =>
        (ts.isImportSpecifier(node) ||
          ts.isImportClause(node) ||
          ts.isNamespaceImport(node) ||
          ts.isImportEqualsDeclaration(node) ||
          ts.isBindingElement(node)) &&
        node.name !== undefined &&
        ts.isIdentifier(node.name) &&
        node.name.text === binding.name &&
        symbol(node.name) !== binding,
    );

  // `PrismaClient` imported from `@prisma/client`, by name or from its default import.
  function prismaClass(expression: ts.Expression) {
    if (!ts.isIdentifier(expression)) return false;
    const declaration = symbol(expression)?.declarations?.[0];
    const prisma = (node: ts.Node) =>
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === '@prisma/client';
    if (declaration && ts.isImportSpecifier(declaration))
      return (
        (declaration.propertyName ?? declaration.name).text === 'PrismaClient' &&
        prisma(declaration.parent.parent.parent)
      );
    // `import pkg from '@prisma/client'; const { PrismaClient } = pkg;`
    if (
      !declaration ||
      !ts.isBindingElement(declaration) ||
      declaration.dotDotDotToken ||
      ((declaration.propertyName ?? declaration.name) as ts.Identifier).text !== 'PrismaClient'
    )
      return false;
    const holder = declaration.parent.parent;
    const source =
      ts.isVariableDeclaration(holder) &&
      ts.isObjectBindingPattern(declaration.parent) &&
      ts.isVariableDeclarationList(holder.parent) &&
      holder.parent.flags & ts.NodeFlags.Const &&
      holder.initializer
        ? unwrap(holder.initializer)
        : undefined;
    const imported = source && ts.isIdentifier(source) && symbol(source)?.declarations?.[0];
    return Boolean(imported && ts.isImportClause(imported) && prisma(imported.parent));
  }
  // `globalThis`, `global`, or a constant holding it (`globalThis as unknown as { prisma: … }`).
  function globalObject(expression: ts.Expression): boolean {
    const current = unwrap(expression);
    if (!ts.isIdentifier(current)) return false;
    const binding = symbol(current);
    if (GLOBALS.has(current.text) && !binding?.valueDeclaration) return true;
    const declaration = constant(binding?.valueDeclaration);
    return Boolean(
      binding &&
      declaration?.initializer &&
      globalObject(declaration.initializer) &&
      uses(binding)?.every((reference) => declared(reference) || receiver(reference)),
    );
  }
  // Every `globalThis.NAME` in the source is the cache read or `globalThis.NAME = client`.
  function cache(read: ts.PropertyAccessExpression, client: ts.Symbol) {
    const name = read.name.text;
    return nodes.every((node) => {
      const access =
        (ts.isPropertyAccessExpression(node) && node.name.text === name) ||
        (ts.isElementAccessExpression(node) &&
          ts.isStringLiteralLike(node.argumentExpression) &&
          node.argumentExpression.text === name);
      if (!access || node === read || !globalObject(node.expression)) return true;
      return written(node);
    });
    function written(node: ts.Expression) {
      const parent = node.parent;
      return (
        ts.isBinaryExpression(parent) &&
        parent.left === node &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(unwrap(parent.right)) &&
        symbol(unwrap(parent.right)) === client
      );
    }
  }
  // A Prisma client constant, or the client a `$transaction` callback receives.
  function client(expression: ts.Expression): boolean {
    const current = unwrap(expression);
    if (!ts.isIdentifier(current)) return false;
    const binding = symbol(current);
    if (!binding) return false;
    const parameter = binding.valueDeclaration;
    if (parameter && ts.isParameter(parameter)) return transaction(parameter, binding);
    const declaration = constant(parameter);
    if (!declaration?.initializer) return false;
    return clients(binding, () => {
      const value = unwrap(declaration.initializer!);
      const created = (node: ts.Expression) =>
        ts.isNewExpression(node) && prismaClass(unwrap(node.expression));
      let read: ts.PropertyAccessExpression | undefined;
      if (!created(value)) {
        if (
          !ts.isBinaryExpression(value) ||
          ![ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(
            value.operatorToken.kind,
          ) ||
          !created(unwrap(value.right))
        )
          return false;
        const left = unwrap(value.left);
        if (!ts.isPropertyAccessExpression(left) || !globalObject(left.expression)) return false;
        read = left;
      }
      const all = foreign(binding) ? undefined : uses(binding);
      return Boolean(
        all?.every((reference) => {
          const parent = reference.parent;
          if (
            declared(reference) ||
            ts.isImportSpecifier(parent) ||
            ts.isImportClause(parent) ||
            ts.isExportSpecifier(parent) ||
            ts.isExportAssignment(parent)
          )
            return true;
          // `globalThis.prisma = db`, checked with the cache below.
          if (
            read &&
            ts.isBinaryExpression(parent) &&
            parent.right === reference &&
            parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isPropertyAccessExpression(parent.left) &&
            parent.left.name.text === read.name.text &&
            globalObject(parent.left.expression)
          )
            return true;
          return (
            receiver(reference) &&
            !(ts.isPropertyAccessExpression(parent) && parent.name.text === '$use')
          );
        }) &&
        (!read || cache(read, binding)),
      );
    });
  }
  // `db.$transaction(async (tx) => …)`: `tx` is only used through its properties.
  function transaction(parameter: ts.ParameterDeclaration, binding: ts.Symbol) {
    const callback = parameter.parent;
    const call = callback.parent;
    return Boolean(
      ts.isIdentifier(parameter.name) &&
      !parameter.dotDotDotToken &&
      !parameter.initializer &&
      (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
      callback.parameters[0] === parameter &&
      ts.isCallExpression(call) &&
      call.arguments[0] === callback &&
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === '$transaction' &&
      client(call.expression.expression) &&
      localUses(binding)?.every((reference) => declared(reference) || receiver(reference)),
    );
  }
  // `await client.model.method(…)`.
  function query(expression: ts.Expression, methods: Set<string>) {
    const current = unwrap(expression);
    if (!ts.isAwaitExpression(current)) return false;
    const call = unwrap(current.expression);
    return (
      ts.isCallExpression(call) &&
      ts.isPropertyAccessExpression(call.expression) &&
      methods.has(call.expression.name.text) &&
      ts.isPropertyAccessExpression(call.expression.expression) &&
      !call.expression.expression.name.text.startsWith('$') &&
      client(call.expression.expression.expression)
    );
  }
  // A row taken out of a list leaves the call only as a receiver, a test or a proven constant.
  function kept(value: ts.Expression) {
    const current = climb(value);
    const parent = current.parent;
    if (receiver(current) || tested(current)) return true;
    const declaration = constant(parent as ts.Declaration);
    const binding = declaration && symbol(declaration.name);
    return Boolean(declaration?.initializer === current && binding && rowUses(binding));
  }
  function rowUses(binding: ts.Symbol) {
    return rows(binding, () =>
      Boolean(
        localUses(binding)?.every(
          (reference) => declared(reference) || receiver(reference) || tested(reference),
        ),
      ),
    );
  }
  // A constant list of rows that is only read: its length, indexes, `for…of` over it, and
  // read-only methods whose callback receives each row as a parameter that is itself only read.
  function list(expression: ts.Expression): boolean {
    const current = unwrap(expression);
    if (!ts.isIdentifier(current)) return false;
    const binding = symbol(current);
    const declaration = constant(binding?.valueDeclaration);
    if (!binding || !declaration?.initializer || !query(declaration.initializer, LIST_METHODS))
      return false;
    return lists(binding, () =>
      Boolean(
        localUses(binding)?.every((reference) => {
          if (declared(reference) || tested(reference)) return true;
          const read = climb(reference);
          const parent = read.parent;
          if (ts.isForOfStatement(parent) && parent.expression === read) {
            const [variable] = ts.isVariableDeclarationList(parent.initializer)
              ? parent.initializer.declarations
              : [];
            const element = constant(variable);
            const name = element && symbol(element.name);
            return Boolean(name && rowUses(name));
          }
          if (ts.isElementAccessExpression(parent) && parent.expression === read)
            return !assigned(parent) && kept(parent);
          if (!ts.isPropertyAccessExpression(parent) || parent.expression !== read) return false;
          if (parent.name.text === 'length') return !assigned(parent);
          const call = parent.parent;
          if (
            !ts.isCallExpression(call) ||
            call.expression !== parent ||
            !(ROW_CALLBACKS.has(parent.name.text) || ROW_ELEMENTS.has(parent.name.text))
          )
            return false;
          const callback = call.arguments[0] && unwrap(call.arguments[0]);
          const element =
            ROW_CALLBACKS.has(parent.name.text) &&
            callback &&
            (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
              ? callback.parameters[0]
              : undefined;
          if (ROW_CALLBACKS.has(parent.name.text)) {
            const name = element && ts.isIdentifier(element.name) && symbol(element.name);
            if (
              !element ||
              element.dotDotDotToken ||
              element.initializer ||
              !name ||
              !rowUses(name)
            )
              return false;
          }
          return !ROW_ELEMENTS.has(parent.name.text) || kept(call);
        }),
      ),
    );
  }
  function row(expression: ts.Expression): boolean {
    const current = unwrap(expression);
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      ROW_ELEMENTS.has(current.expression.name.text)
    )
      return list(current.expression.expression);
    if (ts.isElementAccessExpression(current)) return list(current.expression);
    if (!ts.isIdentifier(current)) return false;
    const binding = symbol(current);
    const declaration = binding?.valueDeclaration;
    if (!binding || !declaration) return false;
    const variable = constant(declaration);
    if (variable && ts.isForOfStatement(variable.parent.parent))
      return list(variable.parent.parent.expression) && rowUses(binding);
    if (variable?.initializer)
      return (
        rowUses(binding) &&
        (query(variable.initializer, ROW_METHODS) ||
          (!ts.isIdentifier(unwrap(variable.initializer)) && row(variable.initializer)))
      );
    // A callback parameter that receives each row of a list.
    const callback = declaration.parent;
    const call = callback?.parent;
    return Boolean(
      ts.isParameter(declaration) &&
      (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
      callback.parameters[0] === declaration &&
      call &&
      ts.isCallExpression(call) &&
      call.arguments[0] === callback &&
      ts.isPropertyAccessExpression(call.expression) &&
      ROW_CALLBACKS.has(call.expression.name.text) &&
      list(call.expression.expression),
    );
  }
  return { row };
}
