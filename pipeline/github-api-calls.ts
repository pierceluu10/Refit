import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Kind, parse, type DocumentNode, type SelectionSetNode } from 'graphql';
import ts from 'typescript-compiler';
import { TEST_PATH } from './deadline-exposure.ts';
import {
  calleeText,
  consumers,
  constantString,
  excerpt,
  expressionName,
  extendedElsewhere,
  findDeclaration,
  httpMethod,
  importedNames,
  isConst,
  isUrlRoot,
  lineOf,
  objectProperty,
  partsOf,
  propertyName,
  requiredModule,
  sourceOf,
  unwrap,
  type Part,
} from './meta-graph-calls.ts';
import { readRepository } from './repository.ts';
import { createSourceImportResolver } from './source-imports.ts';
import { isObject, parseObject } from './specifications.ts';
import type { Repository } from './types.ts';

// GitHub API use a repository makes, read from source without running it: Octokit REST calls
// (`octokit.rest.<scope>.<method>`, `octokit.request('GET /…')`, `octokit.paginate`), raw HTTP
// requests to https://api.github.com, pinned `X-GitHub-Api-Version` headers, and GraphQL queries
// sent through Octokit. Each request is matched to the operations GitHub's OpenAPI description
// deprecates, to Octokit's own deprecations, and to the REST version breaking changes; each
// GraphQL field to GitHub's upcoming GraphQL breaking changes. Review only.

export const GITHUB_API = new URL('../data/github-api.json', import.meta.url);
// Packages whose default or named export is an Octokit client class.
const OCTOKIT_MODULES = new Set([
  'octokit',
  '@octokit/rest',
  '@octokit/core',
  '@octokit/action',
  '@octokit/app',
]);
const ACTIONS = '@actions/github';
const PROBOT = 'probot';
const GRAPHQL_MODULE = '@octokit/graphql';
export const GITHUB_PACKAGES = [
  'octokit',
  '@octokit/rest',
  '@octokit/core',
  '@octokit/action',
  '@octokit/app',
  '@octokit/request',
  '@octokit/graphql',
  '@actions/github',
  'probot',
];
const HOST = /^(?:https?:)?\/\/api\.github\.com(?=[/?#]|$)/;
const VERSION_HEADER = /^x-github-api-version$/i;
const AXIOS_METHODS = new Set(['get', 'delete', 'head', 'options', 'post', 'put', 'patch']);
const PATH_NAME = /path|endpoint|url|route|uri/i;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface GitHubNotice {
  source: 'openapi' | 'octokit' | 'graphql';
  text: string;
  // The removal or effective date, when the source gives one.
  date: string | null;
}

export interface GitHubCall {
  kind: 'octokit' | 'request' | 'url' | 'graphql';
  file: string;
  line: number;
  use: 'live' | 'test';
  // `issues.create` for Octokit REST methods; null otherwise.
  method: string | null;
  // `GET /repos/{owner}/{repo}/issues`; null when unknown or for GraphQL.
  route: string | null;
  client: string | null;
  // GraphQL only: `Issue.timeline`-style coordinates of the fields the query selects that
  // GitHub's upcoming changes list.
  fields: string[];
  notices: GitHubNotice[];
  // Breaking changes a newer REST API version makes to this endpoint. They apply only when the
  // request moves to that version, so they are not deprecations of the endpoint.
  versionChanges: { version: string; title: string }[];
  notes: string[];
  unknown: string[];
  text: string;
}

export interface GitHubVersionPin {
  file: string;
  line: number;
  use: 'live' | 'test';
  version: string;
  // The end of support date GitHub publishes, null when none is scheduled.
  endOfSupport: string | null;
  notes: string[];
  text: string;
}

export interface GitHubScan {
  calls: GitHubCall[];
  pins: GitHubVersionPin[];
  packages: { name: string; file: string; declared: string; locked: string | null }[];
  sources: { checkedAt: string; openapi: string; docs: string; defaultVersion: string };
  warnings: string[];
}

interface Change {
  title: string;
  endpoints: string[];
}

export interface GitHubApiData {
  checkedAt: string;
  octokitReleases: string[];
  methods: Map<
    string,
    { route: string; releases: string; deprecated?: string; renamed?: string }[]
  >;
  versions: Map<string, string | null>;
  supported: string[];
  defaultVersion: string;
  // Route key -> breaking changes of each version that list it.
  breaking: Map<string, { version: string; title: string }[]>;
  // Route key -> the OpenAPI deprecation.
  deprecated: Map<
    string,
    { operationId: string | null; deprecationDate: string | null; removalDate: string | null }
  >;
  graphql: {
    query: string;
    mutation: string;
    types: Record<string, Record<string, string>>;
    // `Issue.timeline` -> the change.
    changes: Map<string, { description: string; date: string }>;
  };
  sources: GitHubScan['sources'];
}

// `GET /repos/{owner}/{repo}` and `GET /repos/{o}/{r}/` compare equal, as do Octokit's
// `compare/{base}...{head}` and GitHub's `compare/{basehead}`; `{?name}` query templates are dropped.
export function githubRouteKey(route: string) {
  const [method, path = ''] = route.split(' ');
  const clean = path
    .replace(/\{\?[^}]*\}/g, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .split('/')
    .map((segment) => (segment.includes('{') || segment.includes(':') ? '{}' : segment))
    .join('/');
  return `${method.toUpperCase()} ${clean}`;
}

let loaded: Promise<GitHubApiData> | undefined;
export function loadGitHubApiData(path: string | URL = GITHUB_API): Promise<GitHubApiData> {
  const load = async () => {
    const value = parseObject(await readFile(path, 'utf8'), 'GitHub API data');
    const { octokit, rest, openapi, graphql, graphqlTypes } = value;
    if (
      value.formatVersion !== 1 ||
      !isObject(octokit) ||
      !isObject(octokit.methods) ||
      !isObject(rest) ||
      !isObject(openapi) ||
      !Array.isArray(openapi.deprecated) ||
      !isObject(graphql) ||
      !isObject(graphqlTypes)
    )
      throw new Error(
        'GitHub API data requires formatVersion 1, Octokit methods, REST versions, OpenAPI deprecations and GraphQL changes.',
      );
    const breaking = new Map<string, { version: string; title: string }[]>();
    for (const [version, changes] of Object.entries(
      rest.breakingChanges as Record<string, Change[]>,
    ))
      for (const change of changes)
        for (const endpoint of change.endpoints) {
          const key = githubRouteKey(endpoint);
          breaking.set(key, [...(breaking.get(key) ?? []), { version, title: change.title }]);
        }
    const deprecated: GitHubApiData['deprecated'] = new Map();
    for (const item of openapi.deprecated as {
      method: string;
      path: string;
      operationId: string | null;
      deprecationDate: string | null;
      removalDate: string | null;
    }[])
      deprecated.set(githubRouteKey(`${item.method} ${item.path}`), item);
    return {
      checkedAt: String(value.checkedAt),
      octokitReleases: (octokit.releases as unknown[]).map(String),
      methods: new Map(Object.entries(octokit.methods as Record<string, never>)),
      versions: new Map(
        (rest.versions as { version: string; endOfSupport: string | null }[]).map((item) => [
          item.version,
          item.endOfSupport,
        ]),
      ),
      supported: (rest.supported as unknown[]).map(String),
      defaultVersion: String(rest.defaultVersion),
      breaking,
      deprecated,
      graphql: {
        query: String(graphql.query),
        mutation: String(graphql.mutation),
        types: graphqlTypes as Record<string, Record<string, string>>,
        changes: new Map(
          (graphql.changes as { location: string; description: string; date: string }[]).map(
            (change) => [change.location, { description: change.description, date: change.date }],
          ),
        ),
      },
      sources: {
        checkedAt: String(value.checkedAt),
        openapi: `${String(openapi.repository)} at ${String(openapi.commit).slice(0, 7)}`,
        docs: `${String(rest.repository)} at ${String(rest.commit).slice(0, 7)}`,
        defaultVersion: String(rest.defaultVersion),
      },
    };
  };
  if (path !== GITHUB_API) return load();
  loaded ??= load();
  return loaded;
}

// What GitHub's OpenAPI description says about one REST route.
function routeNotices(data: GitHubApiData, route: string | null): GitHubNotice[] {
  if (!route) return [];
  const key = githubRouteKey(route);
  const notices: GitHubNotice[] = [];
  const deprecated = data.deprecated.get(key);
  if (deprecated)
    notices.push({
      source: 'openapi',
      text: `GitHub's OpenAPI description marks this operation deprecated${deprecated.deprecationDate ? ` since ${deprecated.deprecationDate}` : ''}${deprecated.removalDate ? `, to be removed on ${deprecated.removalDate}` : ''}`,
      date: deprecated.removalDate,
    });
  return notices;
}

function versionChanges(data: GitHubApiData, route: string | null) {
  return route ? (data.breaking.get(githubRouteKey(route)) ?? []) : [];
}

interface FileContext {
  path: string;
  source: ts.SourceFile;
  use: GitHubCall['use'];
}

// Names a file binds from the Octokit packages, @actions/github and Probot.
function bindings(source: ts.SourceFile) {
  const classes = new Set<string>();
  const getters = new Set<string>();
  const namespaces = new Map<string, string>();
  const graphqls = new Set<string>();
  let probot = false;
  const bind = (module: string, local: string, name: string) => {
    if (OCTOKIT_MODULES.has(module) && (name === 'Octokit' || name === 'default' || name === 'App'))
      classes.add(local);
    if (module === ACTIONS && name === 'getOctokit') getters.add(local);
    if (module === GRAPHQL_MODULE && name === 'graphql') graphqls.add(local);
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const module = node.moduleSpecifier.text;
      if (module === PROBOT) probot = true;
      const clause = node.importClause;
      if (clause?.name) {
        bind(module, clause.name.text, 'default');
        if (module === ACTIONS) namespaces.set(clause.name.text, module);
      }
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings))
        namespaces.set(clause.namedBindings.name.text, module);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
        for (const element of clause.namedBindings.elements)
          bind(module, element.name.text, (element.propertyName ?? element.name).text);
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const module = requiredModule(unwrap(node.initializer));
      if (module) {
        if (module === PROBOT) probot = true;
        if (ts.isIdentifier(node.name)) {
          namespaces.set(node.name.text, module);
          if (module === GRAPHQL_MODULE) graphqls.add(node.name.text);
        }
        if (ts.isObjectBindingPattern(node.name))
          for (const element of node.name.elements) {
            const name = propertyName(element.propertyName) ?? propertyName(element.name);
            if (name && ts.isIdentifier(element.name)) bind(module, element.name.text, name);
          }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { classes, getters, namespaces, graphqls, probot };
}

interface ResolverContext {
  names: Set<string>;
  functions: Set<string>;
  methods: Set<string>;
}
const EMPTY_CONTEXT: ResolverContext = {
  names: new Set(),
  functions: new Set(),
  methods: new Set(),
};

// Which expressions hold an Octokit client in one file.
function resolver(source: ts.SourceFile, context: ResolverContext = EMPTY_CONTEXT) {
  const { classes, getters, namespaces, probot } = bindings(source);
  // `Octokit`, `rest.Octokit`, a name imported for an exported alias, or `Octokit.plugin(…)`.
  const isClass = (expression: ts.Node, depth = 0): boolean => {
    const node = ts.isExpression(expression) ? unwrap(expression) : expression;
    if (ts.isIdentifier(node)) {
      if (classes.has(node.text) || context.names.has(node.text)) return true;
      const declaration = depth < 3 ? findDeclaration(node.text, node) : undefined;
      return !!declaration?.initializer && isClass(declaration.initializer, depth + 1);
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const module = namespaces.get(node.expression.text);
      return !!module && OCTOKIT_MODULES.has(module) && node.name.text === 'Octokit';
    }
    if (ts.isQualifiedName(node) && ts.isIdentifier(node.left)) {
      const module = namespaces.get(node.left.text);
      return !!module && OCTOKIT_MODULES.has(module) && node.right.text === 'Octokit';
    }
    // `Octokit.plugin(paginateRest)` returns a client class.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['plugin', 'defaults'].includes(node.expression.name.text)
    )
      return isClass(node.expression.expression, depth + 1);
    return false;
  };
  // `getOctokit(token)` or `github.getOctokit(token)` from @actions/github.
  const isGetter = (expression: ts.Expression) => {
    const node = unwrap(expression);
    if (ts.isIdentifier(node)) return getters.has(node.text);
    return (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.get(node.expression.text) === ACTIONS &&
      node.name.text === 'getOctokit'
    );
  };
  const typed = (type: ts.TypeNode | undefined, depth = 0): boolean => {
    if (!type || depth > 4) return false;
    if (ts.isUnionTypeNode(type)) return type.types.some((item) => typed(item, depth + 1));
    // `InstanceType<typeof Octokit>`, `ReturnType<typeof github.getOctokit>`.
    if (/\btypeof\s+[\w.]*(?:Octokit|getOctokit)\b/.test(type.getText())) return true;
    if (!ts.isTypeReferenceNode(type)) return false;
    if (isClass(type.typeName)) return true;
    const name = type.typeName.getText();
    const alias = source.statements.find(
      (statement): statement is ts.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(statement) && statement.name.text === name,
    );
    return !!alias && typed(alias.type, depth + 1);
  };
  const functionOf = (name: string, from: ts.Node) => {
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
  const returns = (fn: ts.SignatureDeclaration, depth: number): boolean => {
    if (typed(fn.type)) return true;
    const body = (fn as ts.FunctionLikeDeclaration).body;
    if (!body) return false;
    if (!ts.isBlock(body)) return holds(body, depth + 1);
    let found = false;
    const visit = (node: ts.Node) => {
      if (found || (node !== body && ts.isFunctionLike(node))) return;
      if (ts.isReturnStatement(node) && node.expression) found = holds(node.expression, depth + 1);
      ts.forEachChild(node, visit);
    };
    visit(body);
    return found;
  };
  const assigned = (matches: (left: ts.Expression) => boolean, scope: ts.Node, depth: number) => {
    let found = false;
    const visit = (node: ts.Node) => {
      if (found) return;
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        matches(unwrap(node.left))
      )
        found = holds(node.right, depth + 1);
      ts.forEachChild(node, visit);
    };
    visit(scope);
    return found;
  };
  const property = (owner: ts.ClassLikeDeclaration, name: string, depth: number): boolean => {
    for (const member of owner.members) {
      if (
        ts.isPropertyDeclaration(member) &&
        member.name.getText() === name &&
        (typed(member.type) || holds(member.initializer, depth + 1))
      )
        return true;
      if (ts.isConstructorDeclaration(member))
        for (const parameter of member.parameters)
          if (
            ts.getModifiers(parameter)?.length &&
            ts.isIdentifier(parameter.name) &&
            parameter.name.text === name &&
            typed(parameter.type)
          )
            return true;
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
  const holds = (expression: ts.Expression | undefined, depth = 0): boolean => {
    if (!expression || depth > 6) return false;
    const node = unwrap(expression);
    if (ts.isAwaitExpression(node)) return holds(node.expression, depth + 1);
    if (ts.isNewExpression(node)) return isClass(node.expression);
    if (ts.isBinaryExpression(node))
      return (
        (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          node.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
        (holds(node.right, depth + 1) || holds(node.left, depth + 1))
      );
    if (ts.isConditionalExpression(node))
      return holds(node.whenTrue, depth + 1) || holds(node.whenFalse, depth + 1);
    if (ts.isCallExpression(node)) {
      if (isGetter(node.expression)) return true;
      if (ts.isIdentifier(node.expression)) {
        const fn = functionOf(node.expression.text, node);
        return fn ? returns(fn, depth) : context.functions.has(node.expression.text);
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        const owner = ts.findAncestor(node, ts.isClassLike);
        const name = node.expression.name.getText();
        const method = owner?.members.find(
          (member): member is ts.MethodDeclaration =>
            ts.isMethodDeclaration(member) && member.name.getText() === name,
        );
        if (method) return returns(method, depth);
        return !!owner?.heritageClauses?.length && context.methods.has(name);
      }
      return false;
    }
    if (ts.isIdentifier(node)) {
      const declaration = findDeclaration(node.text, node);
      if (declaration) {
        const scope = ts.findAncestor(
          declaration,
          (item) => ts.isBlock(item) || ts.isSourceFile(item),
        );
        return (
          typed(declaration.type) ||
          holds(declaration.initializer, depth + 1) ||
          (!!scope &&
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
      for (let scope: ts.Node | undefined = node; scope; scope = scope.parent)
        if (ts.isFunctionLike(scope))
          for (const parameter of scope.parameters) {
            if (ts.isIdentifier(parameter.name) && parameter.name.text === node.text)
              return typed(parameter.type);
            // Probot and github-script handlers: `({ octokit })` or `({ github })`.
            if (ts.isObjectBindingPattern(parameter.name))
              for (const element of parameter.name.elements)
                if (ts.isIdentifier(element.name) && element.name.text === node.text)
                  return (
                    probot &&
                    (propertyName(element.propertyName) ?? element.name.text) === 'octokit'
                  );
          }
      return false;
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ThisKeyword) {
        const owner = ts.findAncestor(node, ts.isClassLike);
        return !!owner && property(owner, node.name.getText(), depth);
      }
      // Probot's `context.octokit` and `app.octokit` in a file that imports Probot or @octokit/app.
      if (node.name.text === 'octokit' && (probot || classes.size > 0)) return true;
    }
    return false;
  };
  return { holds, returns, typed, functionOf, isClass };
}

// The path a URL's parts spell after the host, with runtime pieces named in braces.
function urlPath(parts: Part[], unknown: string[]): string | null {
  const segments: Part[][] = [[]];
  for (const part of parts) {
    if ('expression' in part) {
      segments.at(-1)!.push(part);
      continue;
    }
    const cut = part.text.search(/[?#]/);
    const pieces = (cut < 0 ? part.text : part.text.slice(0, cut)).split('/');
    pieces.forEach((piece, index) => {
      if (index > 0) segments.push([]);
      if (piece.trim()) segments.at(-1)!.push({ text: piece.trim(), node: part.node });
    });
    if (cut >= 0) break;
  }
  let path = '';
  for (const [index, segment] of segments.entries()) {
    if (!segment.length) continue;
    const [only] = segment;
    if (segment.length === 1 && 'expression' in only) {
      const name = expressionName(only.expression);
      if (index === 0 || PATH_NAME.test(name) || path === '') {
        unknown.push(`path is built at runtime from \`${name}\``);
        return null;
      }
    }
    path += `/${segment.map((part) => ('text' in part ? part.text : `{${expressionName(part.expression).replace(/^.*\./, '')}}`)).join('')}`;
  }
  return path || null;
}

function apiUrl(expression: ts.Expression, depth = 0): Part[] | undefined {
  const [first, ...rest] = partsOf(expression);
  if (!first || depth > 3) return undefined;
  if ('text' in first)
    return HOST.test(first.text)
      ? [{ text: first.text.replace(HOST, ''), node: first.node }, ...rest]
      : undefined;
  const node = unwrap(first.expression);
  const declaration = ts.isIdentifier(node) ? findDeclaration(node.text, node) : undefined;
  if (!declaration?.initializer || !isConst(declaration)) return undefined;
  const inner = apiUrl(declaration.initializer, depth + 1);
  return inner && [...inner, ...rest];
}

function requestMethod(call: ts.CallExpression, argument: number, unknown: string[]) {
  const client = calleeText(call);
  const name = ts.isPropertyAccessExpression(call.expression)
    ? call.expression.name.text
    : ts.isIdentifier(call.expression)
      ? call.expression.text
      : '';
  const receiver = ts.isPropertyAccessExpression(call.expression)
    ? call.expression.expression.getText()
    : '';
  const optionMethod = (expression: ts.Expression | undefined): Method | null | undefined => {
    const node = expression && unwrap(expression);
    if (!node) return undefined;
    if (!ts.isObjectLiteralExpression(node)) {
      unknown.push(`request options come from \`${expressionName(node)}\` at runtime`);
      return null;
    }
    const method = objectProperty(node, 'method');
    if (!method) return undefined;
    const value = constantString(method)?.value;
    if (value === undefined) unknown.push('HTTP method is chosen at runtime');
    return httpMethod(value);
  };
  if (name === 'fetch' || name === '$fetch' || name === 'ofetch') {
    if (argument !== 0) return { client, method: null, helper: true };
    const method = optionMethod(call.arguments[1]);
    return { client, method: method === undefined ? ('GET' as const) : method, helper: false };
  }
  if (AXIOS_METHODS.has(name) && /axios|http|client|api|instance/i.test(receiver) && argument === 0)
    return { client, method: httpMethod(name), helper: false };
  if (name === 'axios' || (name === 'request' && /axios/i.test(receiver))) {
    const method = optionMethod(argument === -1 ? call.arguments[0] : call.arguments[1]);
    return { client, method: method === undefined ? ('GET' as const) : method, helper: false };
  }
  return { client, method: null, helper: true };
}

// The GraphQL fields a query selects, as `Type.field` coordinates, walked with GitHub's schema.
function graphqlFields(document: DocumentNode, data: GitHubApiData, unknown: string[]) {
  const { types } = data.graphql;
  const fragments = new Map(
    document.definitions.flatMap((definition) =>
      definition.kind === Kind.FRAGMENT_DEFINITION ? [[definition.name.value, definition]] : [],
    ),
  );
  const found = new Set<string>();
  const walk = (set: SelectionSetNode | undefined, type: string, seen: Set<string>) => {
    if (!set) return;
    for (const selection of set.selections) {
      if (selection.kind === Kind.FIELD) {
        const name = selection.name.value;
        if (name.startsWith('__')) continue;
        found.add(`${type}.${name}`);
        for (const argument of selection.arguments ?? [])
          found.add(`${type}.${name}.${argument.name.value}`);
        const next = types[type]?.[name];
        if (next) walk(selection.selectionSet, next, seen);
      } else if (selection.kind === Kind.INLINE_FRAGMENT)
        walk(selection.selectionSet, selection.typeCondition?.name.value ?? type, seen);
      else if (selection.kind === Kind.FRAGMENT_SPREAD) {
        const fragment = fragments.get(selection.name.value);
        if (!fragment || seen.has(fragment.name.value)) continue;
        walk(
          fragment.selectionSet,
          fragment.typeCondition.name.value,
          new Set([...seen, fragment.name.value]),
        );
      }
    }
  };
  for (const definition of document.definitions)
    if (definition.kind === Kind.OPERATION_DEFINITION)
      walk(
        definition.selectionSet,
        definition.operation === 'mutation' ? data.graphql.mutation : data.graphql.query,
        new Set(),
      );
  if (!document.definitions.some((definition) => definition.kind === Kind.OPERATION_DEFINITION))
    unknown.push('the document holds only fragments');
  return [...found];
}

// A GraphQL document written in a string, template without substitutions, or a `const` holding
// one. Fragments interpolated into a template are not followed.
function graphqlText(expression: ts.Expression | undefined, depth = 0): string | undefined {
  const node = expression && unwrap(expression);
  if (!node || depth > 3) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTaggedTemplateExpression(node)) return graphqlText(node.template, depth + 1);
  if (ts.isTemplateExpression(node))
    return node.head.text + node.templateSpans.map((span) => ` ${span.literal.text}`).join('');
  if (ts.isIdentifier(node)) {
    const declaration = findDeclaration(node.text, node);
    return declaration?.initializer && isConst(declaration)
      ? graphqlText(declaration.initializer, depth + 1)
      : undefined;
  }
  return undefined;
}

function graphqlRecord(
  file: FileContext,
  call: ts.CallExpression,
  query: ts.Expression | undefined,
  data: GitHubApiData,
): GitHubCall {
  const unknown: string[] = [];
  const notices: GitHubNotice[] = [];
  let fields: string[] = [];
  const text = graphqlText(query);
  if (text === undefined)
    unknown.push(
      `the query comes from \`${query ? expressionName(query) : 'nothing'}\` at runtime`,
    );
  else
    try {
      for (const coordinate of graphqlFields(parse(text), data, unknown)) {
        const change = data.graphql.changes.get(coordinate);
        if (!change) continue;
        fields.push(coordinate);
        notices.push({
          source: 'graphql',
          text: `${coordinate}: ${change.description}`,
          date: change.date,
        });
      }
    } catch {
      unknown.push('the query does not parse as GraphQL');
    }
  fields = [...new Set(fields)];
  return {
    kind: 'graphql',
    file: file.path,
    line: lineOf(file.source, call),
    use: file.use,
    method: null,
    route: null,
    client: calleeText(call),
    fields,
    notices,
    versionChanges: [],
    notes: [],
    unknown,
    text: excerpt(file.source, call),
  };
}

// `octokit.rest.issues.create(…)`, `octokit.issues.create(…)`, `octokit.request('GET /…')`,
// `octokit.paginate(…)` and `octokit.graphql(…)`.
function octokitCalls(
  file: FileContext,
  data: GitHubApiData,
  context: ResolverContext,
): GitHubCall[] {
  const { holds } = resolver(file.source, context);
  const { graphqls } = bindings(file.source);
  const calls: GitHubCall[] = [];
  const newest = data.octokitReleases.at(-1)!;
  // A method reference such as `octokit.rest.issues.listForRepo` passed to paginate.
  const methodOf = (expression: ts.Expression): string | undefined => {
    const path: string[] = [];
    let node: ts.Expression = unwrap(expression);
    while (ts.isPropertyAccessExpression(node)) {
      path.unshift(node.name.text);
      node = node.expression;
      if (holds(node)) break;
    }
    if (!holds(node)) return undefined;
    if (path[0] === 'rest') path.shift();
    return path.length === 2 ? path.join('.') : undefined;
  };
  const restRecord = (call: ts.CallExpression, method: string): GitHubCall => {
    const entries = data.methods.get(method);
    const current = entries?.find((entry) => entry.releases.split(/\.\.| /).includes(newest));
    const chosen = current ?? entries?.at(-1);
    const notes: string[] = [];
    const notices = routeNotices(data, chosen?.route ?? null);
    if (!chosen)
      notes.push(
        `\`${method}\` is not a method of any recorded @octokit/plugin-rest-endpoint-methods release (${data.octokitReleases[0]} to ${newest})`,
      );
    else {
      if (!current)
        notes.push(
          `\`${method}\` is not in @octokit/plugin-rest-endpoint-methods ${newest}; the last recorded release with it is ${chosen.releases.split(/\.\.| /).at(-1)}`,
        );
      if (chosen.deprecated)
        notices.unshift({ source: 'octokit', text: chosen.deprecated, date: null });
      if (chosen.renamed) notes.push(`Octokit renamed \`${method}\` to \`${chosen.renamed}\``);
    }
    return {
      kind: 'octokit',
      file: file.path,
      line: lineOf(file.source, call),
      use: file.use,
      method,
      route: chosen?.route ?? null,
      client: calleeText(call),
      fields: [],
      notices,
      versionChanges: versionChanges(data, chosen?.route ?? null),
      notes,
      unknown: [],
      text: excerpt(file.source, call),
    };
  };
  const routeRecord = (
    call: ts.CallExpression,
    argument: ts.Expression | undefined,
  ): GitHubCall => {
    const unknown: string[] = [];
    const value = argument && constantString(argument)?.value;
    let route: string | null = null;
    if (value && /^(GET|POST|PUT|PATCH|DELETE|HEAD) \//i.test(value)) route = value;
    else if (value && value.startsWith('/')) route = `GET ${value}`;
    else if (argument && ts.isTemplateExpression(unwrap(argument))) {
      const template = unwrap(argument) as ts.TemplateExpression;
      const head = /^(GET|POST|PUT|PATCH|DELETE) (\/.*)$/.exec(template.head.text);
      const path =
        head &&
        urlPath([{ text: head[2], node: template.head }, ...partsOf(template).slice(1)], unknown);
      if (head && path) route = `${head[1]} ${path}`;
    } else
      unknown.push(
        `the route comes from \`${argument ? expressionName(argument) : 'nothing'}\` at runtime`,
      );
    return {
      kind: 'request',
      file: file.path,
      line: lineOf(file.source, call),
      use: file.use,
      method: null,
      route,
      client: calleeText(call),
      fields: [],
      notices: routeNotices(data, route),
      versionChanges: versionChanges(data, route),
      notes: [],
      unknown,
      text: excerpt(file.source, call),
    };
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      // A standalone `graphql(query)` from @octokit/graphql, or `graphql.defaults(…)(query)`.
      if (ts.isIdentifier(callee) && graphqls.has(callee.text))
        calls.push(graphqlRecord(file, node, node.arguments[0], data));
      if (ts.isPropertyAccessExpression(callee)) {
        const path: string[] = [];
        let receiver: ts.Expression = callee;
        let found = false;
        while (ts.isPropertyAccessExpression(receiver)) {
          path.unshift(receiver.name.text);
          receiver = receiver.expression;
          if (holds(receiver)) {
            found = true;
            break;
          }
        }
        if (found) {
          if (path[0] === 'rest') path.shift();
          const joined = path.join('.');
          if (joined === 'graphql' || joined === 'graphql.paginate')
            calls.push(graphqlRecord(file, node, node.arguments[0], data));
          else if (joined === 'request') calls.push(routeRecord(node, node.arguments[0]));
          else if (joined === 'paginate' || joined === 'paginate.iterator') {
            const first = node.arguments[0];
            const method = first && methodOf(first);
            calls.push(method ? restRecord(node, method) : routeRecord(node, first));
          } else if (path.length === 2) calls.push(restRecord(node, joined));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file.source);
  return calls;
}

function urlCalls(file: FileContext, data: GitHubApiData): GitHubCall[] {
  const calls: GitHubCall[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isExpression(node) && isUrlRoot(node)) {
      const parts = apiUrl(node);
      if (parts) {
        calls.push(...urlRecords(file, node, parts, data));
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
  parts: Part[],
  data: GitHubApiData,
): GitHubCall[] {
  const pathUnknown: string[] = [];
  const path = urlPath(parts, pathUnknown);
  const base = path === null && !pathUnknown.length;
  const parent = node.parent;
  const wrapped =
    ts.isNewExpression(parent) &&
    parent.expression.getText() === 'URL' &&
    parent.arguments?.[0] === node
      ? parent
      : node;
  const found = consumers(wrapped);
  if (base && !found.length) return [];
  const declaration = ts.isVariableDeclaration(node.parent) ? node.parent : undefined;
  if (declaration && !found.length && extendedElsewhere(declaration)) return [];
  return (found.length ? found : [undefined]).map((consumer) => {
    const unknown = [...pathUnknown];
    let client: string | null = null;
    let method: Method | null = null;
    if (consumer && base)
      unknown.push(
        `the base URL is passed to \`${calleeText(consumer.call)}\`; requests built from it are not traced`,
      );
    else if (consumer) {
      const read = requestMethod(consumer.call, consumer.argument, unknown);
      client = read.client;
      method = read.method;
      if (read.helper) unknown.push(`HTTP method of helper \`${client}\` is not known`);
    } else unknown.push('no request call was traced for this URL');
    const route = !base && method && path ? `${method} ${path}` : null;
    const anchor = consumer?.call ?? node;
    return {
      kind: 'url' as const,
      file: file.path,
      line: lineOf(file.source, anchor),
      use: file.use,
      method: null,
      route,
      client,
      fields: [],
      notices: routeNotices(data, route),
      versionChanges: versionChanges(data, route),
      notes: [],
      unknown: [...new Set(unknown)],
      text: excerpt(file.source, anchor),
    };
  });
}

// `'X-GitHub-Api-Version': '2022-11-28'` in any object literal, such as request headers.
function versionPins(file: FileContext, data: GitHubApiData): GitHubVersionPin[] {
  const pins: GitHubVersionPin[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && VERSION_HEADER.test(propertyName(node.name) ?? '')) {
      const value = constantString(node.initializer)?.value;
      const notes: string[] = [];
      if (value && !data.versions.has(value))
        notes.push(
          `${value} is not a REST API version GitHub lists (${[...data.versions.keys()].join(', ')})`,
        );
      if (value)
        pins.push({
          file: file.path,
          line: lineOf(file.source, node),
          use: file.use,
          version: value,
          endOfSupport: data.versions.get(value) ?? null,
          notes,
          text: excerpt(file.source, node),
        });
    }
    ts.forEachChild(node, visit);
  };
  visit(file.source);
  return pins;
}

// Exports of a file that make clients elsewhere: aliases, client functions, and the names of
// methods that return a client.
function exportsOf(source: ts.SourceFile) {
  const { typed, functionOf, returns, isClass } = resolver(source);
  const names = new Set<string>();
  const functions = new Set<string>();
  const methods = new Set<string>();
  const exporting = (statement: ts.Statement) =>
    ts
      .getModifiers(statement as ts.HasModifiers)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  for (const statement of source.statements) {
    if (ts.isTypeAliasDeclaration(statement) && exporting(statement) && typed(statement.type))
      names.add(statement.name.text);
    if (ts.isVariableStatement(statement) && exporting(statement))
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        // `export const MyOctokit = Octokit.plugin(…)`.
        if (declaration.initializer && isClass(declaration.initializer))
          names.add(declaration.name.text);
        const fn = functionOf(declaration.name.text, statement);
        if (fn && returns(fn, 0)) functions.add(declaration.name.text);
      }
    if (ts.isFunctionDeclaration(statement) && statement.name && exporting(statement))
      if (returns(statement, 0)) functions.add(statement.name.text);
    if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    )
      for (const element of statement.exportClause.elements)
        if (isClass(element.propertyName ?? element.name)) names.add(element.name.text);
  }
  const visit = (node: ts.Node) => {
    if (ts.isMethodDeclaration(node) && returns(node, 0)) methods.add(node.name.getText());
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { names, functions, methods };
}

const PACKAGE_TEXT = /['"](?:octokit|@octokit\/[\w-]+|@actions\/github|probot)['"]/;

function scanFiles(repository: Repository, data: GitHubApiData) {
  const calls: GitHubCall[] = [];
  const pins: GitHubVersionPin[] = [];
  const sources = new Map<string, ts.SourceFile>();
  const sourceFor = (file: Repository['files'][number]) => {
    let source = sources.get(file.path);
    if (!source) sources.set(file.path, (source = sourceOf(file.path, file.content)));
    return source;
  };
  const exported = new Map<string, ReturnType<typeof exportsOf>>();
  const methods = new Set<string>();
  for (const file of repository.files)
    if (PACKAGE_TEXT.test(file.content)) {
      const found = exportsOf(sourceFor(file));
      exported.set(file.path, found);
      for (const method of found.methods) methods.add(method);
    }
  const exportedNames = [...exported.values()].flatMap((item) => [
    ...item.names,
    ...item.functions,
  ]);
  const absolute = new Map(
    repository.files.map((file) => [join(repository.root, file.path), file.path]),
  );
  const imports = createSourceImportResolver(repository, absolute);
  for (const file of repository.files) {
    const api = file.content.includes('api.github.com');
    const pinned = /x-github-api-version/i.test(file.content);
    const context: ResolverContext = { names: new Set(), functions: new Set(), methods };
    if (exportedNames.some((name) => file.content.includes(name)))
      for (const [local, binding] of importedNames(sourceFor(file))) {
        const target = imports.resolve(binding.specifier, join(repository.root, file.path));
        const found = target ? exported.get(absolute.get(target)!) : undefined;
        if (found?.names.has(binding.name)) context.names.add(local);
        if (found?.functions.has(binding.name)) context.functions.add(local);
      }
    const inherited = [...methods].some((method) => file.content.includes(`this.${method}(`));
    const sdk =
      PACKAGE_TEXT.test(file.content) ||
      context.names.size > 0 ||
      context.functions.size > 0 ||
      inherited;
    if (!api && !sdk && !pinned) continue;
    const current: FileContext = {
      path: file.path,
      source: sourceFor(file),
      use: TEST_PATH.test(file.path) ? 'test' : 'live',
    };
    if (api) calls.push(...urlCalls(current, data));
    if (sdk) calls.push(...octokitCalls(current, data, context));
    if (pinned) pins.push(...versionPins(current, data));
  }
  const order = <T extends { file: string; line: number }>(items: T[]) =>
    items.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { calls: order(calls), pins: order(pins) };
}

// Lists every GitHub API request a repository makes, and its pinned REST API versions.
export async function scanGitHubCalls(
  directory: string,
  options: { data?: GitHubApiData } = {},
): Promise<GitHubScan> {
  const data = options.data ?? (await loadGitHubApiData());
  const root = resolve(directory);
  let repository: Repository | undefined;
  const packages: GitHubScan['packages'] = [];
  for (const name of GITHUB_PACKAGES) {
    repository = await readRepository(root, name);
    packages.push(
      ...repository.dependencies.map((dependency) => ({
        name,
        file: dependency.file,
        declared: dependency.version,
        locked: dependency.lock.version,
      })),
    );
  }
  return {
    ...scanFiles(repository!, data),
    packages,
    sources: data.sources,
    warnings: repository!.warnings,
  };
}

// What the deadline registry can match for GitHub: pinned REST API versions, requests to
// endpoints, and GraphQL field coordinates, each by the registry's own spelling.
export async function githubDeadlineUses(
  directory: string,
  versions: string[],
  repository?: Repository,
): Promise<{ version: string; file: string; line: number; use: 'live' | 'test'; text: string }[]> {
  const data = await loadGitHubApiData();
  const read = repository ?? (await readRepository(resolve(directory), GITHUB_PACKAGES[0]));
  const { calls, pins } = scanFiles(read, data);
  const routes = new Map(
    versions
      .filter((version) => / \//.test(version))
      .map((version) => [githubRouteKey(version), version]),
  );
  const listed = new Set(versions);
  return [
    ...pins
      .filter((pin) => listed.has(pin.version))
      .map((pin) => ({
        version: pin.version,
        file: pin.file,
        line: pin.line,
        use: pin.use,
        text: pin.text,
      })),
    ...calls.flatMap((call) => {
      const matched = [
        ...(call.route && routes.has(githubRouteKey(call.route))
          ? [routes.get(githubRouteKey(call.route))!]
          : []),
        ...call.fields.filter((field) => listed.has(field)),
      ];
      return matched.map((version) => ({
        version,
        file: call.file,
        line: call.line,
        use: call.use,
        text: call.text,
      }));
    }),
  ];
}
