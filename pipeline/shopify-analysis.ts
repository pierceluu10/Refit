import { resolve } from 'node:path';
import ts from 'typescript-compiler';
import { createSourceImportResolver } from './source-imports.ts';
import { isShopifyVersion, versionFromEnum } from './shopify-versions.ts';
import type { Location, Repository } from './types.ts';

// Shopify packages whose clients reach the Admin API.
export const SHOPIFY_PACKAGES = [
  '@shopify/shopify-app-remix',
  '@shopify/shopify-app-react-router',
  '@shopify/shopify-app-express',
  '@shopify/shopify-api',
  '@shopify/admin-api-client',
];
const SHOPIFY_IMPORT = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]@shopify\/[^'"]+['"]/;
const GRAPHQL_MARKER = /^\s*#graphql\b/;
const TEST_FILE = /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const ADMIN_RECEIVER = /(?:^|\.)admin$/;
const ADMIN_CLIENT_FACTORY = /^createAdminApiClient$|\.clients\.Graphql$|^GraphqlClient$/;
// `admin.rest.*`, `rest.resources.*`, `clients.Rest`, and REST resource classes (`shopify.rest.Product`).
const REST_RECEIVER =
  /(?:^|\.)admin\.rest\b|\brest\.resources\b|\.clients\.Rest$|(?:^|\.)rest\.[A-Z]\w*(?:\.|$)/;
// A `.json` endpoint, or a resource path segment before a substitution (`products/${id}.json`).
const REST_URL =
  /\/admin\/api\/(\d{4}-\d{2}|unstable)\/(?:[\w/{}.$-]*\.json|(?!graphql\b)[\w-]+\/)/;
const VERSION_URL = /\/admin\/api\/(\d{4}-\d{2})\//g;

export interface DocumentSegment {
  // Offsets in the assembled document text and the source text each piece came from.
  documentStart: number;
  documentEnd: number;
  file: string;
  sourceStart: number;
  sourceText: string;
}

export interface AdminDocument extends Location {
  text: string;
  segments: DocumentSegment[];
  // True when the document reaches an Admin API client call; #graphql literals Refit could not
  // tie to a call are still checked but carry review evidence.
  traced: boolean;
}

export interface VersionDeclaration extends Location {
  kind: 'enum' | 'string' | 'url';
  value: string;
  start: number;
  end: number;
  text: string;
}

export interface ShopifyScan {
  documents: AdminDocument[];
  // Admin calls whose document Refit could not read statically.
  unreadable: (Location & { reason: string })[];
  rest: (Location & { expression: string })[];
  versions: VersionDeclaration[];
  // `latest` marks LATEST_API_VERSION, which the locked SDK release determines.
  unresolvedVersions: (Location & { reason: string; latest?: true })[];
  adminCalls: number;
  shopifyFiles: string[];
}

type Literal = ts.NoSubstitutionTemplateLiteral | ts.StringLiteral | ts.TemplateExpression;

function isLiteral(node: ts.Node): node is Literal {
  return (
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isStringLiteral(node) ||
    ts.isTemplateExpression(node)
  );
}

function isWithin(node: ts.Node, ancestor: ts.Node) {
  for (let current: ts.Node | undefined = node; current; current = current.parent)
    if (current === ancestor) return true;
  return false;
}

function unwrap(node: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  )
    return unwrap(node.expression);
  // gql`...` and graphql`...` tags only mark a document.
  if (ts.isTaggedTemplateExpression(node)) return node.template;
  return node;
}

export function scanShopify(repository: Repository): ShopifyScan {
  const sources = new Map(
    repository.files.map((file) => [resolve(repository.root, file.path), file.content]),
  );
  const resolution = createSourceImportResolver(repository, sources);
  const parsed = new Map<string, ts.SourceFile>();
  const pathOf = new Map(
    repository.files.map((file) => [resolve(repository.root, file.path), file.path]),
  );
  const sourceFile = (absolute: string) => {
    let file = parsed.get(absolute);
    if (!file) {
      file = ts.createSourceFile(absolute, sources.get(absolute)!, ts.ScriptTarget.Latest, true);
      parsed.set(absolute, file);
    }
    return file;
  };
  const location = (node: ts.Node, offset = node.getStart()): Location => {
    const source = node.getSourceFile();
    const position = source.getLineAndCharacterOfPosition(offset);
    return {
      file: pathOf.get(source.fileName)!,
      line: position.line + 1,
      column: position.character + 1,
    };
  };
  const scan: ShopifyScan = {
    documents: [],
    unreadable: [],
    rest: [],
    versions: [],
    unresolvedVersions: [],
    adminCalls: 0,
    shopifyFiles: [],
  };
  // Top-level `const NAME = <literal>` and the files importing names, per file.
  const constants = new Map<string, Map<string, ts.Expression>>();
  const imports = new Map<string, Map<string, { file: string; name: string }>>();
  for (const absolute of sources.keys()) {
    const file = sourceFile(absolute);
    const local = new Map<string, ts.Expression>();
    const imported = new Map<string, { file: string; name: string }>();
    for (const statement of file.statements) {
      if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const)
        for (const declaration of statement.declarationList.declarations)
          if (ts.isIdentifier(declaration.name) && declaration.initializer)
            local.set(declaration.name.text, declaration.initializer);
      // `export default NAME` is read as the constant `default`.
      if (ts.isExportAssignment(statement) && !statement.isExportEquals)
        local.set('default', statement.expression);
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.importClause
      ) {
        const target = resolution.resolve(statement.moduleSpecifier.text, absolute);
        const { name, namedBindings } = statement.importClause;
        if (target && name) imported.set(name.text, { file: target, name: 'default' });
        if (target && namedBindings && ts.isNamedImports(namedBindings))
          for (const element of namedBindings.elements)
            imported.set(element.name.text, {
              file: target,
              name: (element.propertyName ?? element.name).text,
            });
      }
    }
    constants.set(absolute, local);
    imports.set(absolute, imported);
  }
  const constant = (
    file: string,
    name: string,
    seen = new Set<string>(),
  ): { file: string; node: ts.Expression } | undefined => {
    const key = `${file}#${name}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const local = constants.get(file)?.get(name);
    if (local) {
      const value = unwrap(local);
      return ts.isIdentifier(value) ? constant(file, value.text, seen) : { file, node: value };
    }
    const imported = imports.get(file)?.get(name);
    return imported && sources.has(imported.file)
      ? constant(imported.file, imported.name, seen)
      : undefined;
  };
  // Assembles a literal into document text, inlining `${FRAGMENT}` constants. Any other
  // substitution makes the document unreadable.
  const assemble = (
    literal: Literal,
    file: string,
    depth = 0,
  ): { text: string; segments: DocumentSegment[] } | string => {
    const segments: DocumentSegment[] = [];
    let text = '';
    const append = (value: string, node: ts.Node, sourceStart: number) => {
      segments.push({
        documentStart: text.length,
        documentEnd: text.length + value.length,
        file: pathOf.get(node.getSourceFile().fileName)!,
        sourceStart,
        sourceText: node.getSourceFile().text,
      });
      text += value;
    };
    if (!ts.isTemplateExpression(literal)) {
      append(literal.text, literal, literal.getStart() + 1);
      return { text, segments };
    }
    append(literal.head.text, literal.head, literal.head.getStart() + 1);
    for (const span of literal.templateSpans) {
      const expression = unwrap(span.expression);
      const resolved = ts.isIdentifier(expression) ? constant(file, expression.text) : undefined;
      if (!resolved || !isLiteral(resolved.node) || depth > 8)
        return 'The document interpolates a value Refit cannot resolve to a constant fragment.';
      const inner = assemble(resolved.node, resolved.file, depth + 1);
      if (typeof inner === 'string') return inner;
      for (const segment of inner.segments)
        segments.push({
          ...segment,
          documentStart: segment.documentStart + text.length,
          documentEnd: segment.documentEnd + text.length,
        });
      text += inner.text;
      append(span.literal.text, span.literal, span.literal.getStart() + 1);
    }
    return { text, segments };
  };
  const documentLiterals = new Map<Literal, boolean>();
  const record = (literal: Literal, file: string, reached: boolean, call?: ts.Node) => {
    // Documents in tests go to mocked clients; they are fixtures, not Admin API usage.
    const traced = reached && !TEST_FILE.test(pathOf.get(file) ?? '');
    if (documentLiterals.get(literal)) return;
    documentLiterals.set(literal, traced);
    const assembled = assemble(literal, file);
    if (typeof assembled === 'string') {
      scan.unreadable.push({ ...location(call ?? literal), reason: assembled });
      return;
    }
    const existing = scan.documents.findIndex(
      (entry) =>
        entry.segments[0].sourceStart === assembled.segments[0].sourceStart &&
        entry.file === location(literal).file,
    );
    if (existing >= 0) scan.documents.splice(existing, 1);
    scan.documents.push({ ...location(literal), ...assembled, traced });
  };
  // The `const` an identifier names in an enclosing block, including names destructured from
  // `await import('./module')` or `require('./module')`. Reassignable bindings are not followed.
  const scoped = (
    identifier: ts.Identifier,
    file: string,
  ): { file: string; node: ts.Expression } | undefined => {
    for (let scope: ts.Node | undefined = identifier.parent; scope; scope = scope.parent) {
      if (!('statements' in scope) || !Array.isArray(scope.statements)) continue;
      for (const statement of scope.statements as ts.Statement[]) {
        if (
          !ts.isVariableStatement(statement) ||
          !(statement.declarationList.flags & ts.NodeFlags.Const)
        )
          continue;
        for (const declaration of statement.declarationList.declarations) {
          if (!declaration.initializer || declaration.getStart() > identifier.getStart()) continue;
          if (ts.isIdentifier(declaration.name) && declaration.name.text === identifier.text) {
            const value = unwrap(declaration.initializer);
            return ts.isIdentifier(value)
              ? (scoped(value, file) ?? constant(file, value.text))
              : { file, node: value };
          }
          if (ts.isObjectBindingPattern(declaration.name)) {
            const element = declaration.name.elements.find(
              (entry) => ts.isIdentifier(entry.name) && entry.name.text === identifier.text,
            );
            let source = unwrap(declaration.initializer);
            if (ts.isAwaitExpression(source)) source = unwrap(source.expression);
            const specifier =
              ts.isCallExpression(source) &&
              (source.expression.kind === ts.SyntaxKind.ImportKeyword ||
                source.expression.getText() === 'require') &&
              source.arguments[0] &&
              ts.isStringLiteral(source.arguments[0])
                ? source.arguments[0].text
                : undefined;
            const target = specifier && resolution.resolve(specifier, file);
            if (element && target && sources.has(target))
              return constant(target, (element.propertyName ?? element.name).getText());
          }
        }
      }
    }
    return undefined;
  };
  // Calls whose callee is a plain identifier, per file, built on first use.
  let identifierCalls: Map<string, ts.CallExpression[]> | undefined;
  const callsIn = (file: string) => {
    if (!identifierCalls) {
      identifierCalls = new Map();
      for (const absolute of sources.keys()) {
        const calls: ts.CallExpression[] = [];
        const visit = (node: ts.Node) => {
          if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.push(node);
          ts.forEachChild(node, visit);
        };
        visit(sourceFile(absolute));
        identifierCalls.set(absolute, calls);
      }
    }
    return identifierCalls.get(file) ?? [];
  };
  // When a document is a parameter of a named helper (`fetchAll(admin, query)`), the arguments its
  // callers pass in this file or through a named import. Undefined when there is no such caller.
  const helperArguments = (identifier: ts.Identifier, file: string) => {
    for (let scope: ts.Node | undefined = identifier.parent; scope; scope = scope.parent) {
      if (!ts.isFunctionLike(scope)) continue;
      const index = scope.parameters.findIndex(
        (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === identifier.text,
      );
      if (index < 0 || scope.parameters[index].dotDotDotToken) continue;
      const name =
        ts.isFunctionDeclaration(scope) && scope.name
          ? scope.name.text
          : (ts.isArrowFunction(scope) || ts.isFunctionExpression(scope)) &&
              ts.isVariableDeclaration(scope.parent) &&
              ts.isIdentifier(scope.parent.name)
            ? scope.parent.name.text
            : undefined;
      if (!name) return undefined;
      const helper = scope;
      const callers: { file: string; call: ts.CallExpression }[] = [];
      for (const caller of sources.keys()) {
        const names = new Set(
          caller === file
            ? [name]
            : [...(imports.get(caller) ?? [])]
                .filter(([, target]) => target.file === file && target.name === name)
                .map(([local]) => local),
        );
        for (const call of callsIn(caller))
          if (names.has((call.expression as ts.Identifier).text) && !isWithin(call, helper))
            callers.push({ file: caller, call });
      }
      return callers.length ? { helper, index, callers } : undefined;
    }
    return undefined;
  };
  // A document argument: a literal, or a constant naming one, possibly wrapped as { query }.
  const documentArgument = (
    node: ts.Expression | undefined,
    file: string,
    call: ts.Node,
    helpers = new Set<ts.Node>(),
  ): void => {
    if (!node) return;
    let value = unwrap(node);
    if (ts.isObjectLiteralExpression(value)) {
      const query = value.properties.find(
        (property): property is ts.PropertyAssignment =>
          ts.isPropertyAssignment(property) && property.name.getText() === 'query',
      );
      if (!query) {
        scan.unreadable.push({
          ...location(call),
          reason: 'The request body has no static query.',
        });
        return;
      }
      value = unwrap(query.initializer);
    }
    if (ts.isConditionalExpression(value)) {
      documentArgument(value.whenTrue, file, call, helpers);
      documentArgument(value.whenFalse, file, call, helpers);
      return;
    }
    let owner = file;
    if (ts.isIdentifier(value)) {
      const resolved = scoped(value, file) ?? constant(file, value.text);
      if (resolved) {
        value = resolved.node;
        owner = resolved.file;
      } else {
        const forwarded = helperArguments(value, file);
        if (forwarded && !helpers.has(forwarded.helper)) {
          for (const caller of forwarded.callers) {
            const argument = caller.call.arguments[forwarded.index];
            if (argument)
              documentArgument(
                argument,
                caller.file,
                caller.call,
                new Set([...helpers, forwarded.helper]),
              );
            else
              scan.unreadable.push({
                ...location(caller.call),
                reason: 'The helper call passes no GraphQL document.',
              });
          }
          return;
        }
      }
      // `const mutation = isCode ? CODE_MUTATION : AUTOMATIC_MUTATION`
      if (ts.isConditionalExpression(value)) return documentArgument(value, owner, call, helpers);
    }
    if (isLiteral(value)) record(value, owner, true, call);
    else
      scan.unreadable.push({
        ...location(call),
        reason: 'The document is built at runtime; Refit only reads literal or constant documents.',
      });
  };
  for (const [absolute, content] of sources) {
    const file = sourceFile(absolute);
    const shopify = SHOPIFY_IMPORT.test(content);
    if (shopify) scan.shopifyFiles.push(pathOf.get(absolute)!);
    // Identifiers bound to Admin GraphQL clients in this file.
    const clients = new Set<string>();
    const apiVersionImported = /\bApiVersion\b/.test(content) && shopify;
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const value = unwrap(node.initializer);
        const callee =
          ts.isCallExpression(value) || ts.isNewExpression(value) ? value.expression.getText() : '';
        if (ADMIN_CLIENT_FACTORY.test(callee)) clients.add(node.name.text);
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const receiver = node.expression.expression.getText();
        if (method === 'graphql' && ADMIN_RECEIVER.test(receiver)) {
          scan.adminCalls++;
          documentArgument(node.arguments[0], absolute, node);
        } else if ((method === 'request' || method === 'query') && clients.has(receiver)) {
          scan.adminCalls++;
          const argument = node.arguments[0];
          const data =
            method === 'query' && argument && ts.isObjectLiteralExpression(unwrap(argument))
              ? (unwrap(argument) as ts.ObjectLiteralExpression).properties.find(
                  (property): property is ts.PropertyAssignment =>
                    ts.isPropertyAssignment(property) && property.name.getText() === 'data',
                )?.initializer
              : argument;
          documentArgument(data, absolute, node);
        } else if (
          // A call chained on a REST call (`.then`) is the same request.
          !ts.isCallExpression(node.expression.expression) &&
          REST_RECEIVER.test(node.expression.getText())
        )
          scan.rest.push({ ...location(node), expression: node.expression.getText() });
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'createAdminRestApiClient'
      )
        scan.rest.push({ ...location(node), expression: node.expression.text });
      if (ts.isNewExpression(node) && REST_RECEIVER.test(node.expression.getText()))
        scan.rest.push({ ...location(node), expression: node.expression.getText() });
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'ApiVersion' &&
        apiVersionImported
      ) {
        const value = versionFromEnum(node.name.text);
        if (value)
          scan.versions.push({
            ...location(node),
            kind: 'enum',
            value,
            start: node.name.getStart(),
            end: node.name.getEnd(),
            text: node.getText(),
          });
        else
          scan.unresolvedVersions.push({
            ...location(node),
            reason: `${node.getText()} is not a dated Admin API version.`,
          });
      }
      if (
        ts.isIdentifier(node) &&
        node.text === 'LATEST_API_VERSION' &&
        shopify &&
        !ts.isImportSpecifier(node.parent)
      )
        scan.unresolvedVersions.push({
          ...location(node),
          reason:
            'LATEST_API_VERSION follows the installed Shopify package, so the version changes only with an SDK upgrade.',
          latest: true,
        });
      if (
        shopify &&
        ts.isPropertyAssignment(node) &&
        node.name.getText().replace(/['"]/g, '') === 'apiVersion'
      ) {
        const value = unwrap(node.initializer);
        if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
          if (isShopifyVersion(value.text))
            scan.versions.push({
              ...location(value),
              kind: 'string',
              value: value.text,
              start: value.getStart() + 1,
              end: value.getEnd() - 1,
              text: value.getText(),
            });
          else
            scan.unresolvedVersions.push({
              ...location(value),
              reason: `apiVersion ${value.getText()} is not a dated Admin API version.`,
            });
        } else if (
          (!ts.isPropertyAccessExpression(value) || value.expression.getText() !== 'ApiVersion') &&
          !(ts.isIdentifier(value) && value.text === 'LATEST_API_VERSION')
        )
          scan.unresolvedVersions.push({
            ...location(value),
            reason: `apiVersion is set from ${value.getText().slice(0, 80)}, which Refit cannot resolve statically.`,
          });
      }
      if (
        (isLiteral(node) && !ts.isTemplateExpression(node)) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        if (isLiteral(node) && GRAPHQL_MARKER.test(node.text))
          record(node, absolute, documentLiterals.get(node) ?? false);
        if (REST_URL.test(node.text))
          scan.rest.push({ ...location(node), expression: node.text.slice(0, 120) });
        for (const match of node.text.matchAll(VERSION_URL)) {
          const start = node.getStart() + 1 + match.index! + '/admin/api/'.length;
          scan.versions.push({
            ...location(node, start),
            kind: 'url',
            value: match[1],
            start,
            end: start + match[1].length,
            text: match[0],
          });
        }
      }
      if (ts.isTemplateExpression(node) && GRAPHQL_MARKER.test(node.head.text))
        record(node, absolute, documentLiterals.get(node) ?? false);
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  scan.documents.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return scan;
}

// Maps an offset in an assembled document back to the source file and line it came from.
export function documentLocation(document: AdminDocument, offset: number): Location {
  const segment =
    document.segments.find(
      (entry) => offset >= entry.documentStart && offset < entry.documentEnd,
    ) ?? document.segments[document.segments.length - 1];
  const position = segment.sourceStart + Math.max(0, offset - segment.documentStart);
  const before = segment.sourceText.slice(0, position);
  const line = before.split('\n').length;
  return { file: segment.file, line, column: position - before.lastIndexOf('\n') };
}
