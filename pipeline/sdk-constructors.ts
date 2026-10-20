import ts from 'typescript-compiler';
import type { ProviderAdapter } from './providers.ts';
import { staticRequire } from './source-modules.ts';

export function sdkConstructors(options: {
  nodes: ts.Node[];
  checker: ts.TypeChecker;
  provider: ProviderAdapter;
  external: (name: string, containingFile: string) => boolean;
  symbol: (node: ts.Node) => ts.Symbol | undefined;
}) {
  const { nodes, checker, provider, symbol, external } = options;
  const vendor = (node: ts.Node) => external(provider.packageName, node.getSourceFile().fileName);
  const constructors = new Set<ts.Symbol>();
  const imports: ts.Node[] = [];
  const add = (node: ts.Node) => {
    const binding = symbol(node);
    if (binding) constructors.add(binding);
  };
  function constructorExpression(node: ts.Expression): ts.Expression {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    return node;
  }
  // `await import('stripe')` is the module namespace: its `default` or named export is the
  // constructor, never the namespace itself.
  function dynamicImport(node: ts.Node) {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    if (!ts.isAwaitExpression(node)) return false;
    let call: ts.Expression = node.expression;
    while (ts.isParenthesizedExpression(call)) call = call.expression;
    return (
      ts.isCallExpression(call) &&
      call.expression.kind === ts.SyntaxKind.ImportKeyword &&
      call.arguments.length === 1 &&
      ts.isStringLiteral(call.arguments[0]) &&
      call.arguments[0].text === provider.packageName
    );
  }
  const vendorModule = (node: ts.Node) =>
    staticRequire(node, checker) === provider.packageName || dynamicImport(node);
  function requiredConstructor(node: ts.Node) {
    if (ts.isParenthesizedExpression(node)) return requiredConstructor(node.expression);
    if (!vendor(node)) return false;
    if (staticRequire(node, checker) === provider.packageName) return provider.defaultImport;
    if (
      !ts.isPropertyAccessExpression(node) ||
      node.questionDotToken ||
      !vendorModule(node.expression)
    )
      return false;
    return (
      node.name.text === provider.namedExport ||
      (node.name.text === 'default' && provider.defaultImport)
    );
  }
  for (const node of nodes) {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === provider.packageName
    ) {
      imports.push(node);
      if (!vendor(node)) continue;
      const clause = node.importClause;
      if (provider.defaultImport && clause?.name && !clause.isTypeOnly) add(clause.name);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && !clause.isTypeOnly)
        for (const entry of clause.namedBindings.elements)
          if (!entry.isTypeOnly && (entry.propertyName ?? entry.name).text === provider.namedExport)
            add(entry.name);
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression) &&
      node.moduleReference.expression.text === provider.packageName
    ) {
      imports.push(node);
      if (vendor(node) && provider.defaultImport) add(node.name);
    }
    if (vendorModule(node)) imports.push(node);
    if (
      !ts.isVariableDeclaration(node) ||
      !node.initializer ||
      !ts.isVariableDeclarationList(node.parent) ||
      !(node.parent.flags & ts.NodeFlags.Const)
    )
      continue;
    if (ts.isIdentifier(node.name) && requiredConstructor(node.initializer)) add(node.name);
    if (ts.isObjectBindingPattern(node.name) && vendorModule(node.initializer) && vendor(node))
      for (const entry of node.name.elements) {
        const key = entry.propertyName ?? entry.name;
        if (
          ts.isIdentifier(entry.name) &&
          (ts.isIdentifier(key) || ts.isStringLiteral(key)) &&
          !entry.initializer &&
          !entry.dotDotDotToken &&
          (key.text === provider.namedExport || (key.text === 'default' && provider.defaultImport))
        )
          add(entry.name);
      }
  }
  let previousSize = -1;
  while (constructors.size !== previousSize) {
    previousSize = constructors.size;
    for (const node of nodes)
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isIdentifier(node.initializer) &&
        constructors.has(symbol(node.initializer)!) &&
        ts.isVariableDeclarationList(node.parent) &&
        node.parent.flags & ts.NodeFlags.Const
      )
        add(node.name);
  }
  function creation(node: ts.Node): ts.NewExpression | ts.CallExpression | undefined {
    if (!(ts.isNewExpression(node) || (provider.constructorCalls && ts.isCallExpression(node))))
      return;
    if (ts.isCallExpression(node) && node.questionDotToken) return;
    const expression = constructorExpression(node.expression);
    if (
      requiredConstructor(node.expression) ||
      (ts.isIdentifier(expression) && constructors.has(symbol(expression)!))
    )
      return node;
  }
  return {
    imports,
    creation,
    constructors,
    binding: (node: ts.NewExpression | ts.CallExpression) =>
      symbol(constructorExpression(node.expression)),
  };
}
