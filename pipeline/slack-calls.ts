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
  importedNames,
  isConst,
  isUrlRoot,
  lineOf,
  partsOf,
  propertyName,
  requiredModule,
  resolveImport,
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

// A report-only use of a Slack surface other than Web API methods: an incoming webhook (a
// `@slack/webhook` IncomingWebhook or a request to hooks.slack.com) or the Legacy RTM API (an
// `RTMClient`, or the `rtm.connect` and `rtm.start` methods that open its WebSocket).
export interface SlackFinding {
  kind: 'incoming-webhook' | 'rtm';
  file: string;
  line: number;
  use: 'live' | 'test';
  // `IncomingWebhook`, `RTMClient`, `rtm.connect`, or the call a webhook URL is passed to.
  via: string;
  notes: string[];
  text: string;
}

export interface SlackCallScan {
  calls: SlackCall[];
  webhooks: SlackFinding[];
  rtm: SlackFinding[];
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

type Holder = 'web-api' | 'bolt-app' | 'bolt-client';
// Exported functions that return a client, by file and export name, so `getSlackClient()`
// imported from another file is followed.
type FunctionHolders = Map<string, Map<string, Holder>>;
const MAX_DEPTH = 6;

// Resolves which expressions hold a WebClient or Bolt App in one file, without a type checker:
// `new WebClient()` (also behind `??`, `||` or a conditional), names and class properties typed
// `WebClient` or `App` or assigned one, constructor parameter properties, Bolt's `app.client` and
// handler `({ client })`, and calls of functions that return a client, local or imported.
function resolver(source: ts.SourceFile, imported: Map<string, Holder>) {
  const { namespaces, named } = bindings(source);
  const bolt = [...namespaces.values(), ...[...named.values()].map((item) => item.module)].includes(
    BOLT,
  );
  const holderName = (module: string | undefined, name: string | undefined): Holder | undefined => {
    if (!module) return undefined;
    if (name === 'WebClient' && WEB_CLIENT_MODULES.includes(module)) return 'web-api';
    if (name === 'App' && module === BOLT) return 'bolt-app';
    return undefined;
  };
  // `WebClient` or `slack.WebClient` from a module that exports it; `App` from Bolt.
  const classOf = (expression: ts.Node): Holder | undefined => {
    if (ts.isIdentifier(expression)) {
      const item = named.get(expression.text);
      return holderName(item?.module, item?.name);
    }
    if (
      (ts.isPropertyAccessExpression(expression) || ts.isQualifiedName(expression)) &&
      ts.isIdentifier(ts.isQualifiedName(expression) ? expression.left : expression.expression)
    ) {
      const left = ts.isQualifiedName(expression) ? expression.left : expression.expression;
      const name = ts.isQualifiedName(expression) ? expression.right.text : expression.name.text;
      return holderName(namespaces.get((left as ts.Identifier).text), name);
    }
    return undefined;
  };
  // `WebClient`, `WebClient | null`, `App`.
  const typeHolder = (type: ts.TypeNode | undefined): Holder | undefined => {
    if (!type) return undefined;
    if (ts.isTypeReferenceNode(type)) return classOf(type.typeName);
    if (ts.isUnionTypeNode(type)) {
      for (const member of type.types) {
        const holder = typeHolder(member);
        if (holder) return holder;
      }
    }
    if (ts.isParenthesizedTypeNode(type)) return typeHolder(type.type);
    return undefined;
  };
  // The functions a name can call in this file: declarations and `const f = () => …`.
  const functionOf = (name: string, from: ts.Node): ts.SignatureDeclaration | undefined => {
    const declaration = findDeclaration(name, from);
    const initializer = declaration?.initializer && unwrap(declaration.initializer);
    if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)))
      return initializer;
    if (declaration) return undefined;
    return source.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === name,
    );
  };
  const returned = (fn: ts.SignatureDeclaration, depth: number): Holder | undefined => {
    const declared = typeHolder(fn.type);
    if (declared) return declared;
    const body = (fn as ts.FunctionLikeDeclaration).body;
    if (!body) return undefined;
    if (!ts.isBlock(body)) return holderOf(body, depth + 1);
    let found: Holder | undefined;
    const visit = (node: ts.Node) => {
      if (found || (node !== body && ts.isFunctionLike(node))) return;
      if (ts.isReturnStatement(node) && node.expression)
        found = holderOf(node.expression, depth + 1);
      ts.forEachChild(node, visit);
    };
    visit(body);
    return found;
  };
  // Holders assigned to a variable or a `this` property after its declaration.
  const assigned = (matches: (left: ts.Expression) => boolean, scope: ts.Node, depth: number) => {
    let found: Holder | undefined;
    const visit = (node: ts.Node) => {
      if (found) return;
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        matches(unwrap(node.left))
      )
        found = holderOf(node.right, depth + 1);
      ts.forEachChild(node, visit);
    };
    visit(scope);
    return found;
  };
  const propertyHolder = (
    owner: ts.ClassLikeDeclaration,
    name: string,
    depth: number,
  ): Holder | undefined => {
    for (const member of owner.members) {
      if (ts.isPropertyDeclaration(member) && member.name.getText() === name) {
        const holder = typeHolder(member.type) ?? holderOf(member.initializer, depth + 1);
        if (holder) return holder;
      }
      // `constructor(private readonly client: WebClient)`.
      if (ts.isConstructorDeclaration(member))
        for (const parameter of member.parameters)
          if (
            ts.getModifiers(parameter)?.length &&
            ts.isIdentifier(parameter.name) &&
            parameter.name.text === name
          ) {
            const holder = typeHolder(parameter.type);
            if (holder) return holder;
          }
    }
    return assigned(
      (left) =>
        ts.isPropertyAccessExpression(left) &&
        left.expression.kind === ts.SyntaxKind.ThisKeyword &&
        left.name.getText() === name,
      owner,
      depth,
    );
  };
  const parameterHolder = (binding: ts.Node, name: string): Holder | undefined => {
    if (ts.isParameter(binding)) return typeHolder(binding.type);
    // Bolt's `({ client })` or `({ client: web })` in a file that uses Bolt.
    if (!bolt || !ts.isBindingElement(binding)) return undefined;
    const pattern = binding.parent;
    return ts.isObjectBindingPattern(pattern) &&
      ts.isParameter(pattern.parent) &&
      (propertyName(binding.propertyName) ?? name) === 'client'
      ? 'bolt-client'
      : undefined;
  };
  const holderOf = (expression: ts.Expression | undefined, depth = 0): Holder | undefined => {
    if (!expression || depth > MAX_DEPTH) return undefined;
    const node = unwrap(expression);
    if (ts.isAwaitExpression(node)) return holderOf(node.expression, depth + 1);
    if (ts.isNewExpression(node)) return classOf(unwrap(node.expression));
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      return operator === ts.SyntaxKind.QuestionQuestionToken ||
        operator === ts.SyntaxKind.BarBarToken
        ? (holderOf(node.right, depth + 1) ?? holderOf(node.left, depth + 1))
        : undefined;
    }
    if (ts.isConditionalExpression(node))
      return holderOf(node.whenTrue, depth + 1) ?? holderOf(node.whenFalse, depth + 1);
    if (ts.isIdentifier(node)) {
      const declaration = findDeclaration(node.text, node);
      if (declaration) {
        const scope = ts.findAncestor(
          declaration,
          (item) => ts.isBlock(item) || ts.isSourceFile(item),
        );
        return (
          typeHolder(declaration.type) ??
          holderOf(declaration.initializer, depth + 1) ??
          (scope &&
            assigned(
              (left) =>
                ts.isIdentifier(left) &&
                left.text === node.text &&
                findDeclaration(left.text, left) === declaration,
              scope,
              depth,
            ))
        );
      }
      const binding = parameterBinding(node.text, node);
      return binding && parameterHolder(binding, node.text);
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ThisKeyword) {
        const owner = ts.findAncestor(node, ts.isClassLike);
        return owner && propertyHolder(owner, node.name.getText(), depth);
      }
      // `app.client`.
      if (node.name.text === 'client' && holderOf(node.expression, depth + 1) === 'bolt-app')
        return 'bolt-client';
      return undefined;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const fn = functionOf(node.expression.text, node);
      if (fn) return returned(fn, depth);
      return imported.get(node.expression.text);
    }
    return undefined;
  };
  return { holderOf, functionOf, returned, bolt, named };
}

// Exported functions of a file that return a client: `export function getSlackClient(): WebClient`.
function exportedFunctionHolders(source: ts.SourceFile): Map<string, Holder> {
  const { functionOf, returned } = resolver(source, new Map());
  const found = new Map<string, Holder>();
  for (const statement of source.statements) {
    const exportedStatement = ts
      .getModifiers(statement as ts.HasModifiers)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!exportedStatement) continue;
    const names = ts.isFunctionDeclaration(statement)
      ? [statement.name?.text]
      : ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.map((item) =>
            ts.isIdentifier(item.name) ? item.name.text : undefined,
          )
        : [];
    for (const name of names) {
      const fn = name && functionOf(name, statement);
      const holder = fn && returned(fn, 0);
      if (name && holder) found.set(name, holder);
    }
  }
  return found;
}

// The parameter or destructured parameter a name refers to, which findDeclaration does not follow.
function parameterBinding(name: string, from: ts.Node): ts.Node | undefined {
  for (let scope: ts.Node | undefined = from; scope; scope = scope.parent) {
    if (!ts.isFunctionLike(scope)) continue;
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
function sdkCalls(
  file: FileContext,
  data: SlackMethods,
  imported: Map<string, Holder>,
): SlackCall[] {
  const { holderOf } = resolver(file.source, imported);
  const calls: SlackCall[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      // Walk `a.b.c` down to the receiver that holds a client, collecting the property path.
      const path: string[] = [];
      let receiver: ts.Expression = node.expression;
      let holder: Holder | undefined;
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
  visit(file.source);
  return calls;
}

function sdkRecord(
  file: FileContext,
  call: ts.CallExpression,
  path: string[],
  holder: Holder,
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
  let runtime: ts.Expression | undefined;
  for (const part of rest) {
    if (/[?#]/.test(text)) break;
    if ('expression' in part) {
      runtime = part.expression;
      break;
    }
    text += part.text;
  }
  const match = /^\/([A-Za-z][\w.]*)?/.exec(text);
  // `/${method}` or `/apps.manifest.${operation}`: a runtime value names all or part of the method.
  if (runtime && match && match[0] === text)
    return {
      method: null,
      why: `the method is chosen at runtime from \`${expressionName(runtime)}\``,
    };
  return match?.[1] ? { method: match[1] } : { method: null };
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
  // `new URL('https://slack.com/api/…')` is followed like the string it wraps.
  const parent = node.parent;
  const wrapped =
    ts.isNewExpression(parent) &&
    parent.expression.getText() === 'URL' &&
    parent.arguments?.[0] === node
      ? parent
      : node;
  const found = consumers(wrapped);
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

const WEBHOOK_URL = /^(?:https?:)?\/\/hooks\.slack\.com\/(services|workflows)\//;
// The Legacy RTM API, as Slack's SDK guides name it (docs/english/rtm-api.md in node-slack-sdk).
const RTM_NOTE =
  "Slack's SDK guides call this the Legacy RTM API: it is not available to granular-permission apps, and new classic apps can no longer be created";

// `new IncomingWebhook(url)` and `new RTMClient(token)` from Slack's packages, and requests to
// incoming-webhook URLs.
function surfaceFindings(file: FileContext): SlackFinding[] {
  const { namespaces, named } = bindings(file.source);
  const classOf = (expression: ts.Expression) => {
    const node = unwrap(expression);
    if (ts.isIdentifier(node)) return named.get(node.text)?.name;
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text)
    )
      return node.name.text;
    return undefined;
  };
  const found: SlackFinding[] = [];
  const add = (kind: SlackFinding['kind'], node: ts.Node, via: string, notes: string[]) =>
    found.push({
      kind,
      file: file.path,
      line: lineOf(file.source, node),
      use: file.use,
      via,
      notes,
      text: excerpt(file.source, node),
    });
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node)) {
      const name = classOf(node.expression);
      if (name === 'IncomingWebhook') add('incoming-webhook', node, name, []);
      if (name === 'RTMClient') add('rtm', node, name, [RTM_NOTE]);
    }
    if (ts.isExpression(node) && isUrlRoot(node)) {
      const [first] = expanded(node);
      const match = first && 'text' in first ? WEBHOOK_URL.exec(first.text) : null;
      if (match) {
        // A URL is reported where it is sent, or where it is written when no call is traced. One
        // passed to a constructor, such as `new IncomingWebhook(url)`, is reported there.
        const consumer = consumers(node)[0];
        if (consumer || !constructedWith(node))
          add(
            'incoming-webhook',
            consumer?.call ?? node,
            consumer ? calleeText(consumer.call) : 'url',
            [
              ...(match[1] === 'workflows'
                ? [
                    'a Workflow Builder webhook (hooks.slack.com/workflows), which starts a workflow',
                  ]
                : []),
              ...(/\/services\/T\w+\/B\w+\/\w+/.test(first && 'text' in first ? first.text : '')
                ? ['the complete webhook URL, which is a credential, is written in source']
                : []),
            ],
          );
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file.source);
  return found;
}

// Whether a URL is passed to a constructor, directly or through the variable that holds it.
function constructedWith(node: ts.Expression) {
  const argument = (child: ts.Node) => {
    const parent = child.parent;
    return ts.isNewExpression(parent) && (parent.arguments ?? []).some((item) => item === child);
  };
  if (argument(node)) return true;
  const declaration = node.parent;
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return false;
  const name = declaration.name.text;
  const scope = ts.findAncestor(declaration, (item) => ts.isBlock(item) || ts.isSourceFile(item));
  let found = false;
  const visit = (child: ts.Node) => {
    if (found) return;
    if (
      ts.isIdentifier(child) &&
      child.text === name &&
      argument(child) &&
      findDeclaration(name, child) === declaration
    )
      found = true;
    ts.forEachChild(child, visit);
  };
  if (scope) visit(scope);
  return found;
}

function scanFiles(files: Repository['files'], data: SlackMethods) {
  const calls: SlackCall[] = [];
  const findings: SlackFinding[] = [];
  const sources = new Map<string, ts.SourceFile>();
  const sourceFor = (file: Repository['files'][number]) => {
    let source = sources.get(file.path);
    if (!source) sources.set(file.path, (source = sourceOf(file.path, file.content)));
    return source;
  };
  // Functions exported by Slack files that return a client, followed into the files importing them.
  const exportedHolders: FunctionHolders = new Map();
  for (const file of files)
    if (mentionsSdk(file.content)) {
      const holders = exportedFunctionHolders(sourceFor(file));
      if (holders.size) exportedHolders.set(file.path, holders);
    }
  const names = [...exportedHolders.values()].flatMap((holders) => [...holders.keys()]);
  const paths = new Set(files.map((file) => file.path));
  for (const file of files) {
    const api = mentionsApiHost(file.content);
    const surface =
      file.content.includes('hooks.slack.com') || /IncomingWebhook|RTMClient/.test(file.content);
    const imported = new Map<string, Holder>();
    if (names.some((name) => file.content.includes(name)))
      for (const [local, binding] of importedNames(sourceFor(file))) {
        const target = resolveImport(file.path, binding.specifier, paths);
        const holder = target && exportedHolders.get(target)?.get(binding.name);
        if (holder) imported.set(local, holder);
      }
    const sdk = mentionsSdk(file.content) || imported.size > 0;
    if (!api && !sdk && !surface) continue;
    const context: FileContext = {
      path: file.path,
      source: sourceFor(file),
      use: TEST_PATH.test(file.path) ? 'test' : 'live',
    };
    if (api) calls.push(...urlCalls(context, data));
    if (sdk) calls.push(...sdkCalls(context, data, imported));
    if (surface) findings.push(...surfaceFindings(context));
  }
  const order = <T extends { file: string; line: number }>(items: T[]) =>
    items.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  // The methods that open an RTM connection are RTM findings too.
  for (const call of calls)
    for (const method of call.methods)
      if (method === 'rtm.connect' || method === 'rtm.start')
        findings.push({
          kind: 'rtm',
          file: call.file,
          line: call.line,
          use: call.use,
          via: method,
          notes: [RTM_NOTE],
          text: call.text,
        });
  return {
    calls: order(calls),
    webhooks: order(findings.filter((item) => item.kind === 'incoming-webhook')),
    rtm: order(findings.filter((item) => item.kind === 'rtm')),
  };
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
    ...scanFiles(repository!.files, data),
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
  return scanFiles(read, data).calls.flatMap((call) =>
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
