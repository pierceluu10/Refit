import { posix } from 'node:path';
import type { SdkCallRecord, SourceSite, TracedValue } from '../sdk-call-record.ts';
import {
  readPythonFiles,
  withPythonTrees,
  type Node,
  type PythonFile,
  type Tree,
} from './syntax.ts';

// The model-bearing Python SDKs Refit traces. `clients` maps each client class to the platform it is
// set up for, or null for the provider's own API. `text` lists the text-generation calls; every
// other call that sends a model is traced too, and only reported.
interface PythonSdk {
  provider: string;
  package: string;
  module: string;
  clients: Record<string, string | null>;
  // Whether the module itself is a client, as `openai.chat.completions.create(...)` is.
  moduleClient: boolean;
  text: Set<string>;
}

export const PYTHON_SDKS: PythonSdk[] = [
  {
    provider: 'openai',
    package: 'openai',
    module: 'openai',
    clients: {
      OpenAI: null,
      AsyncOpenAI: null,
      AzureOpenAI: 'Azure OpenAI',
      AsyncAzureOpenAI: 'Azure OpenAI',
    },
    moduleClient: true,
    text: new Set([
      'chat.completions.create',
      'chat.completions.parse',
      'chat.completions.stream',
      'beta.chat.completions.parse',
      'beta.chat.completions.stream',
      'responses.create',
      'responses.parse',
      'responses.stream',
      // openai before 1.0, where the module was the only client.
      'ChatCompletion.create',
      'ChatCompletion.acreate',
    ]),
  },
  {
    provider: 'anthropic',
    package: 'anthropic',
    module: 'anthropic',
    clients: {
      Anthropic: null,
      AsyncAnthropic: null,
      AnthropicBedrock: 'Amazon Bedrock',
      AsyncAnthropicBedrock: 'Amazon Bedrock',
      AnthropicVertex: 'Vertex AI',
      AsyncAnthropicVertex: 'Vertex AI',
    },
    moduleClient: false,
    text: new Set([
      'messages.create',
      'messages.stream',
      'messages.count_tokens',
      'beta.messages.create',
      'beta.messages.stream',
      'beta.messages.count_tokens',
    ]),
  },
  {
    // Report only, like every Gemini call (AGENTS.md).
    provider: 'gemini',
    package: 'google-genai',
    module: 'google.genai',
    clients: { Client: null },
    moduleClient: false,
    text: new Set([
      'models.generate_content',
      'models.generate_content_stream',
      'models.count_tokens',
      'chats.create',
      'aio.models.generate_content',
      'aio.models.generate_content_stream',
      'aio.models.count_tokens',
      'aio.chats.create',
    ]),
  },
];

// LangChain chat model classes, reported by name and never edited: `ChatOpenAI(model=...)`.
const LANGCHAIN_MODELS: Record<string, { provider: string; custom: string | null }> = {
  ChatOpenAI: { provider: 'openai', custom: null },
  AzureChatOpenAI: { provider: 'openai', custom: 'Azure OpenAI' },
  ChatAnthropic: { provider: 'anthropic', custom: null },
};
const LANGCHAIN_MODULES =
  /^(?:langchain_openai|langchain_anthropic|langchain_community\.chat_models|langchain\.chat_models)(?:\.|$)/;
const LANGCHAIN_ENDPOINTS = new Set([
  'base_url',
  'openai_api_base',
  'azure_endpoint',
  'anthropic_api_url',
  'http_client',
]);

// Attributes that return the same resource with another response shape.
const RESPONSE_WRAPPERS = new Set(['with_raw_response', 'with_streaming_response']);
// Keyword arguments that point a client somewhere other than the provider's own API.
const ENDPOINT_OPTIONS = new Set(['base_url', 'azure_endpoint', 'api_base', 'http_client']);
const MAX_DEPTH = 8;
const MAX_TEXT = 80;

// Test, fixture and example files, by directory or name, including pytest's conventions.
export const PYTHON_TEST_PATH =
  /(?:^|\/)(?:tests?|testing|specs?|e2e|fixtures?|examples?|samples?|cookbooks?|notebooks?)\/|(?:^|\/)(?:test_[^/]*|[^/]*_test|conftest)\.py$/i;

type Context = {
  files: Map<string, PythonFile>;
  tree: (path: string) => Tree | undefined;
  // The module client's endpoint, per SDK, found once.
  endpoints?: Map<PythonSdk, string | null>;
  // The call whose return value is being traced, per function (`file:node id`), so that function's
  // parameters take that call's arguments rather than every caller's.
  frames?: Map<string, { call: Node; file: string }>;
};

type Binding =
  | { kind: 'value'; node: Node }
  | { kind: 'parameter'; node: Node; owner: Node }
  | { kind: 'import'; module: string; name: string | null; level: number; at: Node }
  | { kind: 'definition'; node: Node }
  | { kind: 'unknown'; node: Node };

interface Client {
  sdk: PythonSdk;
  kind: SdkCallRecord['client']['kind'];
  at: Node;
  file: string;
  custom: string | null;
}

const text = (node: Node) => {
  const value = node.text.replace(/\s+/g, ' ');
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT - 1)}…` : value;
};
const field = (node: Node, name: string) => node.childForFieldName(name) ?? undefined;
const site = (file: string, node: Node): SourceSite => ({
  file,
  line: node.startPosition.row + 1,
  column: node.startPosition.column + 1,
});

function unwrap(node: Node): Node {
  while (node.type === 'parenthesized_expression' && node.namedChildCount === 1)
    node = node.namedChild(0)!;
  return node;
}

// A plain string's value; undefined for byte strings, interpolated f-strings and escapes.
export function stringValue(node: Node): string | undefined {
  if (node.type !== 'string') return undefined;
  const start = node.child(0)?.text ?? '';
  if (/[bB]/.test(start)) return undefined;
  const parts = node.namedChildren.filter(
    (child) => child && child.type !== 'string_start' && child.type !== 'string_end',
  ) as Node[];
  if (parts.some((part) => part.type !== 'string_content')) return undefined;
  const value = parts.map((part) => part.text).join('');
  return value.includes('\\') ? undefined : value;
}

function keywordArguments(call: Node) {
  const list = field(call, 'arguments');
  const keywords = new Map<string, Node>();
  const splats: Node[] = [];
  let positional = 0;
  for (const child of list?.namedChildren ?? []) {
    if (!child) continue;
    if (child.type === 'keyword_argument') {
      const name = field(child, 'name')?.text;
      const value = field(child, 'value');
      if (name && value) keywords.set(name, value);
    } else if (child.type === 'dictionary_splat') splats.push(child.namedChild(0)!);
    else if (child.type !== 'comment') positional += 1;
  }
  return { keywords, splats, positional };
}

// The names of an attribute chain, outermost last: `a.b.c` gives `a`, then `b` and `c`.
function chain(node: Node) {
  const names: string[] = [];
  const objects: Node[] = [];
  let current = node;
  while (current.type === 'attribute') {
    names.unshift(field(current, 'attribute')!.text);
    current = field(current, 'object')!;
    objects.unshift(current);
  }
  return { root: current, names, objects };
}

function dotted(node: Node): string | undefined {
  node = unwrap(node);
  if (node.type === 'identifier') return node.text;
  if (node.type !== 'attribute') return undefined;
  const object = dotted(field(node, 'object')!);
  return object && `${object}.${field(node, 'attribute')!.text}`;
}

const SCOPES = new Set(['function_definition', 'class_definition', 'lambda']);
// Bindings found per scope and name, per tree: lookups repeat for every use of a name.
const BINDINGS = new WeakMap<Tree, Map<string, Binding[]>>();

// Where a name is bound in one scope: a function's parameters and body, a class body or the
// module. Nested functions and classes are their own scopes and are not entered.
function bindingsIn(scope: Node, name: string): Binding[] {
  let cache = BINDINGS.get(scope.tree);
  if (!cache) BINDINGS.set(scope.tree, (cache = new Map()));
  const key = `${scope.id}\t${name}`;
  let found = cache.get(key);
  if (!found) cache.set(key, (found = scanBindings(scope, name)));
  return found;
}

function scanBindings(scope: Node, name: string): Binding[] {
  const found: Binding[] = [];
  if (scope.type === 'function_definition')
    for (const parameter of field(scope, 'parameters')?.namedChildren ?? []) {
      if (!parameter) continue;
      const id =
        parameter.type === 'identifier'
          ? parameter
          : (field(parameter, 'name') ?? parameter.namedChild(0));
      if (id?.text === name) found.push({ kind: 'parameter', node: parameter, owner: scope });
    }
  const body = scope.type === 'module' ? scope : field(scope, 'body');
  const visit = (node: Node) => {
    for (const child of node.namedChildren) {
      if (!child) continue;
      if (child.type === 'decorated_definition') {
        visit(child);
        continue;
      }
      if (SCOPES.has(child.type)) {
        if (field(child, 'name')?.text === name) found.push({ kind: 'definition', node: child });
        continue;
      }
      if (child.type === 'assignment') {
        const left = field(child, 'left');
        let right = field(child, 'right');
        while (right?.type === 'assignment') right = field(right, 'right');
        if (left?.type === 'identifier' && left.text === name)
          found.push(right ? { kind: 'value', node: right } : { kind: 'unknown', node: child });
        else if (
          left &&
          left.type !== 'identifier' &&
          left.type !== 'attribute' &&
          left.type !== 'subscript' &&
          left.descendantsOfType('identifier').some((id) => id?.text === name)
        )
          found.push({ kind: 'unknown', node: child });
      } else if (child.type === 'augmented_assignment') {
        if (field(child, 'left')?.text === name) found.push({ kind: 'unknown', node: child });
      } else if (child.type === 'for_statement' || child.type === 'as_pattern') {
        const target = field(child, child.type === 'as_pattern' ? 'alias' : 'left');
        if (target?.descendantsOfType('identifier').some((id) => id?.text === name))
          found.push({ kind: 'unknown', node: child });
      } else if (child.type === 'import_from_statement') {
        const module = field(child, 'module_name')!;
        const level =
          module.type === 'relative_import'
            ? (module.descendantsOfType('import_prefix')[0]?.text.length ?? 0)
            : 0;
        const path =
          module.type === 'relative_import'
            ? (module.namedChildren.find((item) => item?.type === 'dotted_name')?.text ?? '')
            : module.text;
        for (const item of child.childrenForFieldName('name')) {
          if (!item) continue;
          const original = item.type === 'aliased_import' ? field(item, 'name')!.text : item.text;
          const local = item.type === 'aliased_import' ? field(item, 'alias')!.text : item.text;
          if (local === name)
            found.push({ kind: 'import', module: path, name: original, level, at: child });
        }
      } else if (child.type === 'import_statement') {
        for (const item of child.childrenForFieldName('name')) {
          if (!item) continue;
          const original = item.type === 'aliased_import' ? field(item, 'name')!.text : item.text;
          const local =
            item.type === 'aliased_import' ? field(item, 'alias')!.text : original.split('.')[0];
          if (local === name)
            found.push({
              kind: 'import',
              module: item.type === 'aliased_import' ? original : local,
              name: null,
              level: 0,
              at: child,
            });
        }
      }
      visit(child);
    }
  };
  if (body) visit(body);
  return found;
}

// The scopes a name used at `node` is looked up in, innermost first (LEGB without builtins). A
// class body is visible only to code directly in it, not to its methods.
function scopesOf(node: Node): Node[] {
  const scopes: Node[] = [];
  let direct = true;
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === 'function_definition' || current.type === 'lambda') {
      scopes.push(current);
      direct = false;
    } else if (current.type === 'class_definition') {
      if (direct) scopes.push(current);
      direct = false;
    } else if (current.type === 'module') scopes.push(current);
  }
  return scopes;
}

function lookup(node: Node, name: string): Binding[] {
  for (const scope of scopesOf(node)) {
    const found = bindingsIn(scope, name);
    if (found.length)
      return scope.type === 'function_definition' ? reaching(scope, node, found) : found;
  }
  return [];
}

// In a function, an assignment that is a statement of the body itself, before the use, replaces
// every earlier binding: `model = MODEL_NAME` at the top of a function hides the parameter.
function reaching(scope: Node, use: Node, found: Binding[]) {
  const body = field(scope, 'body');
  let cut: Node | undefined;
  for (const binding of found) {
    if (binding.kind !== 'value' && binding.kind !== 'unknown') continue;
    const statement =
      binding.node.parent?.type === 'assignment' ? binding.node.parent.parent : binding.node.parent;
    if (
      statement?.parent?.id === body?.id &&
      statement!.endIndex <= use.startIndex &&
      (!cut || statement!.startIndex > cut.startIndex)
    )
      cut = statement!;
  }
  return cut
    ? found.filter(
        (binding) =>
          binding.kind !== 'parameter' &&
          'node' in binding &&
          binding.node.startIndex >= cut!.startIndex,
      )
    : found;
}

// The file a module name refers to, from the importing file: relative imports from its directory,
// absolute ones from the repository root, a `src/` directory or any directory above the file.
function moduleFile(context: Context, from: string, module: string, level: number) {
  const parts = module ? module.split('.') : [];
  const bases: string[] = [];
  if (level) {
    let base = posix.dirname(from);
    for (let step = 1; step < level; step += 1) base = posix.dirname(base);
    bases.push(base);
  } else {
    bases.push('', 'src');
    for (let base = posix.dirname(from); base !== '.' && base !== ''; base = posix.dirname(base))
      bases.push(base);
  }
  for (const base of bases) {
    const stem = posix.join(base || '.', ...parts);
    for (const candidate of [`${stem}.py`, `${stem}/__init__.py`]) {
      const path = posix.normalize(candidate);
      if (context.files.has(path)) return path;
    }
  }
  return undefined;
}

function sdkForModule(module: string) {
  return PYTHON_SDKS.find((sdk) => sdk.module === module);
}

// What an imported or dotted name refers to in an SDK: the module itself or a client class.
function sdkReference(
  context: Context,
  file: string,
  node: Node,
  depth = 0,
):
  { sdk: PythonSdk; kind: 'module' } | { sdk: PythonSdk; kind: 'class'; name: string } | undefined {
  node = unwrap(node);
  if (depth > MAX_DEPTH) return undefined;
  if (node.type === 'attribute') {
    const object = sdkReference(context, file, field(node, 'object')!, depth + 1);
    const name = field(node, 'attribute')!.text;
    if (object?.kind === 'module') {
      if (name in object.sdk.clients) return { sdk: object.sdk, kind: 'class', name };
      const nested = sdkForModule(`${object.sdk.module}.${name}`);
      return nested && { sdk: nested, kind: 'module' };
    }
    // `import google.genai` binds `google`; `google.genai` is then the module.
    const path = dotted(node);
    const sdk = path ? sdkForModule(path) : undefined;
    return sdk && { sdk, kind: 'module' };
  }
  if (node.type !== 'identifier') return undefined;
  for (const binding of lookup(node, node.text)) {
    if (binding.kind !== 'import') continue;
    const full = binding.name ? `${binding.module}.${binding.name}` : binding.module;
    if (binding.level === 0) {
      const sdk = sdkForModule(full);
      if (sdk) return { sdk, kind: 'module' };
      if (binding.name) {
        const owner = PYTHON_SDKS.find(
          (item) => binding.module === item.module || binding.module.startsWith(`${item.module}.`),
        );
        if (owner && binding.name in owner.clients)
          return { sdk: owner, kind: 'class', name: binding.name };
      }
    }
  }
  return undefined;
}

function customEndpoint(call: Node, sdk: PythonSdk, className: string | null) {
  const platform = className ? sdk.clients[className] : null;
  if (platform) return platform;
  const { keywords } = keywordArguments(call);
  return [...keywords.keys()].some((name) => ENDPOINT_OPTIONS.has(name))
    ? 'a custom base URL'
    : null;
}

// The SDK client an expression holds, if Refit can prove it.
function resolveClient(context: Context, file: string, node: Node, depth = 0): Client | undefined {
  node = unwrap(node);
  if (depth > MAX_DEPTH) return undefined;
  if (node.type === 'await') return undefined;
  if (node.type === 'call') {
    const callee = field(node, 'function')!;
    const reference = sdkReference(context, file, callee);
    if (reference?.kind === 'class')
      return {
        sdk: reference.sdk,
        kind: 'constructor',
        at: node,
        file,
        custom: customEndpoint(node, reference.sdk, reference.name),
      };
    if (callee.type === 'attribute' && field(callee, 'attribute')!.text === 'with_options') {
      const client = resolveClient(context, file, field(callee, 'object')!, depth + 1);
      return (
        client && { ...client, custom: client.custom ?? customEndpoint(node, client.sdk, null) }
      );
    }
    // A function in the repository that returns a client on every path that returns one.
    const returned = returnedValues(context, file, callee);
    if (!returned) return undefined;
    let client: Client | undefined;
    for (const value of returned.values) {
      if (value.node.type === 'none') continue;
      const found = resolveClient(context, value.file, value.node, depth + 1);
      if (!found) return undefined;
      client ??= found;
    }
    return client;
  }
  if (node.type === 'identifier') {
    const reference = sdkReference(context, file, node);
    if (reference?.kind === 'module')
      return reference.sdk.moduleClient
        ? {
            sdk: reference.sdk,
            kind: 'module',
            at: node,
            file,
            custom: moduleEndpoint(context, reference.sdk),
          }
        : undefined;
    return clientFromBindings(context, file, lookup(node, node.text), depth);
  }
  if (node.type === 'attribute') {
    const object = unwrap(field(node, 'object')!);
    const name = field(node, 'attribute')!.text;
    if (object.type === 'identifier') {
      const owner = classOfSelf(object);
      if (owner) return clientFromBindings(context, file, classField(owner, name), depth);
      const module = importedModule(context, file, object);
      if (module) {
        const tree = context.tree(module);
        return tree && clientFromBindings(context, module, bindingsIn(tree.rootNode, name), depth);
      }
    }
  }
  return undefined;
}

function clientFromBindings(
  context: Context,
  file: string,
  bindings: Binding[],
  depth: number,
): Client | undefined {
  if (depth > MAX_DEPTH) return undefined;
  let client: Client | undefined;
  for (const binding of bindings) {
    let found: Client | undefined;
    if (binding.kind === 'value') {
      if (binding.node.type === 'none') continue;
      found = resolveClient(context, file, binding.node, depth + 1);
    } else if (binding.kind === 'parameter') {
      const type = field(binding.node, 'type');
      const fallback = field(binding.node, 'value');
      found = type
        ? annotatedClient(context, file, type, binding.node)
        : fallback && resolveClient(context, file, fallback, depth + 1);
    } else if (binding.kind === 'import') {
      const module = binding.name
        ? moduleFile(context, file, binding.module, binding.level)
        : undefined;
      const tree = module ? context.tree(module) : undefined;
      found =
        tree && module
          ? clientFromBindings(context, module, bindingsIn(tree.rootNode, binding.name!), depth + 1)
          : undefined;
    } else if (binding.kind === 'definition' && binding.node.type === 'class_definition') return;
    if (!found) return undefined;
    client ??= found;
  }
  return client;
}

// A parameter or field annotated with an SDK client class, such as `client: AsyncOpenAI` or
// `client: Optional[OpenAI]`.
function annotatedClient(context: Context, file: string, type: Node, at: Node): Client | undefined {
  const candidates = [type, ...type.descendantsOfType(['identifier', 'attribute'])].filter(
    (item): item is Node => Boolean(item),
  );
  for (const candidate of candidates) {
    if (candidate.type !== 'identifier' && candidate.type !== 'attribute') continue;
    const reference = sdkReference(context, file, candidate);
    if (reference?.kind === 'class')
      return {
        sdk: reference.sdk,
        kind: at.type === 'assignment' ? 'class-field' : 'parameter',
        at,
        file,
        custom: reference.sdk.clients[reference.name],
      };
  }
  return undefined;
}

// openai's module client points elsewhere when any file sets `openai.base_url`, `openai.api_base`
// or `openai.api_type`.
function moduleEndpoint(context: Context, sdk: PythonSdk) {
  context.endpoints ??= new Map();
  if (!context.endpoints.has(sdk)) context.endpoints.set(sdk, findModuleEndpoint(context, sdk));
  return context.endpoints.get(sdk)!;
}

function findModuleEndpoint(context: Context, sdk: PythonSdk) {
  for (const [path, file] of context.files) {
    if (!/\b(?:base_url|api_base|api_type)\s*=/.test(file.content)) continue;
    const tree = context.tree(path);
    for (const assignment of tree?.rootNode.descendantsOfType('assignment') ?? []) {
      const left = assignment && field(assignment, 'left');
      if (left?.type !== 'attribute') continue;
      const name = field(left, 'attribute')!.text;
      if (!['base_url', 'api_base', 'api_type'].includes(name)) continue;
      const reference = sdkReference(context, path, field(left, 'object')!);
      if (reference?.kind === 'module' && reference.sdk === sdk)
        return name === 'api_type' ? 'Azure OpenAI' : 'a custom base URL';
    }
  }
  return null;
}

// The class whose instance `self` (or `cls`) is, for a method's first parameter.
function classOfSelf(node: Node) {
  // A nested function may use the method's `self`, as long as it does not bind the name itself.
  for (const scope of scopesOf(node)) {
    if (scope.type !== 'function_definition') return undefined;
    const first = field(scope, 'parameters')?.namedChild(0);
    const name = first?.type === 'identifier' ? first.text : first && field(first, 'name')?.text;
    if (name !== node.text) {
      if (bindingsIn(scope, node.text).length) return undefined;
      continue;
    }
    let owner = scope.parent;
    if (owner?.type === 'decorated_definition') owner = owner.parent;
    owner = owner?.parent ?? null;
    return owner?.type === 'class_definition' ? owner : undefined;
  }
  return undefined;
}

// Every place a class sets an attribute: class-body assignments and annotations, and
// `self.<name> = …` in its methods. Base classes in the same file are searched when the class sets
// none.
function classField(owner: Node, name: string, depth = 0): Binding[] {
  const found: Binding[] = [];
  const body = field(owner, 'body');
  for (const statement of body?.namedChildren ?? []) {
    const assignment = statement?.type === 'expression_statement' ? statement.namedChild(0) : null;
    if (assignment?.type === 'assignment' && field(assignment, 'left')?.text === name) {
      const right = field(assignment, 'right');
      const type = field(assignment, 'type');
      if (right) found.push({ kind: 'value', node: right });
      else if (type) found.push({ kind: 'parameter', node: assignment, owner });
    }
  }
  for (const method of body?.descendantsOfType('function_definition') ?? []) {
    if (!method) continue;
    const first = field(method, 'parameters')?.namedChild(0);
    const self = first?.type === 'identifier' ? first.text : undefined;
    if (!self) continue;
    for (const assignment of method.descendantsOfType(['assignment', 'augmented_assignment'])) {
      const left = assignment && field(assignment, 'left');
      if (
        left?.type !== 'attribute' ||
        field(left, 'object')?.text !== self ||
        field(left, 'attribute')!.text !== name
      )
        continue;
      let right = field(assignment!, 'right');
      while (right?.type === 'assignment') right = field(right, 'right');
      found.push(
        assignment!.type === 'assignment' && right
          ? { kind: 'value', node: right }
          : { kind: 'unknown', node: assignment! },
      );
    }
  }
  if (found.length || depth >= 2) return found;
  for (const base of field(owner, 'superclasses')?.namedChildren ?? []) {
    if (base?.type !== 'identifier') continue;
    const definition = lookup(owner, base.text).find((item) => item.kind === 'definition');
    if (definition?.node.type === 'class_definition')
      return classField(definition.node, name, depth + 1);
  }
  return found;
}

// The repository file an identifier names when it is an imported local module.
function importedModule(context: Context, file: string, node: Node) {
  for (const binding of lookup(node, node.text)) {
    if (binding.kind !== 'import') return undefined;
    const module = binding.name
      ? `${binding.module ? `${binding.module}.` : ''}${binding.name}`
      : binding.module;
    return moduleFile(context, file, module, binding.level);
  }
  return undefined;
}

// Every literal a value can resolve to, following constants, environment defaults, `or`
// fallbacks, conditionals, class fields, dictionary entries, imported constants, parameter
// defaults and same-file callers.
function traceValue(
  context: Context,
  file: string,
  node: Node,
  via: string,
  depth = 0,
  seen = new Set<string>(),
): TracedValue {
  node = unwrap(node);
  const key = `${file}:${node.id}:${[...(context.frames?.values() ?? [])].map((frame) => frame.call.id).join(',')}`;
  const stop = (reason: string): TracedValue => ({ literals: [], stop: reason });
  if (depth > MAX_DEPTH)
    return stop(`Tracing this model stopped at the depth limit of ${MAX_DEPTH}.`);
  if (seen.has(key)) return { literals: [], stop: null };
  seen.add(key);
  const next = (target: Node, how: string, where = file) =>
    traceValue(context, where, target, how, depth + 1, seen);
  const value = stringValue(node);
  // An empty string names no model.
  if (value === '') return { literals: [], stop: null };
  if (value !== undefined) return { literals: [{ ...site(file, node), value, via }], stop: null };
  switch (node.type) {
    case 'string':
    case 'concatenated_string':
    case 'binary_operator':
      return stop(`The model is built from \`${text(node)}\`, which Refit cannot trace.`);
    case 'boolean_operator':
    case 'conditional_expression':
      return merge(
        node.namedChildren
          .filter((child): child is Node => Boolean(child))
          .filter((_, index) => node.type === 'boolean_operator' || index !== 1)
          .map((child) => next(child, via)),
      );
    case 'identifier':
      return traceBindings(context, file, node, lookup(node, node.text), node.text, depth, seen);
    case 'attribute': {
      const object = unwrap(field(node, 'object')!);
      const name = field(node, 'attribute')!.text;
      if (object.type === 'identifier') {
        const owner = classOfSelf(object);
        if (owner)
          return traceBindings(
            context,
            file,
            node,
            classField(owner, name),
            `${object.text}.${name}`,
            depth,
            seen,
            'class field',
          );
        const module = importedModule(context, file, object);
        const tree = module && context.tree(module);
        if (module && tree)
          return traceBindings(
            context,
            module,
            node,
            bindingsIn(tree.rootNode, name),
            name,
            depth,
            seen,
            `constant from ${module}`,
          );
        // A class defined in the repository, or an instance of one: its class-level default.
        const definition = classDefinition(context, file, object);
        if (definition)
          return traceBindings(
            context,
            definition.file,
            node,
            classField(definition.node, name),
            `${object.text}.${name}`,
            depth,
            seen,
            'class field',
          );
        const argument = argparseDefault(context, file, object, name, depth, seen);
        if (argument) return argument;
      }
      return stop(`The model comes from \`${text(node)}\`, which Refit cannot trace.`);
    }
    case 'call': {
      const environment = environmentRead(node);
      if (environment) {
        const fallback = environment.fallback
          ? next(environment.fallback, `environment default (${environment.name})`)
          : { literals: [], stop: null };
        return environment.fallback
          ? fallback
          : stop(
              `The model is read from the environment variable ${environment.name} with no default.`,
            );
      }
      // `config.get("model", "gpt-4o")`: the default, and the entry when the mapping is a literal.
      const callee = field(node, 'function')!;
      const { keywords } = keywordArguments(node);
      const positional = (field(node, 'arguments')?.namedChildren ?? []).filter(
        (item): item is Node =>
          Boolean(item) && item!.type !== 'keyword_argument' && item!.type !== 'comment',
      );
      const fallback = positional[1] ?? keywords.get('default');
      const entry = positional[0] && stringValue(unwrap(positional[0]));
      if (callee.type === 'attribute' && field(callee, 'attribute')!.text === 'get' && entry) {
        const table = field(callee, 'object')!;
        const values = [
          dictionaryEntries(context, file, table, entry, depth, seen) ?? {
            literals: [],
            stop: null,
          },
        ];
        if (fallback) values.push(next(fallback, `default of \`${text(callee)}("${entry}")\``));
        return merge(values);
      }
      // pydantic's `Field(default=...)` or `Field("...")`.
      const name = callee.type === 'attribute' ? field(callee, 'attribute')!.text : callee.text;
      if (name === 'Field' && (keywords.get('default') ?? positional[0]))
        return next(keywords.get('default') ?? positional[0], via);
      const factory = returnedValues(context, file, callee);
      if (factory) {
        context.frames ??= new Map();
        const frame = `${factory.file}:${factory.definition.id}`;
        const previous = context.frames.get(frame);
        context.frames.set(frame, { call: node, file });
        try {
          return merge(factory.values.map((value) => next(value.node, via, value.file)));
        } finally {
          if (previous) context.frames.set(frame, previous);
          else context.frames.delete(frame);
        }
      }
      return stop(`The model comes from \`${text(node)}\`, which Refit cannot trace.`);
    }
    case 'subscript': {
      const environment = environmentRead(node);
      if (environment)
        return stop(
          `The model is read from the environment variable ${environment.name} with no default.`,
        );
      const index = field(node, 'subscript');
      const keyValue = index && stringValue(unwrap(index));
      const table = field(node, 'value');
      if (keyValue !== undefined && table) {
        const entries = dictionaryEntries(context, file, table, keyValue, depth, seen);
        if (entries) return entries;
      }
      return stop(`The model comes from \`${text(node)}\`, which Refit cannot trace.`);
    }
    default:
      return stop(`The model comes from \`${text(node)}\`, which Refit cannot trace.`);
  }
}

function merge(values: TracedValue[]): TracedValue {
  return {
    literals: values.flatMap((value) => value.literals),
    stop: values.find((value) => value.stop)?.stop ?? null,
  };
}

function traceBindings(
  context: Context,
  file: string,
  at: Node,
  bindings: Binding[],
  name: string,
  depth: number,
  seen: Set<string>,
  kind = 'constant',
): TracedValue {
  if (depth > MAX_DEPTH)
    return { literals: [], stop: `Tracing this model stopped at the depth limit of ${MAX_DEPTH}.` };
  if (!bindings.length)
    return { literals: [], stop: `The model comes from \`${name}\`, which Refit cannot trace.` };
  return merge(
    bindings.map((binding): TracedValue => {
      const next = (target: Node, via: string, where = file) =>
        traceValue(context, where, target, via, depth + 1, seen);
      switch (binding.kind) {
        case 'value':
          return binding.node.type === 'none'
            ? { literals: [], stop: null }
            : next(binding.node, `${kind} \`${name}\``);
        case 'parameter':
          return traceParameter(context, file, binding, name, depth, seen);
        case 'import': {
          const module = binding.name
            ? moduleFile(context, file, binding.module, binding.level)
            : undefined;
          const tree = module && context.tree(module);
          return module && tree
            ? traceBindings(
                context,
                module,
                at,
                bindingsIn(tree.rootNode, binding.name!),
                binding.name!,
                depth + 1,
                seen,
                `constant from ${module}`,
              )
            : {
                literals: [],
                stop: `The model is imported from \`${binding.module || '.'}\`, which is not a file in this repository.`,
              };
        }
        default:
          return {
            literals: [],
            stop: `The model comes from \`${name}\`, which is reassigned or unpacked where Refit cannot trace it.`,
          };
      }
    }),
  );
}

// A parameter's default and the arguments callers in the same file pass for it.
function traceParameter(
  context: Context,
  file: string,
  binding: Extract<Binding, { kind: 'parameter' }>,
  name: string,
  depth: number,
  seen: Set<string>,
): TracedValue {
  const owner = binding.owner;
  if (owner.type !== 'function_definition')
    return {
      literals: [],
      stop: `The model comes from the field \`${name}\`, which has no value.`,
    };
  const values: TracedValue[] = [];
  const parameters = (field(owner, 'parameters')?.namedChildren ?? []).filter(
    (item): item is Node => Boolean(item),
  );
  // Parameters after `*args` or a bare `*` take keywords only.
  const index = parameters.findIndex((item) => item.id === binding.node.id);
  const position = parameters
    .slice(0, index)
    .some((item) => item.type === 'list_splat_pattern' || item.type === 'keyword_separator')
    ? -1
    : index;
  const functionName = field(owner, 'name')!.text;
  let container = owner.parent;
  if (container?.type === 'decorated_definition') container = container.parent;
  const method = container?.parent?.type === 'class_definition' ? container.parent : undefined;
  const callee = functionName === '__init__' && method ? field(method, 'name')!.text : functionName;
  const offset = method ? 1 : 0;
  const frame = context.frames?.get(`${file}:${owner.id}`);
  const argumentOf = (call: Node) => {
    const { keywords } = keywordArguments(call);
    const positional = (field(call, 'arguments')?.namedChildren ?? []).filter(
      (item): item is Node =>
        Boolean(item) &&
        item!.type !== 'keyword_argument' &&
        item!.type !== 'dictionary_splat' &&
        item!.type !== 'comment',
    );
    return (
      keywords.get(name) ??
      (position - offset >= 0 && positional[position - offset]?.type !== 'list_splat'
        ? positional[position - offset]
        : undefined)
    );
  };
  const fallback = field(binding.node, 'value');
  // Tracing what one call returns: only that call's argument, or the default.
  if (frame) {
    const argument = argumentOf(frame.call);
    if (argument)
      return traceValue(context, frame.file, argument, `argument for \`${name}\``, depth + 1, seen);
    return fallback && fallback.type !== 'none'
      ? traceValue(context, file, fallback, `parameter default \`${name}\``, depth + 1, seen)
      : { literals: [], stop: null };
  }
  let unknown = false;
  // The default is sent when no caller is found, or one leaves the argument out.
  let callers = 0;
  let omitted = false;
  for (const { call, where } of callersOf(context, file, method ?? owner, callee)) {
    const argument = argumentOf(call);
    callers += 1;
    if (argument)
      values.push(
        traceValue(context, where, argument, `argument for \`${name}\``, depth + 1, seen),
      );
    else if (
      field(call, 'arguments')?.namedChildren.some(
        (item) => item?.type === 'list_splat' || item?.type === 'dictionary_splat',
      )
    )
      unknown = true;
    else omitted = true;
  }
  if (fallback && fallback.type !== 'none' && (!callers || omitted))
    values.unshift(
      traceValue(context, file, fallback, `parameter default \`${name}\``, depth + 1, seen),
    );
  if (unknown)
    values.push({
      literals: [],
      stop: `A caller passes \`${name}\` through unpacked arguments, which Refit cannot trace.`,
    });
  if (!values.length)
    values.push({
      literals: [],
      stop: `The model comes from the parameter \`${name}\`, and no caller Refit found passes it.`,
    });
  return merge(values);
}

// Calls to a function or class by name: every call in its own file, and calls in other files that
// import it from that file (by name or through the module), when it is defined at module level.
function callersOf(context: Context, file: string, definition: Node, name: string) {
  const found: { call: Node; where: string }[] = [];
  let top: Node | null = definition.parent;
  if (top?.type === 'decorated_definition') top = top.parent;
  const moduleLevel = top?.type === 'module';
  for (const [path, source] of context.files) {
    if (path !== file && (!moduleLevel || !source.content.includes(name))) continue;
    for (const call of context.tree(path)?.rootNode.descendantsOfType('call') ?? []) {
      if (!call) continue;
      const target = field(call, 'function')!;
      const called =
        target.type === 'identifier'
          ? target.text
          : target.type === 'attribute'
            ? field(target, 'attribute')!.text
            : undefined;
      if (called !== name) continue;
      if (path !== file) {
        const object = target.type === 'attribute' ? unwrap(field(target, 'object')!) : undefined;
        const imported =
          target.type === 'identifier'
            ? lookup(target, name).some(
                (binding) =>
                  binding.kind === 'import' &&
                  binding.name !== null &&
                  moduleFile(context, path, binding.module, binding.level) === file,
              )
            : object?.type === 'identifier' && importedModule(context, path, object) === file;
        if (!imported) continue;
      }
      found.push({ call, where: path });
    }
  }
  return found;
}

// `os.getenv("NAME", default)`, `os.environ.get("NAME", default)` and `os.environ["NAME"]`.
function environmentRead(node: Node): { name: string; fallback: Node | undefined } | undefined {
  if (node.type === 'subscript') {
    const value = field(node, 'value');
    const index = field(node, 'subscript');
    if (value && /^(?:os\.)?environ$/.test(dotted(value) ?? '') && index)
      return { name: stringValue(unwrap(index)) ?? text(index), fallback: undefined };
    return undefined;
  }
  const callee = dotted(field(node, 'function')!) ?? '';
  if (!/^(?:os\.)?(?:getenv|environ\.get)$/.test(callee)) return undefined;
  const { keywords } = keywordArguments(node);
  const positional = (field(node, 'arguments')?.namedChildren ?? []).filter(
    (item): item is Node =>
      Boolean(item) && item!.type !== 'keyword_argument' && item!.type !== 'comment',
  );
  const name = positional[0] ?? keywords.get('key');
  if (!name) return undefined;
  return {
    name: stringValue(unwrap(name)) ?? text(name),
    fallback: positional[1] ?? keywords.get('default'),
  };
}

// A dictionary entry by literal key, where the dictionary is a literal Refit can reach.
function dictionaryEntries(
  context: Context,
  file: string,
  table: Node,
  key: string,
  depth: number,
  seen: Set<string>,
): TracedValue | undefined {
  table = unwrap(table);
  let dictionary: Node | undefined = table.type === 'dictionary' ? table : undefined;
  if (table.type === 'identifier') {
    const bindings = lookup(table, table.text);
    if (
      bindings.length === 1 &&
      bindings[0].kind === 'value' &&
      bindings[0].node.type === 'dictionary'
    )
      dictionary = bindings[0].node;
  }
  for (const pair of dictionary?.namedChildren ?? [])
    if (pair?.type === 'pair' && stringValue(unwrap(field(pair, 'key')!)) === key)
      return traceValue(context, file, field(pair, 'value')!, `entry \`${key}\``, depth + 1, seen);
  return undefined;
}

// The class an identifier names or holds an instance of, when it is defined in the repository.
function classDefinition(
  context: Context,
  file: string,
  node: Node,
  depth = 0,
): { file: string; node: Node } | undefined {
  if (depth > 2) return undefined;
  const bindings = lookup(node, node.text);
  if (bindings.length !== 1) return undefined;
  const [binding] = bindings;
  if (binding.kind === 'definition' && binding.node.type === 'class_definition')
    return { file, node: binding.node };
  if (binding.kind === 'value' && binding.node.type === 'call') {
    const callee = unwrap(field(binding.node, 'function')!);
    return callee.type === 'identifier'
      ? classDefinition(context, file, callee, depth + 1)
      : undefined;
  }
  if (binding.kind === 'import' && binding.name) {
    const module = moduleFile(context, file, binding.module, binding.level);
    const tree = module && context.tree(module);
    if (!module || !tree) return undefined;
    const found = bindingsIn(tree.rootNode, binding.name);
    if (found.length !== 1) return undefined;
    if (found[0].kind === 'definition' && found[0].node.type === 'class_definition')
      return { file: module, node: found[0].node };
    if (found[0].kind === 'value' && found[0].node.type === 'call') {
      const callee = unwrap(field(found[0].node, 'function')!);
      return callee.type === 'identifier'
        ? classDefinition(context, module, callee, depth + 1)
        : undefined;
    }
  }
  return undefined;
}

// The options a `**name` spread passes, when it is a dictionary literal or `dict(...)` call.
function spreadOptions(
  context: Context,
  file: string,
  splat: Node,
  depth = 0,
): { options: Map<string, Node>; complete: boolean } | undefined {
  splat = unwrap(splat);
  if (depth > MAX_DEPTH) return undefined;
  if (splat.type === 'identifier') {
    const bindings = lookup(splat, splat.text).filter((item) => item.kind === 'value');
    if (bindings.length !== 1 || lookup(splat, splat.text).length !== 1) return undefined;
    return spreadOptions(context, file, bindings[0].node, depth + 1);
  }
  const options = new Map<string, Node>();
  if (splat.type === 'dictionary') {
    // Keys after a `**other` win over it; keys before it may be replaced by it.
    let complete = true;
    for (const pair of splat.namedChildren) {
      if (!pair || pair.type === 'comment') continue;
      if (pair.type === 'dictionary_splat') {
        options.clear();
        complete = false;
        continue;
      }
      const key = pair.type === 'pair' ? stringValue(unwrap(field(pair, 'key')!)) : undefined;
      if (key === undefined) return undefined;
      options.set(key, field(pair, 'value')!);
    }
    return { options, complete };
  }
  if (splat.type === 'call' && field(splat, 'function')?.text === 'dict') {
    const { keywords, splats, positional } = keywordArguments(splat);
    return splats.length || positional ? undefined : { options: keywords, complete: true };
  }
  return undefined;
}

// The values a function in the repository returns, by the callee that calls it: a function in
// the same file or imported from a repository module, or a method called on `self`.
function returnedValues(
  context: Context,
  file: string,
  callee: Node,
): { definition: Node; file: string; values: { node: Node; file: string }[] } | undefined {
  callee = unwrap(callee);
  let definition: { node: Node; file: string } | undefined;
  if (callee.type === 'identifier') {
    const bindings = lookup(callee, callee.text);
    const [binding] = bindings;
    if (bindings.length !== 1) return undefined;
    if (binding.kind === 'definition' && binding.node.type === 'function_definition')
      definition = { node: binding.node, file };
    else if (binding.kind === 'import' && binding.name) {
      const module = moduleFile(context, file, binding.module, binding.level);
      const tree = module && context.tree(module);
      const found = tree ? bindingsIn(tree.rootNode, binding.name) : [];
      if (
        module &&
        found.length === 1 &&
        found[0].kind === 'definition' &&
        found[0].node.type === 'function_definition'
      )
        definition = { node: found[0].node, file: module };
    }
  } else if (callee.type === 'attribute') {
    const object = unwrap(field(callee, 'object')!);
    const owner = object.type === 'identifier' ? classOfSelf(object) : undefined;
    const name = field(callee, 'attribute')!.text;
    const method = field(owner ?? callee, 'body')
      ?.namedChildren.map((item) =>
        item?.type === 'decorated_definition' ? field(item, 'definition') : item,
      )
      .find((item) => item?.type === 'function_definition' && field(item, 'name')?.text === name);
    if (owner && method) definition = { node: method, file };
  }
  if (!definition) return undefined;
  const values: { node: Node; file: string }[] = [];
  const visit = (node: Node) => {
    for (const child of node.namedChildren) {
      if (!child || SCOPES.has(child.type) || child.type === 'decorated_definition') continue;
      if (child.type === 'return_statement') {
        const value = child.namedChild(0);
        if (!value) return void values.push({ node: child, file: definition!.file });
        values.push({ node: value, file: definition!.file });
      } else visit(child);
    }
  };
  const body = field(definition.node, 'body');
  if (body) visit(body);
  return values.length ? { definition: definition.node, file: definition.file, values } : undefined;
}

// `args.model` from `argparse`: the default of the option whose destination is `model`, when the
// file defines it with `add_argument`.
function argparseDefault(
  context: Context,
  file: string,
  object: Node,
  name: string,
  depth: number,
  seen: Set<string>,
): TracedValue | undefined {
  const bindings = lookup(object, object.text);
  const parsed = bindings.every(
    (binding) =>
      binding.kind === 'parameter' ||
      (binding.kind === 'value' &&
        binding.node.type === 'call' &&
        /\.parse(?:_known)?_args$/.test(field(binding.node, 'function')!.text)),
  );
  if (!bindings.length || !parsed) return undefined;
  for (const call of context.tree(file)?.rootNode.descendantsOfType('call') ?? []) {
    const callee = call && field(call, 'function');
    if (callee?.type !== 'attribute' || field(callee, 'attribute')!.text !== 'add_argument')
      continue;
    const { keywords } = keywordArguments(call!);
    const flags = (field(call!, 'arguments')?.namedChildren ?? [])
      .map((item) => (item ? stringValue(item) : undefined))
      .filter((item): item is string => item !== undefined);
    const destination =
      (keywords.get('dest') && stringValue(keywords.get('dest')!)) ??
      (flags.find((flag) => flag.startsWith('--')) ?? flags[0] ?? '')
        .replace(/^-+/, '')
        .replaceAll('-', '_');
    if (destination !== name) continue;
    const fallback = keywords.get('default');
    return fallback
      ? traceValue(context, file, fallback, `command-line default (--${name})`, depth + 1, seen)
      : {
          literals: [],
          stop: `The model comes from the command-line option for \`${name}\`, which has no default.`,
        };
  }
  return undefined;
}

// Every SDK call that sends a model, in every Python file that could make one.
function traceCalls(context: Context): SdkCallRecord[] {
  const records: SdkCallRecord[] = [];
  for (const [path, file] of context.files) {
    if (!/\bmodel\b|\*\*/.test(file.content)) continue;
    const tree = context.tree(path);
    for (const call of tree?.rootNode.descendantsOfType('call') ?? []) {
      if (!call) continue;
      const callee = field(call, 'function')!;
      const wrapper = langchainModel(callee);
      if (wrapper) {
        const record = langchainRecord(context, path, call, callee, wrapper);
        if (record) records.push(record);
        continue;
      }
      if (callee.type !== 'attribute') continue;
      const { names, objects } = chain(callee);
      let client: Client | undefined;
      let index = 0;
      for (; index < objects.length && !client; index += 1)
        client = resolveClient(context, path, objects[index]);
      if (!client) continue;
      const parts = names.slice(index - 1).filter((name) => !RESPONSE_WRAPPERS.has(name));
      if (parts.length < 2) continue;
      const method = parts.at(-1)!;
      const resource = parts.slice(0, -1).join('.');
      const { keywords, splats } = keywordArguments(call);
      const options = new Map(keywords);
      let spread = false;
      for (const splat of splats) {
        const found = spreadOptions(context, path, splat);
        if (!found?.complete) spread = true;
        for (const [name, value] of found?.options ?? [])
          if (!options.has(name)) options.set(name, value);
      }
      const model = options.get('model');
      if (!model && !spread) continue;
      records.push({
        language: 'python',
        provider: client.sdk.provider,
        package: client.sdk.package,
        ...site(path, call),
        resource,
        method,
        expression: text(callee),
        client: {
          kind: client.kind,
          ...site(client.file, client.at),
          custom: client.custom,
        },
        options: [...options.keys()],
        spread,
        arguments: {
          model: model
            ? traceValue(context, path, model, 'literal')
            : {
                literals: [],
                stop: `The request passes its options with \`**${text(splats[0])}\`, which Refit cannot trace.`,
              },
        },
      });
    }
  }
  return records;
}

// The LangChain chat model class a callee names, with the package it is imported from.
function langchainModel(callee: Node) {
  callee = unwrap(callee);
  const root = callee.type === 'attribute' ? unwrap(field(callee, 'object')!) : callee;
  if (root.type !== 'identifier') return undefined;
  for (const binding of lookup(root, root.text)) {
    if (binding.kind !== 'import' || binding.level) continue;
    // `ChatOpenAI(...)`, imported under any alias, or `langchain_openai.ChatOpenAI(...)`.
    const [module, name] =
      callee.type === 'identifier'
        ? [binding.module, binding.name ?? '']
        : [
            binding.name ? `${binding.module}.${binding.name}` : binding.module,
            field(callee, 'attribute')!.text,
          ];
    if (name in LANGCHAIN_MODELS && LANGCHAIN_MODULES.test(module))
      return {
        name,
        package: module.split('.')[0].replaceAll('_', '-'),
        ...LANGCHAIN_MODELS[name],
      };
  }
  return undefined;
}

function langchainRecord(
  context: Context,
  path: string,
  call: Node,
  callee: Node,
  wrapper: NonNullable<ReturnType<typeof langchainModel>>,
): SdkCallRecord | undefined {
  const { keywords, splats } = keywordArguments(call);
  const options = new Map(keywords);
  let spread = false;
  for (const splat of splats) {
    const found = spreadOptions(context, path, splat);
    if (!found?.complete) spread = true;
    for (const [name, value] of found?.options ?? [])
      if (!options.has(name)) options.set(name, value);
  }
  const model = options.get('model') ?? options.get('model_name');
  if (!model && !spread) return undefined;
  return {
    language: 'python',
    provider: wrapper.provider,
    package: wrapper.package,
    ...site(path, call),
    resource: 'langchain',
    method: wrapper.name,
    expression: text(callee),
    client: {
      kind: 'constructor',
      ...site(path, call),
      custom:
        wrapper.custom ??
        ([...options.keys()].some((name) => LANGCHAIN_ENDPOINTS.has(name))
          ? 'a custom base URL'
          : null),
    },
    options: [...options.keys()],
    spread,
    arguments: {
      model: model
        ? traceValue(context, path, model, 'literal')
        : {
            literals: [],
            stop: `The model is passed with \`**${text(splats[0])}\`, which Refit cannot trace.`,
          },
    },
  };
}

export function isTextCall(record: Pick<SdkCallRecord, 'provider' | 'resource' | 'method'>) {
  const sdk = PYTHON_SDKS.find((item) => item.provider === record.provider);
  return Boolean(sdk?.text.has(`${record.resource}.${record.method}`));
}

export interface PythonModelTrace {
  calls: SdkCallRecord[];
  files: number;
}

// Every OpenAI, Anthropic and google-genai call in a repository's Python code that sends a model,
// with the literals its model can resolve to. Nothing is executed.
export async function tracePythonModelCalls(directory: string): Promise<PythonModelTrace> {
  const files = await readPythonFiles(directory);
  return { calls: await traceFiles(files), files: files.length };
}

export async function traceFiles(files: PythonFile[]) {
  if (
    !files.some(
      (file) =>
        file.content.includes('langchain') ||
        PYTHON_SDKS.some((sdk) => file.content.includes(sdk.module.split('.').at(-1)!)),
    )
  )
    return [];
  return withPythonTrees(files, (tree) =>
    traceCalls({ files: new Map(files.map((file) => [file.path, file])), tree }),
  );
}
