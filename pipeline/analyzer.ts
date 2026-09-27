import { resolve } from 'node:path';
import ts from 'typescript-compiler';
import { STRIPE, type ProviderAdapter } from './providers.ts';
import {
  PipelineInputError,
  type Finding,
  type Location,
  type Removal,
  type Repository,
  type SourceEdit,
} from './types.ts';

export function analyzeRepository(
  repository: Repository,
  changes: Removal[],
  provider: ProviderAdapter = STRIPE,
) {
  const sources = new Map(
    repository.files.map((file) => [resolve(repository.root, file.path), file.content]),
  );
  const options: ts.CompilerOptions = {
    allowJs: true,
    noResolve: true,
    noLib: true,
    target: ts.ScriptTarget.Latest,
  };
  const host = ts.createCompilerHost(options);
  host.fileExists = (name) => sources.has(name);
  host.readFile = (name) => sources.get(name);
  host.getSourceFile = (name, languageVersion) => {
    const content = sources.get(name);
    return content === undefined
      ? undefined
      : ts.createSourceFile(name, content, languageVersion, true);
  };
  const program = ts.createProgram([...sources.keys()], options, host);
  const checker = program.getTypeChecker();
  const findings: Finding[] = [];
  const imports: Location[] = [];
  const calls: (Location & { method: string })[] = [];
  const constructors = new Set<ts.Symbol>();
  const clients = new Set<ts.Symbol>();
  const responses = new Map<ts.Symbol, string>();
  const origins = new Map<ts.Symbol, ts.CallExpression>();
  const edits: SourceEdit[] = [];
  const nodes: ts.Node[] = [];
  const locations = new Map(
    [...sources.keys()].map((path, index) => [path, repository.files[index].path]),
  );
  const location = (node: ts.Node): Location => {
    const source = node.getSourceFile();
    const position = source.getLineAndCharacterOfPosition(node.getStart());
    return {
      file: locations.get(source.fileName)!,
      line: position.line + 1,
      column: position.character + 1,
    };
  };
  const symbol = (node: ts.Node) => checker.getSymbolAtLocation(node);
  const contains = (set: Set<ts.Symbol>, node: ts.Node) => {
    const found = symbol(node);
    return found !== undefined && set.has(found);
  };
  const add = (set: Set<ts.Symbol>, node: ts.Node) => {
    const found = symbol(node);
    if (found) set.add(found);
  };
  function visit(node: ts.Node) {
    nodes.push(node);
    ts.forEachChild(node, visit);
  }
  for (const source of program.getSourceFiles()) {
    const diagnostics = program.getSyntacticDiagnostics(source);
    if (diagnostics.length) {
      throw new PipelineInputError(
        `${locations.get(source.fileName)}: ${ts.flattenDiagnosticMessageText(diagnostics[0].messageText, '\n')}`,
      );
    }
    visit(source);
  }
  for (const node of nodes) {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === provider.packageName
    ) {
      imports.push(location(node));
      const clause = node.importClause;
      if (provider.defaultImport && clause?.name && !clause.isTypeOnly)
        add(constructors, clause.name);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && !clause.isTypeOnly) {
        for (const binding of clause.namedBindings.elements) {
          if (
            (binding.propertyName ?? binding.name).text === provider.namedExport &&
            !binding.isTypeOnly
          )
            add(constructors, binding.name);
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.some(
        (argument) => ts.isStringLiteral(argument) && argument.text === provider.packageName,
      )
    ) {
      imports.push(location(node));
    }
  }
  function responseCall(node: ts.Node) {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const method = node.expression;
    const resource = method.expression;
    if (
      ts.isPropertyAccessExpression(resource) &&
      ts.isIdentifier(resource.expression) &&
      contains(clients, resource.expression)
    )
      return provider.operations.find(
        (operation) =>
          operation.resource === resource.name.text && operation.method === method.name.text,
      );
  }
  // Resolve only immutable, lexical bindings; a same-named parameter is a different symbol.
  for (const node of nodes) {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      !node.initializer ||
      !ts.isVariableDeclarationList(node.parent) ||
      !(node.parent.flags & ts.NodeFlags.Const)
    )
      continue;
    const value = node.initializer;
    if (
      ts.isNewExpression(value) &&
      ts.isIdentifier(value.expression) &&
      contains(constructors, value.expression)
    )
      add(clients, node.name);
    if (ts.isIdentifier(value) && contains(clients, value)) add(clients, node.name);
    const operation = ts.isAwaitExpression(value) ? responseCall(value.expression) : undefined;
    if (operation && ts.isAwaitExpression(value)) {
      responses.set(symbol(node.name)!, operation.schema);
      origins.set(symbol(node.name)!, value.expression as ts.CallExpression);
    }
    if (ts.isIdentifier(value)) {
      const schema = responses.get(symbol(value)!);
      if (schema) responses.set(symbol(node.name)!, schema);
    }
  }
  for (const node of nodes) {
    const operation = responseCall(node);
    if (operation)
      calls.push({ ...location(node), method: `${operation.resource}.${operation.method}` });
  }
  const providerDetected = imports.length > 0 || repository.dependencies.length > 0;
  function propose(node: ts.Node, receiver: ts.Expression, change: Removal) {
    if (
      provider !== STRIPE ||
      change.schema !== 'payment_intent' ||
      change.property !== 'charges' ||
      !ts.isIdentifier(receiver)
    )
      return;
    const origin = origins.get(symbol(receiver)!);
    const data = node.parent;
    if (
      !origin ||
      origin.arguments.length !== 1 ||
      !ts.isPropertyAccessExpression(origin.expression) ||
      origin.expression.name.text !== 'retrieve' ||
      !ts.isPropertyAccessExpression(data) ||
      data.name.text !== 'data' ||
      data.expression !== node ||
      data.questionDotToken ||
      !ts.isReturnStatement(data.parent) ||
      data.parent.expression !== data ||
      !ts.isPropertyAccessExpression(node) ||
      node.questionDotToken
    )
      return;
    const resource = origin.expression.expression as ts.PropertyAccessExpression;
    const client = resource.expression as ts.Identifier;
    const visible = checker
      .getSymbolsInScope(node, ts.SymbolFlags.Value)
      .find((candidate) => candidate.name === client.text);
    if (visible !== symbol(client)) return;
    const block = data.parent.parent;
    if (!ts.isBlock(block)) return;
    const owner = block.parent;
    if (
      !(
        ts.isFunctionDeclaration(owner) ||
        ts.isFunctionExpression(owner) ||
        ts.isArrowFunction(owner)
      ) ||
      !owner.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    )
      return;
    // Only a response declared in this function body; nested closures and aliases need review.
    const declaration = symbol(receiver)?.valueDeclaration;
    if (!declaration || declaration.parent.parent.parent !== block) return;
    edits.push({
      file: location(node).file,
      start: data.getStart(),
      end: data.getEnd(),
      replacement: `(await ${client.text}.charges.list({ payment_intent: ${receiver.text}.id })).data`,
      changeId: change.id,
    });
  }
  function record(node: ts.Node, receiver: ts.Expression, property: string | undefined) {
    // SDK resources are not response fields, even when their names match a removal.
    if (ts.isIdentifier(receiver) && contains(clients, receiver)) return;
    const schema = ts.isIdentifier(receiver)
      ? responses.get(symbol(receiver)!)
      : ts.isParenthesizedExpression(receiver) && ts.isAwaitExpression(receiver.expression)
        ? responseCall(receiver.expression.expression)?.schema
        : undefined;
    const tracked = schema !== undefined;
    for (const change of changes) {
      if (tracked && change.schema !== schema) continue;
      if (property !== undefined && change.property !== property) continue;
      if (!tracked && !providerDetected) continue;
      const confirmed = Boolean(tracked && property !== undefined && change.schema === schema);
      if (confirmed) propose(node, receiver, change);
      if (property === undefined && !tracked) continue;
      findings.push({
        ...location(node),
        changeId: change.id,
        expression: property === undefined ? '[computed property]' : `.${property}`,
        confidence: confirmed ? 'confirmed' : 'review',
        reason: confirmed
          ? `Removed field read on a locally traced ${provider.id} ${schema} response.`
          : 'Receiver or property cannot be proven by the supported local analysis; inspect manually.',
      });
    }
  }
  for (const node of nodes) {
    if (ts.isPropertyAccessExpression(node)) record(node, node.expression, node.name.text);
    if (ts.isElementAccessExpression(node))
      record(
        node,
        node.expression,
        ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined,
      );
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer
    ) {
      for (const element of node.name.elements) {
        const name = element.propertyName ?? element.name;
        if (ts.isIdentifier(name) || ts.isStringLiteral(name))
          record(element, node.initializer, name.text);
      }
    }
  }
  return {
    imports,
    calls,
    findings,
    providerDetected,
    stripeDetected: provider.id === 'stripe' && providerDetected,
    edits,
  };
}
