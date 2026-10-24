import ts from 'typescript-compiler';
import { SDK_IDENTIFIER } from './providers.ts';

const loaderSafety = new WeakMap<ts.SourceFile, boolean>();

function hasRuntimeDeclaration(node: ts.Node, checker: ts.TypeChecker) {
  return (checker.getSymbolAtLocation(node)?.declarations ?? []).some(
    (declaration) =>
      !ts.isSourceFile(declaration) &&
      !ts.isBinaryExpression(declaration) &&
      !ts.isPropertyAccessExpression(declaration) &&
      !ts.isIdentifier(declaration),
  );
}

export function unshadowedIdentifier(node: ts.Node, name: string, checker: ts.TypeChecker) {
  if (!ts.isIdentifier(node) || node.text !== name) return false;
  // TypeScript creates synthetic symbols for CommonJS globals and their export assignments.
  const global = !hasRuntimeDeclaration(node, checker);
  if (!global || name !== 'require') return global;
  const source = node.getSourceFile();
  if (!loaderSafety.has(source)) {
    let safe = true;
    function visit(current: ts.Node) {
      if (
        ts.isIdentifier(current) &&
        current.text === 'require' &&
        !hasRuntimeDeclaration(current, checker)
      ) {
        const parent = current.parent;
        if (
          !(ts.isCallExpression(parent) && parent.expression === current) &&
          !(ts.isPropertyAccessExpression(parent) && parent.name === current)
        )
          safe = false;
      }
      ts.forEachChild(current, visit);
    }
    visit(source);
    loaderSafety.set(source, safe);
  }
  return loaderSafety.get(source)!;
}

export function staticRequire(node: ts.Node, checker?: ts.TypeChecker) {
  return ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'require' &&
    (!checker || unshadowedIdentifier(node.expression, 'require', checker)) &&
    !node.questionDotToken &&
    node.arguments.length === 1 &&
    ts.isStringLiteral(node.arguments[0])
    ? node.arguments[0].text
    : undefined;
}

// `await import('name')`, with any parentheses, is the module namespace.
export function dynamicImport(node: ts.Node) {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (!ts.isAwaitExpression(node)) return;
  let call: ts.Expression = node.expression;
  while (ts.isParenthesizedExpression(call)) call = call.expression;
  return ts.isCallExpression(call) &&
    call.expression.kind === ts.SyntaxKind.ImportKeyword &&
    call.arguments.length === 1 &&
    ts.isStringLiteral(call.arguments[0])
    ? call.arguments[0].text
    : undefined;
}

export function sourceModuleReferences(source: ts.SourceFile) {
  const names = new Set<string>();
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
      names.add(node.moduleSpecifier.text);
    if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    )
      names.add(node.moduleReference.expression.text);
    const required = staticRequire(node);
    if (required) names.add(required);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return names;
}

export interface ClientExport {
  file: string;
  kind: 'esm' | 'commonjs';
  name: string | null;
}

export function sourceBindings(
  nodes: ts.Node[],
  checker: ts.TypeChecker,
  resolveImport: (name: string, containingFile: string) => string | undefined,
) {
  const aliases = new Map<ts.Symbol, ts.Symbol>();
  const exports = new Map<string, Map<string | null, ts.Symbol>>();
  const formats = new Map<string, ClientExport['kind']>();
  const safeNodes = new Set<ts.Node>();
  const inlineDefaults = new Map<ts.ExportAssignment, ts.Symbol>();
  const escapingSources = new Set<string>();
  const descriptions = new Map<ts.Symbol, ClientExport>();
  const symbol = (node: ts.Node) => checker.getSymbolAtLocation(node);
  const immutable = (binding: ts.Symbol | undefined) => {
    const declaration = binding?.valueDeclaration;
    return declaration &&
      ((ts.isVariableDeclaration(declaration) &&
        ts.isVariableDeclarationList(declaration.parent) &&
        Boolean(declaration.parent.flags & ts.NodeFlags.Const) &&
        ts.isVariableStatement(declaration.parent.parent) &&
        ts.isSourceFile(declaration.parent.parent.parent)) ||
        ((ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration)) &&
          ts.isSourceFile(declaration.parent)))
      ? binding
      : undefined;
  };
  const exportBinding = (expression: ts.Expression) =>
    ts.isIdentifier(expression) ? immutable(symbol(expression)) : undefined;
  function add(file: string, name: string | null, binding: ts.Symbol, kind: ClientExport['kind']) {
    const entries = exports.get(file) ?? new Map<string | null, ts.Symbol>();
    if (entries.has(name)) escapingSources.add(file);
    entries.set(name, binding);
    exports.set(file, entries);
    formats.set(file, kind);
    descriptions.set(binding, {
      file,
      kind,
      name: kind === 'esm' && name === 'default' ? null : name,
    });
  }
  for (const node of nodes) {
    const file = node.getSourceFile().fileName;
    if (
      (ts.isVariableStatement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node)) &&
      ts.isSourceFile(node.parent) &&
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
      !node.modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      const names = !ts.isVariableStatement(node)
        ? node.name
          ? [node.name]
          : []
        : node.declarationList.declarations.flatMap((entry) =>
            ts.isIdentifier(entry.name) ? [entry.name] : [],
          );
      for (const name of names) {
        const binding = immutable(symbol(name));
        if (binding) add(file, name.text, binding, 'esm');
      }
    }
    if (ts.isExportAssignment(node) && !node.isExportEquals && ts.isSourceFile(node.parent)) {
      const binding = exportBinding(node.expression);
      const module = symbol(node.parent);
      const inline =
        module && checker.getExportsOfModule(module).find((entry) => entry.name === 'default');
      if (binding) {
        add(file, 'default', binding, 'esm');
        safeNodes.add(node);
      } else if (
        inline &&
        (ts.isNewExpression(node.expression) || ts.isCallExpression(node.expression))
      ) {
        add(file, 'default', inline, 'esm');
        inlineDefaults.set(node, inline);
        safeNodes.add(node);
      }
    }
  }
  function exportTarget(node: ts.Expression): string | null | undefined {
    if (!ts.isPropertyAccessExpression(node) || node.questionDotToken) return;
    if (unshadowedIdentifier(node.expression, 'module', checker) && node.name.text === 'exports')
      return null;
    if (unshadowedIdentifier(node.expression, 'exports', checker)) return node.name.text;
    if (ts.isPropertyAccessExpression(node.expression) && exportTarget(node.expression) === null)
      return node.name.text;
  }
  const exportRoots = new Set<ts.Node>();
  const directAssignments = new Set<string>();
  const namedAssignments = new Set<string>();
  for (const node of nodes) {
    if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
      continue;
    const name = exportTarget(node.left);
    if (name === undefined) continue;
    const file = node.getSourceFile().fileName;
    const validPosition =
      ts.isExpressionStatement(node.parent) && ts.isSourceFile(node.parent.parent);
    const runtimeImport = node
      .getSourceFile()
      .statements.some(
        (statement) => ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly,
      );
    if (!validPosition || formats.get(file) === 'esm' || runtimeImport) {
      escapingSources.add(file);
      continue;
    }
    exportRoots.add(node.left);
    if (name === null) {
      if (directAssignments.has(file) || namedAssignments.has(file)) escapingSources.add(file);
      directAssignments.add(file);
    } else {
      if (directAssignments.has(file)) escapingSources.add(file);
      namedAssignments.add(file);
    }
    if (name === null && ts.isObjectLiteralExpression(node.right)) {
      for (const entry of node.right.properties) {
        const key = entry.name;
        const binding =
          ts.isShorthandPropertyAssignment(entry) && !entry.objectAssignmentInitializer
            ? immutable(checker.getShorthandAssignmentValueSymbol(entry))
            : ts.isPropertyAssignment(entry)
              ? exportBinding(entry.initializer)
              : undefined;
        if (
          !key ||
          !(ts.isIdentifier(key) || ts.isStringLiteral(key)) ||
          !binding ||
          key.text === '__proto__' ||
          !SDK_IDENTIFIER.test(key.text)
        ) {
          escapingSources.add(file);
          continue;
        }
        add(file, key.text, binding, 'commonjs');
        safeNodes.add(entry);
      }
      safeNodes.add(node);
    } else {
      const binding = exportBinding(node.right);
      if (!binding || (name === null && ts.isFunctionDeclaration(binding.valueDeclaration!))) {
        escapingSources.add(file);
        continue;
      }
      add(file, name, binding, 'commonjs');
      safeNodes.add(node);
    }
  }
  for (const node of nodes) {
    if (
      !ts.isIdentifier(node) ||
      !['module', 'exports'].includes(node.text) ||
      (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
      !unshadowedIdentifier(node, node.text, checker)
    )
      continue;
    let current: ts.Node = node;
    while (ts.isPropertyAccessExpression(current.parent) && current.parent.expression === current)
      current = current.parent;
    if (!exportRoots.has(current)) escapingSources.add(node.getSourceFile().fileName);
  }
  // Names a module exports that cannot be one of its own values: an exported interface or type
  // alias with no value of that name, and `export { name } from './other'`, whose value belongs
  // to the other module. Importing them exposes nothing of this module.
  const typeNames = new Map<string, Set<string>>();
  const valueNames = new Map<string, Set<string>>();
  const reexports = new Map<string, Map<string, { file?: string; name: string }>>();
  const record = (map: Map<string, Set<string>>, file: string, name: string) =>
    map.set(file, (map.get(file) ?? new Set()).add(name));
  for (const node of nodes) {
    if (!node.parent || !ts.isSourceFile(node.parent)) continue;
    const file = node.getSourceFile().fileName;
    const exported =
      ts.canHaveModifiers(node) &&
      Boolean(ts.getModifiers(node)?.some((entry) => entry.kind === ts.SyntaxKind.ExportKeyword));
    if (exported && (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node))) {
      record(typeNames, file, node.name.text);
    } else if (exported && ts.isVariableStatement(node)) {
      for (const entry of node.declarationList.declarations)
        if (ts.isIdentifier(entry.name)) record(valueNames, file, entry.name.text);
    } else if (
      exported &&
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name
    ) {
      record(valueNames, file, node.name.text);
    }
    if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      const target = resolveImport(node.moduleSpecifier.text, file);
      const entries = reexports.get(file) ?? new Map<string, { file?: string; name: string }>();
      for (const element of node.exportClause.elements)
        if (!element.isTypeOnly)
          entries.set(element.name.text, {
            file: target,
            name: (element.propertyName ?? element.name).text,
          });
      reexports.set(file, entries);
    }
  }
  function bind(
    name: ts.Identifier,
    file: string,
    exported: string | null,
    kind: ClientExport['kind'],
  ) {
    const target =
      formats.get(file) === kind && !escapingSources.has(file) && exports.get(file)?.get(exported);
    const local = symbol(name);
    if (target && local) aliases.set(local, target);
    else if (
      kind === 'esm' &&
      exported !== null &&
      typeNames.get(file)?.has(exported) &&
      !valueNames.get(file)?.has(exported) &&
      !reexports.get(file)?.has(exported)
    )
      return;
    else if (kind === 'esm' && exported !== null && reexports.get(file)?.has(exported)) {
      // `export { stripe } from './client'`: the same binding as the other module's export.
      const other = reexports.get(file)!.get(exported)!;
      const original =
        other.file &&
        formats.get(other.file) === 'esm' &&
        !escapingSources.has(other.file) &&
        exports.get(other.file)?.get(other.name);
      if (original && local) aliases.set(local, original);
      else escapingSources.add(other.file ?? file);
    } else escapingSources.add(file);
  }
  for (const node of nodes) {
    const containingFile = node.getSourceFile().fileName;
    if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      const file = resolveImport(node.moduleReference.expression.text, containingFile);
      if (file) bind(node.name, file, null, 'commonjs');
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const file = resolveImport(node.moduleSpecifier.text, containingFile);
      const clause = node.importClause;
      if (!file || !clause || clause.isTypeOnly) continue;
      if (clause.name) bind(clause.name, file, 'default', 'esm');
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const entry of clause.namedBindings.elements)
          if (!entry.isTypeOnly)
            bind(entry.name, file, (entry.propertyName ?? entry.name).text, 'esm');
      } else if (clause.namedBindings) escapingSources.add(file);
    }
    if (ts.isExportDeclaration(node)) {
      const file =
        node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
          ? resolveImport(node.moduleSpecifier.text, containingFile)
          : containingFile;
      if (file && !node.isTypeOnly) escapingSources.add(file);
    }
    if (
      !ts.isVariableDeclaration(node) ||
      !node.initializer ||
      !ts.isVariableDeclarationList(node.parent) ||
      !(node.parent.flags & ts.NodeFlags.Const)
    )
      continue;
    const value = node.initializer;
    const required =
      staticRequire(value, checker) ??
      (ts.isPropertyAccessExpression(value) && !value.questionDotToken
        ? staticRequire(value.expression, checker)
        : undefined);
    const file = required && resolveImport(required, containingFile);
    if (!file) continue;
    if (ts.isIdentifier(node.name))
      bind(
        node.name,
        file,
        ts.isPropertyAccessExpression(value) ? value.name.text : null,
        'commonjs',
      );
    else if (ts.isObjectBindingPattern(node.name) && staticRequire(value, checker)) {
      for (const entry of node.name.elements) {
        const key = entry.propertyName ?? entry.name;
        if (
          ts.isIdentifier(entry.name) &&
          (ts.isIdentifier(key) || ts.isStringLiteral(key)) &&
          !entry.initializer &&
          !entry.dotDotDotToken
        )
          bind(entry.name, file, key.text, 'commonjs');
        else escapingSources.add(file);
      }
    } else escapingSources.add(file);
  }
  // Non-binding requires expose a module namespace to code the analyzer cannot follow.
  for (const node of nodes) {
    const name = staticRequire(node, checker);
    const file = name && resolveImport(name, node.getSourceFile().fileName);
    if (!file) continue;
    const parent =
      ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node
        ? node.parent
        : node;
    if (
      !ts.isVariableDeclaration(parent.parent) ||
      parent.parent.initializer !== parent ||
      !ts.isVariableDeclarationList(parent.parent.parent) ||
      !(parent.parent.parent.flags & ts.NodeFlags.Const)
    )
      escapingSources.add(file);
  }
  // The checker has no lib types, so it cannot follow `await import()`; bind its ESM exports
  // the way static imports are bound. Only stable exports link, so an unknown name stays local.
  const members = new Map<ts.Node, ts.Symbol>();
  const esmExport = (file: string, name: string) =>
    formats.get(file) === 'esm' && !escapingSources.has(file)
      ? exports.get(file)?.get(name)
      : undefined;
  for (const node of nodes) {
    const name = dynamicImport(node);
    const file = name && resolveImport(name, node.getSourceFile().fileName);
    if (!file) continue;
    let parent = node.parent;
    while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
    if (ts.isPropertyAccessExpression(parent) && !parent.questionDotToken) {
      const target = esmExport(file, parent.name.text);
      if (target) members.set(parent.name, target);
    } else if (
      ts.isVariableDeclaration(parent) &&
      ts.isObjectBindingPattern(parent.name) &&
      ts.isVariableDeclarationList(parent.parent) &&
      parent.parent.flags & ts.NodeFlags.Const
    ) {
      for (const entry of parent.name.elements) {
        const key = entry.propertyName ?? entry.name;
        if (!ts.isIdentifier(entry.name) || entry.initializer || entry.dotDotDotToken) continue;
        if (!ts.isIdentifier(key) && !ts.isStringLiteral(key)) continue;
        const target = esmExport(file, key.text);
        const local = symbol(entry.name);
        if (target && local) aliases.set(local, target);
      }
    }
  }
  const canonical = (binding: ts.Symbol | undefined): ts.Symbol | undefined => {
    const seen = new Set<ts.Symbol>();
    while (binding && aliases.has(binding) && !seen.has(binding)) {
      seen.add(binding);
      binding = aliases.get(binding);
    }
    return binding;
  };
  return {
    canonical,
    member: (node: ts.Node) => members.get(node),
    safeNodes,
    inlineDefaults,
    escapingSources,
    clientExport: (binding: ts.Symbol) => descriptions.get(binding),
  };
}
