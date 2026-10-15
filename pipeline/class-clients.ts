import ts from 'typescript-compiler';

type Owner = ts.ClassDeclaration | ts.ClassExpression;
interface Field {
  owner: Owner;
  binding: ts.Symbol;
  origin: ts.Node;
  initializer: ts.Expression;
  initialization: ts.Node;
  source?: ts.Symbol;
}

function owner(node: ts.Node): Owner | undefined {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) return current;
    if (ts.isArrowFunction(current)) {
      current = current.parent;
      continue;
    }
    if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current)) return;
    if (
      (ts.isMethodDeclaration(current) || ts.isGetAccessor(current) || ts.isSetAccessor(current)) &&
      !ts.isClassDeclaration(current.parent) &&
      !ts.isClassExpression(current.parent)
    )
      return;
    current = current.parent;
  }
}

export function classClients(options: {
  nodes: ts.Node[];
  creation: (node: ts.Node) => ts.NewExpression | ts.CallExpression | undefined;
  clients: Set<ts.Symbol>;
  symbol: (node: ts.Node) => ts.Symbol | undefined;
  checker: ts.TypeChecker;
}) {
  const { nodes, creation, clients, symbol, checker } = options;
  const fields = new Map<ts.Symbol, Field>();
  const initializations = new Set<ts.Node>();
  const unsafe = new Set<ts.Symbol>();
  const aliases = new Map<ts.Symbol, ts.Symbol>();
  const creations = new Map<ts.Node, ts.Symbol>();
  const inherited = new Set<ts.Symbol>();
  for (const node of nodes)
    if (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ExtendsKeyword)
      for (const type of node.types) {
        const binding = symbol(type.expression);
        if (binding) inherited.add(binding);
      }
  let previous = -1;
  while (previous !== fields.size) {
    previous = fields.size;
    for (const node of nodes) {
      let binding: ts.Symbol | undefined;
      let initializer: ts.Expression | undefined;
      let initialization: ts.Node | undefined;
      let context: Owner | undefined;
      let direct = false;
      if (
        ts.isPropertyDeclaration(node) &&
        node.initializer &&
        !node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
      ) {
        binding = symbol(node.name);
        initializer = node.initializer;
        initialization = node;
        context = owner(node);
        direct =
          !node.questionToken && (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name));
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        node.left.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        binding = symbol(node.left.name);
        initializer = node.right;
        initialization = node;
        context = owner(node.left);
        direct =
          ts.isExpressionStatement(node.parent) &&
          ts.isBlock(node.parent.parent) &&
          ts.isConstructorDeclaration(node.parent.parent.parent) &&
          node.parent.parent.parent.parent === context;
      }
      if (!binding || !initializer || !initialization || !context) continue;
      const source = ts.isIdentifier(initializer)
        ? symbol(initializer)
        : reference(initializer)?.binding;
      const sdk = creation(initializer);
      if (!sdk && (!source || !clients.has(source))) continue;
      if (fields.has(binding)) {
        if (fields.get(binding)!.initialization !== initialization) unsafe.add(binding);
        continue;
      }
      fields.set(binding, {
        owner: context,
        binding,
        origin: sdk ?? initialization,
        initializer,
        initialization,
        source: sdk ? undefined : source,
      });
      clients.add(binding);
      if (sdk) creations.set(sdk, binding);
      if (source && !sdk) aliases.set(binding, source);
      if (direct) initializations.add(initialization);
      else unsafe.add(binding);
      const property = binding.valueDeclaration;
      if (
        property &&
        (ts.isGetAccessor(property) || ts.isSetAccessor(property) || ts.isParameter(property))
      )
        unsafe.add(binding);
      if (
        context.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword) ||
        (context.name && inherited.has(symbol(context.name)!)) ||
        nodes.some(
          (entry) =>
            owner(entry) === context &&
            ts.canHaveDecorators(entry) &&
            ts.getDecorators(entry)?.length,
        )
      )
        unsafe.add(binding);
    }
  }
  function reference(node: ts.Node) {
    if (!ts.isPropertyAccessExpression(node) || node.expression.kind !== ts.SyntaxKind.ThisKeyword)
      return;
    const binding = symbol(node.name);
    const field = binding && fields.get(binding);
    return field && owner(node) === field.owner ? field : undefined;
  }
  function rootBinding(node: ts.Node): ts.Symbol | undefined {
    if (ts.isPropertyAccessExpression(node)) {
      const binding = symbol(node.name);
      if (binding && fields.has(binding)) return binding;
      const context = instance(node.expression);
      const field = [...fields.values()].find(
        (entry) => entry.owner === context && entry.binding.name === node.name.text,
      );
      if (field) return field.binding;
    }
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node)
    )
      return rootBinding(node.expression);
  }
  function instance(expression: ts.Expression): Owner | undefined {
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    )
      return instance(expression.expression);
    const declaration = checker.getTypeAtLocation(expression).getSymbol()?.valueDeclaration;
    return declaration && (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration))
      ? declaration
      : undefined;
  }
  for (const node of nodes) {
    const exposed =
      ts.isCallExpression(node) || ts.isNewExpression(node) ? (node.arguments ?? []) : [];
    for (const argument of exposed) {
      const context = instance(argument);
      if (context)
        for (const field of fields.values()) if (field.owner === context) unsafe.add(field.binding);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isElementAccessExpression(node.left)
    ) {
      const context = instance(node.left.expression);
      if (context)
        for (const field of fields.values()) if (field.owner === context) unsafe.add(field.binding);
    }
  }
  function client(node: ts.Expression, seen = new Set<ts.Symbol>()): Field | undefined {
    const field = reference(node);
    if (field) return field;
    if (!ts.isIdentifier(node)) return;
    const binding = symbol(node);
    if (!binding || seen.has(binding)) return;
    const declaration = binding.valueDeclaration;
    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !declaration.initializer ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      !(declaration.parent.flags & ts.NodeFlags.Const)
    )
      return;
    return client(declaration.initializer, new Set([...seen, binding]));
  }
  for (const field of fields.values()) {
    const constructor = field.owner.members.find(ts.isConstructorDeclaration);
    if (
      constructor?.body &&
      nodes.some((node) => {
        if (owner(node) !== field.owner) return false;
        if (
          ts.isReturnStatement(node) &&
          node.getStart() >= constructor.body!.getStart() &&
          node.getEnd() <= constructor.body!.getEnd()
        ) {
          let scope: ts.Node | undefined = node.parent;
          while (scope && !ts.isFunctionLike(scope)) scope = scope.parent;
          return scope === constructor;
        }
        if (node.kind !== ts.SyntaxKind.ThisKeyword) return false;
        if (!ts.isPropertyAccessExpression(node.parent) || node.parent.expression !== node)
          return true;
        return (
          ts.isBinaryExpression(field.initialization) &&
          node.getStart() < field.initialization.getStart() &&
          node.getStart() > constructor.body!.getStart() &&
          (rootBinding(node.parent) !== undefined || ts.isCallExpression(node.parent.parent))
        );
      })
    )
      unsafe.add(field.binding);
    for (const node of nodes) {
      if (
        node.kind === ts.SyntaxKind.ThisKeyword &&
        owner(node) === field.owner &&
        (!ts.isPropertyAccessExpression(node.parent) || node.parent.expression !== node)
      )
        unsafe.add(field.binding);
      if (ts.isPropertyAccessExpression(node)) {
        const declaration = symbol(node.name)?.valueDeclaration;
        if (
          declaration &&
          ts.isMethodDeclaration(declaration) &&
          declaration.parent === field.owner &&
          !(ts.isCallExpression(node.parent) && node.parent.expression === node)
        )
          unsafe.add(field.binding);
      }
    }
  }
  return { fields, reference, client, rootBinding, initializations, unsafe, aliases, creations };
}
