import { readFile } from 'node:fs/promises';
import ts from 'typescript-compiler';
import { isAbsolute, relative, resolve } from 'node:path';
import { TEST_PATH } from './deadline-exposure.ts';
import {
  daysUntil,
  loadDeadlineRegistry,
  type DeadlineEntry,
  type DeadlineRegistry,
} from './deadline-registry.ts';
import { sourceOf } from './meta-graph-calls.ts';
import { readRepository } from './repository.ts';
import { scanShopify } from './shopify-analysis.ts';
import { isObject, parseObject } from './specifications.ts';
import type { Repository } from './types.ts';

// REST Admin calls a Shopify app makes to endpoints that a later API version no longer has, read
// from the REST evidence `scanShopify` already collects (`shopify.restCalls`). Each call is matched
// to data/shopify-rest-deprecations.json, which scripts/shopify-rest-deprecations.mjs generates from
// the REST resources Shopify ships per API version in @shopify/shopify-api. Report only: Refit
// never rewrites a REST call.

export const SHOPIFY_REST_DEPRECATIONS = new URL(
  '../data/shopify-rest-deprecations.json',
  import.meta.url,
);
const VERSION = /^\d{4}-\d{2}$/;
const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);
// Resource class operations that `scanShopify` reports, and the generated `paths` operation each
// one sends. `save` is `post` for a new record and `put` for an existing one.
const OPERATIONS: Record<string, string[]> = {
  all: ['get'],
  find: ['get'],
  count: ['count'],
  delete: ['delete'],
  save: ['post', 'put'],
};

export interface RemovedEndpoint {
  resource: string;
  method: string;
  operation: string;
  path: string;
  lastVersion: string;
  removedIn: string;
  resourceRemoved: boolean;
  source: string;
  // What shopify.dev says (docs/benchmarks/2026-10-22-shopify-rest-verification.json): it states
  // this removal version (`confirmed`) or an earlier one that replaced the SDK's `sdkRemovedIn`
  // (`confirmed-earlier`), or no supported version documents the endpoint but no page names the
  // version (`not-in-current-reference`). Endpoints shopify.dev still documents are not listed.
  shopifyDev: { status: ShopifyDevStatus; source: string; checkedAt: string };
  sdkRemovedIn?: string;
}

export type ShopifyDevStatus = 'confirmed' | 'confirmed-earlier' | 'not-in-current-reference';
const SHOPIFY_DEV_STATUSES = new Set([
  'confirmed',
  'confirmed-earlier',
  'not-in-current-reference',
]);

export interface RemovedField {
  resource: string;
  field: string;
  lastVersion: string;
  removedIn: string;
  source: string;
}

export interface ShopifyRestDeprecations {
  checkedAt: string;
  versions: Record<string, string>;
  endpoints: RemovedEndpoint[];
  fields: RemovedField[];
  resources: Record<string, string[]>;
}

export interface ShopifyRestDeprecatedCall {
  file: string;
  line: number;
  use: 'live' | 'test';
  // As `scanShopify` reports the call: the resource operation, method and path it could read.
  call: { expression: string; method: string | null; path: string | null; resource: string | null };
  endpoint: RemovedEndpoint;
  // `removed`: the version the app is served (its pin, or the oldest supported version Shopify
  // falls forward to) no longer has the endpoint. `upcoming`: it still does, until the pin moves
  // to `removedIn` or the last version that has it is retired.
  status: 'removed' | 'upcoming' | 'unknown';
  // The registry sunset of `lastVersion`: after it, no supported version has the endpoint.
  deadline: { id: string; date: string; days: number } | null;
}

export interface ShopifyRestDeprecationScan {
  // API versions the app pins, from `scanShopify`.
  pinned: string[];
  // The version Shopify serves: the newest pin, raised to the oldest supported version.
  served: string | null;
  calls: ShopifyRestDeprecatedCall[];
  // Every REST Admin call `scanShopify` found, so the inventory lists the endpoints an app uses.
  rest: {
    file: string;
    line: number;
    use: 'live' | 'test';
    method: string | null;
    path: string | null;
    resource: string | null;
  }[];
  // REST calls that match no removal, by count; and calls whose endpoint could not be read.
  unmatched: number;
  unreadable: number;
}

export function checkShopifyRestDeprecations(value: unknown) {
  const errors: string[] = [];
  if (!isObject(value) || value.formatVersion !== 1) return ['The list requires formatVersion: 1.'];
  if (typeof value.checkedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.checkedAt))
    errors.push('checkedAt must be a YYYY-MM-DD date.');
  const versions = isObject(value.versions) ? Object.keys(value.versions).sort() : [];
  if (!versions.length || versions.some((version) => !VERSION.test(version)))
    errors.push('versions must map each YYYY-MM API version to the SDK release it was read from.');
  const check = (label: string, entry: unknown, keys: string[]) => {
    if (!isObject(entry)) return errors.push(`${label}: must be an object.`);
    for (const key of keys)
      if (typeof entry[key] !== 'string' || !entry[key])
        errors.push(`${label}: ${key} is required.`);
    const last = String(entry.lastVersion);
    const next = String(entry.removedIn);
    if (!versions.includes(last) || !versions.includes(next))
      errors.push(`${label}: lastVersion and removedIn must be listed versions.`);
    else if (versions.indexOf(next) !== versions.indexOf(last) + 1)
      errors.push(`${label}: removedIn must be the version right after lastVersion.`);
    if (typeof entry.source !== 'string' || !/^https:\/\/\S+/.test(entry.source))
      errors.push(`${label}: source must start with an https URL.`);
  };
  const seen = new Set<string>();
  for (const [index, entry] of (Array.isArray(value.endpoints) ? value.endpoints : []).entries()) {
    check(`endpoints[${index}]`, entry, ['resource', 'method', 'operation', 'path']);
    if (isObject(entry)) {
      if (!METHODS.has(String(entry.method)))
        errors.push(`endpoints[${index}]: method must be GET, POST, PUT or DELETE.`);
      const verified = entry.shopifyDev;
      if (
        !isObject(verified) ||
        !SHOPIFY_DEV_STATUSES.has(String(verified.status)) ||
        typeof verified.source !== 'string' ||
        !/^https:\/\/shopify\.dev\/\S+$/.test(verified.source) ||
        typeof verified.checkedAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(verified.checkedAt)
      )
        errors.push(
          `endpoints[${index}]: shopifyDev needs a status (${[...SHOPIFY_DEV_STATUSES].join(', ')}), a shopify.dev source and checkedAt.`,
        );
      const key = `${String(entry.method)} ${String(entry.path)}`;
      if (seen.has(key)) errors.push(`endpoints[${index}]: ${key} is listed twice.`);
      seen.add(key);
    }
  }
  for (const [index, entry] of (Array.isArray(value.fields) ? value.fields : []).entries())
    check(`fields[${index}]`, entry, ['resource', 'field']);
  if (!Array.isArray(value.endpoints) || !Array.isArray(value.fields))
    errors.push('endpoints and fields must be lists.');
  if (!isObject(value.resources)) errors.push('resources must map each class to its operations.');
  return errors;
}

let cached: Promise<ShopifyRestDeprecations> | undefined;
export function loadShopifyRestDeprecations(
  path: string | URL = SHOPIFY_REST_DEPRECATIONS,
): Promise<ShopifyRestDeprecations> {
  const load = async () => {
    const value = parseObject(await readFile(path, 'utf8'), 'Shopify REST deprecations');
    const errors = checkShopifyRestDeprecations(value);
    if (errors.length) throw new Error(`Shopify REST deprecations are invalid: ${errors[0]}`);
    return value as unknown as ShopifyRestDeprecations;
  };
  if (path !== SHOPIFY_REST_DEPRECATIONS) return load();
  cached ??= load();
  return cached;
}

// `customers/{id}/addresses.json`, `/customers/123/addresses` and `customers/<customer_id>/addresses.json`
// compare equal: a leading slash, `.json`, a query and the name of each substituted segment do
// not matter.
export function restPathKey(path: string) {
  return path
    .replace(/[?#].*$/, '')
    .replace(/^\/+/, '')
    .replace(/^admin\/api\/(?:\d{4}-\d{2}|unstable)\//, '')
    .replace(/\.json$/, '')
    .split('/')
    .map((segment) => (/^(?:<[^>]*>|\{[^}]*\}|\d+)$/.test(segment) ? '*' : segment))
    .join('/');
}

function oldestSupported(registry: DeadlineRegistry, now: Date) {
  return registry.deadlines
    .filter(
      (entry) =>
        entry.provider === 'shopify' &&
        entry.kind === 'api-version' &&
        daysUntil(entry.date, now) >= 0,
    )
    .flatMap((entry) => entry.versions)
    .sort()[0];
}

function sunset(registry: DeadlineRegistry, version: string, now: Date) {
  const entry: DeadlineEntry | undefined = registry.deadlines.find(
    (item) => item.provider === 'shopify' && item.versions.includes(version),
  );
  return entry ? { id: entry.id, date: entry.date, days: daysUntil(entry.date, now) } : null;
}

// Every endpoint a resource class has had, from the generated resources:
// `{ operation, method, key }`.
function operations(data: ShopifyRestDeprecations) {
  return Object.entries(data.resources).flatMap(([resource, list]) =>
    list.map((item) => {
      const [operation, method, path] = item.split(' ');
      return { resource, operation, method, key: restPathKey(path) };
    }),
  );
}

// The removed endpoints a REST call can be, from its path or its resource class and operation.
// When the code leaves the method or the exact endpoint open (a path with no method, `save`), the
// call matches only if every endpoint it could be is removed, so a call to an endpoint that still
// exists is never reported.
function matches(
  data: ShopifyRestDeprecations,
  call: { method?: string; path?: string; resource?: string },
) {
  const known = operations(data);
  const removed = (method: string, key: string) =>
    data.endpoints.find(
      (endpoint) => endpoint.method === method && restPathKey(endpoint.path) === key,
    );
  let candidates: { method: string; key: string }[];
  if (call.path) {
    const key = restPathKey(call.path);
    const methods =
      call.method?.split(' or ') ??
      known.filter((item) => item.key === key).map((item) => item.method);
    candidates = [...new Set(methods)].map((method) => ({ method, key }));
  } else if (call.resource) {
    const [name, operation] = call.resource.split('.');
    const sent = OPERATIONS[operation] ?? [operation];
    // `all` reads the collection and `find` one record: `addresses.json` against `addresses/<id>.json`.
    const byId = (key: string) => key.endsWith('/*');
    candidates = known.filter(
      (item) =>
        item.resource === name &&
        sent.includes(item.operation) &&
        (operation === 'all' ? !byId(item.key) : operation === 'find' ? byId(item.key) : true),
    );
  } else return [];
  const found = candidates.map((item) => removed(item.method, item.key));
  return found.length && found.every(Boolean) ? [...new Set(found as RemovedEndpoint[])] : [];
}

const HTTP_VERBS: Record<string, string> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  delete: 'DELETE',
  del: 'DELETE',
};
// A REST path written after a base URL another expression supplies:
// `${this.baseUrl(credentials)}/orders/${orderId}/fulfillments.json`.
const RELATIVE_REST =
  /^(?:\{[^}]*\})?\/((?:[a-z_]+|\{[^}]*\})(?:\/(?:[a-z_]+|\{[^}]*\}))*\.json)(?:\?.*)?$/;

function literalPath(
  node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression,
) {
  if (!ts.isTemplateExpression(node)) return node.text;
  return (
    node.head.text +
    node.templateSpans.map((span) => `{${span.expression.getText()}}${span.literal.text}`).join('')
  );
}

// The method of the request a URL literal is passed to: an HTTP verb call (`client.post(url)`), or
// a literal `method` in an options object among the call's arguments (`fetch(url, { method })`,
// `shopifyFetch(url, headers, { method: 'POST' })`). Undefined when the code does not say.
function urlMethod(node: ts.Node) {
  const call = node.parent;
  if (!ts.isCallExpression(call) || !call.arguments.includes(node as ts.Expression))
    return undefined;
  if (ts.isPropertyAccessExpression(call.expression) && HTTP_VERBS[call.expression.name.text])
    return HTTP_VERBS[call.expression.name.text];
  for (const argument of call.arguments)
    if (ts.isObjectLiteralExpression(argument))
      for (const property of argument.properties)
        if (
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === 'method' &&
          ts.isStringLiteralLike(property.initializer)
        )
          return property.initializer.text.toUpperCase();
  return undefined;
}

// REST paths `scanShopify` does not see because the versioned base comes from elsewhere. Only files
// that build an `/admin/api/` URL are read, and only literals that are a bare REST path.
function relativeRestCalls(
  repository: Repository,
  root: string,
  seen: Set<string>,
  data: ShopifyRestDeprecations,
) {
  // A path counts only when its first segment is one the REST resources use (`orders`,
  // `products`, …), so an app's own routes such as `/ai/products.json` are not REST calls.
  const roots = new Set(
    Object.values(data.resources).flatMap((list) =>
      list.map((item) =>
        item
          .split(' ')[2]
          .split('/')[0]
          .replace(/\.json$/, ''),
      ),
    ),
  );
  const found: { file: string; line: number; expression: string; method?: string; path: string }[] =
    [];
  for (const file of repository.files) {
    if (!file.content.includes('/admin/api/')) continue;
    const source = sourceOf(file.path, file.content);
    const visit = (node: ts.Node) => {
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node)
      ) {
        const text = literalPath(node);
        const path = RELATIVE_REST.exec(text)?.[1];
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const where = isAbsolute(file.path) ? relative(root, file.path) : file.path;
        if (
          path &&
          roots.has(path.split('/')[0].replace(/\.json$/, '')) &&
          !seen.has(`${where}:${line}`)
        ) {
          const method = urlMethod(node);
          found.push({ file: where, line, expression: text, ...(method ? { method } : {}), path });
        }
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

// Lists the REST Admin calls an app makes to endpoints a later API version removes.
export async function scanShopifyRestDeprecations(
  directory: string,
  options: { data?: ShopifyRestDeprecations; registry?: DeadlineRegistry; now?: Date } = {},
): Promise<ShopifyRestDeprecationScan> {
  const data = options.data ?? (await loadShopifyRestDeprecations());
  const registry = options.registry ?? (await loadDeadlineRegistry());
  const now = options.now ?? new Date();
  const root = resolve(directory);
  const repository = await readRepository(root, '@shopify/shopify-api');
  const scan = scanShopify(repository);
  // `scanShopify`'s pins, plus a version that ends a base URL (`/admin/api/2024-01` + path).
  const baseVersions = repository.files.flatMap((file) =>
    [...file.content.matchAll(/\/admin\/api\/(\d{4}-\d{2})(?=[`'"])/g)].map((match) => match[1]),
  );
  const pinned = [...new Set([...scan.versions.map((item) => item.value), ...baseVersions])]
    .filter((version) => VERSION.test(version))
    .sort();
  const oldest = oldestSupported(registry, now);
  const newest = pinned.at(-1);
  const served = newest && oldest ? (newest < oldest ? oldest : newest) : (newest ?? null);
  const calls: ShopifyRestDeprecatedCall[] = [];
  const rest: ShopifyRestDeprecationScan['rest'] = [];
  let unmatched = 0;
  let unreadable = 0;
  for (const call of scan.rest) {
    const where = isAbsolute(call.file) ? relative(root, call.file) : call.file;
    rest.push({
      file: where,
      line: call.line,
      use: TEST_PATH.test(where) ? 'test' : 'live',
      method: call.method ?? null,
      path: call.path ?? null,
      resource: call.resource ?? null,
    });
    if (!call.path && !call.resource) {
      unreadable += 1;
      continue;
    }
    const found = matches(data, call);
    if (!found.length) unmatched += 1;
    const file = isAbsolute(call.file) ? relative(root, call.file) : call.file;
    for (const endpoint of found)
      calls.push({
        file,
        line: call.line,
        use: TEST_PATH.test(file) ? 'test' : 'live',
        call: {
          expression: call.expression,
          method: call.method ?? null,
          path: call.path ?? null,
          resource: call.resource ?? null,
        },
        endpoint,
        status: !served ? 'unknown' : served >= endpoint.removedIn ? 'removed' : 'upcoming',
        deadline: sunset(registry, endpoint.lastVersion, now),
      });
  }
  const seen = new Set(rest.map((item) => `${item.file}:${item.line}`));
  for (const call of relativeRestCalls(repository, root, seen, data)) {
    rest.push({
      file: call.file,
      line: call.line,
      use: TEST_PATH.test(call.file) ? 'test' : 'live',
      method: call.method ?? null,
      path: call.path,
      resource: null,
    });
    const found = matches(data, call);
    if (!found.length) unmatched += 1;
    for (const endpoint of found)
      calls.push({
        file: call.file,
        line: call.line,
        use: TEST_PATH.test(call.file) ? 'test' : 'live',
        call: {
          expression: call.expression,
          method: call.method ?? null,
          path: call.path,
          resource: null,
        },
        endpoint,
        status: !served ? 'unknown' : served >= endpoint.removedIn ? 'removed' : 'upcoming',
        deadline: sunset(registry, endpoint.lastVersion, now),
      });
  }
  calls.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  rest.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { pinned, served, calls, rest, unmatched, unreadable };
}
