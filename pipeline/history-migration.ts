import { posix } from 'node:path';
import ts from 'typescript-compiler';
import type { Removal, SourceEdit } from './types.ts';
import { sourceModuleReferences, type ClientExport } from './source-modules.ts';

const CLIENT_ALIAS = 'refitStripe';
const HISTORY_BINDING = 'refitCharges';
const CHARGE_BINDING = 'refitCharge';

export function guardedHistoryEdit(options: {
  node: ts.Node;
  receiver: ts.Identifier;
  origin: ts.CallExpression;
  checker: ts.TypeChecker;
  symbol: (node: ts.Node) => ts.Symbol | undefined;
  clients: Set<ts.Symbol>;
  locations: Map<string, string>;
  change: Removal;
  clientExport: (binding: ts.Symbol) => ClientExport | undefined;
  resolveImport: (name: string, containingFile: string) => string | undefined;
}): SourceEdit | undefined {
  const { node, receiver, origin, checker, symbol, clients, locations, change } = options;
  const declaration = symbol(receiver)?.valueDeclaration;
  if (
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    declaration.parent.declarations.length !== 1 ||
    !ts.isVariableStatement(declaration.parent.parent)
  )
    return;
  const first = declaration.parent.parent;
  const body = first.parent;
  if (
    !ts.isBlock(body) ||
    !ts.isFunctionDeclaration(body.parent) ||
    !body.parent.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    body.statements.length !== 3 ||
    body.statements[0] !== first
  )
    return;
  const guard = body.statements[1];
  const returned = body.statements[2];
  if (
    !ts.isIfStatement(guard) ||
    guard.elseStatement ||
    !ts.isPrefixUnaryExpression(guard.expression) ||
    guard.expression.operator !== ts.SyntaxKind.ExclamationToken ||
    !ts.isPropertyAccessExpression(guard.expression.operand) ||
    guard.expression.operand.questionDotToken ||
    guard.expression.operand.name.text !== 'charges' ||
    symbol(guard.expression.operand.expression) !== symbol(receiver) ||
    !ts.isBlock(guard.thenStatement) ||
    guard.thenStatement.statements.length !== 1 ||
    !ts.isThrowStatement(guard.thenStatement.statements[0]) ||
    !ts.isReturnStatement(returned) ||
    !returned.expression ||
    !ts.isPropertyAccessExpression(returned.expression) ||
    returned.expression.questionDotToken ||
    returned.expression.name.text !== 'data'
  )
    return;
  const thrown = guard.thenStatement.statements[0].expression;
  if (
    !thrown ||
    !ts.isNewExpression(thrown) ||
    !ts.isIdentifier(thrown.expression) ||
    !thrown.arguments?.every((argument) => ts.isStringLiteral(argument))
  )
    return;
  const charges = returned.expression.expression;
  if (
    !ts.isPropertyAccessExpression(charges) ||
    charges.questionDotToken ||
    charges.name.text !== 'charges' ||
    symbol(charges.expression) !== symbol(receiver) ||
    (node !== charges && node !== guard.expression.operand)
  )
    return;
  if (
    !ts.isPropertyAccessExpression(origin.expression) ||
    origin.expression.name.text !== 'retrieve' ||
    origin.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(origin.expression.expression)
  )
    return;
  const clientNode = origin.expression.expression.expression;
  const client = symbol(clientNode);
  const exported = client && options.clientExport(client);
  if (!client || !clients.has(client) || !exported) return;
  const source = node.getSourceFile();
  const file = locations.get(source.fileName)!;
  const target = locations.get(exported.file)!;
  if (file === target) return;
  const occupied = new Set(
    checker
      .getSymbolsInScope(node, ts.SymbolFlags.Value | ts.SymbolFlags.Alias)
      .map((entry) => entry.name),
  );
  if ([CLIENT_ALIAS, HISTORY_BINDING, CHARGE_BINDING].some((name) => occupied.has(name))) return;
  let modulePath = posix.relative(posix.dirname(file), target);
  if (!modulePath.startsWith('.')) modulePath = `./${modulePath}`;
  // Follow the repository's import extension convention rather than requiring TS runtime imports.
  const importDeclaration = source.statements.find(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      Boolean(options.resolveImport(statement.moduleSpecifier.text, source.fileName)),
  );
  const sourceImport = [...sourceModuleReferences(source)].find((name) =>
    options.resolveImport(name, source.fileName),
  );
  if (sourceImport) {
    const extension = posix.extname(sourceImport);
    if (['.js', '.mjs', '.cjs'].includes(extension))
      modulePath = modulePath.replace(/\.[cm]?ts$/, extension);
    else if (!extension) modulePath = modulePath.replace(/\.[cm]?[jt]sx?$/, '');
  }
  const newline = source.text.includes('\r\n') ? '\r\n' : '\n';
  const lineStart = source.text.lastIndexOf('\n', guard.getStart()) + 1;
  const indentation = source.text.slice(lineStart, guard.getStart()).match(/^\s*/)?.[0] ?? '';
  const replacement = [
    `const ${HISTORY_BINDING} = [];`,
    `for await (const ${CHARGE_BINDING} of ${CLIENT_ALIAS}.charges.list({ payment_intent: ${receiver.text}.id })) {`,
    `  ${HISTORY_BINDING}.push(${CHARGE_BINDING});`,
    '}',
    `return ${HISTORY_BINDING};`,
  ].join(newline + indentation);
  // One whole-file edit keeps the added import and guarded replacement atomic.
  const content =
    source.text.slice(0, guard.getStart()) + replacement + source.text.slice(returned.getEnd());
  const insertion = importDeclaration?.getStart() ?? body.parent.getStart();
  const clientImport =
    exported.kind === 'esm'
      ? `import ${exported.name ? `{ ${exported.name} as ${CLIENT_ALIAS} }` : CLIENT_ALIAS} from ${JSON.stringify(modulePath)};`
      : `const ${CLIENT_ALIAS} = require(${JSON.stringify(modulePath)})${exported.name ? `.${exported.name}` : ''};`;
  const updated = content.slice(0, insertion) + clientImport + newline + content.slice(insertion);
  return { file, start: 0, end: source.text.length, replacement: updated, changeId: change.id };
}
