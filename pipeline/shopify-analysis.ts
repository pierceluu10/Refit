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
    return found.length === 1 ? found[0] : undefined;
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
  const unreadable = (node: ts.Node, reason: string) => {
    const where = location(node);
    if (
      !scan.unreadable.some(
        (entry) =>
          entry.file === where.file &&
          entry.line === where.line &&
          entry.column === where.column &&
          entry.reason === reason,
      )
    )
      scan.unreadable.push({ ...where, reason });
  };
  const documentLiterals = new Map<Literal, boolean>();
  const record = (literal: Literal, file: string, reached: boolean, call?: ts.Node) => {
    // Documents in tests go to mocked clients; they are fixtures, not Admin API usage.
    const traced = reached && !TEST_FILE.test(pathOf.get(file) ?? '');
    if (documentLiterals.get(literal)) return;
    documentLiterals.set(literal, traced);
    const assembled = assemble(literal, file);
    if (typeof assembled === 'string') {
      unreadable(call ?? literal, assembled);
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
  type Flows = { calls: ts.CallExpression[]; escapes: { node: ts.Node; reason: string }[] };
  const flowCache = new Map<ts.Node, Flows>();
  const ESCAPE =
    'A function that sends Admin GraphQL documents is used here in a way Refit cannot follow, so the documents it receives are not read.';
  const functionFlows = (fn: ts.SignatureDeclaration): Flows => {
    const cached = flowCache.get(fn);
    if (cached) return cached;
    const flows: Flows = { calls: [], escapes: [] };
    flowCache.set(fn, {
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
          for (const call of outer.calls) uses(call);
          flows.escapes.push(...outer.escapes);
          return;
        }
      }
      if (ts.isExportAssignment(parent)) return exported(node.getSourceFile().fileName, 'default');
      if (ts.isExportSpecifier(parent))
        return exported(node.getSourceFile().fileName, parent.name.text);
      escape(
        node,
        ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)
          ? 'A function that sends Admin GraphQL documents is stored in an object here; Refit does not follow calls through object properties, so the documents it receives are not read.'
          : ESCAPE,
      );
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
      for (const load of moduleLoads())
        if (same(load.file, name) || same(load.file, target.name))
          escape(
            load.node,
            'A module defining a function that sends Admin GraphQL documents is loaded dynamically here, so Refit cannot follow its callers.',
          );
    };
    if (ts.isFunctionDeclaration(fn) && fn.name) bound(fn.name);
    else if (ts.isFunctionDeclaration(fn) && hasModifier(fn, ts.SyntaxKind.DefaultKeyword))
      exported(fn.getSourceFile().fileName, 'default');
    else if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) uses(fn);
    // Methods, constructors and accessors: their callers need the receiver's type, so none are
    // followed and the call that sends the document stops for review.
    // Calls in tests are still checked (their documents count as fixtures), but tests that pass a
    // helper to mocks and spies do not stop the run: those reach mocked clients.
    const result = {
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
  // A document argument: a literal, or a constant naming one, possibly wrapped as { query }.
  // A document that is a parameter is read from every call of its function. `helpers` holds the
  // function parameters already being followed, so recursion passing the same one is skipped.
  const documentArgument = (
    node: ts.Expression | undefined,
    file: string,
    call: ts.Node,
    helpers = new Set<string>(),
  ): void => {
    if (!node) return;
    let value = unwrap(node);
    if (ts.isObjectLiteralExpression(value)) {
      const query = value.properties.find(
        (property): property is ts.PropertyAssignment =>
          ts.isPropertyAssignment(property) && property.name.getText() === 'query',
      );
      if (!query) {
        unreadable(call, 'The request body has no static query.');
        return;
      }
      value = unwrap(query.initializer);
    }
    if (ts.isConditionalExpression(value)) {
      documentArgument(value.whenTrue, file, call, helpers);
      documentArgument(value.whenFalse, file, call, helpers);
      return;
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
    if (access && property !== undefined) {
      const container = scoped(base as ts.Identifier, file) ?? constant(file, base.getText());
      const item = container && memberOf(container.node, property);
      if (item) return documentArgument(item, container.file, call, helpers);
    }
    let owner = file;
    if (ts.isIdentifier(value)) {
      const resolved = scoped(value, file) ?? constant(file, value.text);
      const parameter = resolved ? undefined : declarationOf(value)?.node;
      if (resolved) {
        value = resolved.node;
        owner = resolved.file;
      } else if (
        parameter &&
        ts.isParameter(parameter) &&
        ts.isIdentifier(parameter.name) &&
        !parameter.dotDotDotToken
      ) {
        const fn = parameter.parent;
        const index = fn.parameters.indexOf(parameter);
        const key = `${fn.getSourceFile().fileName}:${fn.pos}:${index}`;
        if (helpers.has(key)) return;
        const flows = functionFlows(fn);
        if (flows.calls.length || flows.escapes.length) {
          for (const invocation of flows.calls) {
            const argument = invocation.arguments[index];
            if (invocation.arguments.slice(0, index + 1).some(ts.isSpreadElement))
              unreadable(
                invocation,
                'The call spreads its arguments, so Refit cannot tell which one is the GraphQL document.',
              );
            else if (argument)
              documentArgument(
                argument,
                invocation.getSourceFile().fileName,
                invocation,
                new Set([...helpers, key]),
              );
            else unreadable(invocation, 'The helper call passes no GraphQL document.');
          }
          for (const entry of flows.escapes) unreadable(entry.node, entry.reason);
          return;
        }
      }
      // `const mutation = isCode ? CODE_MUTATION : AUTOMATIC_MUTATION`
      if (ts.isConditionalExpression(value)) return documentArgument(value, owner, call, helpers);
    }
    if (isLiteral(value)) record(value, owner, true, call);
    else
      unreadable(
        call,
        'The document is built at runtime; Refit only reads literal or constant documents.',
      );
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
