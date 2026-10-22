import { resolve } from 'node:path';
import ts from 'typescript-compiler';
import type { DeadlineEntry } from './deadline-registry.ts';
import { unwrap } from './meta-graph-calls.ts';
import type { ReportOnlySite } from './model-retirements.ts';
import { createSourceImportResolver } from './source-imports.ts';
import type { Repository } from './types.ts';

// Report-only detection of models sent through AI wrapper SDKs, which never import `openai` or
// `@anthropic-ai/sdk` themselves: the Vercel AI SDK (`openai('gpt-4o')`, `anthropic('claude-…')`,
// gateway IDs such as `'openai/gpt-4o'`), LangChain JS (`new ChatOpenAI({ model })`,
// `initChatModel('openai:gpt-4o')`) and LlamaIndex TS (`new OpenAI({ model })` from `llamaindex`).
// Each site names the provider, the model as written, the registry ID it maps to and where both are.
// Nothing here is edited.

type Provider = Extract<DeadlineEntry['provider'], 'openai' | 'anthropic' | 'gemini'>;
export type Wrapper = 'ai-sdk' | 'langchain' | 'llamaindex';

export interface ModelWrapperSite {
  // Where the model string is written.
  file: string;
  line: number;
  // The wrapper call that sends it.
  call: { file: string; line: number };
  wrapper: Wrapper;
  provider: Provider;
  // The string as written, and the registry ID it names (a gateway prefix removed).
  model: string;
  version: string;
  // The call as Refit names it, such as `@ai-sdk/openai openai()`.
  via: string;
  // A text-generation model, as opposed to embeddings, images or audio.
  text: boolean;
  // Why the provider may not be the official one: a base URL or an OpenAI-compatible package.
  custom?: string;
}

// Package exports that select a provider's model. `kind` says how the model is passed: as the
// first argument of a provider instance (`instance`), or as `model` or `modelName` of the first
// argument of a class or function (`options`). `text: false` marks embeddings, images and audio.
const AI_SDK: Record<string, Provider> = {
  '@ai-sdk/openai': 'openai',
  '@ai-sdk/anthropic': 'anthropic',
  '@ai-sdk/google': 'gemini',
};
const AI_SDK_FACTORIES = new Set(['createOpenAI', 'createAnthropic', 'createGoogleGenerativeAI']);
const AI_SDK_INSTANCES = new Set(['openai', 'anthropic', 'google']);
// Provider instance methods that take a model ID; the rest of the name decides `text`.
const AI_SDK_METHODS: Record<string, boolean> = {
  chat: true,
  responses: true,
  languageModel: true,
  messages: true,
  completion: false,
  embedding: false,
  textEmbedding: false,
  textEmbeddingModel: false,
  image: false,
  imageModel: false,
  transcription: false,
  speech: false,
};
// OpenAI-compatible providers built on the AI SDK's OpenAI provider.
const AI_SDK_COMPATIBLE = '@ai-sdk/openai-compatible';

const CLASSES: Record<string, Record<string, { provider: Provider; text: boolean }>> = {
  '@langchain/openai': {
    ChatOpenAI: { provider: 'openai', text: true },
    AzureChatOpenAI: { provider: 'openai', text: true },
    OpenAI: { provider: 'openai', text: false },
    OpenAIEmbeddings: { provider: 'openai', text: false },
  },
  '@langchain/anthropic': { ChatAnthropic: { provider: 'anthropic', text: true } },
  '@langchain/google-genai': {
    ChatGoogleGenerativeAI: { provider: 'gemini', text: true },
    GoogleGenerativeAIEmbeddings: { provider: 'gemini', text: false },
  },
  llamaindex: {
    OpenAI: { provider: 'openai', text: true },
    Anthropic: { provider: 'anthropic', text: true },
    Gemini: { provider: 'gemini', text: true },
    OpenAIEmbedding: { provider: 'openai', text: false },
  },
  '@llamaindex/openai': {
    OpenAI: { provider: 'openai', text: true },
    openai: { provider: 'openai', text: true },
    OpenAIEmbedding: { provider: 'openai', text: false },
  },
  '@llamaindex/google': { Gemini: { provider: 'gemini', text: true } },
  '@llamaindex/anthropic': {
    Anthropic: { provider: 'anthropic', text: true },
    anthropic: { provider: 'anthropic', text: true },
  },
};
// The LangChain legacy entry points re-export the same classes.
const LANGCHAIN_LEGACY = /^langchain\/(?:chat_models|llms|embeddings)\/(openai|anthropic)$/;
const UNIVERSAL = new Set(['langchain/chat_models/universal', 'langchain']);

// Gateway and registry IDs: `openai/gpt-4o` (AI SDK gateway, OpenRouter-style) and `openai:gpt-4o`
// (AI SDK provider registry, LangChain `initChatModel`).
const PREFIXED = /^(openai|anthropic|google)[/:]([a-z0-9][\w.@-]*)$/;
const PREFIX_PROVIDER: Record<string, Provider> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'gemini',
};
// Constructor options that point a provider at another endpoint.
const ENDPOINT_OPTION = /^(?:base_?url|basePath|anthropicApiUrl|configuration)$/i;

const MAX_DEPTH = 6;
// Literals reached through a function's `return`: a shared helper may return several providers'
// models, so such a literal counts only when it is shaped like the call's provider's.
const RETURNED = new WeakSet<ts.Node>();
const MODEL_SHAPES: [RegExp, string][] = [
  // Amazon Bedrock and Vertex AI IDs, and other vendors' families seen in shared helpers.
  [/^(?:[a-z]{2,6}\.)?anthropic\.|@\d{8}$/, 'platform'],
  [/^grok-/, 'xai'],
  [/^claude-/, 'anthropic'],
  [/^gemini-/, 'gemini'],
  [/^(?:gpt-|o\d|chatgpt-|text-embedding-|dall-e|whisper-|tts-)/, 'openai'],
];

function wrapperOf(module: string): Wrapper | undefined {
  if (module.startsWith('@ai-sdk/') || module === 'ai') return 'ai-sdk';
  if (module === 'langchain' || module.startsWith('langchain/') || module.startsWith('@langchain/'))
    return 'langchain';
  if (module === 'llamaindex' || module.startsWith('@llamaindex/')) return 'llamaindex';
  return undefined;
}

function propertyName(name: ts.PropertyName | undefined) {
  return name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : undefined;
}

function option(object: ts.Expression | undefined, names: string[]) {
  const value = object && unwrap(object);
  if (!value || !ts.isObjectLiteralExpression(value)) return undefined;
  for (const property of value.properties) {
    const name = propertyName(property.name);
    if (!name || !names.includes(name)) continue;
    if (ts.isPropertyAssignment(property)) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property)) return property.name;
  }
  return undefined;
}

// An options object's endpoint setting, as `file:line` text, if it has one.
function endpointOption(program: Program, object: ts.Expression | undefined) {
  const value = object && unwrap(object);
  if (!value || !ts.isObjectLiteralExpression(value)) return undefined;
  for (const property of value.properties) {
    const name = propertyName(property.name);
    if (!name || !ENDPOINT_OPTION.test(name)) continue;
    // LangChain's `configuration` only counts when it sets a base URL.
    if (name === 'configuration' && !endpointOption(program, option(object, ['configuration'])))
      continue;
    return `\`${name}\` (${program.where(property)})`;
  }
  return undefined;
}

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
  host.getSourceFile = (name, version) => {
    const content = sources.get(name);
    return content === undefined ? undefined : ts.createSourceFile(name, content, version, true);
  };
  const program = ts.createProgram([...sources.keys()], options, host);
  const checker = program.getTypeChecker();
  const paths = new Map(
    [...sources.keys()].map((path, index) => [path, repository.files[index].path]),
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
  const path = (node: ts.Node) => paths.get(node.getSourceFile().fileName)!;
  const line = (node: ts.Node) =>
    node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
  return {
    files: program.getSourceFiles().filter((source) => paths.has(source.fileName)),
    symbolOf,
    path,
    line,
    where: (node: ts.Node) => `${path(node)}:${line(node)}`,
  };
}
type Program = ReturnType<typeof sourceProgram>;

// The `return` expressions of a function body, not counting nested functions.
function returnsOf(fn: ts.SignatureDeclaration) {
  const body = (fn as ts.FunctionLikeDeclaration).body;
  if (!body) return [];
  if (!ts.isBlock(body)) return [body];
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isReturnStatement(node)) {
      if (node.expression) found.push(node.expression);
    } else if (!ts.isFunctionLike(node) && !ts.isClassLike(node)) ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

// The string literals a model expression can send: the literal itself, both sides of `||`, `??`
// and a conditional, `const` variables and object members (`MODEL`, `CONFIG.model`), and what a
// repository function returns (`modelForProvider(…)`), also across files. An environment variable
// adds nothing; anything else is not followed.
function modelLiterals(
  program: Program,
  expression: ts.Expression,
  depth = 0,
): ts.StringLiteralLike[] {
  const value = unwrap(expression);
  if (ts.isStringLiteralLike(value)) return [value];
  if (depth >= MAX_DEPTH) return [];
  if (ts.isConditionalExpression(value))
    return [value.whenTrue, value.whenFalse].flatMap((item) =>
      modelLiterals(program, item, depth + 1),
    );
  if (
    ts.isBinaryExpression(value) &&
    [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(
      value.operatorToken.kind,
    )
  )
    return [value.left, value.right].flatMap((item) => modelLiterals(program, item, depth + 1));
  if (ts.isCallExpression(value) && ts.isIdentifier(value.expression)) {
    const callee = program.symbolOf(value.expression)?.valueDeclaration;
    const fn =
      callee && ts.isFunctionDeclaration(callee)
        ? callee
        : callee &&
            ts.isVariableDeclaration(callee) &&
            callee.initializer &&
            (ts.isArrowFunction(callee.initializer) || ts.isFunctionExpression(callee.initializer))
          ? callee.initializer
          : undefined;
    const returned = fn
      ? returnsOf(fn).flatMap((item) => modelLiterals(program, item, depth + 1))
      : [];
    for (const literal of returned) RETURNED.add(literal);
    return returned;
  }
  const name = ts.isIdentifier(value)
    ? value
    : ts.isPropertyAccessExpression(value)
      ? value.name
      : undefined;
  const declaration = name && program.symbolOf(name)?.valueDeclaration;
  if (!declaration) return [];
  if (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer &&
    ts.isVariableDeclarationList(declaration.parent) &&
    declaration.parent.flags & ts.NodeFlags.Const
  )
    return modelLiterals(program, declaration.initializer, depth + 1);
  // A `let` or `var`: its initializer and every `name = …` in the same file.
  if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
    const symbol = program.symbolOf(declaration.name);
    const sources = declaration.initializer ? [declaration.initializer] : [];
    const visit = (node: ts.Node) => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        program.symbolOf(node.left) === symbol
      )
        sources.push(node.right);
      ts.forEachChild(node, visit);
    };
    visit(declaration.getSourceFile());
    return sources.flatMap((item) => modelLiterals(program, item, depth + 1));
  }
  if (ts.isPropertyAssignment(declaration))
    return modelLiterals(program, declaration.initializer, depth + 1);
  return [];
}

interface Binding {
  module: string;
  // The exported name, or `*` for a namespace import.
  name: string;
}

// The wrapper package `require('…')`, `import('…')` or `await import('…')` loads.
function loadedModule(initializer: ts.Expression | undefined) {
  const value =
    initializer && unwrap(ts.isAwaitExpression(initializer) ? initializer.expression : initializer);
  if (!value || !ts.isCallExpression(value)) return undefined;
  const specifier = value.arguments[0];
  const loads =
    value.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(value.expression) && value.expression.text === 'require');
  return loads && specifier && ts.isStringLiteral(specifier) && wrapperOf(specifier.text)
    ? specifier.text
    : undefined;
}

// What each identifier in a file is bound to by a wrapper package import, require or
// destructured dynamic import.
function wrapperBindings(source: ts.SourceFile) {
  const bindings = new Map<string, Binding>();
  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.importClause &&
      !node.importClause.isTypeOnly &&
      wrapperOf(node.moduleSpecifier.text)
    ) {
      const module = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause.name) bindings.set(clause.name.text, { module, name: 'default' });
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named))
        bindings.set(named.name.text, { module, name: '*' });
      else if (named)
        for (const element of named.elements)
          bindings.set(element.name.text, {
            module,
            name: (element.propertyName ?? element.name).text,
          });
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      loadedModule(node.initializer)
    ) {
      const module = loadedModule(node.initializer)!;
      for (const element of node.name.elements)
        if (ts.isIdentifier(element.name))
          bindings.set(element.name.text, {
            module,
            name: propertyName(element.propertyName) ?? element.name.text,
          });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bindings;
}

// The class or function export a name refers to, through `ns.Name` for a namespace import.
function exported(bindings: Map<string, Binding>, callee: ts.Expression) {
  if (ts.isIdentifier(callee)) return bindings.get(callee.text);
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const namespace = bindings.get(callee.expression.text);
    if (namespace?.name === '*') return { module: namespace.module, name: callee.name.text };
  }
  return undefined;
}

function classEntry(binding: Binding | undefined) {
  if (!binding) return undefined;
  const legacy = LANGCHAIN_LEGACY.exec(binding.module);
  const module = legacy ? `@langchain/${legacy[1]}` : binding.module;
  return CLASSES[module]?.[binding.name];
}

// Every model sent through a wrapper SDK in the repository's non-test sources.
export function modelWrapperSites(repository: Repository): ModelWrapperSite[] {
  if (
    !repository.files.some((file) =>
      /['"](?:@ai-sdk\/|ai['"]|@langchain\/|langchain|llamaindex|@llamaindex\/)/.test(file.content),
    )
  )
    return [];
  const program = sourceProgram(repository);
  const sites: ModelWrapperSite[] = [];
  const seen = new Set<string>();
  const add = (
    call: ts.Node,
    value: ts.Expression,
    details: Omit<ModelWrapperSite, 'file' | 'line' | 'call' | 'model' | 'version'>,
    prefixed = false,
  ) => {
    for (const literal of modelLiterals(program, value)) {
      const match = PREFIXED.exec(literal.text);
      // A gateway or registry ID names its provider; a bare one belongs to the call's provider.
      if (prefixed && !match) continue;
      const provider = match ? PREFIX_PROVIDER[match[1]] : details.provider;
      // A bare ID shaped like another provider's (`claude-…` reaching `new OpenAI()` through a
      // shared helper) is not this call's model.
      const shaped = MODEL_SHAPES.find(([pattern]) => pattern.test(literal.text))?.[1];
      if (!match && (shaped ? shaped !== provider : RETURNED.has(literal))) continue;
      const site = {
        ...details,
        provider,
        file: program.path(literal),
        line: program.line(literal),
        call: { file: program.path(call), line: program.line(call) },
        model: literal.text,
        version: match ? match[2] : literal.text,
      };
      const key = `${site.file}:${site.line}:${site.model}:${site.call.file}:${site.call.line}`;
      if (!seen.has(key)) {
        seen.add(key);
        sites.push(site);
      }
    }
  };
  for (const source of program.files) {
    const bindings = wrapperBindings(source);
    if (!bindings.size) continue;
    // AI SDK provider instances: the default exports and every `createOpenAI(...)` result, with
    // the endpoint option the factory was given.
    const instances = new Map<string, { provider: Provider; module: string; custom?: string }>();
    for (const [name, binding] of bindings) {
      const provider = AI_SDK[binding.module];
      if (provider && AI_SDK_INSTANCES.has(binding.name))
        instances.set(name, { provider, module: binding.module });
    }
    const collect = (node: ts.Node) => {
      // `const openai = createOpenAI(…)`, or `google = createGoogleGenerativeAI(…)` on a `let`.
      const target =
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
          ? { name: node.name, value: node.initializer }
          : ts.isBinaryExpression(node) &&
              node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
              ts.isIdentifier(node.left)
            ? { name: node.left, value: node.right }
            : undefined;
      if (target?.value && ts.isCallExpression(unwrap(target.value))) {
        const factory = unwrap(target.value) as ts.CallExpression;
        const binding = exported(bindings, factory.expression);
        if (binding && AI_SDK_FACTORIES.has(binding.name) && AI_SDK[binding.module])
          instances.set(target.name.text, {
            provider: AI_SDK[binding.module],
            module: binding.module,
            custom: endpointOption(program, factory.arguments[0]),
          });
        else if (binding?.module === AI_SDK_COMPATIBLE)
          instances.set(target.name.text, {
            provider: 'openai',
            module: binding.module,
            custom: `\`${binding.name}\` from ${AI_SDK_COMPATIBLE} (${program.where(factory)})`,
          });
      }
      ts.forEachChild(node, collect);
    };
    collect(source);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const callee = node.expression;
        const first = node.arguments?.[0];
        // `openai('gpt-4o')` or `openai.chat('gpt-4o')` on an AI SDK provider instance.
        const instanceName = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
            ? callee.expression.text
            : undefined;
        const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
        const instance = instanceName !== undefined ? instances.get(instanceName) : undefined;
        if (
          ts.isCallExpression(node) &&
          instance &&
          first &&
          (method === undefined || Object.hasOwn(AI_SDK_METHODS, method))
        )
          add(node, first, {
            wrapper: 'ai-sdk',
            provider: instance.provider,
            via: `${instance.module} ${instanceName}${method ? `.${method}` : ''}()`,
            text: method === undefined || AI_SDK_METHODS[method],
            ...(instance.custom ? { custom: instance.custom } : {}),
          });
        const binding = exported(bindings, callee);
        const entry = classEntry(binding);
        // `new ChatOpenAI({ model })`, LlamaIndex `new OpenAI({ model })` or `openai({ model })`.
        if (binding && entry && first) {
          const model = option(first, ['model', 'modelName']);
          const custom = endpointOption(program, first);
          if (model)
            add(node, model, {
              wrapper: wrapperOf(binding.module)!,
              provider: entry.provider,
              via: `${binding.module} ${ts.isNewExpression(node) ? 'new ' : ''}${binding.name}()`,
              text: entry.text,
              ...(custom ? { custom } : {}),
            });
        }
        // LangChain `initChatModel('gpt-4o', { modelProvider: 'openai' })` or
        // `initChatModel('openai:gpt-4o')`.
        if (binding?.name === 'initChatModel' && UNIVERSAL.has(binding.module) && first) {
          const providerOption = option(node.arguments?.[1], ['modelProvider']);
          const named =
            providerOption && ts.isStringLiteralLike(unwrap(providerOption))
              ? PREFIX_PROVIDER[(unwrap(providerOption) as ts.StringLiteralLike).text]
              : undefined;
          add(
            node,
            first,
            {
              wrapper: 'langchain',
              provider: named ?? 'openai',
              via: `${binding.module} initChatModel()`,
              text: true,
            },
            !named,
          );
        }
        // AI SDK gateway IDs: `generateText({ model: 'openai/gpt-4o' })` and the like, and a
        // provider registry's `registry.languageModel('openai:gpt-4o')`.
        if (binding?.module === 'ai' && first) {
          const model = option(first, ['model']);
          if (model)
            add(
              node,
              model,
              { wrapper: 'ai-sdk', provider: 'openai', via: `ai ${binding.name}()`, text: true },
              true,
            );
        }
        // The AI SDK gateway provider: `gateway('openai/gpt-4o')`.
        if (binding?.module === 'ai' && binding.name === 'gateway' && first)
          add(
            node,
            first,
            { wrapper: 'ai-sdk', provider: 'openai', via: 'ai gateway()', text: true },
            true,
          );
        if (method === 'languageModel' && !instance && first)
          add(
            node,
            first,
            {
              wrapper: 'ai-sdk',
              provider: 'openai',
              via: 'ai registry.languageModel()',
              text: true,
            },
            true,
          );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
}

// The wrapper sites as model-retirement stops, for the report-only hook in model-retirements.ts:
// listed with why Refit does not edit them, never edited.
export function modelWrapperStops(repository: Repository): ReportOnlySite[] {
  return modelWrapperSites(repository).map((site) => ({
    file: site.file,
    line: site.line,
    model: site.version,
    call: site.via,
    reason: site.custom
      ? `The model is sent through ${site.via} (${site.call.file}:${site.call.line}) on a provider set to another endpoint by ${site.custom}, such as an OpenAI-compatible host (Groq, Together, Fireworks), so it may not be this provider's model; Refit reports it but does not edit it. Check the endpoint and change it by hand if it is.`
      : `The model is sent through ${site.via} (${site.call.file}:${site.call.line}), a ${site.wrapper === 'ai-sdk' ? 'Vercel AI SDK' : site.wrapper === 'langchain' ? 'LangChain' : 'LlamaIndex'} call Refit reports but does not edit; change it by hand.`,
  }));
}
