import { resolve } from 'node:path';
import ts from 'typescript-compiler';
import {
  PipelineInputError,
  type Finding,
  type Location,
  type Removal,
  type Repository,
  type SourceEdit,
} from './types.ts';

const PAYMENT_INTENT_METHODS = new Set([
  'retrieve',
  'create',
  'update',
  'confirm',
  'cancel',
  'capture',
]);
const PAYMENT_INTENT_SCHEMA = 'payment_intent';

export function analyzeRepository(repository: Repository, changes: Removal[]) {
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
  const intents = new Set<ts.Symbol>();
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
      node.moduleSpecifier.text === 'stripe'
    ) {
      imports.push(location(node));
      const clause = node.importClause;
      if (clause?.name && !clause.isTypeOnly) add(constructors, clause.name);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && !clause.isTypeOnly) {
        for (const binding of clause.namedBindings.elements) {
          if ((binding.propertyName ?? binding.name).text === 'Stripe' && !binding.isTypeOnly)
            add(constructors, binding.name);
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.some((argument) => ts.isStringLiteral(argument) && argument.text === 'stripe')
    ) {
      imports.push(location(node));
    }
  }
  function paymentIntentCall(node: ts.Node): string | undefined {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const method = node.expression;
    const resource = method.expression;
    if (
      PAYMENT_INTENT_METHODS.has(method.name.text) &&
      ts.isPropertyAccessExpression(resource) &&
      resource.name.text === 'paymentIntents' &&
      ts.isIdentifier(resource.expression) &&
      contains(clients, resource.expression)
    )
      return method.name.text;
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
    if (ts.isAwaitExpression(value) && paymentIntentCall(value.expression)) {
      add(intents, node.name);
      origins.set(symbol(node.name)!, value.expression as ts.CallExpression);
    }
    if (ts.isIdentifier(value) && contains(intents, value)) add(intents, node.name);
  }
  for (const node of nodes) {
    const method = paymentIntentCall(node);
    if (method) calls.push({ ...location(node), method: `paymentIntents.${method}` });
  }
  const stripeDetected = imports.length > 0 || repository.dependencies.length > 0;
  function propose(node: ts.Node, receiver: ts.Expression, change: Removal) {
    if (change.property !== 'charges' || !ts.isIdentifier(receiver)) return;
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
    const tracked =
      (ts.isIdentifier(receiver) && contains(intents, receiver)) ||
      (ts.isParenthesizedExpression(receiver) &&
        ts.isAwaitExpression(receiver.expression) &&
        Boolean(paymentIntentCall(receiver.expression.expression)));
    for (const change of changes) {
      if (property !== undefined && change.property !== property) continue;
      if (!tracked && !stripeDetected) continue;
      const confirmed = Boolean(
        tracked && property !== undefined && change.schema === PAYMENT_INTENT_SCHEMA,
      );
      if (confirmed) propose(node, receiver, change);
      if (property === undefined && !tracked) continue;
      findings.push({
        ...location(node),
        changeId: change.id,
        expression: property === undefined ? '[computed property]' : `.${property}`,
        confidence: confirmed ? 'confirmed' : 'review',
        reason: confirmed
          ? 'Removed field read on a locally traced Stripe PaymentIntent response.'
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
  return { imports, calls, findings, stripeDetected, edits };
}
