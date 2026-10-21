import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-compiler';
import { analyzeRepository } from './analyzer.ts';
import type { DeadlineEntry, DeadlineRegistry } from './deadline-registry.ts';
import { daysUntil } from './deadline-registry.ts';
import { TEST_PATH } from './deadline-exposure.ts';
import { renderPatch } from './patches.ts';
import { readProviderAdapter, type ProviderAdapter } from './providers.ts';
import { readRepository } from './repository.ts';
import { createSourceImportResolver } from './source-imports.ts';
import {
  EMPTY_MODEL_PARAMETERS,
  MODEL_PARAMETER_NAMES,
  parameterReason,
  parameterVerdict,
  type ModelParameterTable,
} from './model-parameters.ts';
import type { Repository, SourceEdit } from './types.ts';

// Text-generation calls whose `model` selects a chat or reasoning model. Embeddings, images, audio,
// moderation and legacy completions are left out: their replacements change vector sizes, formats,
// endpoints or parameters.
const MODEL_CALLS: Record<string, Set<string>> = {
  openai: new Set([
    'chat.completions.create',
    'chat.completions.parse',
    'chat.completions.stream',
    'beta.chat.completions.parse',
    'beta.chat.completions.stream',
    'responses.create',
    'responses.parse',
    'responses.stream',
  ]),
  anthropic: new Set([
    'messages.create',
    'messages.stream',
    'messages.countTokens',
    'beta.messages.create',
    'beta.messages.stream',
    'beta.messages.countTokens',
  ]),
};

// The OpenAI v3 SDK and openai-edge, which keeps its API: methods on an `OpenAIApi` client.
function legacyOpenAi(packageName: string): ProviderAdapter {
  return {
    id: 'openai',
    packageName,
    defaultImport: false,
    namedExport: 'OpenAIApi',
    operations: [],
  };
}

// How each provider's model-bearing calls are traced. The Anthropic adapter is not in the agent
// catalog yet (Anthropic publishes no contract for `refit run`), but it traces the same calls.
const TRACERS: {
  provider: DeadlineEntry['provider'];
  adapter: URL | ProviderAdapter;
  resourceCalls?: Set<string>;
  clientCalls?: Set<string>;
  // The client is not the provider's own endpoint, so its requests only ever stop for review.
  custom?: boolean;
}[] = [
  {
    provider: 'openai',
    adapter: new URL('../examples/openai.provider.json', import.meta.url),
    resourceCalls: MODEL_CALLS.openai,
  },
  {
    // `model` on an Azure client is a deployment name (WR-04).
    provider: 'openai',
    adapter: { ...legacyOpenAi('openai'), namedExport: 'AzureOpenAI' },
    resourceCalls: MODEL_CALLS.openai,
    custom: true,
  },
  ...['openai', 'openai-edge'].map((packageName) => ({
    provider: 'openai' as const,
    adapter: legacyOpenAi(packageName),
    clientCalls: new Set(['createChatCompletion']),
  })),
  {
    provider: 'anthropic',
    adapter: new URL('../examples/anthropic.provider.json', import.meta.url),
    resourceCalls: MODEL_CALLS.anthropic,
  },
];
// Claude API model IDs such as `claude-opus-4-8` or `claude-haiku-4-5-20251001`.
const CLAUDE_VERSIONED = /^claude-(?:opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;

// Whether a replacement model is one on which Anthropic rejects non-default sampling parameters:
// Claude 4.7 and later models, per the Anthropic model deprecations page (2026-10-20). Unrecognized
// IDs are treated as rejecting them, so the request stops for review. This serves replacements with
// no entry in data/model-parameters.json; an entry there overrides it per parameter.
function rejectsSampling(provider: string, model: string) {
  if (provider !== 'anthropic') return true;
  const match = CLAUDE_VERSIONED.exec(model);
  if (!match) return true;
  const [major, minor] = [Number(match[1]), Number(match[2] ?? 0)];
  return major > 4 || (major === 4 && minor >= 7);
}
const MODEL_ID = /^[a-z0-9][a-z0-9.-]*$/;
const MAX_CHAIN = 8;

export interface ModelReplacement {
  deadline: string;
  provider: DeadlineEntry['provider'];
  date: string;
  days: number;
  file: string;
  line: number;
  call: string;
  // Where the model string is edited: the call itself, a constant, an enum member, a parameter
  // default or a helper's caller.
  edited: { file: string; line: number };
  from: string;
  to: string;
  // Registry deadlines followed from `from` to `to`, when a replacement retires too.
  via: string[];
}

export interface ModelReplacementStop {
  deadline: string;
  provider: DeadlineEntry['provider'];
  file: string;
  line: number;
  call: string;
  // Where the model string is written.
  at: { file: string; line: number };
  model: string;
  reason: string;
}

export interface ModelReplacementProposal {
  replacements: ModelReplacement[];
  stops: ModelReplacementStop[];
  // A unified diff of every replacement; null when there is none. Never applied by Refit.
  patch: string | null;
}

// The model a retiring one should become: the registry replacement, followed while it retires
// too. Null when an entry names no concrete model ID or the chain loops.
function finalReplacement(
  entry: DeadlineEntry,
  byModel: Map<string, DeadlineEntry>,
): { to: string; via: string[] } | null {
  const via = [entry.id];
  let current = entry;
  for (let step = 0; step < MAX_CHAIN; step += 1) {
    const next = current.replacement?.trim();
    if (!next || !MODEL_ID.test(next)) return null;
    const retiring = byModel.get(next);
    if (!retiring) return { to: next, via };
    if (via.includes(retiring.id)) return null;
    via.push(retiring.id);
    current = retiring;
  }
  return null;
}

function propertyName(name: ts.PropertyName) {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
}

function unwrap(expression: ts.Expression): ts.Expression {
  while (
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isParenthesizedExpression(expression) ||
    ts.isNonNullExpression(expression)
  )
    expression = expression.expression;
  return expression;
}

function sdkImported(content: string, packageName: string) {
  return [`'${packageName}'`, `"${packageName}"`, `'${packageName}/`, `"${packageName}/`].some(
    (needle) => content.includes(needle),
  );
}

// Raw HTTP requests to the official endpoints, with the request body sent through `JSON.stringify`:
// `fetch(url, { body })`, Apps Script's `UrlFetchApp.fetch(url, { payload })`, `axios.post(url, data)`
// and axios request configs. Only the text-generation endpoints are edited (`text`); the others stop
// for review. Only JSON-body endpoints are listed: multipart ones never reach this rule.
// Source: openai/openai-openapi openapi.yaml, info.version 2.3.0, read 2026-10-21; Anthropic
// platform.claude.com completions page, "POST /v1/complete" (deprecated), checked 2026-10-21.
const RAW_ENDPOINTS: { provider: DeadlineEntry['provider']; pattern: RegExp; text: boolean }[] = [
  {
    provider: 'openai',
    pattern: /api\.openai\.com\/v1\/(?:chat\/completions|responses)(?![\w/-])/,
    text: true,
  },
  {
    provider: 'openai',
    pattern:
      /api\.openai\.com\/v1\/(?:images\/generations|images\/edits|audio\/speech|embeddings|moderations|completions)(?![\w/-])/,
    text: false,
  },
  { provider: 'anthropic', pattern: /api\.anthropic\.com\/v1\/messages(?![\w/-])/, text: true },
  { provider: 'anthropic', pattern: /api\.anthropic\.com\/v1\/complete(?![\w/-])/, text: false },
];

// A TypeScript program over the repository's own sources, so references can be resolved across
// files: imports, re-exported constants, enum members and helper functions.
function sourceProgram(repository: Repository) {
  const sources = new Map(
    repository.files.map((file) => [resolve(repository.root, file.path), file.content]),
  );
  const resolution = createSourceImportResolver(repository, sources);
  const options: ts.CompilerOptions = {
    allowJs: true,
    noLib: true,
    target: ts.ScriptTarget.Latest,
  };
  const host = ts.createCompilerHost(options);
  host.fileExists = (name) => sources.has(name);
  host.readFile = (name) => sources.get(name);
  host.resolveModuleNames = (names, containingFile) =>
    names.map((name) => {
      const path = resolution.resolve(name, containingFile);
      return path ? { resolvedFileName: path } : undefined;
    });
  host.getSourceFile = (name, languageVersion) => {
    const content = sources.get(name);
    return content === undefined
      ? undefined
      : ts.createSourceFile(name, content, languageVersion, true);
  };
  const program = ts.createProgram([...sources.keys()], options, host);
  const checker = program.getTypeChecker();
  const paths = new Map(
    [...sources.keys()].map((path, index) => [path, repository.files[index].path]),
  );
  const files = program
    .getSourceFiles()
    .filter(
      (source) => paths.has(source.fileName) && !program.getSyntacticDiagnostics(source).length,
    );
  const symbolOf = (node: ts.Node) => {
    let symbol =
      ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
    for (let depth = 0; symbol && symbol.flags & ts.SymbolFlags.Alias && depth < 8; depth += 1)
      symbol = checker.getAliasedSymbol(symbol);
    return symbol;
  };
  // The symbol as written, without following imports (an uninstalled package resolves to nothing).
  const bindingOf = (node: ts.Node) => checker.getSymbolAtLocation(node);
  // Every use of each symbol in the repository: identifiers that are not its declaration name and
  // not part of an import or export.
  // Built per name on first use: only constants and helpers a request reaches are looked up.
  const byName = new Map<
    string,
    { uses: Map<ts.Symbol, ts.MemberName[]>; assigns: Map<ts.Symbol, ts.Expression[]> }
  >();
  // A default export's symbol is named `default`, while its uses are written with the local name
  // it is declared under or imported as.
  let defaultNames: Set<string> | undefined;
  const defaultImports = () => {
    if (!defaultNames) {
      defaultNames = new Set();
      for (const source of files)
        for (const statement of source.statements)
          if (ts.isImportDeclaration(statement) && statement.importClause?.name)
            defaultNames.add(statement.importClause.name.text);
    }
    return defaultNames;
  };
  // Every `import { a as b }` and `export { a as b }`: a use of `a` can be written as `b`, and
  // again under a third name in the next module (CR-01).
  let renames: [string, string][] | undefined;
  const renamed = () => {
    if (!renames) {
      renames = [];
      for (const source of files)
        for (const statement of source.statements) {
          const bindings = ts.isImportDeclaration(statement)
            ? statement.importClause?.namedBindings
            : ts.isExportDeclaration(statement)
              ? statement.exportClause
              : undefined;
          if (bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)))
            for (const item of bindings.elements)
              if (item.propertyName) renames.push([item.propertyName.text, item.name.text]);
        }
    }
    return renames;
  };
  // `export default X` makes X reachable under whatever name a module imports its default as.
  let defaultsExported: Set<string> | undefined;
  const exportedAsDefault = () => {
    if (!defaultsExported) {
      defaultsExported = new Set();
      for (const source of files)
        for (const statement of source.statements)
          if (
            ts.isExportAssignment(statement) &&
            !statement.isExportEquals &&
            ts.isIdentifier(statement.expression)
          )
            defaultsExported.add(statement.expression.text);
    }
    return defaultsExported;
  };
  // A private field's symbol is named `__#1@#model`; its identifier text is `#model`. Uses are
  // attributed by symbol, so a use under another local name counts as long as its name is scanned.
  const indexOf = (symbol: ts.Symbol) => {
    const name = symbol.name.replace(/^__#\d+@/, '');
    let index = byName.get(name);
    if (!index) {
      index = { uses: new Map(), assigns: new Map() };
      const names =
        name === 'default'
          ? new Set([
              ...defaultImports(),
              ...files.flatMap((source) =>
                source.statements.flatMap((statement) =>
                  (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
                  statement.name &&
                  statement.modifiers?.some((item) => item.kind === ts.SyntaxKind.DefaultKeyword)
                    ? [statement.name.text]
                    : [],
                ),
              ),
            ])
          : new Set([name]);
      for (let grown = true; grown;) {
        const before = names.size;
        for (const [from, to] of renamed()) {
          if (names.has(from) || (name === 'default' && from === 'default')) names.add(to);
          if (to === 'default' && names.has(from))
            for (const item of defaultImports()) names.add(item);
        }
        for (const item of exportedAsDefault())
          if (names.has(item)) for (const local of defaultImports()) names.add(local);
        grown = names.size > before;
      }
      for (const source of files) {
        if (![...names].some((item) => source.text.includes(item))) continue;
        const visit = (node: ts.Node) => {
          if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && names.has(node.text)) {
            const assignment = assignmentTarget(node);
            const resolved =
              assignment ||
              (!declarationName(node) && !(ts.isIdentifier(node) && moduleBinding(node)))
                ? symbolOf(node)
                : undefined;
            if (resolved && assignment)
              index!.assigns.set(resolved, [
                ...(index!.assigns.get(resolved) ?? []),
                assignment.right,
              ]);
            else if (resolved)
              index!.uses.set(resolved, [...(index!.uses.get(resolved) ?? []), node]);
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
      byName.set(name, index);
    }
    return index;
  };
  // Every class in the repository with the class it extends, when that resolves to one.
  let classList: Map<ts.ClassLikeDeclaration, ts.ClassLikeDeclaration | undefined> | undefined;
  // Whether some class extends something that is neither a class declaration nor an external
  // name: a mixin call, a class expression, an aliased or computed base. Any class may be its base.
  const unknownClasses = new Set<ts.ClassLikeDeclaration>();
  let unknownBase = false;
  const classes = () => {
    if (!classList) {
      const list = new Map<ts.ClassLikeDeclaration, ts.ClassLikeDeclaration | undefined>();
      classList = list;
      const visit = (node: ts.Node) => {
        if (ts.isClassLike(node)) {
          const base = node.heritageClauses?.find(
            (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
          )?.types[0]?.expression;
          const name = base && (ts.isPropertyAccessExpression(base) ? base.name : base);
          const target = name && ts.isIdentifier(name) ? symbolOf(name) : undefined;
          const declaration = target?.valueDeclaration;
          const resolved = declaration && ts.isClassLike(declaration) ? declaration : undefined;
          list.set(node, resolved);
          // A name that resolves to no declaration is a global or an uninstalled package.
          if (
            base &&
            !resolved &&
            (!name || !ts.isIdentifier(name) || target?.declarations?.length)
          ) {
            unknownBase = true;
            unknownClasses.add(node);
          }
        }
        ts.forEachChild(node, visit);
      };
      for (const source of files) visit(source);
    }
    return classList;
  };
  const unknownBases = () => {
    classes();
    return unknownBase;
  };
  const topClass = (cls: ts.ClassLikeDeclaration) => {
    let top = cls;
    for (let depth = 0; depth < MAX_CHAIN; depth += 1) {
      const base = classes().get(top);
      if (!base) break;
      top = base;
    }
    return top;
  };
  // Every other class in the same inheritance tree: ancestors, descendants and siblings.
  const relatives = (cls: ts.ClassLikeDeclaration) => {
    const top = topClass(cls);
    return [...classes().keys()].filter(
      (item) => item !== cls && (topClass(item) === top || unknownClasses.has(item)),
    );
  };
  // The classes that extend `cls`, directly or not.
  const subclasses = (cls: ts.ClassLikeDeclaration) =>
    relatives(cls).filter((item) => {
      if (unknownClasses.has(item)) return true;
      for (let up = classes().get(item), depth = 0; up && depth < MAX_CHAIN; depth += 1) {
        if (up === cls) return true;
        up = classes().get(up);
      }
      return false;
    });
  // Modules some code loads in a way the tracer cannot follow: `import()`, `require()`, a glob
  // import, `export *`, or a namespace used for anything but `ns.name` (a computed key, a
  // destructuring, a pass-along). Every export of such a module has unknown uses, and so does
  // every module it re-exports. A load whose specifier cannot be read makes every module opaque.
  let opaqueModules: { all: boolean; paths: Set<string> } | undefined;
  const opaqueIndex = () => {
    if (opaqueModules) return opaqueModules;
    const found = { all: false, paths: new Set<string>() };
    opaqueModules = found;
    const edges: [string, string][] = [];
    const target = (specifier: ts.Expression | undefined, from: ts.SourceFile) => {
      if (!specifier || !ts.isStringLiteralLike(specifier)) return undefined;
      return resolution.resolve(specifier.text, from.fileName) ?? undefined;
    };
    const load = (specifier: ts.Expression | undefined, from: ts.SourceFile) => {
      if (!specifier || !ts.isStringLiteralLike(specifier)) found.all = true;
      else {
        const path = target(specifier, from);
        if (path) found.paths.add(path);
      }
    };
    for (const source of files) {
      // Local names this file imports by static `import`, with the module each comes from.
      const imported = new Map<string, string>();
      for (const statement of source.statements) {
        if (ts.isImportDeclaration(statement)) {
          const path = target(statement.moduleSpecifier, source);
          const clause = statement.importClause;
          if (path && clause) {
            if (clause.name) imported.set(clause.name.text, path);
            const bindings = clause.namedBindings;
            if (bindings && ts.isNamespaceImport(bindings)) {
              imported.set(bindings.name.text, path);
              // Any identifier of that name, so a shadowing one only blocks more.
              const visit = (node: ts.Node) => {
                if (
                  ts.isIdentifier(node) &&
                  node.text === bindings.name.text &&
                  node !== bindings.name
                ) {
                  const parent = node.parent;
                  if (
                    !(ts.isPropertyAccessExpression(parent) && parent.expression === node) &&
                    !ts.isQualifiedName(parent)
                  )
                    found.paths.add(path);
                }
                ts.forEachChild(node, visit);
              };
              visit(source);
            } else if (bindings)
              for (const item of bindings.elements) imported.set(item.name.text, path);
          }
        } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
          const path = target(statement.moduleSpecifier, source);
          if (path) {
            // `export *` and `export * as ns` hide which name is used.
            if (!statement.exportClause || ts.isNamespaceExport(statement.exportClause))
              found.paths.add(path);
            edges.push([source.fileName, path]);
          }
        } else if (
          ts.isImportEqualsDeclaration(statement) &&
          ts.isExternalModuleReference(statement.moduleReference)
        )
          load(statement.moduleReference.expression, source);
      }
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) {
          const callee = node.expression;
          if (
            callee.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(callee) && callee.text === 'require')
          )
            load(node.arguments[0], source);
          else if (
            ts.isPropertyAccessExpression(callee) &&
            ((ts.isMetaProperty(callee.expression) && callee.name.text.startsWith('glob')) ||
              (ts.isIdentifier(callee.expression) &&
                callee.expression.text === 'require' &&
                callee.name.text === 'context'))
          )
            found.all = true;
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      // A name imported from a module and exported again makes that module reachable through this
      // one.
      for (const statement of source.statements) {
        const names =
          ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause
            ? ts.isNamedExports(statement.exportClause)
              ? statement.exportClause.elements.map((item) => (item.propertyName ?? item.name).text)
              : []
            : ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)
              ? [statement.expression.text]
              : [];
        for (const name of names) {
          const path = imported.get(name);
          if (path) edges.push([source.fileName, path]);
        }
      }
    }
    for (let grown = true; grown;) {
      grown = false;
      for (const [from, to] of edges)
        if (found.paths.has(from) && !found.paths.has(to)) {
          found.paths.add(to);
          grown = true;
        }
    }
    return found;
  };
  const opaque = (source: ts.SourceFile) =>
    opaqueIndex().all || opaqueIndex().paths.has(source.fileName);
  const usesOf = (symbol: ts.Symbol) => indexOf(symbol).uses.get(symbol) ?? [];
  // The reference to a container: the identifier, or `ns.Name` when it is read through a namespace.
  const referenceOf = (use: ts.MemberName): ts.Node =>
    ts.isPropertyAccessExpression(use.parent) && use.parent.name === use ? use.parent : use;
  // `X.member` or `X['member']` that is only read: not assigned, deleted or incremented.
  const plainRead = (reference: ts.Node) => {
    const access = reference.parent;
    if (!(
      (ts.isPropertyAccessExpression(access) && access.expression === reference) ||
      (ts.isElementAccessExpression(access) &&
        access.expression === reference &&
        access.argumentExpression &&
        ts.isStringLiteralLike(unwrap(access.argumentExpression)))
    ))
      return false;
    const writer = access.parent;
    return !(
      (ts.isBinaryExpression(writer) &&
        writer.left === access &&
        writer.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        writer.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
      (ts.isDeleteExpression(writer) && writer.expression === access) ||
      ((ts.isPrefixUnaryExpression(writer) || ts.isPostfixUnaryExpression(writer)) &&
        (writer.operator === ts.SyntaxKind.PlusPlusToken ||
          writer.operator === ts.SyntaxKind.MinusMinusToken))
    );
  };
  // Whether every reference to a symbol is a plain read of one of its members.
  const onlyMemberReads = (symbol: ts.Symbol | undefined) =>
    Boolean(symbol) && usesOf(symbol!).every((use) => inType(use) || plainRead(referenceOf(use)));
  // A `new C(...)` whose instance is only read through `.member`: directly, or through a variable
  // every use of which does the same.
  const instanceReadOnly = (created: ts.NewExpression) => {
    const holder = created.parent;
    // Built and dropped: nothing reads it.
    if (ts.isExpressionStatement(holder)) return true;
    if (
      ts.isVariableDeclaration(holder) &&
      holder.initializer === created &&
      ts.isIdentifier(holder.name)
    )
      return onlyMemberReads(symbolOf(holder.name));
    return plainRead(created);
  };
  const containers = new Map<ts.Node, boolean>();
  // Whether an enum, or the class a field belongs to (with its subclasses), is used as a whole
  // somewhere: `Object.values(E)`, `const X = E`, `E[k]`, a spread or destructuring, `this` passed
  // along, an instance handed on. Reads of a member and `this.member` are not. Unsure means yes.
  const containerEscape = (
    declaration: ts.Declaration | undefined,
  ): 'enum' | 'class' | undefined => {
    if (!declaration) return undefined;
    if (ts.isEnumMember(declaration)) {
      const key = declaration.parent;
      let escaped = containers.get(key);
      if (escaped === undefined) {
        escaped = !onlyMemberReads(symbolOf(key.name));
        containers.set(key, escaped);
      }
      return escaped ? 'enum' : undefined;
    }
    const owner = ts.isParameter(declaration) ? declaration.parent.parent : declaration.parent;
    if (
      !ts.isClassLike(owner) ||
      !(ts.isPropertyDeclaration(declaration) || ts.isParameter(declaration))
    )
      return undefined;
    let escaped = containers.get(owner);
    if (escaped === undefined) {
      escaped = [owner, ...subclasses(owner)].some((cls) => {
        if (!cls.name) return true;
        const bound = symbolOf(cls.name);
        if (!bound) return true;
        let thisEscapes = false;
        const visit = (node: ts.Node) => {
          if (node.kind === ts.SyntaxKind.ThisKeyword) {
            const parent = node.parent;
            if (!(
              (ts.isPropertyAccessExpression(parent) && parent.expression === node) ||
              (ts.isElementAccessExpression(parent) &&
                parent.expression === node &&
                parent.argumentExpression &&
                ts.isStringLiteralLike(unwrap(parent.argumentExpression)))
            ))
              thisEscapes = true;
          }
          ts.forEachChild(node, visit);
        };
        for (const member of cls.members) visit(member);
        return (
          thisEscapes ||
          usesOf(bound).some((use) => {
            if (inType(use)) return false;
            const reference = referenceOf(use);
            const parent = reference.parent;
            if (ts.isNewExpression(parent) && parent.expression === reference)
              return !instanceReadOnly(parent);
            if (ts.isExpressionWithTypeArguments(parent) && ts.isHeritageClause(parent.parent))
              return false;
            return !plainRead(reference);
          })
        );
      });
      containers.set(owner, escaped);
    }
    return escaped ? 'class' : undefined;
  };

  // The right-hand side of every `x.name = value` in the repository, for a field's symbol.
  const assignmentsOf = (symbol: ts.Symbol) => indexOf(symbol).assigns.get(symbol) ?? [];
  return {
    files,
    symbolOf,
    bindingOf,
    usesOf,
    assignmentsOf,
    relatives,
    subclasses,
    unknownBases,
    opaque,
    containerEscape,
    path: (node: ts.Node) => paths.get(node.getSourceFile().fileName)!,
    line: (node: ts.Node) =>
      node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1,
    source: (path: string) => files.find((source) => paths.get(source.fileName) === path),
  };
}
type SourceProgram = ReturnType<typeof sourceProgram>;

// `x.name = value` where `node` is the name: the assignment.
function assignmentTarget(node: ts.MemberName) {
  const parent = node.parent;
  return ts.isPropertyAccessExpression(parent) &&
    parent.name === node &&
    ts.isBinaryExpression(parent.parent) &&
    parent.parent.left === parent &&
    parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ? parent.parent
    : undefined;
}

function declarationName(node: ts.MemberName) {
  const parent = node.parent;
  return (
    ((ts.isVariableDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isParameter(parent) ||
      ts.isEnumMember(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isBindingElement(parent)) &&
      parent.name === node) ||
    Boolean(assignmentTarget(node))
  );
}

// Import and export bindings, including CommonJS `module.exports = { name }`, are not uses.
function moduleBinding(node: ts.Identifier) {
  if (
    ts.isImportSpecifier(node.parent) ||
    ts.isImportClause(node.parent) ||
    ts.isNamespaceImport(node.parent) ||
    ts.isImportEqualsDeclaration(node.parent) ||
    ts.isExportSpecifier(node.parent) ||
    ts.isExportAssignment(node.parent)
  )
    return true;
  for (let current: ts.Node = node; current.parent; current = current.parent) {
    const up = current.parent;
    if (
      ts.isBinaryExpression(up) &&
      up.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      up.right === current &&
      /^(?:module\.)?exports\b/.test(up.left.getText())
    )
      return true;
    if (
      !ts.isObjectLiteralExpression(up) &&
      !ts.isShorthandPropertyAssignment(up) &&
      !ts.isPropertyAssignment(up)
    )
      return false;
  }
  return false;
}

// The traced call at an analyzer location: the call whose callee matches the traced expression.
function callAt(source: ts.SourceFile, line: number, column: number, expression: string) {
  const start = source.getPositionOfLineAndCharacter(line - 1, column - 1);
  const wanted = expression.replace(/\s+/g, '');
  let found: ts.CallExpression | undefined;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      node.getStart(source) === start &&
      node.expression.getText(source).replace(/\s+/g, '') === wanted
    )
      found = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// A string literal behind a URL argument: inline, or a const declared with one.
function urlText(program: SourceProgram, node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  const value = unwrap(node);
  if (ts.isStringLiteralLike(value)) return value.text;
  if (ts.isTemplateExpression(value)) return value.head.text;
  if (ts.isIdentifier(value)) {
    const declaration = program.symbolOf(value)?.valueDeclaration;
    if (
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      ts.isVariableDeclarationList(declaration.parent) &&
      declaration.parent.flags & ts.NodeFlags.Const
    )
      return urlText(program, declaration.initializer);
  }
  return undefined;
}

function objectProperty(object: ts.ObjectLiteralExpression, name: string) {
  return object.properties.find(
    (property): property is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      propertyName(property.name) === name,
  );
}

function propertyValue(property: ts.PropertyAssignment | ts.ShorthandPropertyAssignment) {
  return unwrap(ts.isPropertyAssignment(property) ? property.initializer : property.name);
}

// Whether an expression is the `axios` module or an `axios.create(...)` instance: the default
// import, `require('axios')`, or a const initialized with either.
function axiosBinding(program: SourceProgram, node: ts.Expression, depth = 0): boolean {
  if (depth > 4) return false;
  const value = unwrap(node);
  if (ts.isCallExpression(value)) {
    const callee = value.expression;
    if (ts.isIdentifier(callee) && callee.text === 'require')
      return value.arguments.length === 1 && urlText(program, value.arguments[0]) === 'axios';
    return (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === 'create' &&
      axiosBinding(program, callee.expression, depth + 1)
    );
  }
  if (!ts.isIdentifier(value)) return false;
  const declaration = program.bindingOf(value)?.declarations?.[0];
  if (declaration && ts.isImportClause(declaration))
    return (
      declaration.name !== undefined &&
      ts.isStringLiteral(declaration.parent.moduleSpecifier) &&
      declaration.parent.moduleSpecifier.text === 'axios'
    );
  return Boolean(
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer &&
    axiosBinding(program, declaration.initializer, depth + 1),
  );
}

// The request body of a raw HTTP call to an official endpoint, before `JSON.stringify`.
function rawRequest(program: SourceProgram, call: ts.CallExpression) {
  const callee = call.expression;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : '';
  // `axios({ url, data })` and `axios.request({ url, data })`, also on an `axios.create` instance.
  const config =
    (ts.isIdentifier(callee) && axiosBinding(program, callee)) ||
    (ts.isPropertyAccessExpression(callee) &&
      name === 'request' &&
      axiosBinding(program, callee.expression));
  if (!config && name !== 'fetch' && name !== 'post') return undefined;
  const options = call.arguments[config ? 0 : 1] && unwrap(call.arguments[config ? 0 : 1]);
  const configUrl =
    config && options && ts.isObjectLiteralExpression(options)
      ? objectProperty(options, 'url')
      : undefined;
  const url = urlText(program, config ? configUrl && propertyValue(configUrl) : call.arguments[0]);
  const endpoint = url && RAW_ENDPOINTS.find((item) => item.pattern.test(url));
  if (!endpoint) return undefined;
  let body: ts.Expression | undefined;
  if (name === 'post' && !config) body = call.arguments[1];
  else {
    if (!options || !ts.isObjectLiteralExpression(options)) return undefined;
    const property = config
      ? objectProperty(options, 'data')
      : (objectProperty(options, 'body') ?? objectProperty(options, 'payload'));
    const value = property && propertyValue(property);
    // axios sends an object as JSON; fetch and UrlFetchApp need the `JSON.stringify` call.
    body =
      value &&
      ts.isCallExpression(value) &&
      value.expression.getText() === 'JSON.stringify' &&
      value.arguments.length === 1
        ? value.arguments[0]
        : config
          ? value
          : undefined;
  }
  if (!body) return undefined;
  const path = /\/v1\/[\w/]+/.exec(url)![0];
  const label = config ? (name === 'request' ? 'request' : 'axios') : name;
  return { provider: endpoint.provider, body, call: `${label} ${path}`, text: endpoint.text };
}

// A reference a literal was reached through, kept for the shared-use rule and the limit stops.
interface Pass {
  symbol: ts.Symbol;
  node: ts.Node;
  // The identifier that read the symbol, one of its uses.
  use: ts.MemberName;
  kind: 'constant' | 'enum member' | 'field' | 'function' | 'parameter' | 'binding';
  name: string;
  at: string;
  // For a parameter or binding: the property path read from it. A read of another property does
  // not change the model.
  keys?: string[];
}

interface Site {
  literal: ts.StringLiteralLike;
  passes: Pass[];
  // Why the site cannot be edited from this call, when it cannot.
  stop?: string;
}

// The request object a call sends: an object literal, or a const holding one that only this call
// uses.
function requestObject(program: SourceProgram, argument: ts.Expression | undefined) {
  if (!argument) return undefined;
  const value = unwrap(argument);
  if (ts.isObjectLiteralExpression(value)) return { object: value };
  if (!ts.isIdentifier(value)) return undefined;
  const symbol = program.symbolOf(value);
  const declaration = symbol?.valueDeclaration;
  if (
    !symbol ||
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    !declaration.initializer ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    !(declaration.parent.flags & ts.NodeFlags.Const)
  )
    return undefined;
  const object = unwrap(declaration.initializer);
  if (!ts.isObjectLiteralExpression(object)) return undefined;
  const uses = program.usesOf(symbol).length;
  return uses === 1
    ? { object }
    : {
        object,
        shared: `The request object ${value.text} (${program.path(declaration)}:${program.line(declaration)}) is used ${uses} times; change its model by hand to`,
      };
}

// The arguments a followed call binds to its function's parameters. `null` marks an argument that
// cannot be known (after a spread); `undefined` a missing one, which leaves the default.
interface CallContext {
  params: Map<ts.ParameterDeclaration, ts.Expression | null | undefined>;
  parent?: CallContext;
}

// `via` lists the call contexts whose arguments the literal was reached through.
interface Terminal extends Site {
  via?: Set<CallContext>;
}

interface Trace {
  depth: number;
  // Shared by the whole request: remaining steps, and results by declaration.
  budget: { left: number };
  memo: Map<ts.Node, Map<string, Terminal[]>>;
  ctx?: CallContext;
  // Set when the depth or work limit stopped a path, so it is known not to be fully followed.
  cut: { by?: 'depth' | 'budget' };
}

const MAX_DEPTH = 10;
const MAX_STEPS = 2000;

const copyTerminal = (terminal: Terminal): Terminal => ({
  ...terminal,
  passes: [...terminal.passes],
  via: terminal.via && new Set(terminal.via),
});

// A result by declaration, computed once per request. Not used inside a followed call, where
// parameters mean that call's arguments.
function cached(trace: Trace, key: ts.Node, keys: string[], compute: () => Terminal[]) {
  if (trace.ctx) return compute();
  const byKeys = trace.memo.get(key) ?? new Map<string, Terminal[]>();
  trace.memo.set(key, byKeys);
  const id = keys.join('.');
  let found = byKeys.get(id);
  if (!found) {
    byKeys.set(id, []);
    found = compute();
    byKeys.set(id, found);
  }
  return found.map(copyTerminal);
}

function through(pass: Pass, terminals: Terminal[]) {
  for (const terminal of terminals) terminal.passes.unshift(pass);
  return terminals;
}

// A type position (`typeof MODELS`, a type reference) does not use a value; `extends X` does.
function inType(node: ts.Node) {
  for (let up = node.parent; up; up = up.parent) {
    if (
      ts.isExpressionWithTypeArguments(up) &&
      ts.isHeritageClause(up.parent) &&
      up.parent.token === ts.SyntaxKind.ExtendsKeyword &&
      ts.isClassLike(up.parent.parent)
    )
      return false;
    if (ts.isTypeNode(up)) return true;
  }
  return false;
}

// The existing shared-source sentence, when some use of a symbol the model passed through is not
// a request this proposal reaches (D-09). `passes` run outermost first; the innermost reports.
function sharedUse(program: SourceProgram, passes: Pass[], reached: Set<ts.Node>) {
  for (const pass of [...passes].reverse()) {
    if (program.opaque(pass.node.getSourceFile()))
      return 'The module that declares this model is also loaded dynamically or through a namespace the tracer cannot follow; change it by hand to';
    const whole =
      pass.kind === 'enum member' || pass.kind === 'field'
        ? program.containerEscape(pass.symbol.valueDeclaration ?? pass.symbol.declarations?.[0])
        : undefined;
    if (whole)
      return `The model comes from the ${pass.kind} ${pass.name} (${pass.at}), and its ${whole} is also used as a whole, so a change shows up elsewhere; change it by hand to`;
    const all = program.usesOf(pass.symbol);
    const uses = all.filter(
      (use) =>
        !inType(use) &&
        !(
          pass.keys?.length &&
          ts.isPropertyAccessExpression(use.parent) &&
          use.parent.expression === use &&
          use.parent.name.text !== pass.keys[0]
        ),
    );
    if (!uses.includes(pass.use) || uses.some((use) => !reached.has(use)))
      return `The model comes from the ${pass.kind} ${pass.name} (${pass.at}), which is used ${all.length} times; change it by hand to`;
  }
  return undefined;
}

function returnsOf(fn: ts.FunctionLikeDeclaration) {
  if (!fn.body) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isReturnStatement(node)) {
      if (node.expression) found.push(node.expression);
      return;
    }
    if (!ts.isFunctionLike(node) && !ts.isClassLike(node)) ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return found;
}

const where = (program: SourceProgram, node: ts.Node) =>
  `${program.path(node)}:${program.line(node)}`;

// The literals an expression can hold, with `keys` as the property path still to read from it.
function valuesOf(
  program: SourceProgram,
  expression: ts.Expression,
  trace: Trace,
  keys: string[] = [],
): Terminal[] {
  if (trace.depth > MAX_DEPTH) {
    trace.cut.by ??= 'depth';
    return [];
  }
  if (trace.budget.left <= 0) {
    trace.cut.by = 'budget';
    return [];
  }
  trace.budget.left -= 1;
  const next = { ...trace, depth: trace.depth + 1 };
  const value = unwrap(expression);
  if (ts.isStringLiteralLike(value)) return keys.length ? [] : [{ literal: value, passes: [] }];
  if (ts.isAwaitExpression(value)) return valuesOf(program, value.expression, next, keys);
  if (ts.isConditionalExpression(value))
    return [
      ...valuesOf(program, value.whenTrue, next, keys),
      ...valuesOf(program, value.whenFalse, next, keys),
    ];
  if (
    ts.isBinaryExpression(value) &&
    [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(
      value.operatorToken.kind,
    )
  )
    return [
      ...valuesOf(program, value.left, next, keys),
      ...valuesOf(program, value.right, next, keys),
    ];
  // `flag && 'gpt-4'`: the right side is the model when the flag holds.
  if (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  )
    return valuesOf(program, value.right, next, keys);
  if (ts.isObjectLiteralExpression(value)) {
    const property = keys[0] ? objectProperty(value, keys[0]) : undefined;
    return property ? valuesOf(program, propertyValue(property), next, keys.slice(1)) : [];
  }
  if (ts.isCallExpression(value)) return callValues(program, value, next, keys);
  if (ts.isPropertyAccessExpression(value)) {
    const symbol = program.symbolOf(value.name);
    const declaration = symbol && (symbol.valueDeclaration ?? symbol.declarations?.[0]);
    // A getter or setter: whatever its getters (and those it overrides) return is stopped on.
    const accessors = symbol?.declarations?.filter(ts.isAccessor) ?? [];
    if (accessors.length) {
      const owner = { ...next, ctx: undefined };
      const found = [...accessors, ...accessors.flatMap((item) => relatedMembers(program, item))]
        .filter(ts.isGetAccessorDeclaration)
        .flatMap((getter) => returnsOf(getter))
        .flatMap((returned) => valuesOf(program, returned, owner, keys));
      for (const terminal of found) terminal.stop ??= inherited(`The accessor ${value.name.text}`);
      return found;
    }
    // A member with a declaration of its own (enum member, class field, a module's exported
    // constant); anything else is a property of whatever the owner holds.
    if (
      symbol &&
      declaration &&
      (ts.isEnumMember(declaration) ||
        ts.isVariableDeclaration(declaration) ||
        ts.isPropertyDeclaration(declaration) ||
        (ts.isParameter(declaration) && ts.isConstructorDeclaration(declaration.parent)) ||
        program.assignmentsOf(symbol).length)
    )
      return declarationValues(program, symbol, declaration, value.name, true, next, keys);
    return valuesOf(program, value.expression, next, [value.name.text, ...keys]);
  }
  // `MODELS['fast']`: a string-literal key reads the member like `MODELS.fast`. A computed key is
  // not traced.
  if (ts.isElementAccessExpression(value)) {
    const key = value.argumentExpression && unwrap(value.argumentExpression);
    if (!key || !ts.isStringLiteralLike(key)) return [];
    const symbol = program.symbolOf(key);
    const declaration = symbol && (symbol.valueDeclaration ?? symbol.declarations?.[0]);
    // An enum member or class field: its uses are identifiers, so the key never counts as one
    // and the shared-use check stops.
    if (
      symbol &&
      declaration &&
      (ts.isEnumMember(declaration) || ts.isPropertyDeclaration(declaration))
    )
      return declarationValues(
        program,
        symbol,
        declaration,
        key as unknown as ts.MemberName,
        true,
        next,
        keys,
      );
    return valuesOf(program, value.expression, next, [key.text, ...keys]);
  }
  if (!ts.isIdentifier(value)) return [];
  const symbol = program.symbolOf(value);
  const declaration = symbol?.valueDeclaration;
  return symbol && declaration
    ? declarationValues(program, symbol, declaration, value, false, next, keys)
    : [];
}

function declarationValues(
  program: SourceProgram,
  symbol: ts.Symbol,
  declaration: ts.Declaration,
  reference: ts.MemberName,
  member: boolean,
  trace: Trace,
  keys: string[],
): Terminal[] {
  const pass = (kind: Pass['kind'], node: ts.Node): Pass => ({
    symbol,
    node,
    use: reference,
    kind,
    name: reference.text,
    at: where(program, node),
  });
  const defaultExport =
    ts.isExportAssignment(declaration) && !declaration.isExportEquals ? declaration : undefined;
  if (
    (ts.isVariableDeclaration(declaration) &&
      ts.isVariableDeclarationList(declaration.parent) &&
      declaration.parent.flags & ts.NodeFlags.Const) ||
    ts.isEnumMember(declaration) ||
    defaultExport
  ) {
    const initializer = defaultExport
      ? defaultExport.expression
      : (declaration as ts.VariableDeclaration | ts.EnumMember).initializer;
    if (!initializer) return [];
    return cached(trace, declaration, keys, () =>
      through(
        pass(ts.isEnumMember(declaration) ? 'enum member' : 'constant', unwrap(initializer)),
        valuesOf(program, initializer, trace, keys),
      ),
    );
  }
  // Every other read of a parameter or binding must be a request too (WR-01).
  if (ts.isBindingElement(declaration))
    return through(
      { ...pass(ts.isParameter(root(declaration)) ? 'parameter' : 'binding', declaration), keys },
      bindingValues(program, declaration, trace, keys),
    );
  if (ts.isParameter(declaration) && !member)
    return through(
      { ...pass('parameter', declaration), keys },
      parameterValues(program, declaration, trace, keys),
    );
  // A field: its initializer, a constructor parameter property and every `this.name = value`.
  const assignments = program.assignmentsOf(symbol);
  if (
    !ts.isPropertyDeclaration(declaration) &&
    !ts.isPropertyAssignment(declaration) &&
    !ts.isParameter(declaration) &&
    !assignments.length
  )
    return [];
  const owner = { ...trace, ctx: undefined };
  return cached(owner, declaration, keys, () => {
    const found: Terminal[] = [];
    if (
      (ts.isPropertyDeclaration(declaration) || ts.isPropertyAssignment(declaration)) &&
      declaration.initializer
    )
      found.push(...valuesOf(program, declaration.initializer, owner, keys));
    if (ts.isParameter(declaration))
      found.push(...parameterValues(program, declaration, owner, keys));
    for (const assigned of assignments) found.push(...valuesOf(program, assigned, owner, keys));
    // A base field and its overrides: every one may be what a request reads.
    const related =
      ts.isPropertyDeclaration(declaration) || ts.isParameter(declaration)
        ? relatedMembers(program, declaration)
        : [];
    for (const other of related) {
      if (ts.isPropertyDeclaration(other) && other.initializer)
        found.push(...valuesOf(program, other.initializer, owner, keys));
      if (ts.isParameter(other)) found.push(...parameterValues(program, other, owner, keys));
      if (ts.isGetAccessorDeclaration(other))
        for (const returned of returnsOf(other))
          found.push(...valuesOf(program, returned, owner, keys));
      const otherName = (other as ts.NamedDeclaration).name;
      const otherSymbol = otherName && program.symbolOf(otherName);
      for (const assigned of otherSymbol ? program.assignmentsOf(otherSymbol) : [])
        found.push(...valuesOf(program, assigned, owner, keys));
    }
    const inClass = ts.isParameter(declaration)
      ? ts.isClassLike(declaration.parent.parent)
      : ts.isClassLike(declaration.parent);
    // An object member or static field assigned anywhere, or an instance field assigned through
    // another receiver than `this`, may be overwritten before a request reads it.
    const staticMember =
      ts.isPropertyDeclaration(declaration) &&
      declaration.modifiers?.some((item) => item.kind === ts.SyntaxKind.StaticKeyword);
    const overwritten = assignments.some(
      (assigned) =>
        ts.isPropertyAssignment(declaration) ||
        staticMember ||
        !(
          ts.isBinaryExpression(assigned.parent) &&
          ts.isPropertyAccessExpression(assigned.parent.left) &&
          assigned.parent.left.expression.kind === ts.SyntaxKind.ThisKeyword
        ),
    );
    if (overwritten)
      for (const terminal of found)
        terminal.stop ??= `The ${reference.text} member is also assigned to elsewhere, so a request may send another value; change it by hand to`;
    if (related.length || (inClass && program.unknownBases()))
      for (const terminal of found) terminal.stop ??= inherited(`The field ${reference.text}`);
    return through(pass('field', declaration), found);
  });
}

// The parameter or variable declaration a binding pattern belongs to.
function root(element: ts.BindingElement) {
  let node: ts.Node = element;
  while (ts.isBindingElement(node)) node = node.parent.parent;
  return node;
}

// `{ model = 'gpt-4' }` and `{ options: { model } }`: the default, and the property of whatever
// the pattern destructures.
function bindingValues(
  program: SourceProgram,
  element: ts.BindingElement,
  trace: Trace,
  keys: string[],
): Terminal[] {
  const found: Terminal[] = [];
  let tail = keys;
  let node: ts.Node = element;
  while (ts.isBindingElement(node)) {
    const name = node.propertyName ?? node.name;
    if (
      !ts.isObjectBindingPattern(node.parent) ||
      !(ts.isIdentifier(name) || ts.isStringLiteralLike(name))
    )
      return found;
    if (node.initializer) found.push(...valuesOf(program, node.initializer, trace, tail));
    tail = [name.text, ...tail];
    node = node.parent.parent;
  }
  if (ts.isParameter(node)) found.push(...parameterValues(program, node, trace, tail));
  else if (ts.isVariableDeclaration(node) && node.initializer)
    found.push(...valuesOf(program, node.initializer, trace, tail));
  return found;
}

// The name callers use for a function-like declaration: its own, the constant holding it, or the
// class a constructor belongs to.
function callableName(fn: ts.SignatureDeclaration) {
  return ts.isConstructorDeclaration(fn)
    ? fn.parent.name
    : ts.isFunctionDeclaration(fn) && fn.name
      ? fn.name
      : (ts.isFunctionExpression(fn) || ts.isArrowFunction(fn)) &&
          ts.isVariableDeclaration(fn.parent) &&
          ts.isIdentifier(fn.parent.name)
        ? fn.parent.name
        : ts.isMethodDeclaration(fn) && !ts.isComputedPropertyName(fn.name)
          ? fn.name
          : undefined;
}

// A parameter holds the argument of the call being followed; otherwise its default and the
// argument of every caller.
function parameterValues(
  program: SourceProgram,
  parameter: ts.ParameterDeclaration,
  trace: Trace,
  keys: string[],
): Terminal[] {
  for (let ctx = trace.ctx; ctx; ctx = ctx.parent) {
    if (!ctx.params.has(parameter)) continue;
    const argument = ctx.params.get(parameter);
    if (argument === null) return [];
    if (!argument)
      return parameter.initializer ? valuesOf(program, parameter.initializer, trace, keys) : [];
    const bound = ctx;
    return valuesOf(program, argument, { ...trace, ctx: ctx.parent }, keys).map((terminal) => ({
      ...terminal,
      via: new Set([...(terminal.via ?? []), bound]),
    }));
  }
  const found: Terminal[] = [];
  if (parameter.initializer) found.push(...valuesOf(program, parameter.initializer, trace, keys));
  const fn = parameter.parent;
  const index = fn.parameters.indexOf(parameter);
  const constructed = ts.isConstructorDeclaration(fn);
  const name = callableName(fn);
  const symbol = name && program.symbolOf(name);
  if (!name || !symbol) return found;
  const helperName = `${name.text} (${where(program, name)})`;
  const callers = { ...trace, ctx: undefined };
  // Applied to every terminal after the loop, so the result does not depend on the order of uses.
  let stopped: string | undefined;
  const take = (args: readonly ts.Expression[]) => {
    if (args.slice(0, index + 1).some((argument) => ts.isSpreadElement(argument))) {
      stopped ??= `The helper ${helperName} is called with spread arguments; change its model by hand to`;
      return;
    }
    if (args[index]) found.push(...valuesOf(program, args[index], callers, keys));
  };
  for (const use of program.usesOf(symbol)) {
    if (ts.isTypeReferenceNode(use.parent)) continue;
    // `extends Name`: the subclasses are followed below.
    if (
      ts.isExpressionWithTypeArguments(use.parent) &&
      ts.isHeritageClause(use.parent.parent) &&
      use.parent.parent.token === ts.SyntaxKind.ExtendsKeyword
    )
      continue;
    const callee =
      ts.isPropertyAccessExpression(use.parent) && use.parent.name === use ? use.parent : use;
    const call = callee.parent;
    if (
      !(ts.isCallExpression(call) || (constructed && ts.isNewExpression(call))) ||
      call.expression !== callee
    ) {
      // Passed as a value, the helper may be called with any model.
      stopped ??= `The helper ${helperName} is also passed as a value; change its model by hand to`;
      continue;
    }
    take(call.arguments ?? []);
  }
  // A subclass passes its own arguments up through `super(...)`, or inherits this constructor and
  // is built with `new Subclass(...)` (WR-02).
  if (constructed && program.unknownBases()) stopped ??= inherited(`The class ${name.text}`);
  if (constructed)
    for (const subclass of program.subclasses(fn.parent)) {
      stopped ??= inherited(`The class ${name.text}`);
      const constructor = subclass.members.find(ts.isConstructorDeclaration);
      if (constructor?.body) {
        const visit = (node: ts.Node) => {
          if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword)
            take(node.arguments);
          if (!ts.isClassLike(node)) ts.forEachChild(node, visit);
        };
        visit(constructor.body);
      } else {
        const own = subclass.name && program.symbolOf(subclass.name);
        for (const use of own ? program.usesOf(own) : [])
          if (ts.isNewExpression(use.parent) && use.parent.expression === use)
            take(use.parent.arguments ?? []);
      }
    }
  if (stopped) for (const site of found) site.stop ??= stopped;
  return found;
}

// Members of the same name in the other classes of an inheritance tree: what an override, an
// abstract declaration or a base field can send instead of the member a request resolves to (WR-02).
function relatedMembers(program: SourceProgram, declaration: ts.Declaration) {
  const owner = ts.isParameter(declaration) ? declaration.parent.parent : declaration.parent;
  const name =
    ts.isParameter(declaration) && ts.isIdentifier(declaration.name)
      ? declaration.name.text
      : (ts.isMethodDeclaration(declaration) ||
            ts.isPropertyDeclaration(declaration) ||
            ts.isAccessor(declaration)) &&
          !ts.isPrivateIdentifier(declaration.name)
        ? propertyName(declaration.name)
        : undefined;
  if (!name || !ts.isClassLike(owner)) return [];
  const found: ts.Declaration[] = [];
  // The class itself too: a getter or setter beside the field, or an overload of the method.
  for (const cls of [owner, ...program.relatives(owner)])
    for (const member of cls.members) {
      if (member === declaration) continue;
      if (
        (ts.isMethodDeclaration(member) ||
          ts.isPropertyDeclaration(member) ||
          ts.isAccessor(member)) &&
        !ts.isPrivateIdentifier(member.name) &&
        propertyName(member.name) === name
      )
        found.push(member);
      else if (ts.isConstructorDeclaration(member))
        for (const parameter of member.parameters)
          if (
            parameter !== declaration &&
            ts.isParameterPropertyDeclaration(parameter, member) &&
            ts.isIdentifier(parameter.name) &&
            parameter.name.text === name
          )
            found.push(parameter);
    }
  return found;
}

const inherited = (what: string) =>
  `${what} is declared or overridden in another class, is an accessor, or sits in a class tree the tracer cannot fully resolve, so the model cannot be traced through class inheritance; change it by hand to`;

// The function a member holds: a method, or a property initialized with one.
function memberFunction(member: ts.Declaration) {
  if (ts.isMethodDeclaration(member)) return member;
  const initializer =
    ts.isPropertyDeclaration(member) && member.initializer && unwrap(member.initializer);
  return initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
    ? initializer
    : undefined;
}

// A call resolves through the `return` statements of the function it calls.
function callValues(
  program: SourceProgram,
  call: ts.CallExpression,
  trace: Trace,
  keys: string[],
): Terminal[] {
  const callee = unwrap(call.expression);
  const name = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
  if (!ts.isIdentifier(name) && !ts.isPrivateIdentifier(name)) return [];
  const symbol = program.symbolOf(name);
  const declaration = symbol?.valueDeclaration;
  const initializer =
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    declaration.parent.flags & ts.NodeFlags.Const &&
    declaration.initializer
      ? unwrap(declaration.initializer)
      : undefined;
  const fn =
    declaration && (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration))
      ? declaration
      : initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
        ? initializer
        : undefined;
  if (!symbol || !fn) return [];
  const bound = fn.parameters.length > 0;
  const ctx: CallContext | undefined = bound
    ? {
        params: new Map(
          fn.parameters.map((parameter, index) => [
            parameter,
            call.arguments.slice(0, index + 1).some((argument) => ts.isSpreadElement(argument))
              ? null
              : call.arguments[index],
          ]),
        ),
        parent: trace.ctx,
      }
    : trace.ctx;
  // The override, or the abstract declaration's implementation, may be what runs.
  const related = ts.isMethodDeclaration(fn) ? relatedMembers(program, fn) : [];
  const treeUnknown =
    ts.isMethodDeclaration(fn) && ts.isClassLike(fn.parent) && program.unknownBases();
  const run = () => {
    const found = [fn, ...related.map(memberFunction)]
      .flatMap((item) => (item ? returnsOf(item) : []))
      .flatMap((returned) => valuesOf(program, returned, { ...trace, ctx }, keys));
    if (related.length || treeUnknown)
      for (const terminal of found) terminal.stop ??= inherited(`The method ${name.text}`);
    // A literal passed in as an argument belongs to this call only, not to the function.
    const own = found.filter((terminal) => !(bound && terminal.via?.delete(ctx!)));
    const pass: Pass = {
      symbol,
      node: fn,
      use: name,
      kind: 'function',
      name: name.text,
      at: where(program, name),
    };
    through(pass, own);
    return found;
  };
  return bound ? run() : cached(trace, fn, keys, run);
}

// Where the model a request sends is written, followed through constants, enum and object
// members (also in other modules), class fields, fallbacks, returned values and parameters, with
// the references each literal passed through. `cut` says whether a limit ended a path.
function modelSites(program: SourceProgram, value: ts.Expression) {
  const trace: Trace = { depth: 0, budget: { left: MAX_STEPS }, memo: new Map(), cut: {} };
  const sites = new Map<ts.StringLiteralLike, Site>();
  for (const { via: _via, ...site } of valuesOf(program, value, trace)) {
    const known = sites.get(site.literal);
    if (!known) sites.set(site.literal, site);
    else {
      known.stop ??= site.stop;
      known.passes = [...known.passes, ...site.passes];
    }
  }
  return { sites: [...sites.values()], cut: trace.cut.by };
}

// Text that points a client at another endpoint: a base URL option or variable, `withOptions`, or
// an Azure client (WR-01). Matched case-insensitively anywhere, so a const options object, a
// spread, an assignment and an environment variable need no tracing.
const ENDPOINT_TEXT = /base_?url|basepath|openai_api_base|withoptions\(|azureopenai/i;
const CONFIG_FILE = /^\.env(?:\..*)?$|\.env$|\.(?:json|ya?ml)$/i;
// Compiler and lockfile settings that never configure a client.
const NOT_CONFIG =
  /^(?:[jt]sconfig[\w.-]*\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml)$/i;
const MAX_CONFIG_FILES = 5000;
const MAX_CONFIG_BYTES = 1024 * 1024;

// Whether any source or configuration file (`.env*`, JSON, YAML, outside node_modules) in the
// repository mentions a custom endpoint. Which client sends a request is not traced, so one match
// puts every SDK request in doubt: the model may name another provider's model or a deployment.
// An unreadable or oversized file, or too many files, counts as a match.
async function customEndpoint(directory: string, repository: Repository) {
  if (repository.files.some((file) => ENDPOINT_TEXT.test(file.content))) return true;
  let count = 0;
  const visit = async (path: string): Promise<boolean> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git' && (await visit(full)))
          return true;
      } else if (entry.isFile() && CONFIG_FILE.test(entry.name) && !NOT_CONFIG.test(entry.name)) {
        count += 1;
        if (count > MAX_CONFIG_FILES || (await stat(full)).size > MAX_CONFIG_BYTES) return true;
        if (ENDPOINT_TEXT.test(await readFile(full, 'utf8'))) return true;
      }
    }
    return false;
  };
  try {
    return await visit(directory);
  } catch {
    return true;
  }
}

const SWEEP_CAP = 20_000;

// After a limit cut a request's trace: every string literal that can reach `start` by the same
// references as `valuesOf`, ignoring which call or property it came through. Each declaration is
// entered once and at most SWEEP_CAP expressions are visited, so it ends on any input. It finds a
// superset of the precise trace; the caller only ever stops on what it returns.
function sweepLiterals(
  program: SourceProgram,
  start: ts.Expression,
  wanted: (text: string) => boolean,
) {
  const found = new Set<ts.StringLiteralLike>();
  const entered = new Set<ts.Node>();
  const queue: ts.Node[] = [start];
  const enter = (node: ts.Node | undefined) => {
    if (node && !entered.has(node)) {
      entered.add(node);
      queue.push(node);
    }
  };
  const symbols = new Set<ts.Symbol>();
  const declared = (symbol: ts.Symbol) => {
    if (symbols.has(symbol)) return;
    symbols.add(symbol);
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isParameter(declaration)) {
        enter(declaration.initializer);
        argumentsOf(declaration);
      } else if (ts.isBindingElement(declaration)) {
        let node: ts.Node = declaration;
        while (ts.isBindingElement(node)) {
          enter(node.initializer);
          node = node.parent.parent;
        }
        if (ts.isParameter(node)) argumentsOf(node);
        else if (ts.isVariableDeclaration(node)) enter(node.initializer);
      } else if ('initializer' in declaration) {
        enter((declaration as { initializer?: ts.Expression }).initializer);
      }
    }
    for (const assigned of program.assignmentsOf(symbol)) enter(assigned);
  };
  // The argument every caller passes for a parameter.
  const argumentsOf = (parameter: ts.ParameterDeclaration) => {
    const fn = parameter.parent;
    const name = callableName(fn);
    const symbol = name && program.symbolOf(name);
    if (!symbol) return;
    const index = fn.parameters.indexOf(parameter);
    for (const use of program.usesOf(symbol)) {
      const callee =
        ts.isPropertyAccessExpression(use.parent) && use.parent.name === use ? use.parent : use;
      const call = callee.parent;
      if (
        (ts.isCallExpression(call) ||
          (ts.isConstructorDeclaration(fn) && ts.isNewExpression(call))) &&
        call.expression === callee
      )
        enter(call.arguments?.[index]);
    }
  };
  for (let visited = 0; queue.length && visited < SWEEP_CAP; visited += 1) {
    const value = unwrap(queue.pop() as ts.Expression);
    if (ts.isStringLiteralLike(value)) {
      if (wanted(value.text)) found.add(value);
    } else if (ts.isAwaitExpression(value)) enter(value.expression);
    else if (ts.isConditionalExpression(value)) {
      enter(value.whenTrue);
      enter(value.whenFalse);
    } else if (ts.isBinaryExpression(value)) {
      enter(value.left);
      enter(value.right);
    } else if (ts.isObjectLiteralExpression(value)) {
      for (const item of value.properties) {
        if (ts.isPropertyAssignment(item)) enter(item.initializer);
        else if (ts.isShorthandPropertyAssignment(item)) enter(item.name);
      }
    } else if (ts.isCallExpression(value)) {
      const callee = unwrap(value.expression);
      const name = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
      const symbol =
        (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) && program.symbolOf(name);
      for (const declaration of (symbol && symbol.declarations) || []) {
        const fn = ts.isVariableDeclaration(declaration)
          ? declaration.initializer && unwrap(declaration.initializer)
          : declaration;
        if (fn && ts.isFunctionLike(fn))
          for (const returned of returnsOf(fn as ts.FunctionLikeDeclaration)) enter(returned);
      }
    } else if (ts.isPropertyAccessExpression(value)) {
      const symbol = program.symbolOf(value.name);
      if (symbol?.declarations?.length) declared(symbol);
      enter(value.expression);
    } else if (ts.isIdentifier(value)) {
      const symbol = program.symbolOf(value);
      if (symbol) declared(symbol);
    }
  }
  return [...found];
}

// A number written directly in the request, optionally signed. Constants and expressions are not followed.
function numericLiteral(expression: ts.Expression): number | undefined {
  const node = unwrap(expression);
  let value: number | undefined;
  if (ts.isNumericLiteral(node)) value = Number(node.text);
  else if (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken) &&
    ts.isNumericLiteral(unwrap(node.operand))
  ) {
    const operand = Number((unwrap(node.operand) as ts.NumericLiteral).text);
    value = node.operator === ts.SyntaxKind.MinusToken ? -operand : operand;
  }
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

// Proposes replacing a retiring model ID with its registry replacement where a traced SDK call, or a
// raw HTTP request to an official text-generation endpoint, sends it as `model`, outside tests.
// Anything less certain stops for review with a reason. Nothing is written, applied, validated or
// sent to a provider: the proposal is a patch for a person to review.
export async function proposeModelReplacements(
  directory: string,
  registry: DeadlineRegistry,
  now: Date,
  parameters: ModelParameterTable = EMPTY_MODEL_PARAMETERS,
): Promise<ModelReplacementProposal> {
  const byProvider = new Map<string, Map<string, DeadlineEntry>>();
  for (const entry of registry.deadlines)
    if (entry.kind === 'model') {
      const models = byProvider.get(entry.provider) ?? new Map<string, DeadlineEntry>();
      byProvider.set(entry.provider, models);
      for (const version of entry.versions) models.set(version, entry);
    }
  const empty = { replacements: [], stops: [], patch: null };
  if (
    ![...byProvider.keys()].some((provider) =>
      TRACERS.some((tracer) => tracer.provider === provider),
    )
  )
    return empty;
  const repository = await readRepository(directory);
  // A model can only be edited where its ID is written, so a repository that never quotes a
  // retiring model of a provider needs no analysis for it.
  const quoted = (provider: string) =>
    [...(byProvider.get(provider)?.keys() ?? [])].some((model) =>
      repository.files.some(
        (file) =>
          file.content.includes(`'${model}'`) ||
          file.content.includes(`"${model}"`) ||
          file.content.includes(`\`${model}\``),
      ),
    );
  for (const provider of [...byProvider.keys()]) if (!quoted(provider)) byProvider.delete(provider);
  if (!byProvider.size) return empty;
  const program = sourceProgram(repository);
  // Every request a model can be read from: traced SDK calls first, then raw HTTP requests.
  const requests: {
    provider: DeadlineEntry['provider'];
    call: string;
    node: ts.CallExpression;
    argument: ts.Expression | undefined;
    // Text-generation calls Refit edits; every other traced call only stops for review.
    text: boolean;
    // A call on an SDK client, as opposed to a raw HTTP request to an official host.
    sdk: boolean;
    // A call on an Azure client.
    custom: boolean;
  }[] = [];
  const seen = new Set<ts.Node>();
  for (const tracer of TRACERS) {
    if (!byProvider.has(tracer.provider)) continue;
    const adapter =
      tracer.adapter instanceof URL
        ? await readProviderAdapter(fileURLToPath(tracer.adapter))
        : tracer.adapter;
    // The SDK must be imported somewhere, and a named-export client named, for any of its calls
    // to be traced.
    if (
      !repository.files.some(
        (file) =>
          sdkImported(file.content, adapter.packageName) &&
          (adapter.defaultImport ||
            !adapter.namedExport ||
            file.content.includes(adapter.namedExport)),
      )
    )
      continue;
    const analysis = analyzeRepository(
      await readRepository(directory, adapter.packageName),
      [],
      adapter,
    );
    // Every traced call is kept: one outside the text allow-list stops for review (D-16), so a
    // retiring model in an image, audio, embeddings or legacy completions call is never silent.
    const traced = [
      ...(tracer.resourceCalls ? analysis.sdkCalls : []).map((sdk) => {
        const call = `${sdk.resource}.${sdk.method}`;
        return { ...sdk, call, text: tracer.resourceCalls!.has(call) };
      }),
      ...(tracer.clientCalls ? analysis.clientMethodCalls : []).map((sdk) => ({
        ...sdk,
        call: sdk.method,
        text: tracer.clientCalls!.has(sdk.method),
      })),
    ];
    for (const sdk of traced) {
      const source = program.source(sdk.file);
      const node = source && callAt(source, sdk.line, sdk.column, sdk.expression);
      if (!node || seen.has(node)) continue;
      seen.add(node);
      requests.push({
        provider: tracer.provider,
        call: sdk.call,
        node,
        argument: node.arguments[0],
        text: sdk.text,
        sdk: true,
        custom: Boolean(tracer.custom),
      });
    }
  }
  for (const source of program.files) {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && !seen.has(node)) {
        const raw = rawRequest(program, node);
        if (raw && byProvider.has(raw.provider)) {
          seen.add(node);
          requests.push({
            provider: raw.provider,
            call: raw.call,
            node,
            argument: raw.body,
            text: raw.text,
            sdk: false,
            custom: false,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  // Each request's model sites with a decision. A site reached from several requests is edited
  // only when every one of them allows it.
  const decisions = new Map<
    ts.StringLiteralLike,
    {
      entry: DeadlineEntry;
      to: string;
      via: string[];
      reasons: string[];
      requests: (typeof requests)[number][];
    }
  >();
  const stops: ModelReplacementStop[] = [];
  // First pass: every reference a non-test request's model passes through, whatever the literal
  // and whether or not the request itself allows an edit. A shared source is edited only when all
  // of its uses are in this set (D-09).
  const reached = new Set<ts.Node>();
  const traced: {
    request: (typeof requests)[number];
    found: NonNullable<ReturnType<typeof requestObject>>;
    value: ts.Expression;
    trace: ReturnType<typeof modelSites>;
  }[] = [];
  for (const request of requests) {
    if (TEST_PATH.test(program.path(request.node))) continue;
    const found = requestObject(program, request.argument);
    const property = found && objectProperty(found.object, 'model');
    if (!found || !property) continue;
    const value = propertyValue(property);
    const trace = modelSites(program, value);
    for (const site of trace.sites) for (const pass of site.passes) reached.add(pass.use);
    traced.push({ request, found, value, trace });
  }
  const endpointSet = requests.some((request) => request.sdk && !request.custom)
    ? await customEndpoint(directory, repository)
    : false;
  for (const { request, found, value, trace } of traced) {
    const models = byProvider.get(request.provider)!;
    // A trace a limit cut cannot prove every source and use, so no literal it reaches is edited.
    // The literals a bounded sweep adds stop too.
    const sites: Site[] = [...trace.sites];
    if (trace.cut) {
      const known = new Set(sites.map((site) => site.literal));
      for (const literal of sweepLiterals(program, value, (text) => models.has(text)))
        if (!known.has(literal)) sites.push({ literal, passes: [] });
    }
    const limit =
      trace.cut &&
      `Tracing this model stopped at the ${
        trace.cut === 'budget'
          ? `work budget of ${MAX_STEPS.toLocaleString('en-US')} steps`
          : `depth limit of ${MAX_DEPTH}`
      }, so not every source and use could be checked; change it by hand to`;
    const customUrl = request.custom || (request.sdk && endpointSet);
    for (const site of sites) {
      const entry = models.get(site.literal.text);
      if (!entry || TEST_PATH.test(program.path(site.literal))) continue;
      const resolved = finalReplacement(entry, models) ?? { to: '', via: [entry.id] };
      const tabled = parameters.models.some(
        (item) => item.provider === request.provider && item.model === resolved.to,
      );
      const sensitiveProperties = found.object.properties.flatMap((item) => {
        const name = item.name && propertyName(item.name);
        return name && MODEL_PARAMETER_NAMES[request.provider].has(name) ? [{ item, name }] : [];
      });
      const sensitive = rejectsSampling(request.provider, resolved.to)
        ? sensitiveProperties.map(({ name }) => name)
        : [];
      const tableReasons = tabled
        ? sensitiveProperties.flatMap(({ item, name }) => {
            const value = ts.isPropertyAssignment(item)
              ? numericLiteral(item.initializer)
              : undefined;
            const verdict = parameterVerdict(
              parameters,
              request.provider,
              resolved.to,
              name,
              value,
            );
            return verdict.ok ? [] : [parameterReason(name, value, resolved.to, verdict)];
          })
        : [];
      const stop = site.stop ?? sharedUse(program, site.passes, reached);
      const reason = !resolved.to
        ? 'The registry names no concrete replacement model ID.'
        : // Images, audio, embeddings, moderation and legacy completions change formats, vector
          // sizes or parameters with the model, so they are never edited. The wording is accurate for
          // any call outside the text allow-list, such as beta.assistants.create (D-11, D-16).
          !request.text
          ? `\`${request.call}\` is not a call Refit edits; ${resolved.to} may change formats or parameters; change it by hand to ${resolved.to}.`
          : customUrl
            ? `The client sets a custom base URL, so the model may name another provider's model or a deployment; change it by hand to ${resolved.to}.`
            : limit
              ? `${limit} ${resolved.to}.`
              : stop
                ? `${stop} ${resolved.to}.`
                : found.shared
                  ? `${found.shared} ${resolved.to}.`
                  : found.object.properties.some((item) => ts.isSpreadAssignment(item))
                    ? 'The request spreads other options, which may set parameters the replacement rejects.'
                    : found.object.properties.some(
                          (item) => item.name && ts.isComputedPropertyName(item.name),
                        )
                      ? `The request sets a computed property, which may be a parameter the replacement rejects; change it by hand to ${resolved.to}.`
                      : tabled
                        ? tableReasons.join(' ') || undefined
                        : sensitive.length
                          ? `The request sets ${sensitive.join(', ')}, which ${resolved.to} may reject or treat differently.`
                          : undefined;
      const decision = decisions.get(site.literal) ?? {
        entry,
        ...resolved,
        reasons: [],
        requests: [],
      };
      decisions.set(site.literal, decision);
      decision.requests.push(request);
      decision.reasons.push(reason ?? '');
    }
  }

  const replacements: ModelReplacement[] = [];
  const edits: SourceEdit[] = [];
  for (const [literal, decision] of decisions) {
    const request = decision.requests[0];
    const base = {
      deadline: decision.entry.id,
      provider: decision.entry.provider,
      file: program.path(request.node),
      line: program.line(request.node),
      call: request.call,
    };
    const blocking = decision.reasons.find(Boolean);
    if (blocking) {
      stops.push({
        ...base,
        at: { file: program.path(literal), line: program.line(literal) },
        model: literal.text,
        reason: blocking,
      });
      continue;
    }
    const file = program.path(literal);
    const start = literal.getStart();
    const quote = literal.getSourceFile().text[start];
    edits.push({
      file,
      start,
      end: literal.end,
      replacement: `${quote}${decision.to}${quote}`,
      changeId: decision.entry.id,
      rule: 'model-retirement',
    });
    replacements.push({
      ...base,
      date: decision.entry.date,
      days: daysUntil(decision.entry.date, now),
      edited: { file, line: program.line(literal) },
      from: literal.text,
      to: decision.to,
      via: decision.via,
    });
  }
  return { replacements, stops, patch: edits.length ? renderPatch(repository, edits) : null };
}
