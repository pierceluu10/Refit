import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ShopifyScan } from './shopify-analysis.ts';
import {
  restPathKey,
  SHOPIFY_REST_DEPRECATIONS,
  type ShopifyRestDeprecations,
} from './shopify-rest-deprecations.ts';
import { rewriteRestCalls, type RestTrace } from './shopify-rest-rewrite.ts';

// The versioned REST Admin contract (data/shopify-rest-contract.json, built by
// scripts/shopify-rest-contract.mjs) and the check that proves a traced REST call survives a
// version move: every endpoint, parameter and field the call uses is in both versions' contracts,
// with the same declared type. It proves what Shopify's generated resources and reference state,
// nothing about behaviour they do not describe.

export const SHOPIFY_REST_CONTRACT = new URL('../data/shopify-rest-contract.json', import.meta.url);

export interface RestEndpoint {
  method: string;
  operation: string;
  path: string;
  params: string[];
}

export interface RestResourceContract {
  versions: string[];
  singular?: string;
  plural?: string;
  endpoints: RestEndpoint[];
  fields: Record<string, string>;
}

export interface ShopifyRestContract {
  formatVersion: 1;
  generatedAt: string;
  sources: {
    sdk: {
      package: string;
      release: string;
      tarball: string;
      integrity: string;
      versions: string[];
    }[];
    docs: {
      version: string;
      from: string;
      url: string;
      fetchedAt: string;
      pages: Record<string, Record<string, string | null>>;
    }[];
  };
  sha256: string;
  versions: Record<string, string>;
  resources: Record<string, RestResourceContract[]>;
}

export const contractDigest = (text: string) => createHash('sha256').update(text).digest('hex');

// The parts of a shopify.dev REST reference page (its `.md` form) that state the contract: the
// Endpoints list, the resource Properties and each endpoint's Parameters, with the version in
// links masked. Examples and sample responses are dropped: they change between versions without
// the contract changing. Null when the page is not a reference page (shopify.dev answers an
// undocumented resource with HTML).
export function referenceSections(page: string, version: string) {
  if (!page.startsWith('---\n')) return null;
  const body = page
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(
      new RegExp(`(admin-rest|admin-graphql|/api)/(${version}|latest)\\b`, 'g'),
      '$1/VERSION',
    );
  const kept: string[] = [];
  let heading = '';
  for (const line of body.split('\n')) {
    if (/^#{1,6} /.test(line)) {
      heading = line;
      if (/^## (get|post|put|del)/.test(line)) kept.push(line);
      continue;
    }
    if (['## Endpoints', '### Properties', '### Parameters'].includes(heading)) kept.push(line);
  }
  return kept.join('\n');
}

// The digest of the contract body, as the generator wrote it.
export function contractBodyDigest(contract: ShopifyRestContract) {
  return contractDigest(
    JSON.stringify({ versions: contract.versions, resources: contract.resources }),
  );
}

let deprecationsCache: ShopifyRestDeprecations | undefined;
function loadDeprecationsSync() {
  deprecationsCache ??= JSON.parse(
    readFileSync(SHOPIFY_REST_DEPRECATIONS, 'utf8'),
  ) as ShopifyRestDeprecations;
  return deprecationsCache;
}

let cached: ShopifyRestContract | undefined;
export function loadShopifyRestVersionContract(): ShopifyRestContract {
  cached ??= JSON.parse(readFileSync(SHOPIFY_REST_CONTRACT, 'utf8')) as ShopifyRestContract;
  return cached;
}

// Every resource's contract at one version.
export function contractAt(contract: ShopifyRestContract, version: string) {
  const resources = new Map<string, RestResourceContract>();
  for (const [name, list] of Object.entries(contract.resources)) {
    const entry = list.find((item) => item.versions.includes(version));
    if (entry) resources.set(name, entry);
  }
  return resources;
}

export type RestContractChange =
  | { kind: 'resource-removed'; resource: string }
  | { kind: 'endpoint-removed'; resource: string; method: string; path: string }
  | { kind: 'param-removed'; resource: string; method: string; path: string; param: string }
  | { kind: 'field-removed'; resource: string; field: string }
  | { kind: 'field-type-changed'; resource: string; field: string; from: string; to: string }
  | {
      kind: 'deprecated';
      resource: string;
      what: string;
      removedIn: string;
      source: string;
    };

const endpointKey = (endpoint: Pick<RestEndpoint, 'method' | 'path'>) =>
  `${endpoint.method} ${restPathKey(endpoint.path)}`;

// What a later version no longer has that an earlier one did: resources, endpoints, parameters,
// fields and field types, plus the removals data/shopify-rest-deprecations.json lists between
// the two (some cite shopify.dev for an earlier version than the generated resources show).
// A renamed item is listed as removed: the generated resources do not say what replaced it.
export function restContractDiff(
  contract: ShopifyRestContract,
  from: string,
  to: string,
  deprecations: ShopifyRestDeprecations,
): RestContractChange[] {
  for (const version of [from, to])
    if (!contract.versions[version])
      throw new Error(
        `The REST contract has no ${version}; it covers ${Object.keys(contract.versions).join(', ')}.`,
      );
  const before = contractAt(contract, from);
  const after = contractAt(contract, to);
  const changes: RestContractChange[] = [];
  for (const [resource, old] of before) {
    const next = after.get(resource);
    if (!next) {
      changes.push({ kind: 'resource-removed', resource });
      continue;
    }
    if (old === next) continue;
    const endpoints = new Map(next.endpoints.map((endpoint) => [endpointKey(endpoint), endpoint]));
    for (const endpoint of old.endpoints) {
      const kept = endpoints.get(endpointKey(endpoint));
      if (!kept) {
        changes.push({
          kind: 'endpoint-removed',
          resource,
          method: endpoint.method,
          path: endpoint.path,
        });
        continue;
      }
      for (const param of endpoint.params)
        if (!kept.params.includes(param))
          changes.push({
            kind: 'param-removed',
            resource,
            method: endpoint.method,
            path: endpoint.path,
            param,
          });
    }
    for (const [field, type] of Object.entries(old.fields)) {
      const kept = next.fields[field];
      if (kept === undefined) changes.push({ kind: 'field-removed', resource, field });
      else if (kept !== type)
        changes.push({ kind: 'field-type-changed', resource, field, from: type, to: kept });
    }
  }
  const between = (version: string) => version > from && version <= to;
  for (const endpoint of deprecations.endpoints)
    if (between(endpoint.removedIn))
      changes.push({
        kind: 'deprecated',
        resource: endpoint.resource,
        what: `${endpoint.method} ${endpoint.path}`,
        removedIn: endpoint.removedIn,
        source: endpoint.shopifyDev.source,
      });
  for (const field of deprecations.fields)
    if (between(field.removedIn))
      changes.push({
        kind: 'deprecated',
        resource: field.resource,
        what: field.field,
        removedIn: field.removedIn,
        source: field.source,
      });
  return changes;
}

// Integrity of the committed contract, for `refit rules check`: the body digest matches, every
// version names its source, every version shopify.dev added rests on identical reference digests,
// and every SDK source records a registry tarball and SHA-512 integrity.
export function checkShopifyRestContract(contract: ShopifyRestContract) {
  const errors: string[] = [];
  if (contract.formatVersion !== 1) errors.push('formatVersion must be 1.');
  if (contractBodyDigest(contract) !== contract.sha256)
    errors.push(
      `The contract body digest is ${contractBodyDigest(contract)}, the file records ${contract.sha256}.`,
    );
  for (const source of contract.sources.sdk) {
    if (!/^https:\/\/registry\.npmjs\.org\//.test(source.tarball))
      errors.push(`${source.package}@${source.release} has no registry tarball.`);
    if (!/^sha512-[A-Za-z0-9+/=]+$/.test(source.integrity))
      errors.push(`${source.package}@${source.release} has no SHA-512 integrity.`);
    for (const version of source.versions)
      if (contract.versions[version] !== `${source.package}@${source.release}`)
        errors.push(
          `${version} is not recorded as coming from ${source.package}@${source.release}.`,
        );
  }
  for (const docs of contract.sources.docs) {
    const at = contractAt(contract, docs.version);
    for (const [resource, pages] of Object.entries(docs.pages)) {
      const same = pages[docs.from] !== null && pages[docs.from] === pages[docs.version];
      if (at.has(resource) !== same)
        errors.push(
          same
            ? `${resource}'s ${docs.version} reference matches ${docs.from}, but the contract leaves it out of ${docs.version}.`
            : `${resource} is in the ${docs.version} contract, but its reference differs from ${docs.from} or is missing.`,
        );
      if (
        same &&
        JSON.stringify(stripVersions(at.get(resource))) !==
          JSON.stringify(stripVersions(contractAt(contract, docs.from).get(resource)))
      )
        errors.push(
          `${resource} at ${docs.version} is not the ${docs.from} contract it was carried from.`,
        );
    }
  }
  for (const [resource, list] of Object.entries(contract.resources))
    for (const entry of list)
      for (const version of entry.versions)
        if (!contract.versions[version])
          errors.push(`${resource} lists ${version}, which has no source.`);
  return errors;
}

const stripVersions = (entry: RestResourceContract | undefined) => {
  if (!entry) return undefined;
  const { versions: _versions, ...rest } = entry;
  return rest;
};

// Resource class operations and the endpoint operations each one sends (as in
// shopify-rest-deprecations.ts); `save` is `post` for a new record and `put` for an existing one.
const OPERATIONS: Record<string, string[]> = {
  all: ['get'],
  find: ['get'],
  count: ['count'],
  delete: ['delete'],
  save: ['post', 'put'],
};

const placeholders = (path: string) =>
  [...path.matchAll(/<(\w+)>/g)].map((match) => match[1]).sort();

// Class names a declared field type refers to: `Image[] | null | {[key: string]: any}` is Image.
function classesOf(type: string, resources: Map<string, RestResourceContract>) {
  return [...new Set(type.match(/\b[A-Z]\w*\b/g) ?? [])].filter((name) => resources.has(name));
}

const field = (path: string[]) => path.filter((step) => step !== '[]').join('.') || 'the response';

export type RestCallProof =
  | { status: 'proven'; endpoints: string[]; checked: number }
  | { status: 'unproven'; reason: string };

// Whether everything a traced REST call uses is in the `before` contract and unchanged in `after`:
// the endpoint (method and path, or resource operation), every query or option name, every body
// key and every read of the response, with the field's declared type. A field the code uses whole
// needs every field of the record it holds unchanged; a read inside a field the contract describes
// only as an object (`{[key: string]: unknown}`) is not checked, so it stops.
export function proveRestCall(
  contract: ShopifyRestContract,
  versions: { before: string; after: string },
  trace: RestTrace,
  deprecations: Pick<ShopifyRestDeprecations, 'endpoints' | 'fields'> = loadDeprecationsSync(),
): RestCallProof {
  const { before, after } = versions;
  // Removals data/shopify-rest-deprecations.json lists inside the move, some from shopify.dev.
  const moved = (version: string) => version > before && version <= after;
  const deprecatedField = (resource: string, key: string) =>
    deprecations.fields.find(
      (entry) => entry.resource === resource && entry.field === key && moved(entry.removedIn),
    );
  for (const version of [before, after])
    if (!contract.versions[version])
      return { status: 'unproven', reason: `The REST contract has no Admin API ${version}.` };
  const at = { before: contractAt(contract, before), after: contractAt(contract, after) };
  const label = trace.resource
    ? `${trace.resource.name}.${trace.resource.operation}`
    : `${trace.method} ${trace.path}`;
  const unproven = (reason: string): RestCallProof => ({
    status: 'unproven',
    reason: `${label}: ${reason}`,
  });

  // The endpoints the call can reach, in the before contract.
  let resourceName: string;
  let endpoints: RestEndpoint[];
  let operation: string;
  if (trace.resource) {
    resourceName = trace.resource.name;
    operation = trace.resource.operation;
    const resource = at.before.get(resourceName);
    if (!resource) return unproven(`the ${before} contract has no ${resourceName} resource.`);
    const sent = OPERATIONS[operation] ?? [operation];
    const ids = new Set(resource.endpoints.flatMap((endpoint) => placeholders(endpoint.path)));
    const given = trace.query.filter((name) => ids.has(name)).sort();
    endpoints = resource.endpoints.filter(
      (endpoint) =>
        sent.includes(endpoint.operation) &&
        // `save` reaches the create and the update endpoint; others fill exactly the ids given.
        (operation === 'save' ||
          JSON.stringify(placeholders(endpoint.path)) === JSON.stringify(given)),
    );
  } else {
    const key = `${trace.method} ${restPathKey(trace.path ?? '')}`;
    const found = [...at.before].flatMap(([name, resource]) =>
      resource.endpoints
        .filter((endpoint) => endpointKey(endpoint) === key)
        .map((endpoint) => ({ name, endpoint })),
    );
    const names = [...new Set(found.map((entry) => entry.name))];
    if (names.length > 1)
      return unproven(`the ${before} contract lists this path under ${names.join(' and ')}.`);
    resourceName = names[0];
    endpoints = found.map((entry) => entry.endpoint);
    operation = endpoints[0]?.operation ?? '';
  }
  if (!endpoints.length)
    return unproven(`the ${before} contract has no endpoint this call reaches.`);
  const old = at.before.get(resourceName)!;
  const next = at.after.get(resourceName);
  if (!next)
    return unproven(
      contract.sources.docs.some((docs) => docs.version === after)
        ? `Refit has no ${after} contract for ${resourceName}: shopify.dev's ${after} reference for it is missing or differs from the version Refit has.`
        : `${resourceName} is removed in ${after}.`,
    );
  let checked = 0;
  for (const endpoint of endpoints) {
    const kept = next.endpoints.find((item) => endpointKey(item) === endpointKey(endpoint));
    const deprecated = deprecations.endpoints.find(
      (entry) =>
        entry.resource === resourceName &&
        endpointKey(entry) === endpointKey(endpoint) &&
        moved(entry.removedIn),
    );
    if (!kept || deprecated)
      return unproven(
        `${endpoint.method} ${endpoint.path} is removed in ${deprecated?.removedIn ?? after}${deprecated ? ` (${deprecated.shopifyDev.source})` : ''}.`,
      );
    const ids = new Set(placeholders(endpoint.path));
    for (const name of trace.query) {
      // `asset[key]` is the `asset` parameter; a resource call's ids fill the path.
      const param = name.replace(/\[.*$/, '');
      if (ids.has(param) || (trace.resource && param === 'id')) continue;
      if (!endpoint.params.includes(param))
        return unproven(
          `it sends \`${param}\`, which the ${before} contract does not list for ${endpoint.method} ${endpoint.path}.`,
        );
      if (!kept.params.includes(param))
        return unproven(
          `\`${param}\` is removed from ${endpoint.method} ${endpoint.path} in ${after}.`,
        );
      checked++;
    }
  }

  const visited = new Set<string>();
  // Every field of a record the code uses whole, and of the records its fields hold.
  const whole = (name: string): string | undefined => {
    if (visited.has(name)) return undefined;
    visited.add(name);
    const from = at.before.get(name);
    const to = at.after.get(name);
    if (!from) return `the ${before} contract has no ${name}.`;
    if (!to) return `${name} has no ${after} contract.`;
    for (const [key, type] of Object.entries(from.fields)) {
      if (to.fields[key] === undefined || deprecatedField(name, key))
        return `the code uses a whole ${name}, whose \`${key}\` is removed in ${after}.`;
      if (to.fields[key] !== type)
        return `the code uses a whole ${name}, whose \`${key}\` changes type from ${type} to ${to.fields[key]} in ${after}.`;
      checked++;
      for (const inner of classesOf(type, at.before)) {
        const problem = whole(inner);
        if (problem) return problem;
      }
    }
    return undefined;
  };
  // A field path inside a record: each step must exist with the same type in both versions.
  const fieldPath = (
    name: string,
    path: string[],
    isWhole: boolean,
    shown: string[],
  ): string | undefined => {
    const steps = path.filter((step) => step !== '[]');
    if (!steps.length) return isWhole ? whole(name) : undefined;
    const [key, ...rest] = steps;
    const from = at.before.get(name)!;
    const to = at.after.get(name);
    const where = [...shown, key].join('.');
    const type = from.fields[key];
    if (type === undefined)
      return `it reads \`${where}\`, which the ${before} contract does not list for ${name}.`;
    const deprecated = deprecatedField(name, key);
    if (!to || to.fields[key] === undefined || deprecated)
      return `\`${where}\` is removed in ${deprecated?.removedIn ?? after}.`;
    if (to.fields[key] !== type)
      return `\`${where}\` changes type from ${type} to ${to.fields[key]} in ${after}.`;
    checked++;
    const inner = classesOf(type, at.before);
    if (!rest.length) {
      for (const record of isWhole ? inner : []) {
        const problem = whole(record);
        if (problem) return problem;
      }
      return undefined;
    }
    if (inner.length !== 1)
      return `it reads inside \`${where}\` (${type}), whose fields the contract does not list.`;
    return fieldPath(inner[0], rest, isWhole, [...shown, key]);
  };
  // A body or read path from the top of the JSON: the resource's singular or plural key, or
  // `count` for a count.
  const envelope = (path: string[], isWhole: boolean): string | undefined => {
    if (!path.length) return isWhole ? whole(resourceName) : undefined;
    const [top, ...rest] = path;
    if (operation === 'count' && top === 'count' && !rest.length) return undefined;
    if (top !== old.singular && top !== old.plural)
      return `it reads \`${field(path)}\`, which is not a key of the ${resourceName} response.`;
    return fieldPath(resourceName, rest, isWhole, [top]);
  };
  for (const read of trace.reads) {
    let problem: string | undefined;
    if (!trace.resource) problem = envelope(read.path, read.whole);
    else if (operation === 'count')
      problem =
        read.path.length === 0 || (read.path.length === 1 && read.path[0] === 'count')
          ? undefined
          : `it reads \`${field(read.path)}\`, which a count does not return.`;
    else if (operation === 'delete')
      problem = read.whole
        ? 'it uses the response of a delete, which the contract does not describe.'
        : undefined;
    else {
      // `all` returns records under `data` ('[]'); other operations one record (`__record`).
      const path =
        read.path[0] === '__record' || read.path[0] === '[]' ? read.path.slice(1) : read.path;
      problem = fieldPath(resourceName, path, read.whole, []);
    }
    if (problem) return unproven(problem);
  }
  if (trace.body === null) return unproven('it sends a body that is not an object literal.');
  for (const path of trace.body ?? []) {
    const problem =
      path[0] === old.singular
        ? fieldPath(resourceName, path.slice(1), true, [path[0]])
        : `it sends \`${path.join('.')}\`, which is not a key of the ${resourceName} request.`;
    if (problem) return unproven(problem);
  }
  return {
    status: 'proven',
    endpoints: endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`),
    checked,
  };
}

export interface RestEntryProof {
  entry: ShopifyScan['rest'][number];
  proof: RestCallProof;
}

// Every REST call the scan found, traced and checked against the contract. A REST client
// construction is proven when every use of the client is a call that is proven; a resource
// record built and saved is not traced, so it stays unproven.
export function proveShopifyRest(
  repository: { files: { path: string; content: string }[] },
  scan: Pick<ShopifyScan, 'rest'>,
  versions: { before: string; after: string },
  contract: ShopifyRestContract = loadShopifyRestVersionContract(),
): RestEntryProof[] {
  const byFile = new Map<string, ShopifyScan['rest']>();
  for (const entry of scan.rest) byFile.set(entry.file, [...(byFile.get(entry.file) ?? []), entry]);
  const proofs: RestEntryProof[] = [];
  for (const [file, entries] of byFile) {
    const content = repository.files.find((item) => item.path === file)?.content;
    if (content === undefined) {
      for (const entry of entries)
        proofs.push({
          entry,
          proof: { status: 'unproven', reason: 'Refit could not read the file again.' },
        });
      continue;
    }
    const traced = rewriteRestCalls({
      file,
      content,
      entries,
      rules: [],
      schemas: [],
      traceOnly: true,
    });
    const calls = new Map<string, RestCallProof>();
    for (const result of traced)
      if (result.status === 'stopped' && result.trace)
        calls.set(
          `${result.entry.line}:${result.entry.column}`,
          proveRestCall(contract, versions, result.trace),
        );
    for (const entry of entries) {
      const result = traced.find((item) => item.entry === entry);
      const own = calls.get(`${entry.line}:${entry.column}`);
      if (own) {
        proofs.push({ entry, proof: own });
        continue;
      }
      if (result?.status === 'stopped' && result.clientCalls !== undefined) {
        const sites = result.clientCalls?.map((site) => calls.get(`${site.line}:${site.column}`));
        proofs.push({
          entry,
          proof:
            sites && sites.every((site) => site?.status === 'proven')
              ? { status: 'proven', endpoints: [], checked: 0 }
              : {
                  status: 'unproven',
                  reason: sites
                    ? 'The REST client is also used by calls the contract does not prove.'
                    : 'The REST client is used in ways other than calls Refit traced.',
                },
        });
        continue;
      }
      proofs.push({
        entry,
        proof: {
          status: 'unproven',
          reason:
            result?.status === 'stopped' ? result.reason : 'Refit could not trace this REST call.',
        },
      });
    }
  }
  return proofs;
}
