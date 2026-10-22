import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { TEST_PATH } from './deadline-exposure.ts';
import {
  daysUntil,
  loadDeadlineRegistry,
  type DeadlineEntry,
  type DeadlineRegistry,
} from './deadline-registry.ts';
import { readRepository } from './repository.ts';
import { scanShopify } from './shopify-analysis.ts';
import { isObject, parseObject } from './specifications.ts';

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
}

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

// Lists the REST Admin calls an app makes to endpoints a later API version removes.
export async function scanShopifyRestDeprecations(
  directory: string,
  options: { data?: ShopifyRestDeprecations; registry?: DeadlineRegistry; now?: Date } = {},
): Promise<ShopifyRestDeprecationScan> {
  const data = options.data ?? (await loadShopifyRestDeprecations());
  const registry = options.registry ?? (await loadDeadlineRegistry());
  const now = options.now ?? new Date();
  const root = resolve(directory);
  const scan = scanShopify(await readRepository(root, '@shopify/shopify-api'));
  const pinned = [...new Set(scan.versions.map((item) => item.value))]
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
  calls.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  rest.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { pinned, served, calls, rest, unmatched, unreadable };
}
