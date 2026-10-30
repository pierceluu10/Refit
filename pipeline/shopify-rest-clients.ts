import { basename, extname } from 'node:path';
import ts from 'typescript-compiler';
import { declarationScope, references, unwrapParent } from './shopify-rest-rewrite.ts';

// A REST client a provider function builds and returns, where no file in the repository ever
// calls that provider (the Shopify app templates' `clientProvider.restClient`, kept beside the
// GraphQL provider the app uses). Such a client sends no request, so no version move can break
// one. The provider is followed by name through the consts and object literals that hold it,
// export included; any other use of any of those names (a call, an argument, an array element, a
// member read of the provider, a non-JavaScript file naming it) means the client may be used, and
// the check fails. Frameworks call some functions by convention (`loader`, `useFactory`): a
// provider held in an object that reaches anything but a const or an export is not followed.

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

const scriptKind = (file: string) =>
  /\.[cm]?tsx?$/.test(file)
    ? file.endsWith('x')
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS
    : file.endsWith('x')
      ? ts.ScriptKind.JSX
      : ts.ScriptKind.JS;

const constName = (node: ts.Node) =>
  ts.isVariableDeclaration(node) &&
  ts.isIdentifier(node.name) &&
  node.parent.flags & ts.NodeFlags.Const
    ? node.name.text
    : undefined;

// The name the function `fn` is called by, and the const that holds it or the object it is in.
function providerName(fn: ts.SignatureDeclaration) {
  if (ts.isFunctionDeclaration(fn)) return fn.name ? { name: fn.name.text, at: fn } : undefined;
  if (ts.isMethodDeclaration(fn) && ts.isIdentifier(fn.name)) return { name: fn.name.text, at: fn };
  const parent = unwrapParent(fn).parent;
  if (
    (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
    (ts.isPropertyAssignment(parent) || ts.isVariableDeclaration(parent)) &&
    ts.isIdentifier(parent.name)
  )
    return { name: parent.name.text, at: parent };
  return undefined;
}

// The object a client is placed in, as in `return { client, shop }`.
const inResult = (at: ts.Node) =>
  ts.isShorthandPropertyAssignment(at.parent) ||
  (ts.isPropertyAssignment(at.parent) && at.parent.initializer === at)
    ? unwrapParent(at.parent.parent)
    : at;

// Why the client `construction` builds may send a request, or undefined when it cannot.
export function clientUnreached(
  construction: ts.NewExpression,
  file: string,
  files: { path: string; content: string }[],
): string | undefined {
  const returned: ts.Node[] = [];
  const value = unwrapParent(construction);
  const declaration = value.parent;
  if (constName(declaration)) {
    const uses = references(
      (declaration as ts.VariableDeclaration).name as ts.Identifier,
      declarationScope(declaration.parent),
    );
    if (!uses) return 'Another declaration shadows the REST client.';
    for (const use of uses) returned.push(inResult(unwrapParent(use)));
  } else returned.push(inResult(value));
  const providers = new Set<ts.SignatureDeclaration>();
  for (const at of returned) {
    const fn =
      ts.isReturnStatement(at.parent) && at.parent.expression === at
        ? ts.findAncestor(at.parent, ts.isFunctionLike)
        : ts.isArrowFunction(at.parent) && at.parent.body === at
          ? at.parent
          : undefined;
    if (!fn) return 'The REST client is used in ways other than calls Refit traced.';
    providers.add(fn);
  }
  // No use at all: the client is built and dropped.
  if (!providers.size) return undefined;
  if (providers.size > 1) return 'The REST client is returned from more than one function.';
  const provider = providerName([...providers][0]);
  if (!provider)
    return 'The REST client is returned from a function with no name Refit can follow.';

  // The provider's name and the keys and consts that hold it, up through the object literals it
  // is in, then any const object that holds one of those consts by shorthand or property.
  const chain = new Set<string>();
  const holders = new Set<ts.Node>();
  let holder: ts.Node = provider.at;
  for (;;) {
    holders.add(holder);
    if (ts.isFunctionDeclaration(holder)) {
      chain.add(provider.name);
      break;
    }
    const name = ts.isVariableDeclaration(holder)
      ? constName(holder)
      : ((holder as ts.PropertyAssignment | ts.MethodDeclaration).name as ts.Identifier).text;
    if (!name) return 'The REST client provider is not held in a const.';
    chain.add(name);
    if (ts.isVariableDeclaration(holder)) break;
    const literal = unwrapParent(holder.parent);
    const up = literal.parent;
    if (
      (ts.isVariableDeclaration(up) || ts.isPropertyAssignment(up)) &&
      up.initializer === literal &&
      ts.isIdentifier(up.name)
    )
      holder = up;
    else return 'The REST client provider is held in an object Refit cannot follow.';
  }
  const source = construction.getSourceFile();
  for (let grew = true; grew;) {
    grew = false;
    const visit = (node: ts.Node) => {
      const held =
        (ts.isShorthandPropertyAssignment(node) && chain.has(node.name.text)) ||
        (ts.isPropertyAssignment(node) &&
          ts.isIdentifier(node.name) &&
          ts.isIdentifier(node.initializer) &&
          chain.has(node.initializer.text));
      if (held) {
        const literal = unwrapParent(node.parent);
        if (ts.isVariableDeclaration(literal.parent) && constName(literal.parent)) {
          for (const name of [constName(literal.parent)!, (node.name as ts.Identifier).text])
            if (!chain.has(name)) {
              chain.add(name);
              grew = true;
            }
          if (!holders.has(literal.parent)) {
            holders.add(literal.parent);
            grew = true;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  // Default-export aliases in other files: `import provider from './clientProvider'`.
  const module = basename(file, extname(file));
  for (const item of files) {
    if (![...chain].some((name) => item.content.includes(name)) && !item.content.includes(module))
      continue;
    if (!SOURCE.test(item.path)) {
      if ([...chain].some((name) => new RegExp(`\\b${name}\\b`).test(item.content)))
        return `${item.path} names \`${[...chain].find((name) => item.content.includes(name))}\`, and Refit reads only JavaScript and TypeScript.`;
      continue;
    }
    const parsed =
      item.path === file
        ? source
        : ts.createSourceFile(
            item.path,
            item.content,
            ts.ScriptTarget.Latest,
            true,
            scriptKind(item.path),
          );
    const names = new Set(chain);
    const problem = (node: ts.Node): string | undefined => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const target = basename(node.moduleSpecifier.text).replace(/\.[cm]?[jt]sx?$/, '');
        if (target === module && node.importClause) {
          if (node.importClause.name) names.add(node.importClause.name.text);
          const bindings = node.importClause.namedBindings;
          if (bindings && ts.isNamespaceImport(bindings))
            return `${item.path} imports the provider's module as a namespace.`;
        }
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.getText() === 'require' &&
        ts.isStringLiteralLike(node.arguments[0] ?? node) &&
        basename((node.arguments[0] as ts.StringLiteral).text).replace(/\.[cm]?[jt]sx?$/, '') ===
          module
      ) {
        const name = constName(unwrapParent(node).parent);
        if (!name)
          return `${item.path} requires the provider's module in a way Refit cannot follow.`;
        names.add(name);
      }
      if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        chain.has(node.argumentExpression.text)
      )
        return `${item.path} reads \`${node.getText()}\`.`;
      if (ts.isIdentifier(node) && names.has(node.text)) {
        const reason = identifierProblem(node, names, holders);
        if (reason)
          return `${item.path}:${parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${reason}`;
      }
      let found: string | undefined;
      ts.forEachChild(node, (child) => {
        found ??= problem(child);
      });
      return found;
    };
    const reason = problem(parsed);
    if (reason) return `The REST client provider \`${provider.name}\` may be called: ${reason}`;
  }
  return undefined;
}

// Whether an occurrence of a provider or holder name only declares, holds or exports it.
function identifierProblem(node: ts.Identifier, names: Set<string>, holders: Set<ts.Node>) {
  const parent = node.parent;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isFunctionDeclaration(parent)) &&
    parent.name === node
  )
    return undefined;
  if (ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent))
    return undefined;
  if (ts.isExportAssignment(parent)) return undefined;
  const value = unwrapParent(node);
  const literalHolder = (literal: ts.Node) =>
    ts.isVariableDeclaration(literal.parent) && holders.has(literal.parent);
  if (ts.isShorthandPropertyAssignment(parent))
    return literalHolder(unwrapParent(parent.parent))
      ? undefined
      : 'it is placed in an object Refit does not follow.';
  if (ts.isPropertyAssignment(value.parent) && value.parent.initializer === value)
    return literalHolder(unwrapParent(value.parent.parent))
      ? undefined
      : 'it is placed in an object Refit does not follow.';
  // `module.exports = clientProvider`
  if (
    ts.isBinaryExpression(value.parent) &&
    value.parent.right === value &&
    value.parent.left.getText() === 'module.exports'
  )
    return undefined;
  // A member read that leaves the chain: `clientProvider.offline.graphqlClient(…)`.
  if (ts.isPropertyAccessExpression(parent)) {
    let access: ts.PropertyAccessExpression = parent;
    while (names.has(access.name.text)) {
      if (!ts.isPropertyAccessExpression(access.parent) || access.parent.expression !== access)
        return `it reads \`${access.getText()}\`.`;
      access = access.parent;
    }
    return undefined;
  }
  return `it is used as \`${parent.getText().replace(/\s+/g, ' ').slice(0, 60)}\`.`;
}

// clientUnreached for each `new <shopify>.clients.Rest(…)` entry of one file.
export function fileClientsUnreached<
  Entry extends { line: number; column: number; expression: string },
>(file: string, content: string, entries: Entry[], files: { path: string; content: string }[]) {
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, scriptKind(file));
  const reasons = new Map<Entry, string | undefined>();
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node)) {
      const at = source.getLineAndCharacterOfPosition(node.getStart());
      const entry = entries.find(
        (item) =>
          item.line === at.line + 1 &&
          item.column === at.character + 1 &&
          item.expression === node.expression.getText(),
      );
      if (entry) reasons.set(entry, clientUnreached(node, file, files));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return reasons;
}
