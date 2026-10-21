import { resolve } from 'node:path';
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
}[] = [
  {
    provider: 'openai',
    adapter: new URL('../examples/openai.provider.json', import.meta.url),
    resourceCalls: MODEL_CALLS.openai,
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
// Request parameters a newer model may reject or treat differently. Anthropic returns a 400 for
// non-default temperature, top_p and top_k on Claude 4.7 and later models (Anthropic model
// deprecations page, 2026-10-20). OpenAI reasoning models' support for the sampling and length
// parameters below: unverified, so they stop for review too.
const SENSITIVE_PARAMETERS: Record<string, Set<string>> = {
  openai: new Set([
    'temperature',
    'top_p',
    'max_tokens',
    'presence_penalty',
    'frequency_penalty',
    'logit_bias',
    'logprobs',
    'top_logprobs',
  ]),
  anthropic: new Set(['temperature', 'top_p', 'top_k']),
};
// Claude API model IDs such as `claude-opus-4-8` or `claude-haiku-4-5-20251001`.
const CLAUDE_VERSIONED = /^claude-(?:opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;

// Whether a replacement model is one on which Anthropic rejects non-default sampling parameters:
// Claude 4.7 and later models, per the model deprecations page (2026-10-20). Unrecognized IDs are
// treated as rejecting them, so the request stops for review.
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
  // A private field's symbol is named `__#1@#model`; its identifier text is `#model`.
  const indexOf = (symbol: ts.Symbol) => {
    const name = symbol.name.replace(/^__#\d+@/, '');
    let index = byName.get(name);
    if (!index) {
      index = { uses: new Map(), assigns: new Map() };
      for (const source of files) {
        if (!source.text.includes(name)) continue;
        const visit = (node: ts.Node) => {
          if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && node.text === name) {
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
  const usesOf = (symbol: ts.Symbol) => indexOf(symbol).uses.get(symbol) ?? [];
  // The right-hand side of every `x.name = value` in the repository, for a field's symbol.
  const assignmentsOf = (symbol: ts.Symbol) => indexOf(symbol).assigns.get(symbol) ?? [];
  return {
    files,
    symbolOf,
    bindingOf,
    usesOf,
    assignmentsOf,
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
  kind: 'constant' | 'enum member' | 'field' | 'function';
  name: string;
  at: string;
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
    const all = program.usesOf(pass.symbol);
    const uses = all.filter((use) => !inType(use));
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
  if (ts.isObjectLiteralExpression(value)) {
    const property = keys[0] ? objectProperty(value, keys[0]) : undefined;
    return property ? valuesOf(program, propertyValue(property), next, keys.slice(1)) : [];
  }
  if (ts.isCallExpression(value)) return callValues(program, value, next, keys);
  if (ts.isPropertyAccessExpression(value)) {
    const symbol = program.symbolOf(value.name);
    const declaration = symbol && (symbol.valueDeclaration ?? symbol.declarations?.[0]);
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
  if (
    (ts.isVariableDeclaration(declaration) &&
      ts.isVariableDeclarationList(declaration.parent) &&
      declaration.parent.flags & ts.NodeFlags.Const) ||
    ts.isEnumMember(declaration)
  ) {
    const initializer = declaration.initializer;
    if (!initializer) return [];
    return cached(trace, declaration, keys, () =>
      through(
        pass(ts.isEnumMember(declaration) ? 'enum member' : 'constant', unwrap(initializer)),
        valuesOf(program, initializer, trace, keys),
      ),
    );
  }
  if (ts.isBindingElement(declaration)) return bindingValues(program, declaration, trace, keys);
  if (ts.isParameter(declaration) && !member)
    return parameterValues(program, declaration, trace, keys);
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
    return through(pass('field', declaration), found);
  });
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
  const name = constructed
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
  const symbol = name && program.symbolOf(name);
  if (!name || !symbol) return found;
  const helperName = `${name.text} (${where(program, name)})`;
  const callers = { ...trace, ctx: undefined };
  const stopAll = (reason: string) => found.forEach((site) => (site.stop ??= reason));
  for (const use of program.usesOf(symbol)) {
    if (ts.isTypeReferenceNode(use.parent)) continue;
    const callee =
      ts.isPropertyAccessExpression(use.parent) && use.parent.name === use ? use.parent : use;
    const call = callee.parent;
    if (
      !(ts.isCallExpression(call) || (constructed && ts.isNewExpression(call))) ||
      call.expression !== callee
    ) {
      // Passed as a value, the helper may be called with any model.
      stopAll(`The helper ${helperName} is also passed as a value; change its model by hand to`);
      continue;
    }
    const args = call.arguments ?? [];
    if (args.slice(0, index + 1).some((argument) => ts.isSpreadElement(argument))) {
      stopAll(
        `The helper ${helperName} is called with spread arguments; change its model by hand to`,
      );
      continue;
    }
    if (args[index]) found.push(...valuesOf(program, args[index], callers, keys));
  }
  return found;
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
  const run = () => {
    const found = returnsOf(fn).flatMap((returned) =>
      valuesOf(program, returned, { ...trace, ctx }, keys),
    );
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

// Proposes replacing a retiring model ID with its registry replacement where a traced SDK call, or a
// raw HTTP request to an official text-generation endpoint, sends it as `model`, outside tests.
// Anything less certain stops for review with a reason. Nothing is written, applied, validated or
// sent to a provider: the proposal is a patch for a person to review.
export async function proposeModelReplacements(
  directory: string,
  registry: DeadlineRegistry,
  now: Date,
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
    trace: ReturnType<typeof modelSites>;
  }[] = [];
  for (const request of requests) {
    if (TEST_PATH.test(program.path(request.node))) continue;
    const found = requestObject(program, request.argument);
    const property = found && objectProperty(found.object, 'model');
    if (!found || !property) continue;
    const trace = modelSites(program, propertyValue(property));
    for (const site of trace.sites) for (const pass of site.passes) reached.add(pass.use);
    traced.push({ request, found, trace });
  }
  for (const { request, found, trace } of traced) {
    const models = byProvider.get(request.provider)!;
    for (const site of trace.sites) {
      const entry = models.get(site.literal.text);
      if (!entry || TEST_PATH.test(program.path(site.literal))) continue;
      const resolved = finalReplacement(entry, models) ?? { to: '', via: [entry.id] };
      const sensitive = found.object.properties
        .map((item) => (item.name ? propertyName(item.name) : undefined))
        .filter((name): name is string =>
          Boolean(name && SENSITIVE_PARAMETERS[request.provider].has(name)),
        )
        .filter(() => rejectsSampling(request.provider, resolved.to));
      const stop = site.stop ?? sharedUse(program, site.passes, reached);
      const reason = !resolved.to
        ? 'The registry names no concrete replacement model ID.'
        : // Images, audio, embeddings, moderation and legacy completions change formats, vector
          // sizes or parameters with the model, so they are never edited. The wording is accurate for
          // any call outside the text allow-list, such as beta.assistants.create (D-11, D-16).
          !request.text
          ? `\`${request.call}\` is not a call Refit edits; ${resolved.to} may change formats or parameters; change it by hand to ${resolved.to}.`
          : stop
            ? `${stop} ${resolved.to}.`
            : found.shared
              ? `${found.shared} ${resolved.to}.`
              : found.object.properties.some((item) => ts.isSpreadAssignment(item))
                ? 'The request spreads other options, which may set parameters the replacement rejects.'
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
