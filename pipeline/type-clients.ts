import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-compiler';
import { compilerOptions, SOURCE, stripeTypesEntry } from './stripe-ground-truth.ts';
import { stripePackageDirectory } from './stripe-type-evidence.ts';
import type { Repository } from './types.ts';

// Stripe clients found by type (docs/CLIENT-TRACING.md). A call `x.<resource>.<method>(…)` is a
// Stripe call when TypeScript's checker resolves `x` to stripe-node's client class from the stripe
// package's own declarations, whatever path the client took to get there (factories, injection,
// context objects, class fields, re-exports, Proxy forwarders). Casts can lie: a client whose type
// comes from a type assertion or `any` anywhere along its path is not traced. In JavaScript the
// checker often has no type, so a function or module whose every return or export is a
// `new Stripe(…)` is traced as `js-return`, with lower confidence (its findings stay for review).

// How a traced SDK call was traced.
export type TraceSource = 'analyzer' | 'type' | 'js-return';

export interface TypedClient {
  file: string;
  // The client expression, without parentheses or non-null assertions.
  start: number;
  end: number;
  source: 'type' | 'js-return';
  // No code in its program writes to a stripe-node client or resource object (`stripe.x = …`,
  // `delete`, `Object.assign`, `Object.defineProperty`), so every call on a client of this type
  // runs stripe-node's own method.
  sealed?: true;
}

// The checker builds a program per tsconfig project; larger repositories are reported, not traced.
const MAX_TYPED_FILES = 2_000;
const JAVASCRIPT = /\.[cm]?jsx?$/;
const NULLISH = /^(?:null|undefined)$/;

// Refit's own stripe-node, used when the repository has none installed (the benchmark and the
// hosted worker scan before dependencies are prepared). Only its declarations are read.
const BUNDLED_STRIPE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'node_modules',
  'stripe',
);

type TypedClients = { clients: TypedClient[]; skipped?: 'too-large' | 'no-stripe-types' };
// Declaration files outside the repository (stripe-node's, TypeScript's lib) never change during a
// run; parsing stripe-node's alone takes seconds, so programs share them.
const declarations = new Map<string, ts.SourceFile>();
// One type check per snapshot and stripe package: a run asks for the same snapshot several times.
const cache = new WeakMap<Repository['files'], Map<string, TypedClients>>();

export function typedStripeClients(repository: Repository, explicitPackage?: string) {
  const byPackage = cache.get(repository.files) ?? new Map<string, TypedClients>();
  cache.set(repository.files, byPackage);
  const key = `${repository.root}\0${explicitPackage ?? ''}`;
  const cached = byPackage.get(key);
  if (cached) return cached;
  const result = traceClients(repository, explicitPackage);
  byPackage.set(key, result);
  return result;
}

function traceClients(repository: Repository, explicitPackage?: string): TypedClients {
  const typed = typedPrograms(repository, explicitPackage);
  if (!('programs' in typed)) return { clients: [], ...typed };
  const clients: TypedClient[] = [];
  for (const { program, sources } of typed.programs)
    for (const [source, found] of programClients(program, sources, typed.inStripe))
      clients.push(...found.map((client) => ({ file: typed.path(source), ...client })));
  return { clients };
}

// The repository's source files, as the run holds them (a patched snapshot exists only in memory),
// type-checked with the repository's stripe-node, else Refit's own: one program per tsconfig project.
export function typedPrograms(
  repository: Repository,
  explicitPackage?: string,
):
  | { skipped?: 'too-large' | 'no-stripe-types' }
  | {
      stripe: string;
      programs: { program: ts.Program; sources: ts.SourceFile[] }[];
      inStripe: (node: ts.Node) => boolean;
      path: (fileName: string) => string;
    } {
  const files = repository.files.map((file) => file.path).filter((path) => SOURCE.test(path));
  if (!files.length) return {};
  if (files.length > MAX_TYPED_FILES) return { skipped: 'too-large' };
  const stripe =
    stripePackageDirectory(repository.root, explicitPackage) ??
    stripePackageDirectory(repository.root, BUNDLED_STRIPE);
  if (!stripe) return { skipped: 'no-stripe-types' };
  const root = resolve(repository.root);
  const contents = new Map(repository.files.map((file) => [resolve(root, file.path), file]));
  // Module resolution asks for each directory first; the files may only exist in memory.
  const directories = new Set<string>();
  for (const path of contents.keys())
    for (let directory = dirname(path); !directories.has(directory); directory = dirname(directory))
      directories.add(directory);
  const stripeDirectories = [resolve(stripe), realpathSync(stripe)];
  const inStripe = (node: ts.Node) =>
    stripeDirectories.some((directory) => node.getSourceFile().fileName.startsWith(directory));
  const entry = stripeTypesEntry(stripe);
  const programs: { program: ts.Program; sources: ts.SourceFile[] }[] = [];
  // Monorepos keep a tsconfig per package; each file is checked with its nearest project.
  const projects = new Map<string, string[]>();
  for (const path of contents.keys()) {
    let directory = dirname(path);
    while (directory.startsWith(root) && !existsSync(join(directory, 'tsconfig.json')))
      directory = dirname(directory);
    const project = directory.startsWith(root) ? directory : root;
    projects.set(project, [...(projects.get(project) ?? []), path]);
  }
  for (const [project, projectFiles] of projects) {
    const options = compilerOptions(project, entry.module);
    const host = ts.createCompilerHost(options);
    const fileExists = host.fileExists;
    const readFile = host.readFile;
    host.fileExists = (name) => contents.has(name) || fileExists(name);
    const directoryExists = host.directoryExists?.bind(host);
    host.directoryExists = (name) =>
      directories.has(name) || (directoryExists ? directoryExists(name) : true);
    host.readFile = (name) => contents.get(name)?.content ?? readFile(name);
    const getSourceFile = host.getSourceFile;
    host.getSourceFile = (name, version, ...rest) => {
      const file = contents.get(name);
      if (file) return ts.createSourceFile(name, file.content, version, true);
      if (!name.endsWith('.d.ts')) return getSourceFile(name, version, ...rest);
      const key = `${name}\0${JSON.stringify(version)}`;
      let declaration = declarations.get(key);
      if (!declaration) {
        declaration = getSourceFile(name, version, ...rest);
        if (declaration) declarations.set(key, declaration);
      }
      return declaration;
    };
    const program = ts.createProgram(
      entry.ambient ? [...projectFiles, entry.ambient] : projectFiles,
      options,
      host,
    );
    const own = new Set(projectFiles);
    const sources = program
      .getSourceFiles()
      .filter((source) => own.has(source.fileName) && !source.isDeclarationFile);
    programs.push({ program, sources });
  }
  return { stripe, programs, inStripe, path: (fileName) => contents.get(fileName)!.path };
}

// The values a function returns, or undefined where it may return without one.
export function functionReturns(fn: ts.SignatureDeclaration): ts.Expression[] | undefined {
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return [fn.body];
  const body = (fn as ts.FunctionLikeDeclaration).body;
  if (!body) return undefined;
  const values: ts.Expression[] = [];
  let bare = false;
  const walk = (node: ts.Node) => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isReturnStatement(node)) {
      if (node.expression) values.push(node.expression);
      else bare = true;
    }
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(body, walk);
  return bare || !values.length ? undefined : values;
}

function propertyText(name: ts.PropertyName) {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

function strip(expression: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)
    ? strip(expression.expression)
    : expression;
}

function programClients(
  program: ts.Program,
  sources: ts.SourceFile[],
  inStripe: (node: ts.Node) => boolean,
) {
  const checker = program.getTypeChecker();
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  for (const file of program.getSourceFiles()) if (!file.isDeclarationFile) visit(file);
  // Every simple write to a variable or property: `x = v`, `this.x = v`, `x ??= v`, `x ||= v`.
  const writes = new Map<ts.Symbol, ts.Expression[]>();
  for (const node of nodes) {
    if (
      !ts.isBinaryExpression(node) ||
      node.operatorToken.kind < ts.SyntaxKind.FirstAssignment ||
      node.operatorToken.kind > ts.SyntaxKind.LastAssignment
    )
      continue;
    const symbol = checker.getSymbolAtLocation(
      ts.isPropertyAccessExpression(node.left) ? node.left.name : node.left,
    );
    if (symbol) writes.set(symbol, [...(writes.get(symbol) ?? []), node]);
  }
  const javascriptFile = (node: ts.Node) => JAVASCRIPT.test(node.getSourceFile().fileName);
  const resolved = (symbol: ts.Symbol | undefined) =>
    symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const nullish = (expression: ts.Expression) => {
    const value = strip(expression);
    return (
      value.kind === ts.SyntaxKind.NullKeyword ||
      ts.isVoidExpression(value) ||
      (ts.isIdentifier(value) && NULLISH.test(value.text))
    );
  };
  // stripe-node's client class, or a declaration of the stripe package that extends it (the
  // default export's interface in stripe-node 18 and later).
  const isClientType = (type: ts.Type): boolean => {
    const symbol = type.getSymbol();
    const declaration = symbol?.getDeclarations()?.[0];
    if (!symbol || !declaration || !inStripe(declaration)) return false;
    if (symbol.name === 'Stripe' && ts.isClassDeclaration(declaration)) return true;
    return (type.isClassOrInterface() ? (checker.getBaseTypes(type) ?? []) : []).some(isClientType);
  };
  const clientType = (node: ts.Node) => {
    const type = checker.getNonNullableType(checker.getTypeAtLocation(node));
    return isClientType(checker.getAwaitedType(type) ?? type);
  };
  // Whether an expression the checker types as the Stripe client got that type honestly: from
  // stripe-node's constructor or a declaration, never through a cast or `any`.
  const memo = new Map<ts.Node, boolean>();
  const pending = new Set<ts.Node>();
  function honest(expression: ts.Expression): boolean {
    const known = memo.get(expression);
    if (known !== undefined) return known;
    // A cycle (a lazy client that reads itself) adds no cast of its own.
    if (pending.has(expression)) return true;
    pending.add(expression);
    const result = clientType(expression) && honestValue(expression);
    pending.delete(expression);
    memo.set(expression, result);
    return result;
  }
  const honestOrNullish = (expression: ts.Expression) => nullish(expression) || honest(expression);
  function honestValue(expression: ts.Expression): boolean {
    if (ts.isParenthesizedExpression(expression))
      // `/** @type {Stripe} */ (value)` is JavaScript's cast.
      return (
        !(javascriptFile(expression) && ts.getJSDocTypeTag(expression)) &&
        honest(expression.expression)
      );
    if (
      ts.isNonNullExpression(expression) ||
      ts.isAwaitExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    )
      return honest(expression.expression);
    if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) return false;
    if (ts.isConditionalExpression(expression))
      return honestOrNullish(expression.whenTrue) && honestOrNullish(expression.whenFalse);
    if (ts.isBinaryExpression(expression)) {
      const operator = expression.operatorToken.kind;
      if (operator === ts.SyntaxKind.EqualsToken) return honest(expression.right);
      if (
        operator === ts.SyntaxKind.QuestionQuestionToken ||
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.QuestionQuestionEqualsToken ||
        operator === ts.SyntaxKind.BarBarEqualsToken
      )
        return honestOrNullish(expression.left) && honestOrNullish(expression.right);
      return false;
    }
    if (ts.isNewExpression(expression)) {
      const declaration = checker.getResolvedSignature(expression)?.declaration;
      if (declaration && inStripe(declaration)) return true;
      // A Proxy has its target's type.
      return (
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === 'Proxy' &&
        expression.arguments?.length === 2 &&
        honest(expression.arguments[0])
      );
    }
    if (ts.isCallExpression(expression)) {
      const declaration = checker.getResolvedSignature(expression)?.declaration;
      if (!declaration || ts.isJSDocSignature(declaration)) return false;
      if (inStripe(declaration)) return true;
      const values = functionReturns(declaration);
      return Boolean(values?.every(honestOrNullish) && values.some((value) => !nullish(value)));
    }
    if (
      ts.isIdentifier(expression) ||
      ts.isPropertyAccessExpression(expression) ||
      expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      const symbol = resolved(
        checker.getSymbolAtLocation(
          ts.isPropertyAccessExpression(expression) ? expression.name : expression,
        ),
      );
      return Boolean(symbol && honestSymbol(symbol));
    }
    return false;
  }
  const symbols = new Map<ts.Symbol, boolean>();
  function honestSymbol(symbol: ts.Symbol): boolean {
    const known = symbols.get(symbol);
    if (known !== undefined) return known;
    symbols.set(symbol, true);
    const declarations = symbol.getDeclarations() ?? [];
    const result =
      declarations.length > 0 &&
      declarations.every(honestDeclaration) &&
      (writes.get(symbol) ?? []).every((write) =>
        honestOrNullish((write as ts.BinaryExpression).right),
      );
    symbols.set(symbol, result);
    return result;
  }
  function honestDeclaration(declaration: ts.Declaration): boolean {
    if (inStripe(declaration)) return true;
    // `const { stripe } = await clients()`: the property's declarations in the object it is taken
    // from, such as `return { stripe: new Stripe(…) }`, with no default value.
    if (
      ts.isBindingElement(declaration) &&
      ts.isIdentifier(declaration.name) &&
      !declaration.dotDotDotToken &&
      !declaration.initializer &&
      ts.isObjectBindingPattern(declaration.parent) &&
      ts.isVariableDeclaration(declaration.parent.parent) &&
      declaration.parent.parent.initializer
    ) {
      const name = declaration.propertyName ?? declaration.name;
      if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) return false;
      const source = declaration.parent.parent.initializer;
      if (!ts.isAwaitExpression(source) && !ts.isCallExpression(strip(source))) return false;
      const call = strip(ts.isAwaitExpression(source) ? source.expression : source);
      const signature = ts.isCallExpression(call)
        ? checker.getResolvedSignature(call)?.declaration
        : undefined;
      const values = signature && !ts.isJSDocSignature(signature) && functionReturns(signature);
      // Every object the function returns names the property with an honest client.
      return Boolean(
        values &&
        values.length &&
        values.every((value) => {
          const object = strip(value);
          if (!ts.isObjectLiteralExpression(object)) return false;
          const entries = object.properties.filter(
            (entry) => entry.name && propertyText(entry.name) === name.text,
          );
          return (
            !object.properties.some(ts.isSpreadAssignment) &&
            entries.length === 1 &&
            honestDeclaration(entries[0])
          );
        }),
      );
    }
    if (
      ts.isVariableDeclaration(declaration) ||
      ts.isPropertyDeclaration(declaration) ||
      ts.isParameter(declaration)
    ) {
      // Destructured names take their type from a whole object; only plain names are followed.
      if (!ts.isIdentifier(declaration.name)) return false;
      const initializer = declaration.initializer;
      if (initializer && !nullish(initializer)) return honest(initializer);
      // A declared type (an annotated parameter, an injected field) counts. An unannotated
      // variable or field takes its type from its writes, which honestSymbol checks; an
      // unannotated parameter takes it from a caller's context, which is not followed.
      return Boolean(declaration.type) || !ts.isParameter(declaration);
    }
    if (ts.isPropertySignature(declaration))
      return Boolean(declaration.type) && clientType(declaration.name);
    if (ts.isPropertyAssignment(declaration)) return honest(declaration.initializer);
    if (ts.isShorthandPropertyAssignment(declaration)) {
      const value = checker.getShorthandAssignmentValueSymbol(declaration);
      return Boolean(value && honestSymbol(resolved(value)!));
    }
    if (ts.isExportAssignment(declaration)) return honest(declaration.expression);
    if (ts.isBinaryExpression(declaration)) return honest(declaration.right);
    if (ts.isGetAccessorDeclaration(declaration)) {
      const values = functionReturns(declaration);
      return Boolean(values?.every(honestOrNullish));
    }
    return false;
  }

  // `new Stripe(…)`, `Stripe(…)` or `require('stripe')(…)`, read from syntax for JavaScript the
  // checker could not type.
  const stripeImport = (expression: ts.Expression): boolean => {
    const value = strip(expression);
    if (ts.isPropertyAccessExpression(value))
      return /^(?:default|Stripe)$/.test(value.name.text) && stripeImport(value.expression);
    if (ts.isCallExpression(value))
      return (
        ts.isIdentifier(value.expression) &&
        value.expression.text === 'require' &&
        value.arguments.length === 1 &&
        ts.isStringLiteralLike(value.arguments[0]) &&
        value.arguments[0].text === 'stripe'
      );
    if (!ts.isIdentifier(value)) return false;
    const symbol = checker.getSymbolAtLocation(value);
    return (symbol?.getDeclarations() ?? []).some((declaration) => {
      if (ts.isVariableDeclaration(declaration))
        return Boolean(declaration.initializer && stripeImport(declaration.initializer));
      const module = ts.isImportClause(declaration)
        ? declaration.parent.moduleSpecifier
        : ts.isImportSpecifier(declaration)
          ? declaration.parent.parent.parent.moduleSpecifier
          : ts.isNamespaceImport(declaration)
            ? declaration.parent.parent.moduleSpecifier
            : undefined;
      return Boolean(module && ts.isStringLiteral(module) && module.text === 'stripe');
    });
  };
  const creation = (expression: ts.Expression) => {
    const value = strip(expression);
    return (
      (ts.isNewExpression(value) || ts.isCallExpression(value)) && stripeImport(value.expression)
    );
  };
  const jsSymbols = new Map<ts.Symbol, boolean>();
  // A value that only ever holds a client a Stripe constructor made in JavaScript.
  function jsClient(expression: ts.Expression): boolean {
    const value = strip(expression);
    if (creation(value)) return true;
    if (ts.isAwaitExpression(value)) return jsClient(value.expression);
    if (ts.isBinaryExpression(value)) {
      const operator = value.operatorToken.kind;
      if (operator === ts.SyntaxKind.EqualsToken) return jsClient(value.right);
      if (
        operator === ts.SyntaxKind.QuestionQuestionToken ||
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.QuestionQuestionEqualsToken ||
        operator === ts.SyntaxKind.BarBarEqualsToken
      )
        return [value.left, value.right].every((side) => nullish(side) || jsClient(side));
      return false;
    }
    if (ts.isCallExpression(value)) {
      const symbol = resolved(checker.getSymbolAtLocation(value.expression));
      const functions = symbol ? [symbol.valueDeclaration, ...(jsValues(symbol) ?? [])] : [];
      const fn = functions.find(
        (candidate): candidate is ts.FunctionLikeDeclaration =>
          Boolean(candidate) &&
          (ts.isFunctionDeclaration(candidate!) ||
            ts.isArrowFunction(candidate!) ||
            ts.isFunctionExpression(candidate!)),
      );
      const values = fn && functionReturns(fn);
      return Boolean(
        values?.every((returned) => nullish(returned) || jsClient(returned)) &&
        values.some((returned) => !nullish(returned)),
      );
    }
    if (ts.isIdentifier(value)) {
      const symbol = resolved(checker.getSymbolAtLocation(value));
      if (!symbol) return false;
      const known = jsSymbols.get(symbol);
      if (known !== undefined) return known;
      jsSymbols.set(symbol, true);
      const values = jsValues(symbol);
      const result = Boolean(values?.length && values.every(jsClient));
      jsSymbols.set(symbol, result);
      return result;
    }
    return false;
  }
  // The values a JavaScript binding holds (initializer, writes, `module.exports = …` of a module it
  // requires), nullish ones left out; undefined where one comes from somewhere else.
  function jsValues(symbol: ts.Symbol): ts.Expression[] | undefined {
    const values: ts.Expression[] = [];
    for (const declaration of symbol.getDeclarations() ?? []) {
      if (ts.isExportAssignment(declaration)) values.push(declaration.expression);
      else if (ts.isBinaryExpression(declaration)) values.push(declaration.right);
      else if (ts.isFunctionDeclaration(declaration)) continue;
      else if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
        const initializer = declaration.initializer && strip(declaration.initializer);
        if (!initializer || nullish(initializer)) continue;
        if (
          ts.isCallExpression(initializer) &&
          ts.isIdentifier(initializer.expression) &&
          initializer.expression.text === 'require' &&
          initializer.arguments.length === 1
        ) {
          const module = checker.getSymbolAtLocation(initializer.arguments[0]);
          const exported = module?.exports?.get(ts.InternalSymbolName.ExportEquals);
          if (!exported) return undefined;
          const targets = exported.getDeclarations() ?? [];
          if (!targets.length || !targets.every(ts.isBinaryExpression)) return undefined;
          values.push(...targets.map((target) => (target as ts.BinaryExpression).right));
        } else values.push(initializer);
      } else return undefined;
    }
    for (const write of writes.get(symbol) ?? []) {
      const right = (write as ts.BinaryExpression).right;
      if (!nullish(right)) values.push(right);
    }
    return values;
  }

  // A stripe-node client, or one of its resource objects (`…Resource` classes).
  const stripeObject = (node: ts.Expression) => {
    const type = checker.getNonNullableType(checker.getTypeAtLocation(node));
    const declaration = type.getSymbol()?.getDeclarations()?.[0];
    return (
      isClientType(type) ||
      Boolean(declaration && inStripe(declaration) && /Resource$/.test(type.getSymbol()!.name))
    );
  };
  const target = (node: ts.Node) =>
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    stripeObject(node.expression);
  const sealed = !nodes.some(
    (node) =>
      (ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        target(strip(node.left))) ||
      (ts.isDeleteExpression(node) && target(strip(node.expression))) ||
      (ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'Object' &&
        /^(?:assign|defineProperty|defineProperties|setPrototypeOf)$/.test(
          node.expression.name.text,
        ) &&
        node.arguments[0] !== undefined &&
        stripeObject(strip(node.arguments[0]))),
  );
  const found = new Map<string, Omit<TypedClient, 'file'>[]>();
  let javascript = false;
  let current: Omit<TypedClient, 'file'>[] = [];
  const seen = new Set<string>();
  const visitCalls = (node: ts.Node) => {
    ts.forEachChild(node, visitCalls);
    if (!ts.isCallExpression(node)) return;
    // `<client>.<resource>[.<resource>].<method>(…)`: the client is a prefix of the callee.
    const chain: ts.Expression[] = [];
    let callee: ts.Expression = node.expression;
    while (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
      callee = callee.expression;
      chain.unshift(callee);
    }
    // At least a resource and a method follow the client.
    for (const prefix of chain.slice(0, -1)) {
      const client = strip(prefix);
      if (!clientType(client)) continue;
      if (honest(client)) record(client, 'type');
      return;
    }
    const root = strip(chain[0] ?? node.expression);
    if (javascript && chain.length > 1 && !clientType(root) && jsClient(root))
      record(root, 'js-return');
  };
  const record = (client: ts.Expression, source: TypedClient['source']) => {
    const key = `${client.getSourceFile().fileName}\0${client.getStart()}\0${client.end}`;
    if (seen.has(key)) return;
    seen.add(key);
    current.push({
      start: client.getStart(),
      end: client.end,
      source,
      ...(sealed && source === 'type' ? { sealed: true as const } : {}),
    });
  };
  for (const source of sources) {
    javascript = JAVASCRIPT.test(source.fileName);
    current = [];
    visitCalls(source);
    found.set(source.fileName, current);
  }
  return found;
}
