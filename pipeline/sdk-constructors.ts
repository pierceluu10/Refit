import ts from 'typescript-compiler';
import { ABSENT, type injectedParameters } from './injected-clients.ts';
import type { ProviderAdapter } from './providers.ts';
import { dynamicImport, staticRequire } from './source-modules.ts';

// Deno and CDN specifiers name an npm package and its version: `npm:stripe@14`,
// `https://esm.sh/stripe@14.21.0?target=deno`, `https://cdn.jsdelivr.net/npm/stripe@14/+esm`.
// Returns the package name, or the specifier unchanged. Such a file runs the SDK version its
// specifier names, not the one package.json installs.
export function specifierPackage(text: string) {
  const match = text.match(
    /^(?:npm:|https:\/\/(?:esm\.sh\/(?:v\d+\/)?|cdn\.jsdelivr\.net\/npm\/|cdn\.skypack\.dev\/))((?:@[^/@?#]+\/)?[^/@?#]+)(?:@[^/?#]*)?(?:[/?#].*)?$/,
  );
  return match ? match[1] : text;
}

// A regular expression source for a specifier `specifierPackage` maps to `packageName` or one of
// its subpaths, for scans that test file text before parsing it.
export function specifierSource(packageName: string) {
  const name = packageName.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return `(?:npm:|https://(?:esm\\.sh/(?:v\\d+/)?|cdn\\.jsdelivr\\.net/npm/|cdn\\.skypack\\.dev/))?${name}(?:@[^'"/?#]*)?(?:[/?#][^'"]*)?`;
}

export function sdkConstructors(options: {
  nodes: ts.Node[];
  checker: ts.TypeChecker;
  provider: ProviderAdapter;
  external: (name: string, containingFile: string) => boolean;
  symbol: (node: ts.Node) => ts.Symbol | undefined;
  injected?: ReturnType<typeof injectedParameters>;
}) {
  const { nodes, checker, provider, symbol, external, injected } = options;
  const vendor = (node: ts.Node) => external(provider.packageName, node.getSourceFile().fileName);
  const constructors = new Set<ts.Symbol>();
  // Constructors whose clients are traced but never migrated automatically: one imported from a
  // Deno or CDN specifier (the SDK version is the specifier's, which Refit does not upgrade) and a
  // parameter every call fills with the constructor (`make(key, Ctor = Stripe)`).
  const review = new Set<ts.Symbol>();
  const imports: ts.Node[] = [];
  const add = (node: ts.Node) => {
    const binding = symbol(node);
    if (binding) constructors.add(binding);
  };
  function constructorExpression(node: ts.Expression): ts.Expression {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    return node;
  }
  const vendorModule = (node: ts.Node) =>
    staticRequire(node, checker) === provider.packageName ||
    dynamicImport(node) === provider.packageName;
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
      specifierPackage(node.moduleSpecifier.text) === provider.packageName
    ) {
      imports.push(node);
      if (!vendor(node)) continue;
      const clause = node.importClause;
      const pinned = node.moduleSpecifier.text !== provider.packageName;
      const bind = (name: ts.Identifier) => {
        add(name);
        const binding = symbol(name);
        if (pinned && binding) review.add(binding);
      };
      if (provider.defaultImport && clause?.name && !clause.isTypeOnly) bind(clause.name);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && !clause.isTypeOnly)
        for (const entry of clause.namedBindings.elements)
          if (!entry.isTypeOnly && (entry.propertyName ?? entry.name).text === provider.namedExport)
            bind(entry.name);
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
    // `function make(key, Ctor = Stripe) { return new Ctor(key); }` where every call outside tests
    // leaves `Ctor` out (or passes the constructor).
    for (const [binding, values] of injected?.values ?? [])
      if (
        !constructors.has(binding) &&
        values.every(
          (value) =>
            value !== ABSENT &&
            ts.isIdentifier(value) &&
            constructors.has(injected!.binding(value)!),
        )
      ) {
        constructors.add(binding);
        review.add(binding);
      }
    for (const node of nodes)
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isIdentifier(node.initializer) &&
        constructors.has(symbol(node.initializer)!) &&
        ts.isVariableDeclarationList(node.parent) &&
        node.parent.flags & ts.NodeFlags.Const
      ) {
        add(node.name);
        const binding = symbol(node.name);
        if (binding && review.has(symbol(node.initializer)!)) review.add(binding);
      }
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
    review,
    binding: (node: ts.NewExpression | ts.CallExpression) =>
      symbol(constructorExpression(node.expression)),
  };
}
