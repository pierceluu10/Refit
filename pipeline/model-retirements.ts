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

// Build output committed with the sources: `out/` and `ts-out/` directories, minified bundles, and
// JavaScript whose TypeScript source sits beside it or in a sibling `src/` directory. A proposal
// there would be overwritten by the next build. `dist/`, `build/` and `.next/` are never read.
const OUTPUT_DIRECTORY = /(?:^|\/)(?:out|ts-out)\//;
const BUNDLE = /\.(?:min|bundle)\.[cm]?js$/;

function compiledOutput(path: string, paths: Set<string>) {
  if (OUTPUT_DIRECTORY.test(path) || BUNDLE.test(path)) return true;
  const script = /^(.*)\.([cm]?)jsx?$/.exec(path);
  if (!script) return false;
  const parts = script[1].split('/');
  const stems = [
    script[1],
    ...parts.flatMap((part, index) =>
      part === 'lib'
        ? [[...parts.slice(0, index), 'src', ...parts.slice(index + 1)].join('/')]
        : [],
    ),
  ];
  return stems.some((stem) =>
    ['ts', 'tsx'].some((extension) => paths.has(`${stem}.${script[2]}${extension}`)),
  );
}

// Raw HTTP requests to the official text-generation endpoints, with the request body sent through
// `JSON.stringify`: `fetch(url, { body })`, Apps Script's `UrlFetchApp.fetch(url, { payload })`
// and `axios.post(url, data)`.
const RAW_ENDPOINTS: { provider: DeadlineEntry['provider']; pattern: RegExp }[] = [
  {
    provider: 'openai',
    pattern: /api\.openai\.com\/v1\/(?:chat\/completions|responses)(?![\w/-])/,
  },
  { provider: 'anthropic', pattern: /api\.anthropic\.com\/v1\/messages(?![\w/-])/ },
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
  // Every use of each symbol in the repository: identifiers that are not its declaration name and
  // not part of an import or export. Assignments to a property, such as
  // `this.model = options.model ?? 'gpt-4'`, are kept apart as writes.
  // Built per name on first use: only constants and helpers a request reaches are looked up.
  const byName = new Map<
    string,
    { reads: Map<ts.Symbol, ts.Identifier[]>; writes: Map<ts.Symbol, ts.Expression[]> }
  >();
  const references = (symbol: ts.Symbol) => {
    let found = byName.get(symbol.name);
    if (!found) {
      const reads = new Map<ts.Symbol, ts.Identifier[]>();
      const writes = new Map<ts.Symbol, ts.Expression[]>();
      for (const source of files) {
        if (!source.text.includes(symbol.name)) continue;
        const visit = (node: ts.Node) => {
          if (ts.isIdentifier(node) && node.text === symbol.name) {
            const assigned = propertyAssignment(node);
            if (assigned) {
              const resolved = symbolOf(node);
              if (resolved) writes.set(resolved, [...(writes.get(resolved) ?? []), assigned]);
            } else if (!declarationName(node) && !moduleBinding(node)) {
              const resolved = symbolOf(node);
              if (resolved) reads.set(resolved, [...(reads.get(resolved) ?? []), node]);
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
      found = { reads, writes };
      byName.set(symbol.name, found);
    }
    return found;
  };
  return {
    files,
    symbolOf,
    usesOf: (symbol: ts.Symbol) => references(symbol).reads.get(symbol) ?? [],
    writesOf: (symbol: ts.Symbol) => references(symbol).writes.get(symbol) ?? [],
    path: (node: ts.Node) => paths.get(node.getSourceFile().fileName)!,
    line: (node: ts.Node) =>
      node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1,
    source: (path: string) => files.find((source) => paths.get(source.fileName) === path),
  };
}
type SourceProgram = ReturnType<typeof sourceProgram>;

function declarationName(node: ts.Identifier) {
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
    (ts.isPropertyAccessExpression(parent) &&
      parent.name === node &&
      ts.isBinaryExpression(parent.parent) &&
      parent.parent.left === parent &&
      parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)
  );
}

// The value assigned when a property name is the target of `object.name = value`.
function propertyAssignment(node: ts.Identifier) {
  const access = node.parent;
  return ts.isPropertyAccessExpression(access) &&
    access.name === node &&
    ts.isBinaryExpression(access.parent) &&
    access.parent.left === access &&
    access.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ? access.parent.right
    : undefined;
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

// A property of a class: a field, a constructor parameter property or, in JavaScript, a
// `this.name = value` assignment. Object literal properties are not followed.
function classProperty(symbol: ts.Symbol) {
  return (
    Boolean(symbol.flags & ts.SymbolFlags.Property) &&
    Boolean(symbol.declarations?.length) &&
    symbol.declarations!.every(
      (item) =>
        ts.isPropertyDeclaration(item) ||
        (ts.isParameter(item) && ts.isConstructorDeclaration(item.parent)) ||
        ((ts.isPropertyAccessExpression(item) || ts.isBinaryExpression(item)) &&
          inClassMethod(item)),
    )
  );
}

// Whether `this` at a node is a class instance: the nearest function that binds `this` is a
// constructor, method or accessor.
function inClassMethod(node: ts.Node) {
  for (let current = node.parent; current; current = current.parent)
    if (ts.isFunctionLike(current) && !ts.isArrowFunction(current))
      return ts.isClassLike(current.parent);
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

// The request body of a raw HTTP call to a text-generation endpoint, before `JSON.stringify`.
function rawRequest(program: SourceProgram, call: ts.CallExpression) {
  const callee = call.expression;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : '';
  if (name !== 'fetch' && name !== 'post') return undefined;
  const url = urlText(program, call.arguments[0]);
  const endpoint = url && RAW_ENDPOINTS.find((item) => item.pattern.test(url));
  if (!endpoint) return undefined;
  let body: ts.Expression | undefined;
  if (name === 'post') body = call.arguments[1];
  else {
    const options = call.arguments[1] && unwrap(call.arguments[1]);
    if (!options || !ts.isObjectLiteralExpression(options)) return undefined;
    const property = objectProperty(options, 'body') ?? objectProperty(options, 'payload');
    const value = property && propertyValue(property);
    body =
      value &&
      ts.isCallExpression(value) &&
      value.expression.getText() === 'JSON.stringify' &&
      value.arguments.length === 1
        ? value.arguments[0]
        : undefined;
  }
  if (!body) return undefined;
  const path = /\/v1\/[\w/]+/.exec(url)![0];
  return { provider: endpoint.provider, body, call: `${name} ${path}` };
}

interface Site {
  literal: ts.StringLiteralLike;
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

// Where the model a request sends is written, followed through constants, enum members (also in
// other modules) and a helper function's parameter. A constant or member is edited where it is
// declared only when this request is its single use; a parameter is edited at its default and at
// each caller that passes a literal.
function modelSites(program: SourceProgram, value: ts.Expression, depth = 0): Site[] {
  if (depth > 4) return [];
  if (ts.isStringLiteralLike(value)) return [{ literal: value }];
  if (
    ts.isBinaryExpression(value) &&
    [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(
      value.operatorToken.kind,
    )
  )
    return ts.isStringLiteralLike(unwrap(value.right))
      ? [{ literal: unwrap(value.right) as ts.StringLiteralLike }]
      : modelSites(program, unwrap(value.right), depth + 1);
  const reference = ts.isPropertyAccessExpression(value) ? value.name : value;
  if (!ts.isIdentifier(reference)) return [];
  const symbol = program.symbolOf(reference);
  const declaration = symbol?.valueDeclaration;
  if (!symbol || !declaration) return [];
  if (ts.isPropertyAccessExpression(value) && classProperty(symbol)) {
    // A class property, such as `model: this.model`: followed to its initializer, a constructor
    // parameter default and every assignment. It is edited there only when this request is its
    // single read; other reads may compare it, price it or log it.
    const values = [
      ...(symbol.declarations ?? []).flatMap((item) =>
        (ts.isPropertyDeclaration(item) || ts.isParameter(item)) && item.initializer
          ? [item.initializer]
          : [],
      ),
      ...program.writesOf(symbol),
    ];
    const sites = values.flatMap((item) => modelSites(program, unwrap(item), depth + 1));
    const reads = program.usesOf(symbol).length;
    if (reads !== 1) {
      const at = `${program.path(declaration)}:${program.line(declaration)}`;
      sites.forEach(
        (site) =>
          (site.stop ??= `The model comes from the property ${reference.text} (${at}), which is read ${reads} times; change it by hand to`),
      );
    }
    return sites;
  }
  if (
    (ts.isVariableDeclaration(declaration) &&
      ts.isVariableDeclarationList(declaration.parent) &&
      declaration.parent.flags & ts.NodeFlags.Const) ||
    ts.isEnumMember(declaration)
  ) {
    const initializer = declaration.initializer && unwrap(declaration.initializer as ts.Expression);
    if (!initializer || !ts.isStringLiteralLike(initializer)) return [];
    const uses = program.usesOf(symbol).length;
    const kind = ts.isEnumMember(declaration) ? 'enum member' : 'constant';
    const at = `${program.path(initializer)}:${program.line(initializer)}`;
    return [
      {
        literal: initializer,
        ...(uses !== 1
          ? {
              stop: `The model comes from the ${kind} ${reference.text} (${at}), which is used ${uses} times; change it by hand to`,
            }
          : {}),
      },
    ];
  }
  if (ts.isParameter(declaration) && ts.isIdentifier(declaration.name)) {
    const helper = declaration.parent;
    const index = helper.parameters.indexOf(declaration);
    const sites: Site[] = [];
    if (declaration.initializer && ts.isStringLiteralLike(unwrap(declaration.initializer)))
      sites.push({ literal: unwrap(declaration.initializer) as ts.StringLiteralLike });
    const name =
      ts.isFunctionDeclaration(helper) && helper.name
        ? helper.name
        : (ts.isFunctionExpression(helper) || ts.isArrowFunction(helper)) &&
            ts.isVariableDeclaration(helper.parent) &&
            ts.isIdentifier(helper.parent.name)
          ? helper.parent.name
          : undefined;
    const helperSymbol = name && program.symbolOf(name);
    if (!helperSymbol) return sites;
    const helperName = `${name.text} (${program.path(name)}:${program.line(name)})`;
    for (const use of program.usesOf(helperSymbol)) {
      const callee =
        ts.isPropertyAccessExpression(use.parent) && use.parent.name === use ? use.parent : use;
      const call = callee.parent;
      if (!ts.isCallExpression(call) || call.expression !== callee) {
        // Passed as a value, the helper may be called with any model.
        sites.forEach(
          (site) =>
            (site.stop ??= `The helper ${helperName} is also passed as a value; change its model by hand to`),
        );
        continue;
      }
      if (call.arguments.slice(0, index + 1).some((argument) => ts.isSpreadElement(argument))) {
        sites.forEach(
          (site) =>
            (site.stop ??= `The helper ${helperName} is called with spread arguments; change its model by hand to`),
        );
        continue;
      }
      const argument = call.arguments[index] && unwrap(call.arguments[index]);
      if (argument) sites.push(...modelSites(program, argument, depth + 1));
    }
    return sites;
  }
  return [];
}

// Proposes replacing a retiring model ID with its registry replacement where a traced SDK call, or a
// raw HTTP request to an official text-generation endpoint, sends it as `model`, outside tests and
// build output. Anything less certain stops for review with a reason. Nothing is written, applied,
// validated or sent to a provider: the proposal is a patch for a person to review.
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
    // The same files for every tracer, so the analyses share one compiler program.
    const analysis = analyzeRepository(
      { ...(await readRepository(directory, adapter.packageName)), files: repository.files },
      [],
      adapter,
    );
    const traced = [
      ...analysis.sdkCalls
        .map((sdk) => ({ ...sdk, call: `${sdk.resource}.${sdk.method}` }))
        .filter((sdk) => tracer.resourceCalls?.has(sdk.call)),
      ...analysis.clientMethodCalls
        .map((sdk) => ({ ...sdk, call: sdk.method }))
        .filter((sdk) => tracer.clientCalls?.has(sdk.call)),
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
      });
    }
  }
  for (const source of program.files) {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && !seen.has(node)) {
        const raw = rawRequest(program, node);
        if (raw && byProvider.has(raw.provider)) {
          seen.add(node);
          requests.push({ provider: raw.provider, call: raw.call, node, argument: raw.body });
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
  const paths = new Set(repository.files.map((item) => item.path));
  const skipped = (file: string) => TEST_PATH.test(file) || compiledOutput(file, paths);
  for (const request of requests) {
    const models = byProvider.get(request.provider)!;
    const file = program.path(request.node);
    if (skipped(file)) continue;
    const found = requestObject(program, request.argument);
    const property = found && objectProperty(found.object, 'model');
    if (!found || !property) continue;
    for (const site of modelSites(program, propertyValue(property))) {
      const entry = models.get(site.literal.text);
      if (!entry || skipped(program.path(site.literal))) continue;
      const resolved = finalReplacement(entry, models) ?? { to: '', via: [entry.id] };
      const sensitive = found.object.properties
        .map((item) => (item.name ? propertyName(item.name) : undefined))
        .filter((name): name is string =>
          Boolean(name && SENSITIVE_PARAMETERS[request.provider].has(name)),
        )
        .filter(() => rejectsSampling(request.provider, resolved.to));
      const reason = !resolved.to
        ? 'The registry names no concrete replacement model ID.'
        : site.stop
          ? `${site.stop} ${resolved.to}.`
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
