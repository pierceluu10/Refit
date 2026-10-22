import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { SdkCallRecord, SourceSite, TracedValue } from '../sdk-call-record.ts';
import { readGoFiles, withGoTrees, type GoFile, type Node, type Tree } from './syntax.ts';

// The Go SDKs Refit traces, by module path without the major suffix. `clients` are the constructor
// functions and client types that prove a value is a client; `text` lists the text-generation
// calls (others are traced and only reported).
interface GoSdk {
  provider: string;
  module: string;
  // The package name of the module's root package.
  name: string;
  constructors: Set<string>;
  types: Set<string>;
  text: Set<string>;
}

export const GO_SDKS: GoSdk[] = [
  {
    provider: 'stripe',
    module: 'github.com/stripe/stripe-go',
    name: 'stripe',
    // `stripe.NewClient` (v82 and later) and `client.New` from the `client` package.
    constructors: new Set(['NewClient', 'client.New']),
    types: new Set(['Client', 'client.API']),
    text: new Set(),
  },
  {
    provider: 'openai',
    module: 'github.com/openai/openai-go',
    name: 'openai',
    constructors: new Set(['NewClient']),
    types: new Set(['Client']),
    text: new Set([
      'Chat.Completions.New',
      'Chat.Completions.NewStreaming',
      'Responses.New',
      'Responses.NewStreaming',
    ]),
  },
  {
    provider: 'anthropic',
    module: 'github.com/anthropics/anthropic-sdk-go',
    name: 'anthropic',
    constructors: new Set(['NewClient']),
    types: new Set(['Client']),
    text: new Set([
      'Messages.New',
      'Messages.NewStreaming',
      'Messages.CountTokens',
      'Beta.Messages.New',
      'Beta.Messages.NewStreaming',
      'Beta.Messages.CountTokens',
    ]),
  },
];

// stripe-go packages that are not API resources.
const STRIPE_NOT_RESOURCES = new Set(['client', 'form', 'webhook', 'rawrequest', 'testing']);
const MAX_DEPTH = 8;
const MAX_TEXT = 80;

// `_test.go` files and test, example and sample directories.
export const GO_TEST_PATH =
  /(?:^|\/)(?:tests?|testing|e2e|fixtures?|examples?|samples?|_examples?)\/|_test\.go$/i;

// Generated from the SDKs' published sources by scripts/go-sdks.mjs: the Stripe API version each
// stripe-go release pins, and the model constants of openai-go and anthropic-sdk-go.
export interface GoSdkData {
  stripe: Record<string, Record<string, string>>;
  openai: Record<string, { constants: Record<string, string> }>;
  anthropic: Record<string, { constants: Record<string, string> }>;
}
let data: Promise<GoSdkData> | undefined;
export function goSdkData() {
  data ??= readFile(new URL('../../data/go-sdks.json', import.meta.url), 'utf8').then(
    (text) => JSON.parse(text) as GoSdkData,
  );
  return data;
}

interface Import {
  sdk: GoSdk;
  // The package below the module root, such as `paymentintent` or `client`; empty for the root.
  subpackage: string;
}

type Context = {
  files: Map<string, GoFile>;
  tree: (path: string) => Tree | undefined;
  constants: Map<string, string>;
};

const field = (node: Node, name: string) => node.childForFieldName(name) ?? undefined;
const named = (node: Node | undefined) =>
  (node?.namedChildren ?? []).filter((child): child is Node => Boolean(child));
const site = (file: string, node: Node): SourceSite => ({
  file,
  line: node.startPosition.row + 1,
  column: node.startPosition.column + 1,
});
const text = (node: Node) => {
  const value = node.text.replace(/\s+/g, ' ');
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT - 1)}…` : value;
};

export function goString(node: Node): string | undefined {
  if (node.type === 'interpreted_string_literal') {
    const parts = named(node);
    if (parts.some((part) => part.type !== 'interpreted_string_literal_content')) return undefined;
    return parts.map((part) => part.text).join('');
  }
  if (node.type === 'raw_string_literal') return node.text.slice(1, -1);
  return undefined;
}

function unwrap(node: Node): Node {
  while (node.type === 'parenthesized_expression' && named(node).length === 1)
    node = named(node)[0];
  return node;
}

// The SDK an import path belongs to, and the package below its root.
function importOf(path: string): Import | undefined {
  for (const sdk of GO_SDKS) {
    const match = new RegExp(`^${sdk.module.replaceAll('.', '\\.')}(?:/v\\d+)?(?:/(.+))?$`).exec(
      path,
    );
    if (match) return { sdk, subpackage: match[1] ?? '' };
  }
  return undefined;
}

// Every import of a file by local name, with Go's default name: the last path element, or the
// module's package name for a module root with a major suffix.
function imports(root: Node) {
  const found = new Map<string, Import>();
  for (const spec of root.descendantsOfType('import_spec')) {
    if (!spec) continue;
    const path = goString(field(spec, 'path')!);
    const sdkImport = path && importOf(path);
    if (!sdkImport) continue;
    const alias = field(spec, 'name')?.text;
    if (alias === '_' || alias === '.') continue;
    const local =
      alias ??
      (sdkImport.subpackage ? sdkImport.subpackage.split('/').at(-1)! : sdkImport.sdk.name);
    found.set(local, sdkImport);
  }
  return found;
}

const FUNCTIONS = new Set(['function_declaration', 'method_declaration', 'func_literal']);

function enclosingFunction(node: Node) {
  for (let current = node.parent; current; current = current.parent)
    if (FUNCTIONS.has(current.type)) return current;
  return undefined;
}

type Binding =
  | { kind: 'value'; node: Node; file: string }
  | { kind: 'type'; node: Node; file: string }
  | { kind: 'parameter'; node: Node; owner: Node; file: string };

// Where a name is bound: in the enclosing functions (parameters, `:=`, `var`, `=`), then at package
// level in every file of the same directory.
function bindings(context: Context, file: string, use: Node, name: string): Binding[] {
  for (let scope = enclosingFunction(use); scope; scope = enclosingFunction(scope)) {
    const found: Binding[] = [];
    for (const list of [field(scope, 'receiver'), field(scope, 'parameters')])
      for (const parameter of named(list))
        if (named(parameter).some((child) => child.type === 'identifier' && child.text === name))
          found.push({ kind: 'parameter', node: parameter, owner: scope, file });
    const body = field(scope, 'body');
    for (const node of body?.descendantsOfType([
      'short_var_declaration',
      'var_spec',
      'assignment_statement',
      'const_spec',
    ]) ?? []) {
      if (!node || enclosingFunction(node)?.id !== scope.id) continue;
      found.push(...declared(node, name, file));
    }
    if (found.length) return found;
  }
  const directory = posix.dirname(file);
  const found: Binding[] = [];
  for (const path of context.files.keys()) {
    if (posix.dirname(path) !== directory) continue;
    const root = context.tree(path)?.rootNode;
    for (const node of root?.descendantsOfType(['var_spec', 'const_spec']) ?? [])
      if (node && !enclosingFunction(node)) found.push(...declared(node, name, path));
  }
  return found;
}

// The values or declared type a declaration gives `name`.
function declared(node: Node, name: string, file: string): Binding[] {
  if (node.type === 'var_spec' || node.type === 'const_spec') {
    const names = node.childrenForFieldName('name').filter((item): item is Node => Boolean(item));
    const index = names.findIndex((item) => item.text === name);
    if (index < 0) return [];
    const values = named(field(node, 'value'));
    const type = field(node, 'type');
    if (values[index]) return [{ kind: 'value', node: values[index], file }];
    return type ? [{ kind: 'type', node: type, file }] : [];
  }
  const left = named(field(node, 'left'));
  const right = named(field(node, 'right'));
  const index = left.findIndex((item) => item.type === 'identifier' && item.text === name);
  if (index < 0) return [];
  // `a, err := f()` binds the call's first result to `a`; other positions are not followed.
  const value = right.length === left.length ? right[index] : index === 0 ? right[0] : undefined;
  return value ? [{ kind: 'value', node: value, file }] : [];
}

interface Client {
  sdk: GoSdk;
  kind: SdkCallRecord['client']['kind'];
  at: Node;
  file: string;
}

// Whether a type names an SDK client: `*openai.Client`, `openai.Client`, `*client.API`.
function clientType(fileImports: Map<string, Import>, type: Node): GoSdk | undefined {
  let current = type;
  while (current.type === 'pointer_type') current = named(current)[0];
  if (current.type !== 'qualified_type') return undefined;
  const sdkImport = fileImports.get(field(current, 'package')!.text);
  const name = field(current, 'name')!.text;
  if (!sdkImport) return undefined;
  const qualified = sdkImport.subpackage ? `${sdkImport.subpackage}.${name}` : name;
  return sdkImport.sdk.types.has(qualified) ? sdkImport.sdk : undefined;
}

function resolveClient(context: Context, file: string, node: Node, depth = 0): Client | undefined {
  node = unwrap(node);
  if (depth > MAX_DEPTH) return undefined;
  const fileImports = imports(context.tree(file)!.rootNode);
  if (node.type === 'unary_expression')
    return resolveClient(context, file, field(node, 'operand')!, depth + 1);
  if (node.type === 'call_expression') {
    const callee = field(node, 'function')!;
    if (callee.type !== 'selector_expression') return undefined;
    const operand = field(callee, 'operand')!;
    const sdkImport = operand.type === 'identifier' ? fileImports.get(operand.text) : undefined;
    const name = field(callee, 'field')!.text;
    const qualified = sdkImport?.subpackage ? `${sdkImport.subpackage}.${name}` : name;
    return sdkImport?.sdk.constructors.has(qualified)
      ? { sdk: sdkImport.sdk, kind: 'constructor', at: node, file }
      : undefined;
  }
  if (node.type === 'identifier') {
    let client: Client | undefined;
    for (const binding of bindings(context, file, node, node.text)) {
      const found =
        binding.kind === 'value'
          ? resolveClient(context, binding.file, binding.node, depth + 1)
          : (() => {
              const type =
                field(binding.node, 'type') ?? (binding.kind === 'type' ? binding.node : undefined);
              const sdk = type && clientType(imports(context.tree(binding.file)!.rootNode), type);
              return sdk
                ? {
                    sdk,
                    kind:
                      binding.kind === 'parameter'
                        ? ('parameter' as const)
                        : ('constructor' as const),
                    at: binding.node,
                    file: binding.file,
                  }
                : undefined;
            })();
      if (!found) return undefined;
      client ??= found;
    }
    return client;
  }
  if (node.type === 'selector_expression') {
    // `s.client` where a struct in the package declares `client` with an SDK client type.
    const name = field(node, 'field')!.text;
    const directory = posix.dirname(file);
    let client: Client | undefined;
    for (const path of context.files.keys()) {
      if (posix.dirname(path) !== directory) continue;
      const root = context.tree(path)?.rootNode;
      for (const declaration of root?.descendantsOfType('field_declaration') ?? []) {
        if (
          !declaration ||
          !declaration.childrenForFieldName('name').some((item) => item?.text === name)
        )
          continue;
        const sdk = clientType(imports(root!), field(declaration, 'type')!);
        if (!sdk) return undefined;
        client ??= { sdk, kind: 'class-field', at: declaration, file: path };
      }
    }
    return client;
  }
  return undefined;
}

// The `Model` a params value sets, and the other field names it sets.
function paramsOf(
  context: Context,
  file: string,
  node: Node,
  depth = 0,
): { fields: string[]; model: { node: Node; file: string } | undefined } | undefined {
  node = unwrap(node);
  if (depth > MAX_DEPTH) return undefined;
  if (node.type === 'unary_expression')
    return paramsOf(context, file, field(node, 'operand')!, depth + 1);
  if (node.type === 'composite_literal') {
    const fields: string[] = [];
    let model: { node: Node; file: string } | undefined;
    for (const element of named(field(node, 'body'))) {
      if (element.type !== 'keyed_element') continue;
      const [key, value] = named(element);
      const name = key?.text;
      if (!name || !value) continue;
      fields.push(name);
      if (name === 'Model') model = { node: named(value)[0] ?? value, file };
    }
    return { fields, model };
  }
  if (node.type === 'identifier') {
    const found = bindings(context, file, node, node.text).filter((item) => item.kind === 'value');
    if (found.length !== 1) return undefined;
    const params = paramsOf(context, found[0].file, found[0].node, depth + 1);
    // `params.Model = …` after the literal also sets it.
    const scope = enclosingFunction(node);
    for (const assignment of field(scope ?? node, 'body')?.descendantsOfType(
      'assignment_statement',
    ) ?? []) {
      const [left] = named(field(assignment!, 'left'));
      if (
        left?.type === 'selector_expression' &&
        field(left, 'operand')?.text === node.text &&
        field(left, 'field')?.text === 'Model'
      )
        return (
          params && { ...params, model: { node: named(field(assignment!, 'right'))[0], file } }
        );
    }
    return params;
  }
  return undefined;
}

// Every literal a model value can be: string literals, SDK model constants (`openai.ChatModelGPT4o`),
// conversions (`openai.ChatModel("…")`, `openai.F(…)`), constants and variables in the function or
// package, and the values assigned to a variable (`if model == "" { model = "…" }`).
function traceModel(
  context: Context,
  file: string,
  node: Node,
  via: string,
  depth = 0,
  seen = new Set<string>(),
): TracedValue {
  node = unwrap(node);
  const stop = (reason: string): TracedValue => ({ literals: [], stop: reason });
  const key = `${file}:${node.id}`;
  if (depth > MAX_DEPTH)
    return stop(`Tracing this model stopped at the depth limit of ${MAX_DEPTH}.`);
  if (seen.has(key)) return { literals: [], stop: null };
  seen.add(key);
  const value = goString(node);
  if (value === '') return { literals: [], stop: null };
  if (value !== undefined) return { literals: [{ ...site(file, node), value, via }], stop: null };
  const fileImports = imports(context.tree(file)!.rootNode);
  if (node.type === 'selector_expression') {
    const operand = field(node, 'operand')!;
    const name = field(node, 'field')!.text;
    const sdkImport = operand.type === 'identifier' ? fileImports.get(operand.text) : undefined;
    if (sdkImport) {
      const constant = context.constants.get(`${sdkImport.sdk.provider}:${name}`);
      return constant
        ? {
            literals: [
              {
                ...site(file, node),
                value: constant,
                via: `SDK constant \`${operand.text}.${name}\``,
              },
            ],
            stop: null,
          }
        : stop(`\`${text(node)}\` is not a model constant Refit knows from the SDK.`);
    }
    return stop(`The model comes from \`${text(node)}\`, which Refit cannot trace.`);
  }
  if (node.type === 'call_expression') {
    const callee = field(node, 'function')!;
    const [first, second] = named(field(node, 'arguments'));
    const calleeText = callee.text;
    // Conversions and option wrappers that pass their argument through.
    if (
      callee.type === 'selector_expression' &&
      field(callee, 'operand')!.type === 'identifier' &&
      fileImports.has(field(callee, 'operand')!.text) &&
      /^(?:F|String|Opt|\w*Model)$/.test(field(callee, 'field')!.text) &&
      first
    )
      return traceModel(context, file, first, via, depth + 1, seen);
    if (/^os\.(?:Getenv|LookupEnv)$/.test(calleeText)) {
      const variable = first ? (goString(first) ?? text(first)) : '?';
      return stop(
        `The model is read from the environment variable ${variable} with no default in the same expression.`,
      );
    }
    if (calleeText === 'cmp.Or' && first)
      return merge(
        [first, second, ...named(field(node, 'arguments')).slice(2)]
          .filter((item): item is Node => Boolean(item))
          .map((item) => traceModel(context, file, item, via, depth + 1, seen)),
      );
    return stop(`The model comes from \`${text(node)}\`, which Refit cannot trace.`);
  }
  if (node.type === 'identifier') {
    const found = bindings(context, file, node, node.text);
    if (!found.length)
      return stop(`The model comes from \`${node.text}\`, which Refit cannot trace.`);
    return merge(
      found.map((binding): TracedValue =>
        binding.kind === 'value'
          ? traceModel(
              context,
              binding.file,
              binding.node,
              `constant \`${node.text}\``,
              depth + 1,
              seen,
            )
          : binding.kind === 'parameter'
            ? stop(
                `The model comes from the parameter \`${node.text}\`, whose callers Refit does not follow in Go.`,
              )
            : { literals: [], stop: null },
      ),
    );
  }
  return stop(`The model comes from \`${text(node)}\`, which Refit cannot trace.`);
}

function merge(values: TracedValue[]): TracedValue {
  return {
    literals: values.flatMap((value) => value.literals),
    stop: values.find((value) => value.stop)?.stop ?? null,
  };
}

// The names of a selector chain, outermost last, and the objects that could be the client.
function chain(node: Node) {
  const names: string[] = [];
  const objects: Node[] = [];
  let current = node;
  while (current.type === 'selector_expression') {
    names.unshift(field(current, 'field')!.text);
    current = field(current, 'operand')!;
    objects.unshift(current);
  }
  return { names, objects };
}

function traceCalls(context: Context): SdkCallRecord[] {
  const records: SdkCallRecord[] = [];
  for (const [path, file] of context.files) {
    if (!GO_SDKS.some((sdk) => file.content.includes(sdk.module))) {
      // Clients can also come from another file of the package; check the directory once.
      const directory = posix.dirname(path);
      if (
        ![...context.files].some(
          ([other, item]) =>
            posix.dirname(other) === directory &&
            GO_SDKS.some((sdk) => item.content.includes(sdk.module)),
        )
      )
        continue;
    }
    const root = context.tree(path)?.rootNode;
    if (!root) continue;
    const fileImports = imports(root);
    for (const call of root.descendantsOfType('call_expression')) {
      if (!call) continue;
      const callee = field(call, 'function')!;
      if (callee.type !== 'selector_expression') continue;
      const operand = field(callee, 'operand')!;
      const args = named(field(call, 'arguments'));
      // Package-level Stripe resource calls: `paymentintent.New(params)`.
      const packageImport =
        operand.type === 'identifier' ? fileImports.get(operand.text) : undefined;
      if (packageImport) {
        if (
          packageImport.sdk.provider === 'stripe' &&
          packageImport.subpackage &&
          !packageImport.subpackage.includes('/') &&
          !STRIPE_NOT_RESOURCES.has(packageImport.subpackage) &&
          /^[A-Z]/.test(field(callee, 'field')!.text)
        )
          records.push(
            record(
              path,
              call,
              callee,
              packageImport.sdk,
              { sdk: packageImport.sdk, kind: 'module', at: call, file: path },
              packageImport.subpackage,
              field(callee, 'field')!.text,
              [],
              undefined,
              context,
            ),
          );
        continue;
      }
      const { names, objects } = chain(callee);
      let client: Client | undefined;
      let index = 0;
      for (; index < objects.length && !client; index += 1)
        client = resolveClient(context, path, objects[index]);
      if (!client) continue;
      const parts = names.slice(index - 1);
      if (parts.length < 2) continue;
      const method = parts.at(-1)!;
      const resource = parts.slice(0, -1).join('.');
      if (client.sdk.provider === 'stripe') {
        records.push(
          record(path, call, callee, client.sdk, client, resource, method, [], undefined, context),
        );
        continue;
      }
      const params = args.map((arg) => paramsOf(context, path, arg)).find(Boolean);
      if (!params && args.length < 2) continue;
      records.push(
        record(
          path,
          call,
          callee,
          client.sdk,
          client,
          resource,
          method,
          params?.fields ?? [],
          params ? params.model : null,
          context,
        ),
      );
    }
  }
  return records;
}

function record(
  path: string,
  call: Node,
  callee: Node,
  sdk: GoSdk,
  client: Client,
  resource: string,
  method: string,
  options: string[],
  // undefined: the call has no model (Stripe); null: params Refit could not read.
  model: { node: Node; file: string } | null | undefined,
  context: Context,
): SdkCallRecord {
  return {
    language: 'go',
    provider: sdk.provider,
    package: sdk.module,
    ...site(path, call),
    resource,
    method,
    expression: text(callee),
    client: { kind: client.kind, ...site(client.file, client.at), custom: null },
    options,
    spread: model === null,
    arguments:
      model === undefined
        ? {}
        : {
            model: model
              ? traceModel(context, model.file, model.node, 'literal')
              : {
                  literals: [],
                  stop: 'The request params are not a struct literal Refit can read.',
                },
          },
  };
}

export function isGoTextCall(record: Pick<SdkCallRecord, 'provider' | 'resource' | 'method'>) {
  return Boolean(
    GO_SDKS.find((sdk) => sdk.provider === record.provider)?.text.has(
      `${record.resource}.${record.method}`,
    ),
  );
}

// SDK modules a repository requires, with the Stripe API version a stripe-go release pins.
export interface GoModule {
  file: string;
  line: number;
  module: string;
  version: string;
  provider: string;
  // From go.sum when it lists the same version.
  locked: boolean;
  apiVersion: string | null;
}

export async function goModules(directory: string, files?: { path: string; content: string }[]) {
  const sdkData = await goSdkData();
  const found: GoModule[] = [];
  const manifests = files ?? (await readGoManifests(directory));
  for (const manifest of manifests.filter((item) => posix.basename(item.path) === 'go.mod')) {
    const sum =
      manifests.find((item) => item.path === posix.join(posix.dirname(manifest.path), 'go.sum'))
        ?.content ?? '';
    for (const [index, line] of manifest.content.split('\n').entries()) {
      const match =
        /^\s*(?:require\s+)?(github\.com\/[\w.-]+\/[\w.-]+(?:\/v\d+)?)\s+(v[\w.+-]+)/.exec(line);
      const sdkImport = match && importOf(match[1]);
      if (!match || !sdkImport || sdkImport.subpackage) continue;
      found.push({
        file: manifest.path,
        line: index + 1,
        module: match[1],
        version: match[2],
        provider: sdkImport.sdk.provider,
        locked: sum.includes(`${match[1]} ${match[2]} `),
        apiVersion:
          sdkImport.sdk.provider === 'stripe'
            ? (sdkData.stripe[match[1]]?.[match[2]] ?? null)
            : null,
      });
    }
  }
  return found;
}

async function readGoManifests(directory: string) {
  const manifests: { path: string; content: string }[] = [];
  const { readdir } = await import('node:fs/promises');
  const visit = async (path: string, relative: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (
        entry.isDirectory() &&
        !['.git', 'node_modules', 'vendor', 'testdata'].includes(entry.name)
      )
        await visit(join(path, entry.name), posix.join(relative, entry.name));
      else if (entry.isFile() && (entry.name === 'go.mod' || entry.name === 'go.sum'))
        manifests.push({
          path: posix.join(relative, entry.name),
          content: await readFile(join(path, entry.name), 'utf8'),
        });
    }
  };
  await visit(directory, '');
  return manifests.map((item) => ({ ...item, path: item.path.replace(/^\//, '') }));
}

export interface GoTrace {
  calls: SdkCallRecord[];
  modules: GoModule[];
  files: number;
}

// Every stripe-go, openai-go and anthropic-sdk-go call in a repository's Go code, the models the
// OpenAI and Anthropic calls can send, and the SDK versions go.mod requires. Nothing is executed.
export async function traceGoCalls(directory: string): Promise<GoTrace> {
  const files = await readGoFiles(directory);
  return {
    calls: await traceGoFiles(files),
    modules: await goModules(directory),
    files: files.length,
  };
}

export async function traceGoFiles(files: GoFile[]) {
  if (!files.some((file) => GO_SDKS.some((sdk) => file.content.includes(sdk.module)))) return [];
  const sdkData = await goSdkData();
  const constants = new Map<string, string>();
  for (const [provider, table] of [
    ['openai', sdkData.openai],
    ['anthropic', sdkData.anthropic],
  ] as const)
    for (const release of Object.values(table))
      for (const [name, value] of Object.entries(release.constants))
        constants.set(`${provider}:${name}`, value);
  return withGoTrees(files, (tree) =>
    traceCalls({ files: new Map(files.map((file) => [file.path, file])), tree, constants }),
  );
}
