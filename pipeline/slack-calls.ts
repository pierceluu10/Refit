import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript-compiler';
import { TEST_PATH } from './deadline-exposure.ts';
import {
  calleeText,
  constantString,
  consumers,
  excerpt,
  expressionName,
  findDeclaration,
  isConst,
  isUrlRoot,
  lineOf,
  partsOf,
  propertyName,
  requiredModule,
  sourceOf,
  unwrap,
  type Part,
} from './meta-graph-calls.ts';
import { readRepository } from './repository.ts';
import { isObject, parseObject } from './specifications.ts';
import type { Repository } from './types.ts';

// Slack Web API methods a repository calls, read from source without running it: `@slack/web-api`
// WebClient calls, Bolt's `app.client` and handler `client` calls, and raw HTTP requests to
// `https://slack.com/api/<method>`. Each method is matched to the methods recorded from
// @slack/web-api releases and to the deprecations Slack's SDKs publish. Review only: nothing is
// changed, installed, run or sent to Slack.

export const SLACK_METHODS = new URL('../data/slack-methods.json', import.meta.url);
export const SLACK_PACKAGES = [
  '@slack/web-api',
  '@slack/bolt',
  '@slack/rtm-api',
  '@slack/webhook',
  '@slack/client',
];
// Modules that export WebClient: the current package, Bolt's re-export and the retired
// all-in-one @slack/client.
const WEB_CLIENT_MODULES = ['@slack/web-api', '@slack/bolt', '@slack/client'];
const BOLT = '@slack/bolt';
// `https://slack.com/api/` and a workspace's own host (`acme.slack.com/api/`); never the webhook
// host.
const API_URL = /^(?:https?:)?\/\/((?!hooks\.)(?:[\w-]+\.)?slack\.com)\/api(?=[/?#]|$)/;
// WebClient members that send a method named by their first argument.
const NAMED_CALLS = new Set(['apiCall', 'paginate']);

export interface SlackCall {
  kind: 'web-api' | 'bolt' | 'url';
  // Where the method is called: the SDK call, the HTTP call, or the URL when no call was traced.
  file: string;
  line: number;
  // `test` for test, spec, story, fixture and example files.
  use: 'live' | 'test';
  // The Web API methods the call sends: `chat.postMessage`; `filesUploadV2` sends two. Empty when
  // the method is unknown.
  methods: string[];
  // The call as written: `client.chat.postMessage`, `app.client.files.upload`, `fetch`.
  client: string | null;
  // Slack's deprecation of a method, from the SDK sources in data/slack-methods.json.
  deprecation: { method: string; reason: string; announcement: string | null } | null;
  // Facts for review: a method missing from the newest release, one no release defines.
  notes: string[];
  // What could not be read, and why.
  unknown: string[];
  text: string;
}

export interface SlackPackage {
  name: string;
  file: string;
  declared: string;
  locked: string | null;
}

export interface SlackCallScan {
  calls: SlackCall[];
  packages: SlackPackage[];
  // When data/slack-methods.json was generated.
  methodsCheckedAt: string;
  warnings: string[];
}

interface Property {
  methods: string[];
  releases: string[];
  deprecated: string | null;
}

export interface SlackMethods {
  checkedAt: string;
  releases: string[];
  // `chat.postMessage` (the WebClient property path) -> what it sends.
  properties: Map<string, Property>;
  // Every method some recorded release sends.
  methods: Set<string>;
  // Method prefixes Slack's Python SDK warns about, with the changelog post it links.
  deprecations: { prefixes: string[]; announcement: string }[];
  // Methods @slack/web-api 8 removed, with Slack's replacement and note.
  removed: Map<string, { replacement: string | null; notes: string }>;
}

let methods: Promise<SlackMethods> | undefined;
export function loadSlackMethods(path: string | URL = SLACK_METHODS): Promise<SlackMethods> {
  const load = async () => {
    const value = parseObject(await readFile(path, 'utf8'), 'Slack methods');
    const { webApi, pythonSdk, nodeSdk } = value;
    if (
      value.formatVersion !== 1 ||
      !isObject(webApi) ||
      !Array.isArray(webApi.releases) ||
      !isObject(webApi.properties) ||
      !isObject(pythonSdk) ||
      !Array.isArray(pythonSdk.deprecations) ||
      !isObject(nodeSdk) ||
      !Array.isArray(nodeSdk.removed)
    )
      throw new Error(
        'Slack methods require formatVersion 1, Web API properties, Python SDK deprecations and Node SDK removals.',
      );
    const properties = new Map(Object.entries(webApi.properties as Record<string, Property>));
    return {
      checkedAt: String(value.checkedAt),
      releases: webApi.releases.map(String),
      properties,
      methods: new Set([...properties.values()].flatMap((item) => item.methods)),
      deprecations: pythonSdk.deprecations as SlackMethods['deprecations'],
      removed: new Map(
        (nodeSdk.removed as { method: string; replacement: string | null; notes: string }[]).map(
          (item) => [item.method, { replacement: item.replacement, notes: item.notes }],
        ),
      ),
    };
  };
  if (path !== SLACK_METHODS) return load();
  methods ??= load();
  return methods;
}

// What the recorded sources say about one method: a deprecation, and facts for review.
function review(data: SlackMethods, method: string, property?: Property) {
  const notes: string[] = [];
  const newest = data.releases.at(-1)!;
  const listed = data.deprecations.find((item) =>
    item.prefixes.some((prefix) =>
      prefix.endsWith('.') ? method.startsWith(prefix) : method === prefix,
    ),
  );
  const removed = data.removed.get(method);
  const reason =
    property?.deprecated ??
    [...data.properties.values()].find((item) => item.methods.includes(method) && item.deprecated)
      ?.deprecated ??
    (listed
      ? "Slack's SDKs warn that this method is deprecated"
      : removed
        ? `removed: ${removed.notes}`
        : null);
  // JSDoc notices link their changelog post as `{@link <url> <text>}`.
  const link = reason ? /\{@link (https:\/\/\S+) ([^}]*)\}/.exec(reason) : null;
  const deprecation = reason
    ? {
        method,
        reason: reason.replace(/\{@link \S+ ([^}]*)\}/g, '$1'),
        announcement: listed?.announcement ?? link?.[1] ?? null,
      }
    : null;
  if (removed)
    notes.push(
      `\`${method}\` is removed from @slack/web-api 8${removed.replacement ? `; Slack names \`${removed.replacement}\` as its replacement` : ''}`,
    );
  else if (property && !property.releases.includes(newest))
    notes.push(
      `\`${method}\` is not in @slack/web-api ${newest}; the last recorded release with it is ${property.releases.at(-1)}`,
    );
  else if (!data.methods.has(method))
    notes.push(
      `\`${method}\` is not a method of any recorded @slack/web-api release (${data.releases[0]} to ${newest})`,
    );
  return { deprecation, notes };
}

interface FileContext {
  path: string;
  source: ts.SourceFile;
  use: SlackCall['use'];
}

// Names a file binds from Slack modules: namespaces (`import * as slack`, `require(M)`, a default
// import) and named bindings by local name, with the module each came from.
function bindings(source: ts.SourceFile) {
  const namespaces = new Map<string, string>();
  const named = new Map<string, { module: string; name: string }>();
  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      SLACK_PACKAGES.includes(node.moduleSpecifier.text) &&
      node.importClause
    ) {
      const module = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause.name) namespaces.set(clause.name.text, module);
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))
        namespaces.set(clause.namedBindings.name.text, module);
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings))
        for (const element of clause.namedBindings.elements)
          named.set(element.name.text, {
            module,
            name: (element.propertyName ?? element.name).text,
          });
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = unwrap(node.initializer);
      const module =
        requiredModule(initializer) ??
        (ts.isPropertyAccessExpression(initializer) && initializer.name.text === 'default'
          ? requiredModule(initializer.expression)
          : undefined);
      if (module && SLACK_PACKAGES.includes(module)) {
        if (ts.isIdentifier(node.name)) namespaces.set(node.name.text, module);
        if (ts.isObjectBindingPattern(node.name))
          for (const element of node.name.elements) {
            const name = propertyName(element.propertyName) ?? propertyName(element.name);
            if (name && ts.isIdentifier(element.name))
              named.set(element.name.text, { module, name });
          }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { namespaces, named };
}

type Holder = 'web-api' | 'bolt-app';

// WebClient and Bolt App objects a file creates, and where they are held: variables (by
// declaration) and class properties (by class and name).
function holders(source: ts.SourceFile) {
  const { namespaces, named } = bindings(source);
  // `WebClient` or `slack.WebClient` from a module that exports it; `App` from Bolt.
  const classOf = (expression: ts.Expression): Holder | undefined => {
    const node = unwrap(expression);
    let module: string | undefined;
    let name: string | undefined;
    if (ts.isIdentifier(node)) ({ module, name } = named.get(node.text) ?? {});
    else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      module = namespaces.get(node.expression.text);
      name = node.name.text;
    }
    if (!module) return undefined;
    if (name === 'WebClient' && WEB_CLIENT_MODULES.includes(module)) return 'web-api';
    if (name === 'App' && module === BOLT) return 'bolt-app';
    return undefined;
  };
  const constructed = (expression: ts.Expression | undefined) => {
    const node = expression && unwrap(expression);
    return node && ts.isNewExpression(node) ? classOf(node.expression) : undefined;
  };
  const variables = new Map<ts.VariableDeclaration, Holder>();
  const properties = new Map<ts.ClassLikeDeclaration, Map<string, Holder>>();
  const setProperty = (node: ts.Node, name: string, holder: Holder) => {
    const owner = ts.findAncestor(node, ts.isClassLike);
    if (!owner) return;
    const map = properties.get(owner) ?? new Map<string, Holder>();
    properties.set(owner, map);
    map.set(name, holder);
  };
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node)) {
      const holder = constructed(node.initializer);
      if (holder) variables.set(node, holder);
    }
    if (ts.isPropertyDeclaration(node)) {
      const holder = constructed(node.initializer);
      const name = propertyName(node.name);
      if (holder && name) setProperty(node, name, holder);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const holder = constructed(node.right);
      const left = unwrap(node.left);
      if (holder && ts.isIdentifier(left)) {
        const declaration = findDeclaration(left.text, node);
        if (declaration) variables.set(declaration, holder);
      }
      if (
        holder &&
        ts.isPropertyAccessExpression(left) &&
        left.expression.kind === ts.SyntaxKind.ThisKeyword
      )
        setProperty(node, left.name.text, holder);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  // A WebClient type name in this file: `client: WebClient` marks a parameter as a client.
  const typeNames = new Set(
    [...named]
      .filter(([, item]) => item.name === 'WebClient' && WEB_CLIENT_MODULES.includes(item.module))
      .map(([local]) => local),
  );
  const bolt = [...namespaces.values(), ...[...named.values()].map((item) => item.module)].includes(
    BOLT,
  );
  return { classOf, constructed, variables, properties, typeNames, bolt };
}

// A parameter that holds a client: Bolt's `({ client })` in a file that uses Bolt, or one typed
// `WebClient`.
function clientParameter(
  declaration: ts.Node,
  name: string,
  typeNames: Set<string>,
  bolt: boolean,
): Holder | 'bolt-client' | undefined {
  if (ts.isParameter(declaration)) {
    const type = declaration.type;
    if (
      ts.isIdentifier(declaration.name) &&
      declaration.name.text === name &&
      type &&
      ts.isTypeReferenceNode(type) &&
      typeNames.has(type.typeName.getText())
    )
      return 'web-api';
    return undefined;
  }
  if (!bolt || !ts.isBindingElement(declaration) || !ts.isIdentifier(declaration.name))
    return undefined;
  const pattern = declaration.parent;
  const parameter = pattern.parent;
  return ts.isObjectBindingPattern(pattern) &&
    ts.isParameter(parameter) &&
    declaration.name.text === name &&
    (propertyName(declaration.propertyName) ?? declaration.name.text) === 'client'
    ? 'bolt-client'
    : undefined;
}

// The binding a name refers to when it is a parameter or a destructured parameter, which
// findDeclaration does not follow.
function parameterBinding(name: string, from: ts.Node): ts.Node | undefined {
  for (let scope: ts.Node | undefined = from; scope; scope = scope.parent) {
    if (!ts.isFunctionLike(scope)) {
      if (findDeclaration(name, scope) && scope !== from) return undefined;
      continue;
    }
    for (const parameter of scope.parameters) {
      if (ts.isIdentifier(parameter.name) && parameter.name.text === name) return parameter;
      if (ts.isObjectBindingPattern(parameter.name))
        for (const element of parameter.name.elements)
          if (ts.isIdentifier(element.name) && element.name.text === name) return element;
    }
  }
  return undefined;
}

// `client.chat.postMessage(…)`, `app.client.chat.postMessage(…)`, Bolt handlers'
// `({ client }) => client.views.open(…)`, and `client.apiCall('chat.postMessage', …)`.
function sdkCalls(file: FileContext, data: SlackMethods): SlackCall[] {
  const { source } = file;
  const found = holders(source);
  if (!found.variables.size && !found.properties.size && !found.typeNames.size && !found.bolt)
    return [];
  const holderOf = (expression: ts.Expression): Holder | 'bolt-client' | undefined => {
    const node = unwrap(expression);
    if (ts.isNewExpression(node)) return found.classOf(node.expression);
    if (ts.isIdentifier(node)) {
      const declaration = findDeclaration(node.text, node);
      if (declaration) return found.variables.get(declaration);
      const parameter = parameterBinding(node.text, node);
      return parameter && clientParameter(parameter, node.text, found.typeNames, found.bolt);
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ThisKeyword) {
        const owner = ts.findAncestor(node, ts.isClassLike);
        return owner ? found.properties.get(owner)?.get(node.name.text) : undefined;
      }
      // `app.client`, and `context.client` or `args.client` in a Bolt file.
      if (node.name.text === 'client') {
        const owner = holderOf(node.expression);
        if (owner === 'bolt-app') return 'bolt-client';
      }
    }
    return undefined;
  };
  const calls: SlackCall[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      // Walk `a.b.c` down to the receiver that holds a client, collecting the property path.
      const path: string[] = [];
      let receiver: ts.Expression = node.expression;
      let holder: ReturnType<typeof holderOf>;
      while (ts.isPropertyAccessExpression(receiver)) {
        path.unshift(receiver.name.text);
        receiver = receiver.expression;
        holder = holderOf(receiver);
        if (holder && holder !== 'bolt-app') break;
        holder = undefined;
      }
      if (holder) {
        const record = sdkRecord(file, node, path, holder, data);
        if (record) calls.push(record);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

function sdkRecord(
  file: FileContext,
  call: ts.CallExpression,
  path: string[],
  holder: Holder | 'bolt-client',
  data: SlackMethods,
): SlackCall | undefined {
  const unknown: string[] = [];
  let names: string[] = [];
  let property: Property | undefined;
  const joined = path.join('.');
  if (path.length === 1 && NAMED_CALLS.has(path[0])) {
    const argument = call.arguments[0];
    const value = argument && constantString(argument)?.value;
    if (value) names = [value];
    else
      unknown.push(
        `the method is chosen at runtime from \`${argument ? expressionName(argument) : 'nothing'}\``,
      );
  } else if (joined === 'filesUploadV2') {
    property = data.properties.get('files.uploadV2');
    names = property?.methods ?? [];
  } else if (path.length === 1) return undefined;
  else {
    property = data.properties.get(joined);
    names = property?.methods ?? [joined];
  }
  const notes: string[] = [];
  let deprecation: SlackCall['deprecation'] = null;
  for (const method of names) {
    const reviewed = review(data, method, property);
    deprecation ??= reviewed.deprecation;
    notes.push(...reviewed.notes);
  }
  return {
    kind: holder === 'web-api' ? 'web-api' : 'bolt',
    file: file.path,
    line: lineOf(file.source, call),
    use: file.use,
    methods: names,
    client: calleeText(call),
    deprecation,
    notes,
    unknown,
    text: excerpt(file.source, call),
  };
}

// A URL's parts with a leading `const` base expanded: `${SLACK_API}/chat.postMessage` reads as
// `https://slack.com/api/chat.postMessage`.
function expanded(expression: ts.Expression, depth = 0): Part[] {
  const [first, ...rest] = partsOf(expression);
  if (!first || 'text' in first || depth > 3) return first ? [first, ...rest] : [];
  const node = unwrap(first.expression);
  const declaration = ts.isIdentifier(node) ? findDeclaration(node.text, node) : undefined;
  return declaration?.initializer && isConst(declaration)
    ? [...expanded(declaration.initializer, depth + 1), ...rest]
    : [first, ...rest];
}

// The method a Slack API URL names: the segment after `/api/`. `method` is null for a base URL
// (`https://slack.com/api`) and, with `why`, for a method chosen at runtime.
function urlMethod(expression: ts.Expression): { method: string | null; why?: string } | undefined {
  const [first, ...rest] = expanded(expression);
  if (!first || !('text' in first) || !API_URL.test(first.text)) return undefined;
  let text = first.text.replace(API_URL, '');
  for (const part of rest) {
    if (/[?#]/.test(text)) break;
    if ('expression' in part) {
      if (text.replace(/^\//, '') === '')
        return {
          method: null,
          why: `the method is chosen at runtime from \`${expressionName(part.expression)}\``,
        };
      break;
    }
    text += part.text;
  }
  const method = /^\/([A-Za-z][\w.]*)/.exec(text)?.[1];
  return method ? { method } : { method: null };
}

function urlCalls(file: FileContext, data: SlackMethods): SlackCall[] {
  const calls: SlackCall[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isExpression(node) && isUrlRoot(node)) {
      const url = urlMethod(node);
      if (url) {
        const record = urlRecords(file, node, url, data);
        calls.push(...record);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file.source);
  return calls;
}

function urlRecords(
  file: FileContext,
  node: ts.Expression,
  url: { method: string | null; why?: string },
  data: SlackMethods,
): SlackCall[] {
  const found = consumers(node);
  // A base URL is reported only where it is passed to a call; the URLs built from it are reported
  // on their own.
  if (url.method === null && !url.why && !found.length) return [];
  return (found.length ? found : [undefined]).map((consumer) => {
    const unknown: string[] = [];
    if (url.why) unknown.push(url.why);
    else if (url.method === null && consumer)
      unknown.push(
        `the base URL is passed to \`${calleeText(consumer.call)}\`; the methods called through it are not traced`,
      );
    if (!consumer) unknown.push('no request call was traced for this URL');
    const reviewed = url.method
      ? review(data, url.method)
      : { deprecation: null, notes: [] as string[] };
    return {
      kind: 'url' as const,
      file: file.path,
      line: lineOf(file.source, consumer?.call ?? node),
      use: file.use,
      methods: url.method ? [url.method] : [],
      client: consumer ? calleeText(consumer.call) : null,
      ...reviewed,
      unknown,
      text: excerpt(file.source, consumer?.call ?? node),
    };
  });
}

function mentionsApiHost(content: string) {
  return /slack\.com\/api/.test(content);
}

function mentionsSdk(content: string) {
  return WEB_CLIENT_MODULES.some((module) => content.includes(module));
}

function callsIn(files: Repository['files'], data: SlackMethods) {
  const calls: SlackCall[] = [];
  for (const file of files) {
    const api = mentionsApiHost(file.content);
    const sdk = mentionsSdk(file.content);
    if (!api && !sdk) continue;
    const context: FileContext = {
      path: file.path,
      source: sourceOf(file.path, file.content),
      use: TEST_PATH.test(file.path) ? 'test' : 'live',
    };
    if (api) calls.push(...urlCalls(context, data));
    if (sdk) calls.push(...sdkCalls(context, data));
  }
  return calls.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// Lists every Slack Web API method a repository calls, with what Slack's SDKs say about it.
export async function scanSlackCalls(
  directory: string,
  options: { data?: SlackMethods } = {},
): Promise<SlackCallScan> {
  const data = options.data ?? (await loadSlackMethods());
  const root = resolve(directory);
  let repository: Repository | undefined;
  const packages: SlackPackage[] = [];
  for (const name of SLACK_PACKAGES) {
    repository = await readRepository(root, name);
    packages.push(...declarations(repository, name));
  }
  return {
    calls: callsIn(repository!.files, data),
    packages,
    methodsCheckedAt: data.checkedAt,
    warnings: repository!.warnings,
  };
}

// Each method a repository's source sends, with where, for matching against retired methods in
// the deadline registry. `files` lets a caller that already read the repository skip a second read.
export async function slackMethodUses(
  directory: string,
  files?: Repository['files'],
): Promise<{ method: string; file: string; line: number; use: 'live' | 'test'; text: string }[]> {
  const data = await loadSlackMethods();
  const read = files ?? (await readRepository(resolve(directory), SLACK_PACKAGES[0])).files;
  return callsIn(read, data).flatMap((call) =>
    call.methods.map((method) => ({
      method,
      file: call.file,
      line: call.line,
      use: call.use,
      text: call.text,
    })),
  );
}

function declarations(repository: Repository, name: string): SlackPackage[] {
  return repository.dependencies.map((dependency) => ({
    name,
    file: dependency.file,
    declared: dependency.version,
    locked: dependency.lock.version,
  }));
}
