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
const ENVIRONMENT =
  /^process\.env\.(\w+)$|^process\.env\[['"](\w+)['"]\]$|^import\.meta\.env\.(\w+)$/;
// Tags and functions that only mark a document: graphql-tag, codegen's client preset, gql.tada.
const DOCUMENT_TAG = /^(?:gql|graphql)$/;
// Storefront API clients: Hydrogen's `storefront`, createStorefrontApiClient and clients.Storefront.
const STOREFRONT_RECEIVER = /(?:^|\.)storefront$/;
export const STOREFRONT_CLIENT_FACTORY =
  /^createStorefrontApiClient$|\.clients\.Storefront$|^createStorefrontClient$/;
const TEST_FILE = /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const ADMIN_RECEIVER = /(?:^|\.)admin$/;
const ADMIN_CLIENT_FACTORY = /^createAdminApiClient$|\.clients\.Graphql$|^GraphqlClient$/;
// `admin.rest.*`, `rest.resources.*`, `clients.Rest`, and REST resource classes (`shopify.rest.Product`).
const REST_RECEIVER =
  /(?:^|\.)admin\.rest\b|\brest\.resources\b|\.clients\.Rest$|(?:^|\.)rest\.[A-Z]\w*(?:\.|$)/;
// A `.json` endpoint, or a resource path segment before a substitution (`products/${id}.json`).
const REST_URL =
  /\/admin\/api\/(\d{4}-\d{2}|unstable)\/(?:(?!graphql\.json)[\w/{}.$-]*\.json|(?!graphql\b)[\w-]+\/)/;
// The Admin GraphQL endpoint itself, requested without one of Shopify's clients.
const GRAPHQL_URL = /\/admin\/api\/(?:\d{4}-\d{2}|unstable|\{[^}]*\})\/graphql\.json/;
// A version followed by a path, or ending the literal piece: a base URL (`…/admin/api/2025-01`)
// that code joins a path to elsewhere.
const VERSION_URL = /\/admin\/api\/(\d{4}-\d{2})(?=\/|$)/g;
// A base URL ending at its version: the request path, REST or GraphQL, is added elsewhere.
const BASE_URL = /\/admin\/api\/(?:\d{4}-\d{2}|unstable)$/;
// GraphQL clients built from an endpoint URL, and the methods that send their documents.
const ENDPOINT_CLIENT =
  /(?:^|\.)(?:GraphQLClient|createGraphQLClient|createClient|ApolloClient|HttpLink)$/;
const CLIENT_METHODS = new Set(['request', 'rawRequest', 'query', 'mutate', 'mutation']);
const CLIENT_SETTERS = /^(?:setHeaders?|setEndpoint|config)$/;
// Variables holding a REST Admin client: `new shopify.clients.Rest(...)` or `createAdminRestApiClient(...)`.
const REST_CLIENT_FACTORY = /\.clients\.Rest$|^createAdminRestApiClient$/;
const REST_VERBS: Record<string, string> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
};
// REST resource class operations whose HTTP method the SDK fixes; `save` depends on the record's id.
const RESOURCE_METHODS: Record<string, string> = {
  all: 'GET',
  find: 'GET',
  count: 'GET',
  delete: 'DELETE',
  save: 'POST or PUT',
};
const REST_PATH = /\/admin\/api\/(?:\d{4}-\d{2}|unstable)\/([^?#\s]+)/;

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
  // Sent to a Storefront API client: checked against the Storefront contract, never the Admin one.
  api?: 'storefront';
}

export interface VersionDeclaration extends Location {
  kind: 'enum' | 'string' | 'url';
  value: string;
  start: number;
  end: number;
  text: string;
  // `process.env.NAME ?? '2025-01'`: the literal is a default the environment can override.
  envFallback?: string;
  // Set on a Storefront API client; the Admin version move leaves it alone.
  api?: 'storefront';
}

export interface ShopifyScan {
  documents: AdminDocument[];
  // Calls whose document Refit could not read statically; `api` marks a Storefront client's.
  unreadable: (Location & { reason: string; api?: 'storefront' })[];
  // REST Admin usage, with the HTTP method, path (`{…}` marks a substitution) and resource class
  // operation where the code states them. Review-only evidence: Refit never migrates REST calls.
  rest: (Location & { expression: string; method?: string; path?: string; resource?: string })[];
  versions: VersionDeclaration[];
  // `latest` marks LATEST_API_VERSION, which the locked SDK release determines.
  // `note` marks a version the patch leaves alone and the draft names, which stops nothing: an
  // environment variable with no default in code, or the moving `unstable` version.
  unresolvedVersions: (Location & {
    reason: string;
    latest?: true;
    note?: 'environment' | 'unstable';
  })[];
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

type FunctionNode = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

function hasModifier(node: ts.Node, kind: ts.SyntaxKind) {
  return (
    ts.canHaveModifiers(node) &&
    Boolean(ts.getModifiers(node)?.some((entry) => entry.kind === kind))
  );
}

function boundNames(name: ts.BindingName): string[] {
  return ts.isIdentifier(name)
    ? [name.text]
    : name.elements.flatMap((element) =>
        ts.isOmittedExpression(element) ? [] : boundNames(element.name),
      );
}

// The node that declares `name` directly in `scope`: a parameter, variable, function, class or
// import binding. Scopes are functions, blocks, files, loops, case clauses and catch clauses.
function declarationIn(scope: ts.Node, name: string): ts.Node | undefined {
  if (ts.isFunctionLike(scope)) {
    const parameter = scope.parameters.find((entry) => boundNames(entry.name).includes(name));
    if (parameter) return parameter;
    return ts.isFunctionExpression(scope) && scope.name?.text === name ? scope : undefined;
  }
  if (ts.isCatchClause(scope))
    return scope.variableDeclaration && boundNames(scope.variableDeclaration.name).includes(name)
      ? scope.variableDeclaration
      : undefined;
  if (ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) {
    const list = scope.initializer;
    return list && ts.isVariableDeclarationList(list)
      ? list.declarations.find((entry) => boundNames(entry.name).includes(name))
      : undefined;
  }
  if (
    !ts.isSourceFile(scope) &&
    !ts.isBlock(scope) &&
    !ts.isModuleBlock(scope) &&
    !ts.isCaseClause(scope) &&
    !ts.isDefaultClause(scope)
  )
    return undefined;
  for (const statement of scope.statements) {
    if (ts.isVariableStatement(statement)) {
      const declaration = statement.declarationList.declarations.find((entry) =>
        boundNames(entry.name).includes(name),
      );
      if (declaration) return declaration;
    }
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name?.text === name
    )
      return statement;
    if (ts.isImportDeclaration(statement) && statement.importClause) {
      const { name: binding, namedBindings } = statement.importClause;
      if (binding?.text === name) return binding;
      if (namedBindings && ts.isNamespaceImport(namedBindings) && namedBindings.name.text === name)
        return namedBindings.name;
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        const element = namedBindings.elements.find((entry) => entry.name.text === name);
        if (element) return element.name;
      }
    }
  }
  return undefined;
}

// The innermost scope declaring an identifier's name, and the declaring node.
function declarationOf(identifier: ts.Identifier) {
  for (let scope: ts.Node | undefined = identifier.parent; scope; scope = scope.parent) {
    const node = declarationIn(scope, identifier.text);
    if (node) return { scope, node };
  }
  return undefined;
}

// True when an identifier reads a value: not a declaration name, property name or type.
function isValueReference(node: ts.Identifier) {
  const parent = node.parent;
  if (ts.isExportSpecifier(parent))
    return !parent.parent.parent.moduleSpecifier && (parent.propertyName ?? parent.name) === node;
  if (
    ts.isImportClause(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isQualifiedName(parent) ||
    ts.isLabeledStatement(parent) ||
    ts.isBreakOrContinueStatement(parent) ||
    (ts.isBindingElement(parent) && parent.propertyName === node) ||
    ((ts.isPropertyAccessExpression(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isEnumMember(parent) ||
      ts.isJsxAttribute(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isTypeParameterDeclaration(parent) ||
      ts.isEnumDeclaration(parent)) &&
      parent.name === node)
  )
    return false;
  for (let current: ts.Node = parent; !ts.isSourceFile(current); current = current.parent) {
    if (ts.isTypeNode(current)) return false;
    if (ts.isStatement(current)) break;
  }
  return true;
}

// Identifiers in `scope` that read the binding `name` declares there, skipping shadowed names.
function referencesIn(scope: ts.Node, name: string) {
  const found: ts.Identifier[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === name &&
      isValueReference(node) &&
      declarationOf(node)?.scope === scope
    )
      found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
}

// True when `text`, a document's beginning, ends inside a GraphQL string: inside an open `"""`
// block string, or after an odd number of unescaped quotes outside block strings.
function insideString(text: string) {
  const blocks = text.split('"""');
  if (blocks.length % 2 === 0) return true;
  const outside = blocks.filter((_, index) => index % 2 === 0).join('');
  return (outside.match(/(?<!\\)"/g) ?? []).length % 2 === 1;
}

// The GraphQL text of a numeric or boolean literal (`250`, `-1`, `true`), else undefined.
function scalarText(node: ts.Expression): string | undefined {
  const value = unwrap(node);
  if (ts.isNumericLiteral(value)) return value.text;
  if (
    ts.isPrefixUnaryExpression(value) &&
    value.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(value.operand)
  )
    return `-${value.operand.text}`;
  if (value.kind === ts.SyntaxKind.TrueKeyword) return 'true';
  if (value.kind === ts.SyntaxKind.FalseKeyword) return 'false';
  return undefined;
}

function privateMethod(fn: ts.Node): fn is ts.MethodDeclaration {
  return (
    ts.isMethodDeclaration(fn) &&
    (ts.isPrivateIdentifier(fn.name) || hasModifier(fn, ts.SyntaxKind.PrivateKeyword))
  );
}

// `#graphql\n${query}`: a template that only wraps one value, read as that value.
function wrappedValue(node: ts.Expression) {
  return ts.isTemplateExpression(node) &&
    node.templateSpans.length === 1 &&
    /^\s*(?:#graphql\b)?\s*$/.test(node.head.text) &&
    /^\s*$/.test(node.templateSpans[0].literal.text)
    ? node.templateSpans[0].expression
    : undefined;
}

// The return values of a function: its expression body, or every `return` outside nested functions.
function returnedValues(fn: FunctionNode): ts.Expression[] {
  if (fn.body && !ts.isBlock(fn.body)) return [fn.body];
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) found.push(node.expression);
    ts.forEachChild(node, visit);
  };
  if (fn.body) ts.forEachChild(fn.body, visit);
  return found;
}

// An expression's source text on one line, cut to 60 characters, for stop reasons.
function snippet(node: ts.Node) {
  const text = node.getText().replace(/\s+/g, ' ');
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
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

// `graphqlFiles` are the repository's .graphql and .gql files, read as documents of their own.
export function scanShopify(
  repository: Repository,
  graphqlFiles: { path: string; content: string }[] = [],
): ShopifyScan {
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
  // Per file: top-level `const NAME = <value>` and functions, import bindings, `export { a as b }`
  // names (re-exported from another module or not), `export *` modules and namespace imports.
  const constants = new Map<string, Map<string, ts.Expression>>();
  const functions = new Map<string, Map<string, FunctionNode>>();
  const imports = new Map<
    string,
    Map<string, { file: string; name: string; node: ts.Identifier }>
  >();
  const exportNames = new Map<string, Map<string, { file: string; name: string }>>();
  const starExports = new Map<string, string[]>();
  const namespaces = new Map<string, { file: string; node: ts.Identifier }[]>();
  for (const absolute of sources.keys()) {
    const file = sourceFile(absolute);
    const local = new Map<string, ts.Expression>();
    const named = new Map<string, FunctionNode>();
    const imported = new Map<string, { file: string; name: string; node: ts.Identifier }>();
    const exported = new Map<string, { file: string; name: string }>();
    const stars: string[] = [];
    const spaces: { file: string; node: ts.Identifier }[] = [];
    for (const statement of file.statements) {
      if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const)
        for (const declaration of statement.declarationList.declarations)
          if (ts.isIdentifier(declaration.name) && declaration.initializer) {
            local.set(declaration.name.text, declaration.initializer);
            const value = unwrap(declaration.initializer);
            if (ts.isArrowFunction(value) || ts.isFunctionExpression(value))
              named.set(declaration.name.text, value);
          }
      if (ts.isFunctionDeclaration(statement) && statement.body) {
        if (statement.name) named.set(statement.name.text, statement);
        if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) named.set('default', statement);
      }
      // `export default NAME` is read as the constant `default`.
      if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
        local.set('default', statement.expression);
        const value = unwrap(statement.expression);
        if (ts.isArrowFunction(value) || ts.isFunctionExpression(value))
          named.set('default', value);
      }
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.importClause
      ) {
        const target = resolution.resolve(statement.moduleSpecifier.text, absolute);
        const { name, namedBindings } = statement.importClause;
        if (target && name) imported.set(name.text, { file: target, name: 'default', node: name });
        if (target && namedBindings && ts.isNamedImports(namedBindings))
          for (const element of namedBindings.elements)
            imported.set(element.name.text, {
              file: target,
              name: (element.propertyName ?? element.name).text,
              node: element.name,
            });
        if (target && namedBindings && ts.isNamespaceImport(namedBindings))
          spaces.push({ file: target, node: namedBindings.name });
      }
      if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
        const specifier = statement.moduleSpecifier;
        const target =
          specifier && ts.isStringLiteral(specifier)
            ? resolution.resolve(specifier.text, absolute)
            : absolute;
        if (target && !statement.exportClause) stars.push(target);
        if (target && statement.exportClause && ts.isNamedExports(statement.exportClause))
          for (const element of statement.exportClause.elements)
            exported.set(element.name.text, {
              file: target,
              name: (element.propertyName ?? element.name).text,
            });
      }
    }
    constants.set(absolute, local);
    functions.set(absolute, named);
    imports.set(absolute, imported);
    exportNames.set(absolute, exported);
    starExports.set(absolute, stars);
    namespaces.set(absolute, spaces);
  }
  // The file and top-level name an export resolves to, through `export { a as b }`, re-exports,
  // imported bindings and `export *` (only when exactly one module provides the name).
  const exportTarget = (
    file: string,
    name: string,
    seen = new Set<string>(),
  ): { file: string; name: string } | undefined => {
    const key = `${file}#${name}`;
    if (seen.has(key) || !sources.has(file)) return undefined;
    seen.add(key);
    const local = (target: string) => {
      const imported = imports.get(file)?.get(target);
      return imported ? exportTarget(imported.file, imported.name, seen) : { file, name: target };
    };
    const named = exportNames.get(file)?.get(name);
    if (named)
      return named.file === file ? local(named.name) : exportTarget(named.file, named.name, seen);
    if (
      constants.get(file)?.has(name) ||
      functions.get(file)?.has(name) ||
      imports.get(file)?.has(name)
    )
      return local(name);
    if (name === 'default') return undefined;
    const found = (starExports.get(file) ?? [])
      .map((module) => exportTarget(module, name, new Set(seen)))
      .filter((target) => target !== undefined);
    // Modules that import the name and pass it on resolve to the same binding.
    const distinct = new Set(found.map((target) => `${target.file}#${target.name}`));
    return distinct.size === 1 ? found[0] : undefined;
  };
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
    const target = imported && exportTarget(imported.file, imported.name);
    return target ? constant(target.file, target.name, seen) : undefined;
  };
  type Variant = { text: string; segments: DocumentSegment[] };
  // Variants past this many stop: each one is a document Refit checks on both schemas.
  const MAX_VARIANTS = 64;
  // `prefix` followed by each of `pieces`, with the pieces' segments moved after the prefix.
  const joined = (prefixes: Variant[], pieces: Variant[]): Variant[] =>
    prefixes.flatMap((prefix) =>
      pieces.map((piece) => ({
        text: prefix.text + piece.text,
        segments: [
          ...prefix.segments,
          ...piece.segments.map((segment) => ({
            ...segment,
            documentStart: segment.documentStart + prefix.text.length,
            documentEnd: segment.documentEnd + prefix.text.length,
          })),
        ],
      })),
    );
  const piece = (value: string, node: ts.Node, sourceStart: number): Variant => ({
    text: value,
    segments: [
      {
        documentStart: 0,
        documentEnd: value.length,
        file: pathOf.get(node.getSourceFile().fileName)!,
        sourceStart,
        sourceText: node.getSourceFile().text,
      },
    ],
  });
  // What an expression can evaluate to, as the expressions that produce it (`null` for a nullish
  // value): each branch of a conditional, both sides of `||` and `??`, what a repository function
  // returns, a `const` or `let` binding's values, a `for (const x of LIST)` variable's elements, a
  // member of the objects a base can be (every member for a computed key), and a parameter's
  // argument at every call of its function. A superset is sound, since every document variant
  // built from it must validate; a value Refit cannot list returns the reason instead.
  type Leaf = { node: ts.Expression | null; file: string };
  const MAX_LEAVES = 256;
  const values = (
    node: ts.Expression,
    file: string,
    depth: number,
    followed: Set<string>,
  ): Leaf[] | string => {
    const cannot = `The document interpolates \`\${${snippet(node)}}\`, a value Refit cannot resolve to a constant fragment.`;
    if (depth > 12) return cannot;
    let value = unwrap(node);
    if (ts.isAwaitExpression(value)) value = unwrap(value.expression);
    if (
      value.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(value) && value.text === 'undefined')
    )
      return [{ node: null, file }];
    const union = (parts: Leaf[], inner = followed, dropNullish = 0): Leaf[] | string => {
      const found: Leaf[] = [];
      for (const [index, part] of parts.entries()) {
        if (!part.node) {
          if (index >= dropNullish) found.push(part);
          continue;
        }
        const leaves = values(part.node, part.file, depth + 1, inner);
        if (typeof leaves === 'string') return leaves;
        found.push(...(index < dropNullish ? leaves.filter((leaf) => leaf.node) : leaves));
        if (found.length > MAX_LEAVES) return tooMany;
      }
      return found;
    };
    if (ts.isConditionalExpression(value))
      return union([
        { node: value.whenTrue, file },
        { node: value.whenFalse, file },
      ]);
    // `a || b` and `a ?? b` give `b` where `a` is nullish, so `a`'s nullish values are dropped.
    if (
      ts.isBinaryExpression(value) &&
      (value.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    )
      return union(
        [
          { node: value.left, file },
          { node: value.right, file },
        ],
        followed,
        1,
      );
    if (ts.isCallExpression(value)) {
      // `LIST.find(…)`: an element of the list, or undefined.
      const callee = value.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'find') {
        const lists = values(callee.expression, file, depth + 1, followed);
        if (typeof lists === 'string') return lists;
        const found: Leaf[] = [{ node: null, file }];
        for (const list of lists) {
          const array = list.node && unwrap(list.node);
          if (
            !array ||
            !ts.isArrayLiteralExpression(array) ||
            array.elements.some(ts.isSpreadElement)
          )
            return cannot;
          const elements = union(
            array.elements.map((element) => ({ node: element, file: list.file })),
          );
          if (typeof elements === 'string') return elements;
          found.push(...elements);
        }
        return found;
      }
      const fn = calledFunction(callee);
      const key = fn && `${fn.getSourceFile().fileName}:${fn.pos}:return`;
      if (!fn || !key || followed.has(key)) return [{ node: value, file }];
      const returned = returnedValues(fn);
      if (!returned.length) return [{ node: value, file }];
      return union(
        returned.map((entry) => ({ node: entry, file: fn.getSourceFile().fileName })),
        new Set([...followed, key]),
      );
    }
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      if (ts.isPropertyAccessExpression(value) && !ts.isIdentifier(value.name)) return cannot;
      const name = memberName(value);
      const bases = values(value.expression, file, depth + 1, followed);
      if (typeof bases === 'string') return bases;
      const found: Leaf[] = [];
      for (const base of bases) {
        // Reading a member of a nullish value throws, so no document is sent.
        if (!base.node) continue;
        const container = unwrap(base.node);
        if (name !== undefined) {
          const member = memberOf(container, name);
          if (!member) return cannot;
          found.push({ node: member, file: base.file });
        } else if (
          ts.isObjectLiteralExpression(container) &&
          container.properties.every(
            (entry) =>
              (ts.isPropertyAssignment(entry) || ts.isShorthandPropertyAssignment(entry)) &&
              !ts.isComputedPropertyName(entry.name),
          )
        )
          for (const entry of container.properties as ts.NodeArray<
            ts.PropertyAssignment | ts.ShorthandPropertyAssignment
          >)
            found.push({
              node: ts.isPropertyAssignment(entry) ? entry.initializer : entry.name,
              file: base.file,
            });
        else if (
          ts.isArrayLiteralExpression(container) &&
          !container.elements.some(ts.isSpreadElement)
        )
          found.push(...container.elements.map((element) => ({ node: element, file: base.file })));
        else return cannot;
      }
      return union(found);
    }
    if (!ts.isIdentifier(value)) return [{ node: value, file }];
    const resolved = scoped(value, file) ?? constant(file, value.text);
    if (resolved) return union([{ node: resolved.node, file: resolved.file }]);
    const loop = forOfElements(value, file);
    if (loop)
      return loop.elements
        ? union(loop.elements.map((element) => ({ node: element, file: loop.file })))
        : cannot;
    const declaration = declarationOf(value)?.node;
    if (declaration && ts.isParameter(declaration)) {
      if (declaration.dotDotDotToken) return cannot;
      const fn = declaration.parent;
      const index = fn.parameters.indexOf(declaration);
      const key = `${fn.getSourceFile().fileName}:${fn.pos}:${index}`;
      // A function passing its own parameter on can build values without end.
      if (followed.has(key)) return cannot;
      const flows = functionFlows(fn);
      if (flows.escapes.length || !flows.calls.length)
        return `The document interpolates \`\${${snippet(node)}}\`, from the parameter \`${value.text}\`, and Refit cannot list every call of its function.`;
      const parts: Leaf[] = [];
      for (const call of flows.calls) {
        if (call.arguments.slice(0, index + 1).some(ts.isSpreadElement)) return cannot;
        const argument = call.arguments[index];
        parts.push(
          argument
            ? { node: argument, file: call.getSourceFile().fileName }
            : { node: declaration.initializer ?? null, file },
        );
      }
      const inner = new Set([...followed, key]);
      if (ts.isIdentifier(declaration.name)) return union(parts, inner);
      // `({ reverse }) => …`: the property each call's object passes, else the default.
      const element = ts.isObjectBindingPattern(declaration.name)
        ? declaration.name.elements.find(
            (entry) => ts.isIdentifier(entry.name) && entry.name.text === value.text,
          )
        : undefined;
      const property = element && !element.dotDotDotToken && (element.propertyName ?? element.name);
      if (!element || !property || !(ts.isIdentifier(property) || ts.isStringLiteral(property)))
        return cannot;
      const objects = union(parts, inner);
      if (typeof objects === 'string') return objects;
      const found: Leaf[] = [];
      for (const object of objects) {
        const container = object.node && unwrap(object.node);
        if (!container || !ts.isObjectLiteralExpression(container)) return cannot;
        const member = memberOf(container, property.text);
        if (member) found.push({ node: member, file: object.file });
        else if (container.properties.some(ts.isSpreadAssignment)) return cannot;
        else found.push({ node: element.initializer ?? null, file });
      }
      return union(found, inner);
    }
    const assigned = assignedValues(value);
    if (assigned?.length) return union(assigned.map((entry) => ({ node: entry, file })));
    return cannot;
  };
  // `a === b`, `!a`, `a < b`: always a boolean.
  const BOOLEAN_OPERATORS = new Set([
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
    ts.SyntaxKind.LessThanToken,
    ts.SyntaxKind.GreaterThanToken,
    ts.SyntaxKind.LessThanEqualsToken,
    ts.SyntaxKind.GreaterThanEqualsToken,
  ]);
  const boolean = (node: ts.Expression) =>
    (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) ||
    (ts.isBinaryExpression(node) && BOOLEAN_OPERATORS.has(node.operatorToken.kind));
  // `Math.min(…)`, `Number(…)`, `parseInt(…)`, `list.length`, `a * b`: always a number.
  const NUMBER_CALL =
    /^(?:Math\.(?:min|max|floor|ceil|round|trunc|abs)|Number|parseInt|parseFloat)$/;
  const numeric = (node: ts.Expression) =>
    (ts.isCallExpression(node) && NUMBER_CALL.test(node.expression.getText())) ||
    (ts.isPropertyAccessExpression(node) && node.name.text === 'length') ||
    (ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.MinusToken,
        ts.SyntaxKind.AsteriskToken,
        ts.SyntaxKind.SlashToken,
        ts.SyntaxKind.PercentToken,
      ].includes(node.operatorToken.kind));
  const letOverrides = new Map<ts.Node, Variant[]>();
  // Every string a substitution outside a GraphQL string can produce, as document pieces.
  const stringValues = (
    node: ts.Expression,
    file: string,
    depth: number,
    followed: Set<string>,
  ): Variant[] | string => {
    // `let text = …; if (…) text += …` and `text = \`…${text}\``: every value the binding starts
    // from, with or without each such change in source order. A change in a loop or another
    // function can repeat, so it stops.
    const bare = unwrap(node);
    const binding = ts.isIdentifier(bare) ? declarationOf(bare) : undefined;
    const override = binding && letOverrides.get(binding.node);
    if (override) return override;
    const appends: ts.Expression[] = [];
    const assigned =
      binding && ts.isIdentifier(bare) && !(scoped(bare, file) ?? constant(file, bare.text))
        ? assignedValues(bare, appends)
        : undefined;
    const reads = (entry: ts.Expression) =>
      referencesIn(binding!.scope, (bare as ts.Identifier).text).some(
        (reference) => reference.pos >= entry.pos && reference.end <= entry.end,
      );
    const changes = assigned
      ? [
          ...appends.map((entry) => ({ entry, append: true })),
          ...assigned.filter(reads).map((entry) => ({ entry, append: false })),
        ].sort((a, b) => a.entry.pos - b.entry.pos)
      : [];
    if (binding && assigned?.length && changes.length) {
      const repeats = changes.some(
        ({ entry }) =>
          ts.findAncestor(
            entry,
            (ancestor) =>
              ancestor === binding.scope ||
              ts.isIterationStatement(ancestor, false) ||
              ts.isFunctionLike(ancestor),
          ) !== binding.scope,
      );
      if (repeats)
        return `The document interpolates \`\${${snippet(node)}}\`, which a loop or another function changes.`;
      let found: Variant[] = [];
      for (const entry of assigned.filter((item) => !reads(item))) {
        const start = stringValues(entry, file, depth + 1, followed);
        if (typeof start === 'string') return start;
        found.push(...start);
      }
      for (const { entry, append } of changes) {
        letOverrides.set(binding.node, found);
        const changed = stringValues(entry, file, depth + 1, followed);
        letOverrides.delete(binding.node);
        if (typeof changed === 'string') return changed;
        const result = append ? joined(found, changed) : changed;
        // A change written directly in the binding's block before this use always runs.
        const statement = entry.parent.parent;
        const always =
          ts.isExpressionStatement(statement) &&
          statement.parent === binding.scope &&
          statement.end <= node.pos &&
          ts.findAncestor(
            node,
            (ancestor) => ancestor === binding.scope || ts.isFunctionLike(ancestor),
          ) === binding.scope;
        found = always ? result : [...found, ...result];
        if (found.length > MAX_VARIANTS) return tooMany;
      }
      return found;
    }
    const leaves = values(node, file, depth, followed);
    if (typeof leaves === 'string') return leaves;
    const found: Variant[] = [];
    for (const leaf of leaves) {
      if (!leaf.node)
        return `The document interpolates \`\${${snippet(node)}}\`, which can be undefined or null.`;
      const value = unwrap(leaf.node);
      const atom = scalarText(value);
      // A number written where GraphQL takes one: any number validates where `1` does.
      if (atom !== undefined || numeric(value)) found.push({ text: atom ?? '1', segments: [] });
      // Either boolean validates where the other does.
      else if (boolean(value)) found.push({ text: 'true', segments: [] });
      else if (isLiteral(value)) {
        const inner = assemble(value, leaf.file, depth + 1, followed);
        if (typeof inner === 'string') return inner;
        found.push(...inner);
      } else if (
        ts.isBinaryExpression(value) &&
        value.operatorToken.kind === ts.SyntaxKind.PlusToken
      ) {
        const left = stringValues(value.left, leaf.file, depth + 1, followed);
        if (typeof left === 'string') return left;
        const right = stringValues(value.right, leaf.file, depth + 1, followed);
        if (typeof right === 'string') return right;
        if (left.length * right.length > MAX_VARIANTS) return tooMany;
        found.push(...joined(left, right));
      } else
        return `The document interpolates \`\${${snippet(node)}}\`, a value Refit cannot resolve to a constant fragment.`;
      if (found.length > MAX_VARIANTS) return tooMany;
    }
    return found;
  };
  // `[${LIST.map((item) => `{ … }`).join(', ')}]`: GraphQL validates each list element on its own
  // and accepts an empty list, so checking every element the callback returns, one per variant,
  // covers every list the code can build. The callback's own values must still resolve.
  const listElements = (node: ts.Expression, before: string, after: string) => {
    const call = unwrap(node);
    if (
      !/\[\s*$/.test(before) ||
      !/^\s*\]/.test(after) ||
      !ts.isCallExpression(call) ||
      !ts.isPropertyAccessExpression(call.expression) ||
      call.expression.name.text !== 'join' ||
      !call.arguments[0] ||
      !ts.isStringLiteralLike(call.arguments[0]) ||
      !/^[\s,]*$/.test(call.arguments[0].text)
    )
      return undefined;
    const mapped = unwrap(call.expression.expression);
    const callback =
      ts.isCallExpression(mapped) && mapped.arguments[0] && unwrap(mapped.arguments[0]);
    if (
      !callback ||
      !ts.isPropertyAccessExpression(mapped.expression) ||
      mapped.expression.name.text !== 'map' ||
      !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
    )
      return undefined;
    const returned = returnedValues(callback);
    return returned.length === 1
      ? { node: returned[0], file: callback.getSourceFile().fileName }
      : undefined;
  };
  const tooMany = `The document can be built in more than ${MAX_VARIANTS} ways; Refit checks at most ${MAX_VARIANTS}.`;
  // Assembles a literal into its document variants: `${FRAGMENT}` constants are inlined, and a
  // substitution that can take several values gives one variant per value (stringValues).
  const assemble = (
    literal: Literal,
    file: string,
    depth = 0,
    followed = new Set<string>(),
  ): Variant[] | string => {
    if (!ts.isTemplateExpression(literal))
      return [piece(literal.text, literal, literal.getStart() + 1)];
    let variants = [piece(literal.head.text, literal.head, literal.head.getStart() + 1)];
    for (const span of literal.templateSpans) {
      const tail = piece(span.literal.text, span.literal, span.literal.getStart() + 1);
      const expression = unwrap(span.expression);
      const resolved = ts.isIdentifier(expression)
        ? (scoped(expression, file) ?? constant(file, expression.text))
        : undefined;
      // A runtime value inside a GraphQL string (`product(id: "gid://shopify/Product/${id}")`)
      // cannot change which fields the document selects, so a placeholder stands in for it; only
      // a constant string is written as it is.
      const literalValue =
        resolved && isLiteral(resolved.node) && !ts.isTemplateExpression(resolved.node);
      const next: Variant[] = [];
      for (const variant of variants) {
        const element = listElements(span.expression, variant.text, span.literal.text);
        if (!literalValue && insideString(variant.text))
          next.push(...joined([variant], [{ text: 'x', segments: [] }]));
        else if (element) {
          const items = stringValues(element.node, element.file, depth, followed);
          if (typeof items === 'string') return items;
          next.push(...joined([variant], items));
        } else {
          const values = stringValues(span.expression, file, depth, followed);
          if (typeof values === 'string') return values;
          next.push(...joined([variant], values));
        }
        if (next.length > MAX_VARIANTS) return tooMany;
      }
      // Variants with the same text are one document.
      const texts = new Set<string>();
      variants = joined(next, [tail]).filter(
        (variant) => !texts.has(variant.text) && Boolean(texts.add(variant.text)),
      );
    }
    return variants;
  };
  const unreadable = (node: ts.Node, reason: string) => {
    const where = location(node);
    // Documents in tests are fixtures for mocked clients, readable or not.
    if (TEST_FILE.test(where.file)) return;
    if (
      !scan.unreadable.some(
        (entry) =>
          entry.file === where.file &&
          entry.line === where.line &&
          entry.column === where.column &&
          entry.reason === reason &&
          entry.api === api,
      )
    )
      scan.unreadable.push({ ...where, reason, ...(api ? { api } : {}) });
  };
  const documentLiterals = new Map<Literal, boolean>();
  const storefrontLiterals = new Set<Literal>();
  // The API of the client call whose document is being read.
  let api: 'storefront' | undefined;
  const record = (literal: Literal, file: string, reached: boolean, call?: ts.Node) => {
    // Documents in tests go to mocked clients; they are fixtures, not Admin API usage.
    const traced = reached && !TEST_FILE.test(pathOf.get(file) ?? '');
    // A literal a Storefront call read first is read again for an Admin call, which it then is.
    const admin = Boolean(call) && reached && !api;
    if (documentLiterals.get(literal) && (!admin || !storefrontLiterals.has(literal))) return;
    documentLiterals.set(literal, traced);
    if (call && reached && api) storefrontLiterals.add(literal);
    else if (admin) storefrontLiterals.delete(literal);
    const assembled = assemble(literal, file);
    if (typeof assembled === 'string') {
      unreadable(call ?? literal, assembled);
      return;
    }
    const where = location(literal);
    const head = assembled[0].segments[0].sourceStart;
    for (let index = scan.documents.length - 1; index >= 0; index--)
      if (
        scan.documents[index].segments[0].sourceStart === head &&
        scan.documents[index].file === where.file
      )
        scan.documents.splice(index, 1);
    for (const variant of assembled)
      scan.documents.push({
        ...where,
        ...variant,
        traced,
        ...(reached && api ? { api } : {}),
      });
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
            const exported =
              element && target
                ? exportTarget(target, (element.propertyName ?? element.name).getText())
                : undefined;
            if (exported) return constant(exported.file, exported.name);
          }
        }
      }
    }
    return undefined;
  };
  // Modules loaded with `import()` or `require()`, built on first use: their exports may be called
  // in ways Refit does not follow.
  let loads: { file: string; node: ts.CallExpression }[] | undefined;
  const moduleLoads = () => {
    if (!loads) {
      const found: { file: string; node: ts.CallExpression }[] = [];
      for (const absolute of sources.keys()) {
        const visit = (node: ts.Node) => {
          if (
            ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
            node.arguments[0] &&
            ts.isStringLiteral(node.arguments[0])
          ) {
            const target = resolution.resolve(node.arguments[0].text, absolute);
            if (target) found.push({ file: target, node });
          }
          ts.forEachChild(node, visit);
        };
        visit(sourceFile(absolute));
      }
      loads = found;
    }
    return loads;
  };
  // The repository function a callee names: a function declaration, a `const` arrow or function
  // expression (directly or through `const` aliases and imports), or a namespace import's export.
  const calledFunction = (callee: ts.Expression): FunctionNode | undefined => {
    const value = unwrap(callee);
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return value;
    if (ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression)) {
      const binding = declarationOf(value.expression)?.node;
      const space =
        binding && ts.isNamespaceImport(binding.parent)
          ? namespaces
              .get(binding.getSourceFile().fileName)
              ?.find((entry) => entry.node === binding)
          : undefined;
      const target = space && exportTarget(space.file, value.name.text);
      return target && functions.get(target.file)?.get(target.name);
    }
    if (!ts.isIdentifier(value)) return undefined;
    let binding = declarationOf(value)?.node;
    for (let depth = 0; binding && depth < 8; depth++) {
      if (ts.isFunctionDeclaration(binding)) return binding.body ? binding : undefined;
      if (
        ts.isVariableDeclaration(binding) &&
        ts.isIdentifier(binding.name) &&
        binding.parent.flags & ts.NodeFlags.Const &&
        binding.initializer
      ) {
        const initializer = unwrap(binding.initializer);
        if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
          return initializer;
        binding = ts.isIdentifier(initializer) ? declarationOf(initializer)?.node : undefined;
        continue;
      }
      // `const { graphqlQuery } = createHandler(admin)`: the member every return of the
      // repository function names, when all name the same function.
      if (
        ts.isVariableDeclaration(binding) &&
        ts.isObjectBindingPattern(binding.name) &&
        binding.parent.flags & ts.NodeFlags.Const &&
        binding.initializer
      ) {
        const element = binding.name.elements.find(
          (entry) => ts.isIdentifier(entry.name) && entry.name.text === value.text,
        );
        const name = element && !element.dotDotDotToken && (element.propertyName ?? element.name);
        let source = unwrap(binding.initializer);
        if (ts.isAwaitExpression(source)) source = unwrap(source.expression);
        const factory =
          ts.isCallExpression(source) && source.expression !== callee
            ? calledFunction(source.expression)
            : undefined;
        if (!factory || !name || !(ts.isIdentifier(name) || ts.isStringLiteral(name)))
          return undefined;
        const key = name.text;
        const found = new Set(
          returnedValues(factory).map((entry) => {
            const member = memberOf(entry, key);
            return member && calledFunction(member);
          }),
        );
        return found.size === 1 ? [...found][0] : undefined;
      }
      if (
        ts.isIdentifier(binding) &&
        (ts.isImportClause(binding.parent) || ts.isImportSpecifier(binding.parent))
      ) {
        const imported = imports.get(binding.getSourceFile().fileName)?.get(binding.text);
        const target = imported && exportTarget(imported.file, imported.name);
        return target && functions.get(target.file)?.get(target.name);
      }
      return undefined;
    }
    return undefined;
  };
  // Where a function value goes: every call that invokes it, and every use Refit cannot follow
  // (stored in an object, passed to code outside the repository, reassigned, loaded dynamically).
  // A use Refit cannot follow means some callers are unknown, so it stops for review.
  // `open` marks a function code outside the repository may call: exported, or a public method.
  type Flows = {
    calls: ts.CallExpression[];
    escapes: { node: ts.Node; reason: string }[];
    open: boolean;
  };
  const flowCache = new Map<ts.Node, Flows>();
  const ESCAPE =
    'A function that sends Admin GraphQL documents is used here in a way Refit cannot follow, so the documents it receives are not read.';
  const functionFlows = (fn: ts.SignatureDeclaration): Flows => {
    const cached = flowCache.get(fn);
    if (cached) return cached;
    const flows: Flows = { calls: [], escapes: [], open: false };
    flowCache.set(fn, {
      open: false,
      calls: [],
      escapes: [
        {
          node: fn,
          reason: 'A function that sends Admin GraphQL documents is returned through itself.',
        },
      ],
    });
    const visited = new Set<ts.Node>();
    const exportsSeen = new Set<string>();
    const escape = (node: ts.Node, reason = ESCAPE) => {
      flows.escapes.push({ node, reason });
    };
    const uses = (expression: ts.Node): void => {
      let node = expression;
      while (
        ts.isParenthesizedExpression(node.parent) ||
        ts.isAsExpression(node.parent) ||
        ts.isSatisfiesExpression(node.parent) ||
        ts.isNonNullExpression(node.parent) ||
        ts.isTypeAssertionExpression(node.parent) ||
        ts.isAwaitExpression(node.parent)
      )
        node = node.parent;
      const parent = node.parent;
      if (ts.isCallExpression(parent) && parent.expression === node) {
        flows.calls.push(parent);
        return;
      }
      if (ts.isCallExpression(parent) && parent.arguments.some((entry) => entry === node))
        return passed(parent, parent.arguments.indexOf(node as ts.Expression));
      if (
        ts.isVariableDeclaration(parent) &&
        parent.initializer === node &&
        ts.isIdentifier(parent.name) &&
        parent.parent.flags & ts.NodeFlags.Const
      )
        return bound(parent.name);
      // Returned from a factory (`return (query) => admin.graphql(query)`): its callers get it.
      if (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === node)) {
        const factory = ts.isArrowFunction(parent)
          ? parent
          : ts.findAncestor(parent, (entry) => ts.isFunctionLike(entry));
        if (
          factory &&
          (ts.isFunctionDeclaration(factory) ||
            ts.isArrowFunction(factory) ||
            ts.isFunctionExpression(factory))
        ) {
          const outer = functionFlows(factory);
          // An exported factory nothing in the repository calls: its callers are unknown.
          if (!outer.calls.length && !outer.escapes.length && outer.open)
            return escape(
              node,
              'A function that sends Admin GraphQL documents is returned from an exported function nothing in the repository calls, so Refit cannot follow the documents it receives.',
            );
          for (const call of outer.calls) uses(call);
          flows.escapes.push(...outer.escapes);
          flows.open ||= outer.open;
          return;
        }
      }
      if (ts.isExportAssignment(parent)) return exported(node.getSourceFile().fileName, 'default');
      if (ts.isExportSpecifier(parent))
        return exported(node.getSourceFile().fileName, parent.name.text);
      const STORED =
        'A function that sends Admin GraphQL documents is stored in an object here; Refit does not follow calls through object properties, so the documents it receives are not read.';
      if (
        (ts.isPropertyAssignment(parent) && parent.initializer === node) ||
        ts.isShorthandPropertyAssignment(parent)
      )
        return stored(parent, STORED);
      escape(node, ESCAPE);
    };
    // A member of an object literal (`const admin = { graphql: (query) => … }`, a factory's
    // `return { graphql: { request } }`) is followed through every access of its key path:
    // `admin.graphql(…)`, `const { graphql } = admin`, `createClient().graphql.request(…)`. Any
    // other use of the object stops.
    const stored = (
      property: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
      reason: string,
    ) => {
      const path: string[] = [];
      let member: ts.Node = property;
      let object = outermost(property.parent);
      for (;;) {
        const key = (member as ts.PropertyAssignment | ts.ShorthandPropertyAssignment).name;
        if (ts.isComputedPropertyName(key) || ts.isPrivateIdentifier(key))
          return escape(property, reason);
        path.unshift(key.text);
        const holder = object.parent;
        if (!ts.isPropertyAssignment(holder) || holder.initializer !== object) break;
        member = holder;
        object = outermost(holder.parent);
      }
      const holder = object.parent;
      if (
        ts.isVariableDeclaration(holder) &&
        holder.initializer === object &&
        ts.isIdentifier(holder.name) &&
        holder.parent.flags & ts.NodeFlags.Const &&
        !hasModifier(holder.parent.parent, ts.SyntaxKind.ExportKeyword)
      )
        return holderUses(holder.name, path, property, reason);
      // Returned from a factory: followed from every call of it.
      const factory = ts.isReturnStatement(holder)
        ? ts.findAncestor(holder, (entry) => ts.isFunctionLike(entry))
        : ts.isArrowFunction(holder) && holder.body === object
          ? holder
          : undefined;
      if (
        !factory ||
        !(
          ts.isFunctionDeclaration(factory) ||
          ts.isArrowFunction(factory) ||
          ts.isFunctionExpression(factory)
        )
      )
        return escape(property, reason);
      const outer = functionFlows(factory);
      if (outer.escapes.length || (!outer.calls.length && outer.open))
        return escape(property, reason);
      for (const call of outer.calls) valueUses(call, path, property, reason);
    };
    // Where a value holding the object goes: a key path access, a `const` binding of it or of
    // one of its members.
    const valueUses = (
      expression: ts.Node,
      path: string[],
      property: ts.Node,
      reason: string,
    ): void => {
      let node = expression;
      while (
        ts.isParenthesizedExpression(node.parent) ||
        ts.isAsExpression(node.parent) ||
        ts.isNonNullExpression(node.parent) ||
        ts.isSatisfiesExpression(node.parent) ||
        ts.isAwaitExpression(node.parent)
      )
        node = node.parent;
      const parent = node.parent;
      // `{ ...defaults, ...overrides }`: the copy holds the member unless a later one replaces it.
      if (ts.isSpreadAssignment(parent) && ts.isObjectLiteralExpression(parent.parent))
        return valueUses(parent.parent, path, property, reason);
      // Passed to a repository function: followed through its parameter.
      if (ts.isCallExpression(parent) && parent.arguments.some((entry) => entry === node)) {
        const index = parent.arguments.indexOf(node as ts.Expression);
        const parameter = calledFunction(parent.expression)?.parameters[index];
        if (
          !parameter ||
          parameter.dotDotDotToken ||
          !ts.isIdentifier(parameter.name) ||
          parent.arguments.slice(0, index).some(ts.isSpreadElement)
        )
          return escape(node, reason);
        return holderUses(parameter.name, path, property, reason);
      }
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        if (parent.name.text !== path[0]) return;
        return path.length === 1
          ? uses(parent)
          : valueUses(parent, path.slice(1), property, reason);
      }
      if (
        ts.isVariableDeclaration(parent) &&
        parent.initializer === node &&
        parent.parent.flags & ts.NodeFlags.Const &&
        !hasModifier(parent.parent.parent, ts.SyntaxKind.ExportKeyword)
      ) {
        if (ts.isIdentifier(parent.name)) return holderUses(parent.name, path, property, reason);
        if (ts.isObjectBindingPattern(parent.name)) {
          for (const element of parent.name.elements) {
            const name = element.propertyName ?? element.name;
            if (element.dotDotDotToken || !(ts.isIdentifier(name) || ts.isStringLiteral(name)))
              return escape(element, reason);
            if (name.text !== path[0]) continue;
            if (path.length === 1 && ts.isIdentifier(element.name)) bound(element.name);
            else if (ts.isIdentifier(element.name))
              holderUses(element.name, path.slice(1), property, reason);
            else return escape(element, reason);
          }
          return;
        }
      }
      escape(node, reason);
    };
    // Holders already followed for a key path: a function passing its parameter on to itself.
    const held = new Set<string>();
    const holderUses = (name: ts.Identifier, path: string[], property: ts.Node, reason: string) => {
      const key = `${name.getSourceFile().fileName}:${name.pos}:${path.join('.')}`;
      if (held.has(key)) return;
      held.add(key);
      const binding = declarationOf(name);
      if (!binding) return escape(property, reason);
      for (const reference of referencesIn(binding.scope, name.text))
        valueUses(reference, path, property, reason);
    };
    // The names `const { a, b } = await import('./module')` takes from a loaded module, with the
    // binding each one gets; `({ a } = await import('./module'))` names them with no binding
    // Refit follows. A `const mod = await import('./module')` is a namespace, read through
    // `mod.a`. Undefined for any other use of the loaded module.
    const loadedNames = (load: ts.CallExpression) => {
      let node: ts.Node = load;
      while (ts.isAwaitExpression(node.parent) || ts.isParenthesizedExpression(node.parent))
        node = node.parent;
      const parent = node.parent;
      if (
        ts.isVariableDeclaration(parent) &&
        parent.initializer === node &&
        ts.isIdentifier(parent.name) &&
        parent.parent.flags & ts.NodeFlags.Const
      )
        return { namespace: parent.name };
      if (
        ts.isBinaryExpression(parent) &&
        parent.right === node &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const left = unwrap(parent.left);
        if (!ts.isObjectLiteralExpression(left)) return undefined;
        const names: [string, undefined][] = [];
        for (const member of left.properties) {
          if (!ts.isShorthandPropertyAssignment(member) && !ts.isPropertyAssignment(member))
            return undefined;
          if (!ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name)) return undefined;
          names.push([member.name.text, undefined]);
        }
        return { names };
      }
      const pattern =
        ts.isVariableDeclaration(parent) && parent.initializer === node ? parent.name : undefined;
      if (!pattern || !ts.isObjectBindingPattern(pattern)) return undefined;
      const names: [string, ts.Identifier | undefined][] = [];
      for (const element of pattern.elements) {
        const name = element.propertyName ?? element.name;
        if (element.dotDotDotToken || !(ts.isIdentifier(name) || ts.isStringLiteral(name)))
          return undefined;
        names.push([name.text, ts.isIdentifier(element.name) ? element.name : undefined]);
      }
      return { names };
    };
    // Passed as an argument: followed into the called function's parameter.
    const passed = (call: ts.CallExpression, index: number) => {
      const target = calledFunction(call.expression);
      const parameter = target?.parameters[index];
      if (
        !parameter ||
        parameter.dotDotDotToken ||
        !ts.isIdentifier(parameter.name) ||
        call.arguments.slice(0, index).some(ts.isSpreadElement)
      )
        return escape(
          call.arguments[index],
          `A function that sends Admin GraphQL documents is passed to ${call.expression.getText().slice(0, 80)}, which Refit cannot follow, so the documents it receives are not read.`,
        );
      bound(parameter.name);
    };
    const bound = (name: ts.Identifier) => {
      if (visited.has(name)) return;
      visited.add(name);
      const binding = declarationOf(name);
      if (!binding) return escape(name);
      for (const reference of referencesIn(binding.scope, name.text)) uses(reference);
      const statement = ts.isVariableDeclaration(name.parent)
        ? name.parent.parent.parent
        : name.parent;
      if (hasModifier(statement, ts.SyntaxKind.ExportKeyword))
        exported(
          name.getSourceFile().fileName,
          hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? 'default' : name.text,
        );
    };
    // Exported: followed into every module that imports it, by name, namespace or re-export.
    const exported = (file: string, name: string) => {
      flows.open = true;
      const target = exportTarget(file, name);
      if (!target) return;
      const key = `${target.file}#${target.name}`;
      if (exportsSeen.has(key)) return;
      exportsSeen.add(key);
      const same = (module: string, exportName: string) => {
        const resolved = exportTarget(module, exportName);
        return resolved?.file === target.file && resolved.name === target.name;
      };
      for (const bindings of imports.values())
        for (const binding of bindings.values())
          if (same(binding.file, binding.name)) bound(binding.node);
      for (const [importer, spaces] of namespaces)
        for (const space of spaces) {
          if (!same(space.file, name) && !same(space.file, target.name)) continue;
          for (const reference of referencesIn(sourceFile(importer), space.node.text)) {
            const access = reference.parent;
            if (ts.isPropertyAccessExpression(access) && access.expression === reference) {
              if (same(space.file, access.name.text)) uses(access);
            } else escape(reference);
          }
        }
      for (const load of moduleLoads()) {
        if (!same(load.file, name) && !same(load.file, target.name)) continue;
        const LOADED =
          'A module defining a function that sends Admin GraphQL documents is loaded dynamically here, so Refit cannot follow its callers.';
        const loaded = loadedNames(load.node);
        if (!loaded) escape(load.node, LOADED);
        else if (loaded.namespace) {
          const space = loaded.namespace;
          for (const reference of referencesIn(declarationOf(space)!.scope, space.text)) {
            const access = outermost(reference).parent;
            if (
              ts.isPropertyAccessExpression(access) &&
              access.expression === outermost(reference)
            ) {
              if (same(load.file, access.name.text)) uses(access);
            } else escape(reference, LOADED);
          }
        } else
          for (const [exportName, binding] of loaded.names!)
            if (same(load.file, exportName))
              if (binding) bound(binding);
              else escape(load.node, LOADED);
      }
    };
    if (ts.isFunctionDeclaration(fn) && fn.name) bound(fn.name);
    else if (ts.isFunctionDeclaration(fn) && hasModifier(fn, ts.SyntaxKind.DefaultKeyword))
      exported(fn.getSourceFile().fileName, 'default');
    else if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) uses(fn);
    else if (privateMethod(fn)) {
      // A private method is reached only inside its class: `this.name` or, when static,
      // `Class.name`. Any other access there (`self.name`, `this['name']`) stops.
      const owner = fn.parent as ts.ClassLikeDeclaration;
      const name = fn.name.getText();
      const visit = (node: ts.Node) => {
        if (ts.isPropertyAccessExpression(node) && node.name.getText() === name) {
          if (
            node.expression.kind === ts.SyntaxKind.ThisKeyword ||
            (owner.name !== undefined && node.expression.getText() === owner.name.text)
          )
            uses(node);
          else escape(node);
        }
        if (
          ts.isElementAccessExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ThisKeyword &&
          !(
            ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text !== name
          )
        )
          escape(node);
        // `const { send } = this`, `self = this`, `helper(this)`: the method leaves the class.
        if (
          node.kind === ts.SyntaxKind.ThisKeyword &&
          !(
            (ts.isPropertyAccessExpression(node.parent) ||
              ts.isElementAccessExpression(node.parent)) &&
            node.parent.expression === node
          )
        )
          escape(node);
        ts.forEachChild(node, visit);
      };
      visit(owner);
      // TypeScript lets code outside the class read a `private` member as `instance['name']`.
      if (!ts.isPrivateIdentifier(fn.name) && members().elements.has(name)) escape(fn);
    } else flows.open = true;
    // Other methods, constructors and accessors: their callers need the receiver's type, so none
    // are followed and the call that sends the document stops for review.
    // Calls in tests are still checked (their documents count as fixtures), but tests that pass a
    // helper to mocks and spies do not stop the run: those reach mocked clients.
    const result = {
      open: flows.open,
      calls: [...new Set(flows.calls)],
      escapes: flows.escapes.filter((entry) => !TEST_FILE.test(location(entry.node).file)),
    };
    flowCache.set(fn, result);
    return result;
  };
  // The property a member access reads, when it is static: `.query`, `['query']` or `[0]`.
  const memberName = (node: ts.PropertyAccessExpression | ts.ElementAccessExpression) =>
    ts.isPropertyAccessExpression(node)
      ? node.name.text
      : ts.isStringLiteral(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression)
        ? node.argumentExpression.text
        : undefined;
  // A static member of an object or array literal; undefined for spreads, methods and computed keys.
  const memberOf = (container: ts.Expression, name: string): ts.Expression | undefined => {
    const value = unwrap(container);
    if (ts.isArrayLiteralExpression(value)) {
      const index = Number(name);
      return Number.isInteger(index) && !value.elements.slice(0, index + 1).some(ts.isSpreadElement)
        ? value.elements[index]
        : undefined;
    }
    if (!ts.isObjectLiteralExpression(value)) return undefined;
    if (value.properties.some(ts.isSpreadAssignment)) return undefined;
    const property = value.properties.find(
      (entry) =>
        (ts.isPropertyAssignment(entry) || ts.isShorthandPropertyAssignment(entry)) &&
        !ts.isComputedPropertyName(entry.name) &&
        entry.name.text === name,
    );
    return property && ts.isPropertyAssignment(property)
      ? property.initializer
      : property && ts.isShorthandPropertyAssignment(property)
        ? property.name
        : undefined;
  };
  // For a `const` loop variable of `for (... of <array>)`: the array's elements when it is a
  // constant array literal without spreads, or no elements when Refit cannot list them.
  const forOfElements = (identifier: ts.Identifier, file: string) => {
    const declaration = declarationOf(identifier)?.node;
    const loop = declaration?.parent.parent;
    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !ts.isIdentifier(declaration.name) ||
      !loop ||
      !ts.isForOfStatement(loop) ||
      !(declaration.parent.flags & ts.NodeFlags.Const)
    )
      return undefined;
    let array = unwrap(loop.expression);
    let owner = file;
    if (ts.isIdentifier(array)) {
      const resolved = scoped(array, file) ?? constant(file, array.text);
      if (resolved) [array, owner] = [unwrap(resolved.node), resolved.file];
    }
    return {
      file: owner,
      elements:
        ts.isArrayLiteralExpression(array) && !array.elements.some(ts.isSpreadElement)
          ? [...array.elements]
          : undefined,
    };
  };
  // Across the repository: member names written (`x.NAME = …`) or declared by more than one class
  // member, every `.NAME` access, and classes that `Object.assign(this, …)`. Built on first use.
  let memberIndex:
    | {
        written: Set<string>;
        accesses: Map<string, ts.PropertyAccessExpression[]>;
        elements: Set<string>;
        assigned: Set<ts.Node>;
      }
    | undefined;
  const members = () => {
    if (!memberIndex) {
      const index = {
        written: new Set<string>(),
        accesses: new Map<string, ts.PropertyAccessExpression[]>(),
        elements: new Set<string>(),
        assigned: new Set<ts.Node>(),
      };
      const declared = new Map<string, number>();
      for (const absolute of sources.keys()) {
        if (/\.d\.[cm]?ts$/.test(absolute)) continue;
        const visit = (node: ts.Node) => {
          if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
            ts.isPropertyAccessExpression(node.left)
          )
            index.written.add(node.left.name.text);
          if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
            index.elements.add(node.argumentExpression.text);
          if (ts.isPropertyAccessExpression(node))
            index.accesses.set(node.name.text, [
              ...(index.accesses.get(node.name.text) ?? []),
              node,
            ]);
          if (
            (ts.isPropertyDeclaration(node) ||
              ts.isGetAccessorDeclaration(node) ||
              ts.isMethodDeclaration(node)) &&
            ts.isClassLike(node.parent)
          )
            declared.set(node.name.getText(), (declared.get(node.name.getText()) ?? 0) + 1);
          if (
            ts.isCallExpression(node) &&
            node.expression.getText() === 'Object.assign' &&
            node.arguments[0]?.kind === ts.SyntaxKind.ThisKeyword
          ) {
            const owner = ts.findAncestor(node, ts.isClassLike);
            if (owner) index.assigned.add(owner);
          }
          ts.forEachChild(node, visit);
        };
        visit(sourceFile(absolute));
      }
      for (const [name, count] of declared) if (count > 1) index.written.add(name);
      memberIndex = index;
    }
    return memberIndex;
  };
  // The initializer of the instance field `this.NAME` reads, in the class whose method reads it:
  // readonly or private, or a field no code assigns and no other class declares.
  const classField = (access: ts.PropertyAccessExpression) => {
    if (access.expression.kind !== ts.SyntaxKind.ThisKeyword) return undefined;
    const method = ts.findAncestor(
      access.parent,
      (node) => ts.isFunctionLike(node) && !ts.isArrowFunction(node),
    );
    const owner = method?.parent;
    if (!owner || !ts.isClassLike(owner)) return undefined;
    const name = access.name.getText();
    const member = owner.members.find(
      (entry): entry is ts.PropertyDeclaration =>
        ts.isPropertyDeclaration(entry) &&
        entry.name.getText() === name &&
        !hasModifier(entry, ts.SyntaxKind.StaticKeyword),
    );
    if (!member?.initializer) return undefined;
    // `readonly` and private fields can still be set in the constructor or by the class itself.
    return !members().written.has(name) && !members().assigned.has(owner)
      ? member.initializer
      : undefined;
  };
  // Every value a `let` binding holds: its initializer and each `name = value` assignment. Undefined
  // for any other write (`+=`, `++`, destructuring, a loop target), which Refit cannot follow.
  // With `appends`, each `name += value` is collected there instead of stopping.
  const assignedValues = (
    identifier: ts.Identifier,
    appends?: ts.Expression[],
  ): ts.Expression[] | undefined => {
    const binding = declarationOf(identifier);
    const declaration = binding?.node;
    if (
      !binding ||
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !ts.isIdentifier(declaration.name) ||
      !(declaration.parent.flags & ts.NodeFlags.Let) ||
      !ts.isVariableStatement(declaration.parent.parent)
    )
      return undefined;
    const values = declaration.initializer ? [declaration.initializer] : [];
    for (const reference of referencesIn(binding.scope, identifier.text)) {
      const node = outermost(reference);
      const parent = node.parent;
      const operator = ts.isBinaryExpression(parent) ? parent.operatorToken.kind : undefined;
      if (
        ts.isBinaryExpression(parent) &&
        parent.left === node &&
        operator !== undefined &&
        operator >= ts.SyntaxKind.FirstAssignment &&
        operator <= ts.SyntaxKind.LastAssignment
      ) {
        if (operator === ts.SyntaxKind.PlusEqualsToken && appends) appends.push(parent.right);
        else if (operator !== ts.SyntaxKind.EqualsToken) return undefined;
        else values.push(parent.right);
        continue;
      }
      if (
        (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
        (parent.operator === ts.SyntaxKind.PlusPlusToken ||
          parent.operator === ts.SyntaxKind.MinusMinusToken)
      )
        return undefined;
      let target: ts.Node = node;
      while (
        ts.isArrayLiteralExpression(target.parent) ||
        ts.isObjectLiteralExpression(target.parent) ||
        ts.isShorthandPropertyAssignment(target.parent) ||
        ts.isSpreadElement(target.parent) ||
        ts.isSpreadAssignment(target.parent) ||
        (ts.isPropertyAssignment(target.parent) && target.parent.initializer === target) ||
        ts.isParenthesizedExpression(target.parent)
      )
        target = target.parent;
      if (
        (target !== node &&
          ts.isBinaryExpression(target.parent) &&
          target.parent.left === target &&
          target.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) ||
        ((ts.isForOfStatement(target.parent) || ts.isForInStatement(target.parent)) &&
          target.parent.initializer === target)
      )
        return undefined;
    }
    return values;
  };
  // Reads the argument each call passes for a parameter. False when no call is known and code
  // outside the repository may call the function; a local function nothing calls sends nothing.
  const parameterArguments = (
    parameter: ts.ParameterDeclaration,
    helpers: Set<string>,
    read: (argument: ts.Expression, file: string, call: ts.Node, helpers: Set<string>) => void,
  ) => {
    const fn = parameter.parent;
    const index = fn.parameters.indexOf(parameter);
    const key = `${fn.getSourceFile().fileName}:${fn.pos}:${index}`;
    if (helpers.has(key)) return true;
    const flows = functionFlows(fn);
    if (!flows.calls.length && !flows.escapes.length) return !flows.open;
    for (const invocation of flows.calls) {
      const argument = invocation.arguments[index];
      if (invocation.arguments.slice(0, index + 1).some(ts.isSpreadElement))
        unreadable(
          invocation,
          'The call spreads its arguments, so Refit cannot tell which one is the GraphQL document.',
        );
      else if (argument)
        read(argument, invocation.getSourceFile().fileName, invocation, new Set([...helpers, key]));
      else unreadable(invocation, 'The helper call passes no GraphQL document.');
    }
    for (const entry of flows.escapes) unreadable(entry.node, entry.reason);
    return true;
  };
  const openParameter = (name: string) =>
    `The document is \`${name}\`, from a parameter of a function nothing in the repository calls but code outside it can (an export, a public method or a callback), so Refit cannot list the documents it receives.`;
  // The documents in `base.property`: a member of a constant object, or of every object a parameter
  // receives (`options.query`, `({ query }) => …`). `fallback` is a destructuring default.
  const memberDocuments = (
    base: ts.Expression,
    property: string,
    file: string,
    call: ts.Node,
    helpers: Set<string>,
    fallback?: ts.Expression,
  ): void => {
    let value = unwrap(base);
    let owner = file;
    if (ts.isIdentifier(value)) {
      const resolved = scoped(value, file) ?? constant(file, value.text);
      const parameter = resolved ? undefined : declarationOf(value)?.node;
      if (resolved) [value, owner] = [unwrap(resolved.node), resolved.file];
      else if (
        parameter &&
        ts.isParameter(parameter) &&
        ts.isIdentifier(parameter.name) &&
        !parameter.dotDotDotToken &&
        parameterArguments(parameter, helpers, (argument, at, invocation, followed) =>
          memberDocuments(argument, property, at, invocation, followed, fallback),
        )
      )
        return;
      if (parameter && ts.isParameter(parameter))
        return unreadable(call, openParameter(`${value.getText()}.${property}`));
    }
    // `getPaginationQuery(params).query`: the member in each object the function returns.
    if (ts.isCallExpression(value)) {
      const fn = calledFunction(value.expression);
      const key = fn && `${fn.getSourceFile().fileName}:${fn.pos}:return`;
      const returned = fn && key && !helpers.has(key) ? returnedValues(fn) : [];
      if (fn && key && returned.length) {
        for (const entry of returned)
          memberDocuments(
            entry,
            property,
            fn.getSourceFile().fileName,
            call,
            new Set([...helpers, key]),
            fallback,
          );
        return;
      }
    }
    if (ts.isObjectLiteralExpression(value)) {
      const item = memberOf(value, property);
      if (item) return documentArgument(item, owner, call, helpers);
      if (fallback && !value.properties.some(ts.isSpreadAssignment))
        return documentArgument(fallback, file, call, helpers);
    }
    unreadable(
      call,
      `The document \`${snippet(base)}.${property}\` is built at runtime; Refit only reads literal or constant documents.`,
    );
  };
  // A document argument: a literal, or a constant naming one, possibly wrapped as { query }.
  // A document that is a parameter is read from every call of its function, one returned by a
  // repository function from its `return`s, and a `let` from every value assigned to it.
  // `helpers` holds the function parameters already being followed, so recursion is skipped.
  const documentArgument = (
    node: ts.Expression | undefined,
    file: string,
    call: ts.Node,
    helpers = new Set<string>(),
  ): void => {
    if (!node) return;
    let value = unwrap(node);
    if (ts.isAwaitExpression(value)) value = unwrap(value.expression);
    // A raw request body: `JSON.stringify({ query })`.
    if (
      ts.isCallExpression(value) &&
      value.expression.getText() === 'JSON.stringify' &&
      value.arguments[0]
    )
      return documentArgument(value.arguments[0], file, call, helpers);
    if (ts.isObjectLiteralExpression(value)) {
      // `{ query }`, graphql-request's `{ document }` and Apollo's `{ mutation }`.
      const query =
        memberOf(value, 'query') ?? memberOf(value, 'document') ?? memberOf(value, 'mutation');
      if (!query) {
        unreadable(call, 'The request body has no static query.');
        return;
      }
      value = unwrap(query);
    }
    if (ts.isConditionalExpression(value)) {
      documentArgument(value.whenTrue, file, call, helpers);
      documentArgument(value.whenFalse, file, call, helpers);
      return;
    }
    if (ts.isCallExpression(value)) {
      // An imported `graphql(\`…\`)` or `gql(\`…\`)` only marks its document.
      const binding = ts.isIdentifier(value.expression)
        ? declarationOf(value.expression)?.node
        : undefined;
      if (
        binding &&
        DOCUMENT_TAG.test(value.expression.getText()) &&
        (ts.isImportClause(binding.parent) || ts.isImportSpecifier(binding.parent))
      )
        return documentArgument(value.arguments[0], file, call, helpers);
      // `admin.graphql(productsQuery(first))`: what the repository function returns.
      const fn = calledFunction(value.expression);
      const key = fn && `${fn.getSourceFile().fileName}:${fn.pos}:return`;
      if (fn && key && !helpers.has(key)) {
        const returned = returnedValues(fn);
        for (const entry of returned)
          documentArgument(entry, fn.getSourceFile().fileName, call, new Set([...helpers, key]));
        if (returned.length) return;
      }
    }
    // Members of a constant object or array literal: `QUERIES.product`, `QUERIES[0]`, and the
    // loop variable (or its property) of `for (const tier of TIERS)`, where every element is read.
    const access =
      (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) &&
      ts.isIdentifier(value.expression)
        ? value
        : undefined;
    const base = access ? (access.expression as ts.Identifier) : value;
    const loop = ts.isIdentifier(base) ? forOfElements(base, file) : undefined;
    const property = access && memberName(access);
    if (loop) {
      if (!loop.elements || (access && property === undefined))
        return unreadable(
          call,
          'The document comes from an array Refit cannot read element by element.',
        );
      for (const element of loop.elements) {
        const item = access ? memberOf(element, property!) : element;
        if (item) documentArgument(item, loop.file, call, helpers);
        else
          unreadable(call, 'An element of the array the document comes from has no static query.');
      }
      return;
    }
    if (access && property !== undefined)
      return memberDocuments(base, property, file, call, helpers);
    // `this.LIST_QUERY`: a class field's initializer, when nothing else can set it.
    const field = ts.isPropertyAccessExpression(value) ? classField(value) : undefined;
    if (field) return documentArgument(field, file, call, helpers);
    let owner = file;
    if (ts.isIdentifier(value)) {
      const resolved = scoped(value, file) ?? constant(file, value.text);
      const declaration = resolved ? undefined : declarationOf(value)?.node;
      if (resolved) {
        value = resolved.node;
        owner = resolved.file;
      } else if (declaration && ts.isParameter(declaration) && !declaration.dotDotDotToken) {
        if (
          ts.isIdentifier(declaration.name) &&
          parameterArguments(declaration, helpers, documentArgument)
        )
          return;
        // `({ query, variables }) => …`: the property each call's argument names.
        const element = ts.isObjectBindingPattern(declaration.name)
          ? declaration.name.elements.find(
              (entry) => ts.isIdentifier(entry.name) && entry.name.text === value.getText(),
            )
          : undefined;
        const name = element && !element.dotDotDotToken && (element.propertyName ?? element.name);
        if (
          name &&
          (ts.isIdentifier(name) || ts.isStringLiteral(name)) &&
          parameterArguments(declaration, helpers, (argument, at, invocation, followed) =>
            memberDocuments(argument, name.text, at, invocation, followed, element.initializer),
          )
        )
          return;
        return unreadable(call, openParameter(value.getText()));
      } else if (
        // `const { query, variables } = input`: a property of a value Refit can follow.
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        ts.isObjectBindingPattern(declaration.name) &&
        declaration.parent.flags & ts.NodeFlags.Const &&
        declaration.initializer
      ) {
        const element = declaration.name.elements.find(
          (entry) => ts.isIdentifier(entry.name) && entry.name.text === value.getText(),
        );
        const name = element && !element.dotDotDotToken && (element.propertyName ?? element.name);
        if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name)))
          return memberDocuments(
            declaration.initializer,
            name.text,
            file,
            call,
            helpers,
            element.initializer,
          );
      } else {
        const values = assignedValues(value);
        if (values?.length) {
          for (const entry of values) documentArgument(entry, file, call, helpers);
          return;
        }
      }
      // `const mutation = isCode ? CODE_MUTATION : AUTOMATIC_MUTATION`, `const body = { query }`
      if (ts.isConditionalExpression(value) || ts.isObjectLiteralExpression(value))
        return documentArgument(value, owner, call, helpers);
    }
    const wrapped = wrappedValue(value);
    if (wrapped) {
      documentLiterals.set(value as Literal, true);
      return documentArgument(wrapped, owner, call, helpers);
    }
    if (isLiteral(value)) record(value, owner, true, call);
    else
      unreadable(
        call,
        `The document \`${snippet(value)}\` is built at runtime; Refit only reads literal or constant documents.`,
      );
  };
  // A literal's text with each substitution shown as `{name}` (or `{…}` when it is not a name).
  const literalText = (literal: Literal) =>
    ts.isTemplateExpression(literal)
      ? literal.head.text +
        literal.templateSpans
          .map((span) => {
            const text = span.expression.getText();
            return `{${/^[\w$.]{1,40}$/.test(text) ? text : '…'}}${span.literal.text}`;
          })
          .join('')
      : literal.text;
  // The path a REST call names: a literal or constant, directly or as `{ path }`.
  const restPath = (argument: ts.Expression | undefined, file: string) => {
    let value = argument && unwrap(argument);
    if (value && ts.isObjectLiteralExpression(value)) {
      const path = memberOf(value, 'path');
      value = path && unwrap(path);
    }
    if (value && ts.isIdentifier(value)) {
      const resolved = scoped(value, file) ?? constant(file, value.text);
      value = resolved && unwrap(resolved.node);
    }
    return value && isLiteral(value) ? literalText(value).replace(/^\//, '') : undefined;
  };
  // `admin.rest.get({ path })`, `client.post('products', ...)` and `shopify.rest.Product.all()`.
  const restCall = (call: ts.CallExpression, file: string) => {
    const callee = call.expression as ts.PropertyAccessExpression;
    const operation = callee.name.text;
    const resource = /(?:^|\.)(?:rest|resources)\.([A-Z]\w*)$/.exec(
      callee.expression.getText(),
    )?.[1];
    if (resource)
      return {
        resource: `${resource}.${operation}`,
        ...(RESOURCE_METHODS[operation] ? { method: RESOURCE_METHODS[operation] } : {}),
      };
    const method = REST_VERBS[operation];
    const path = method ? restPath(call.arguments[0], file) : undefined;
    return { ...(method ? { method } : {}), ...(path ? { path } : {}) };
  };
  // The HTTP method of a request whose URL is `node`: `fetch(url)` (GET), `fetch(url, { method })`
  // with a literal method, or an HTTP verb call (`axios.post(url)`). Undefined otherwise.
  const requestMethod = (node: ts.Node) => {
    while (
      ts.isParenthesizedExpression(node.parent) ||
      ts.isAsExpression(node.parent) ||
      ts.isNonNullExpression(node.parent)
    )
      node = node.parent;
    const call = node.parent;
    if (!ts.isCallExpression(call) || call.arguments[0] !== node) return undefined;
    if (ts.isPropertyAccessExpression(call.expression) && REST_VERBS[call.expression.name.text])
      return REST_VERBS[call.expression.name.text];
    if (!/^(?:\w+\.)*fetch$/.test(call.expression.getText())) return undefined;
    const options = call.arguments[1] && unwrap(call.arguments[1]);
    if (!options) return 'GET';
    if (!ts.isObjectLiteralExpression(options) || options.properties.some(ts.isSpreadAssignment))
      return undefined;
    const option = memberOf(options, 'method');
    const value = option && unwrap(option);
    return !option
      ? 'GET'
      : value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))
        ? value.text.toUpperCase()
        : undefined;
  };
  // A versioned REST URL: its path, and the method when the URL is passed straight to `fetch`
  // (from a literal `method` option, GET without one) or to an HTTP verb call (`axios.post(url)`).
  const restUrl = (piece: ts.Node) => {
    const literal = ts.isTemplateHead(piece)
      ? piece.parent
      : ts.isTemplateMiddle(piece) || ts.isTemplateTail(piece)
        ? piece.parent.parent
        : piece;
    const path = REST_PATH.exec(literalText(literal as Literal))?.[1];
    let node: ts.Node = literal;
    while (
      ts.isParenthesizedExpression(node.parent) ||
      ts.isAsExpression(node.parent) ||
      ts.isNonNullExpression(node.parent)
    )
      node = node.parent;
    // `const url = ...; fetch(url)`: the method every use of the constant agrees on.
    const declaration = node.parent;
    const uses =
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer === node &&
      ts.isIdentifier(declaration.name) &&
      declaration.parent.flags & ts.NodeFlags.Const
        ? referencesIn(declarationOf(declaration.name)!.scope, declaration.name.text)
        : [node];
    const methods = new Set(uses.map(requestMethod));
    const [method] = methods.size === 1 ? methods : [undefined];
    return { ...(method ? { method } : {}), ...(path ? { path } : {}) };
  };
  // The node a value flows from, past parentheses and type assertions.
  const outermost = (node: ts.Node) => {
    while (
      ts.isParenthesizedExpression(node.parent) ||
      ts.isAsExpression(node.parent) ||
      ts.isNonNullExpression(node.parent) ||
      ts.isSatisfiesExpression(node.parent)
    )
      node = node.parent;
    return node;
  };
  // A fetch body: `JSON.stringify({ query })`, or with an application/graphql content type the
  // document itself, through `const` bindings and conditionals.
  const rawBody = (node: ts.Expression, file: string, call: ts.Node, graphql: boolean): void => {
    let value = unwrap(node);
    if (ts.isIdentifier(value)) {
      const resolved = scoped(value, file) ?? constant(file, value.text);
      if (resolved) value = unwrap(resolved.node);
    }
    if (ts.isConditionalExpression(value)) {
      rawBody(value.whenTrue, file, call, graphql);
      rawBody(value.whenFalse, file, call, graphql);
    } else if (
      graphql ||
      ts.isObjectLiteralExpression(value) ||
      (ts.isCallExpression(value) && value.expression.getText() === 'JSON.stringify')
    )
      documentArgument(value, file, call);
    else
      unreadable(
        call,
        'A raw request to the Admin GraphQL endpoint whose body Refit cannot read; Refit reads `fetch(url, { body: JSON.stringify({ query }) })` and `axios.post(url, { query })`.',
      );
  };
  // A GraphQL client built for the Admin endpoint URL `at`: `new GraphQLClient(url)` (graphql-request),
  // `createGraphQLClient({ url })` (@shopify/graphql-client), urql's `createClient({ url })` and
  // Apollo's `new ApolloClient({ uri })`.
  const endpointClient = (at: ts.Node) => {
    let argument: ts.Node = at;
    if (
      ((ts.isPropertyAssignment(at.parent) && at.parent.initializer === at) ||
        ts.isShorthandPropertyAssignment(at.parent)) &&
      /^(?:url|uri|endpoint)$/.test(at.parent.name.getText())
    )
      argument = outermost(at.parent.parent);
    const creation = argument.parent;
    return (ts.isCallExpression(creation) || ts.isNewExpression(creation)) &&
      creation.arguments?.[0] === argument &&
      ENDPOINT_CLIENT.test(creation.expression.getText())
      ? creation
      : undefined;
  };
  // Where a client value goes: a member use in place (`client.request(…)`), through `const`
  // bindings, and into repository functions as an argument or as an object member the parameter
  // destructures (`sync({ client })`). Member uses go to `uses`, every other use to `escapes`.
  const clientFlow = (
    value: ts.Node,
    uses: ts.Node[],
    escapes: ts.Node[],
    seen = new Set<ts.Node>(),
  ): void => {
    let node = outermost(value);
    while (ts.isAwaitExpression(node.parent)) node = outermost(node.parent);
    const parent = node.parent;
    const into = (name: ts.Identifier) => {
      if (seen.has(name)) return;
      seen.add(name);
      const binding = declarationOf(name);
      if (!binding) return escapes.push(node);
      for (const reference of referencesIn(binding.scope, name.text))
        clientFlow(reference, uses, escapes, seen);
    };
    // The parameter of the repository function `call` names that receives argument `argument`.
    const parameterOf = (call: ts.CallExpression, argument: ts.Node) => {
      const index = call.arguments.indexOf(argument as ts.Expression);
      const parameter = calledFunction(call.expression)?.parameters[index];
      return parameter &&
        !parameter.dotDotDotToken &&
        !call.arguments.slice(0, index).some(ts.isSpreadElement)
        ? parameter
        : undefined;
    };
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) uses.push(node);
    else if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer === node &&
      ts.isIdentifier(parent.name) &&
      parent.parent.flags & ts.NodeFlags.Const &&
      !hasModifier(parent.parent.parent, ts.SyntaxKind.ExportKeyword)
    )
      into(parent.name);
    else if (ts.isCallExpression(parent) && parent.arguments.some((entry) => entry === node)) {
      const parameter = parameterOf(parent, node);
      if (parameter && ts.isIdentifier(parameter.name)) into(parameter.name);
      else escapes.push(node);
    } else if (
      ((ts.isShorthandPropertyAssignment(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.initializer === node)) &&
      (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name))
    ) {
      // `sync({ client })` into `function sync({ client }: …)`.
      const object = outermost(parent.parent);
      const call = object.parent;
      const parameter =
        ts.isCallExpression(call) && call.arguments.some((entry) => entry === object)
          ? parameterOf(call, object)
          : undefined;
      if (!parameter || !ts.isObjectBindingPattern(parameter.name)) return void escapes.push(node);
      const key = parent.name.text;
      for (const element of parameter.name.elements) {
        const name = element.propertyName ?? element.name;
        if (element.dotDotDotToken || !(ts.isIdentifier(name) || ts.isStringLiteral(name)))
          return void escapes.push(node);
        if (name.text !== key) continue;
        if (ts.isIdentifier(element.name)) into(element.name);
        else escapes.push(node);
      }
    } else escapes.push(node);
  };
  const clientRequests = (creation: ts.Node, file: string) => {
    const node = outermost(creation);
    const holder = node.parent;
    const ESCAPED =
      'A GraphQL client for the Admin endpoint is used here in a way Refit cannot follow, so the documents it sends are not read.';
    const factory = ts.isReturnStatement(holder)
      ? ts.findAncestor(holder, ts.isFunctionLike)
      : ts.isArrowFunction(holder) && holder.body === node
        ? holder
        : undefined;
    const references: ts.Node[] = [];
    const escapes: ts.Node[] = [];
    if (
      factory &&
      (ts.isFunctionDeclaration(factory) ||
        ts.isArrowFunction(factory) ||
        ts.isFunctionExpression(factory))
    ) {
      // `const client = createClient(…)` or `createClient(…).request(…)` at every call.
      const flows = functionFlows(factory);
      if (flows.escapes.length || (!flows.calls.length && flows.open))
        return unreadable(creation, ESCAPED);
      for (const call of flows.calls) clientFlow(call, references, escapes);
    } else if (
      ts.isBinaryExpression(holder) &&
      holder.right === node &&
      holder.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(holder.left) &&
      holder.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
      ts.findAncestor(holder, ts.isClassLike)
    ) {
      const name = holder.left.name.text;
      const assigned = holder.left;
      const owner = ts.findAncestor(holder, ts.isClassLike)!;
      // A field code outside the class can read (`repository.client.request(…)`) stops.
      if (
        !ts.isPrivateIdentifier(holder.left.name) &&
        (members().accesses.get(name) ?? []).some((access) => {
          const inside = Boolean(ts.findAncestor(access, (node) => node === owner));
          if (inside) return access.expression.kind !== ts.SyntaxKind.ThisKeyword;
          // Another class's own `this.client` is its field, unless it extends a class.
          const other = ts.findAncestor(access, ts.isClassLike);
          return (
            access.expression.kind !== ts.SyntaxKind.ThisKeyword ||
            !other ||
            Boolean(other.heritageClauses?.length)
          );
        })
      )
        return unreadable(creation, ESCAPED);
      const visit = (child: ts.Node) => {
        if (
          child !== assigned &&
          ts.isPropertyAccessExpression(child) &&
          child.expression.kind === ts.SyntaxKind.ThisKeyword &&
          child.name.text === name
        )
          clientFlow(child, references, escapes);
        ts.forEachChild(child, visit);
      };
      visit(owner);
    } else clientFlow(creation, references, escapes);
    for (const escape of escapes) unreadable(escape, ESCAPED);
    for (const reference of references) {
      const at = outermost(reference);
      const access = at.parent;
      if (!ts.isPropertyAccessExpression(access) || access.expression !== at) {
        unreadable(reference, ESCAPED);
        continue;
      }
      const call = access.parent;
      // Header and endpoint setters send nothing; any other member may send a document.
      if (CLIENT_SETTERS.test(access.name.text)) continue;
      if (
        !CLIENT_METHODS.has(access.name.text) ||
        !ts.isCallExpression(call) ||
        call.expression !== access
      ) {
        unreadable(reference, ESCAPED);
        continue;
      }
      scan.adminCalls++;
      documentArgument(call.arguments[0], file, call);
    }
  };
  // A raw request to the Admin GraphQL endpoint: the document in `fetch(url, { body:
  // JSON.stringify({ query }) })` or `axios.post(url, { query })`, for the URL literal and every use
  // of a `const` holding it. False when no request with a readable body was found.
  const rawGraphql = (literal: Literal, file: string) => {
    const node = outermost(literal);
    const declaration = node.parent;
    const uses =
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer === node &&
      ts.isIdentifier(declaration.name) &&
      declaration.parent.flags & ts.NodeFlags.Const
        ? referencesIn(declarationOf(declaration.name)!.scope, declaration.name.text)
        : [node];
    let found = false;
    const read = new Set<ts.Node>();
    for (const use of uses) {
      const at = outermost(use);
      const client = endpointClient(at);
      if (client) {
        found = true;
        read.add(at);
        clientRequests(client, file);
        continue;
      }
      const call = at.parent;
      if (!ts.isCallExpression(call) || call.arguments[0] !== at) continue;
      let body: ts.Expression | undefined;
      let graphqlBody = false;
      if (/^(?:\w+\.)*fetch$/.test(call.expression.getText())) {
        // The options literal, or the `const` holding it.
        let options: ts.Expression | undefined = call.arguments[1] && unwrap(call.arguments[1]);
        if (options && ts.isIdentifier(options))
          options = (scoped(options, file) ?? constant(file, options.text))?.node;
        options = options && unwrap(options);
        if (options && ts.isObjectLiteralExpression(options)) {
          body = memberOf(options, 'body');
          let headers = memberOf(options, 'headers');
          if (headers && ts.isIdentifier(headers))
            headers = (scoped(headers, file) ?? constant(file, headers.text))?.node;
          graphqlBody = Boolean(headers && /application\/graphql/.test(headers.getText()));
        }
      } else if (
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.name.text === 'post'
      )
        body = call.arguments[1];
      if (!body) continue;
      found = true;
      scan.adminCalls++;
      read.add(at);
      rawBody(body, file, call, graphqlBody);
    }
    // Once one use is read, every other use passed to a call stops at its own line.
    if (found)
      for (const use of uses) {
        const at = outermost(use);
        if (
          !read.has(at) &&
          (ts.isCallExpression(at.parent) || ts.isNewExpression(at.parent)) &&
          at.parent.arguments?.some((argument) => argument === at)
        )
          unreadable(
            at,
            'A raw request to the Admin GraphQL endpoint whose body Refit cannot read; Refit reads `fetch(url, { body: JSON.stringify({ query }) })` and `axios.post(url, { query })`.',
          );
      }
    return found;
  };
  const versionKeys = new Set<string>();
  // Version literals Storefront API URLs take, checked against the Admin pins once all are read.
  const storefrontVersionSources: { literal: ts.Node; at: ts.Node }[] = [];
  const pushVersion = (entry: VersionDeclaration) => {
    const key = `${entry.file}:${entry.start}`;
    if (versionKeys.has(key)) return;
    versionKeys.add(key);
    scan.versions.push(entry);
  };
  // A version literal an expression names: directly, through `const` bindings and imports, or as
  // the default of `process.env.NAME ?? '2025-01'` (or `||`). `handled` marks ApiVersion members
  // and LATEST_API_VERSION, which are read where they are written.
  const versionSource = (
    expression: ts.Expression,
    file: string,
    depth = 0,
  ):
    | { literal: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral; envFallback?: string }
    | { environment: string }
    | 'handled'
    | undefined => {
    const value = unwrap(expression);
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))
      return { literal: value };
    if (ts.isPropertyAccessExpression(value) && value.expression.getText() === 'ApiVersion')
      return 'handled';
    if (ts.isIdentifier(value) && value.text === 'LATEST_API_VERSION') return 'handled';
    if (
      ts.isBinaryExpression(value) &&
      (value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        value.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      // A default in code: `process.env.NAME ?? '2025-01'`, `options.apiVersion || ApiVersion.X`.
      const left = unwrap(value.left).getText();
      const environment = ENVIRONMENT.exec(left);
      const fallback = versionSource(value.right, file, depth + 1);
      if (fallback === 'handled') return 'handled';
      return fallback && 'literal' in fallback
        ? {
            ...fallback,
            envFallback: environment
              ? (environment[1] ?? environment[2] ?? environment[3])
              : left.slice(0, 80),
          }
        : undefined;
    }
    const environment = ENVIRONMENT.exec(value.getText());
    if (environment) return { environment: environment[1] ?? environment[2] ?? environment[3] };
    if (ts.isIdentifier(value) && depth < 8) {
      const resolved = scoped(value, value.getSourceFile().fileName) ?? constant(file, value.text);
      return resolved ? versionSource(resolved.node, resolved.file, depth + 1) : undefined;
    }
    return undefined;
  };
  // Records a version an expression names; false when Refit cannot read it.
  const versionFrom = (
    expression: ts.Expression,
    file: string,
    kind: 'string' | 'url',
    storefront: boolean,
  ) => {
    const source = versionSource(expression, file);
    if (source === 'handled') return true;
    if (source && 'environment' in source) {
      scan.unresolvedVersions.push({
        ...location(expression),
        reason: `The Admin API version comes from the environment variable ${source.environment}, with no default in code; set it to the target version where the app is deployed.`,
        note: 'environment',
      });
      return true;
    }
    if (source && source.literal.text === 'unstable') {
      scan.unresolvedVersions.push({
        ...location(source.literal),
        reason: 'The unstable Admin API version changes without notice; Refit leaves it as it is.',
        note: 'unstable',
      });
      return true;
    }
    if (!source || !isShopifyVersion(source.literal.text)) return false;
    pushVersion({
      ...location(source.literal),
      kind,
      value: source.literal.text,
      start: source.literal.getStart() + 1,
      end: source.literal.getEnd() - 1,
      text: source.literal.getText(),
      ...(source.envFallback ? { envFallback: source.envFallback } : {}),
      ...(storefront ? { api: 'storefront' as const } : {}),
    });
    return true;
  };
  for (const [absolute, content] of sources) {
    const file = sourceFile(absolute);
    const shopify = SHOPIFY_IMPORT.test(content);
    if (shopify) scan.shopifyFiles.push(pathOf.get(absolute)!);
    // Identifiers bound to Admin GraphQL and REST clients in this file.
    const clients = new Set<string>();
    const storefrontClients = new Set<string>();
    const restClients = new Set<string>();
    const apiVersionImported = /\bApiVersion\b/.test(content) && shopify;
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const value = unwrap(node.initializer);
        const callee =
          ts.isCallExpression(value) || ts.isNewExpression(value) ? value.expression.getText() : '';
        if (ADMIN_CLIENT_FACTORY.test(callee)) clients.add(node.name.text);
        if (STOREFRONT_CLIENT_FACTORY.test(callee)) storefrontClients.add(node.name.text);
        if (REST_CLIENT_FACTORY.test(callee)) restClients.add(node.name.text);
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const receiver = node.expression.expression.getText();
        if (
          ((method === 'query' || method === 'mutate') && STOREFRONT_RECEIVER.test(receiver)) ||
          ((method === 'request' || method === 'query') && storefrontClients.has(receiver))
        ) {
          api = 'storefront';
          const argument = node.arguments[0];
          const data =
            method === 'query' &&
            storefrontClients.has(receiver) &&
            argument &&
            ts.isObjectLiteralExpression(unwrap(argument))
              ? memberOf(argument, 'data')
              : argument;
          documentArgument(data, absolute, node);
          api = undefined;
        } else if (method === 'graphql' && ADMIN_RECEIVER.test(receiver)) {
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
          scan.rest.push({
            ...location(node),
            expression: node.expression.getText(),
            ...restCall(node, absolute),
          });
        else if (REST_VERBS[method] && restClients.has(receiver))
          scan.rest.push({
            ...location(node),
            expression: node.expression.getText(),
            ...restCall(node, absolute),
          });
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'createAdminRestApiClient'
      )
        scan.rest.push({ ...location(node), expression: node.expression.text });
      if (ts.isNewExpression(node) && REST_RECEIVER.test(node.expression.getText())) {
        // `new shopify.rest.Product(...)` builds a record that `save()` sends.
        const resource = /(?:^|\.)(?:rest|resources)\.([A-Z]\w*)$/.exec(
          node.expression.getText(),
        )?.[1];
        scan.rest.push({
          ...location(node),
          expression: node.expression.getText(),
          ...(resource ? { resource: `new ${resource}` } : {}),
        });
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'ApiVersion' &&
        apiVersionImported
      ) {
        const value = versionFromEnum(node.name.text);
        if (value)
          pushVersion({
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
            ...(node.name.text === 'Unstable'
              ? {
                  reason: 'ApiVersion.Unstable changes without notice; Refit leaves it as it is.',
                  note: 'unstable' as const,
                }
              : { reason: `${node.getText()} is not a dated Admin API version.` }),
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
        const factory = node.parent.parent;
        // A Storefront client, or a codegen project for the Storefront API
        // (`shopifyApiProject({ apiType: ApiType.Storefront, apiVersion })`).
        const apiType = memberOf(node.parent as ts.ObjectLiteralExpression, 'apiType');
        const storefront =
          ((ts.isCallExpression(factory) || ts.isNewExpression(factory)) &&
            STOREFRONT_CLIENT_FACTORY.test(factory.expression.getText())) ||
          Boolean(apiType && /Storefront/.test(apiType.getText()));
        if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
          if (!versionFrom(value, absolute, 'string', storefront))
            scan.unresolvedVersions.push({
              ...location(value),
              reason: `apiVersion ${value.getText()} is not a dated Admin API version.`,
            });
        } else if (!versionFrom(value, absolute, 'string', storefront))
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
        // A versioned Admin URL whose whole path is a substitution (`/admin/api/2025-01/${path}`)
        // or is added elsewhere (`/admin/api/2025-01`) may name any REST resource, so it counts as
        // REST usage.
        if (
          REST_URL.test(node.text) ||
          BASE_URL.test(node.text) ||
          ((ts.isTemplateHead(node) || ts.isTemplateMiddle(node)) &&
            /\/admin\/api\/(?:\d{4}-\d{2}|unstable)\/$/.test(node.text))
        )
          scan.rest.push({
            ...location(node),
            expression: node.text.slice(0, 120),
            ...restUrl(node),
          });
        for (const match of node.text.matchAll(VERSION_URL)) {
          const start = node.getStart() + 1 + match.index! + '/admin/api/'.length;
          pushVersion({
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
      // Raw requests in tests go to mocked endpoints, like documents in tests.
      if (
        isLiteral(node) &&
        GRAPHQL_URL.test(literalText(node)) &&
        !rawGraphql(node, absolute) &&
        !TEST_FILE.test(pathOf.get(absolute) ?? '')
      ) {
        scan.adminCalls++;
        unreadable(
          node,
          'A raw request to the Admin GraphQL endpoint whose body Refit cannot read; Refit reads `fetch(url, { body: JSON.stringify({ query }) })` and `axios.post(url, { query })`.',
        );
      }
      // `/admin/api/${API_VERSION}/…`: the version a constant or environment default names.
      if (ts.isTemplateExpression(node))
        node.templateSpans.forEach((span, index) => {
          const before = index ? node.templateSpans[index - 1].literal.text : node.head.text;
          if (!span.literal.text.startsWith('/')) return;
          // A Storefront API URL (`/api/${version}/graphql.json`): its version source must not
          // also be an Admin pin, which the move would change too.
          if (/(?<!\/admin)\/api\/$/.test(before) && /^\/graphql\.json\b/.test(span.literal.text)) {
            const source = versionSource(span.expression, absolute);
            if (source && typeof source === 'object' && 'literal' in source)
              storefrontVersionSources.push({ literal: source.literal, at: span.expression });
            return;
          }
          if (!/\/admin\/api\/$/.test(before)) return;
          // `/admin/api/${version}/orders.json`: REST usage, as with a literal version.
          if (!/^\/graphql\.json\b/.test(span.literal.text) && span.literal.text !== '/')
            scan.rest.push({
              ...location(span.literal),
              expression: span.literal.text.slice(0, 120),
              ...restUrl(span.literal),
            });
          if (!versionFrom(span.expression, absolute, 'url', false))
            scan.unresolvedVersions.push({
              ...location(span.expression),
              reason: `An Admin API URL takes its version from ${span.expression.getText().slice(0, 80)}, which Refit cannot resolve statically.`,
            });
        });
      // gql`…` and graphql`…` documents, and graphql(`…`) documents for codegen and gql.tada.
      if (
        ts.isTaggedTemplateExpression(node) &&
        DOCUMENT_TAG.test(node.tag.getText()) &&
        isLiteral(node.template)
      )
        record(node.template, absolute, documentLiterals.get(node.template) ?? false);
      // Only an imported `graphql()`: a local function of that name may send the document itself.
      const imported = (identifier: ts.Identifier) => {
        const binding = declarationOf(identifier)?.node;
        return Boolean(
          binding && (ts.isImportClause(binding.parent) || ts.isImportSpecifier(binding.parent)),
        );
      };
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        DOCUMENT_TAG.test(node.expression.text) &&
        imported(node.expression) &&
        node.arguments[0] &&
        isLiteral(node.arguments[0])
      )
        record(node.arguments[0], absolute, documentLiterals.get(node.arguments[0]) ?? false);
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  // .graphql files: no call Refit can see sends them, so they count as untraced documents.
  for (const document of graphqlFiles)
    if (/\S/.test(document.content))
      scan.documents.push({
        file: document.path,
        line: 1,
        column: 1,
        text: document.content,
        segments: [
          {
            documentStart: 0,
            documentEnd: document.content.length,
            file: document.path,
            sourceStart: 0,
            sourceText: document.content,
          },
        ],
        traced: false,
      });
  scan.documents.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  // A version literal both an Admin pin and a Storefront API URL use: moving it would move the
  // Storefront version, which Refit does not prove, so the Admin move stops.
  for (const { literal, at } of storefrontVersionSources) {
    const file = pathOf.get(literal.getSourceFile().fileName);
    const start = literal.getStart() + 1;
    if (scan.versions.some((pin) => pin.file === file && pin.start === start && !pin.api))
      scan.unresolvedVersions.push({
        ...location(at),
        reason: `The Admin API version ${literal.getText()} also sets this Storefront API URL; moving it would move the Storefront API version too, which Refit does not prove.`,
      });
  }
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
