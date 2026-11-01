// Shopify ToolPack: helpers the migration agent may call to check its own work.
// Every tool returns information (with sources and snapshot dates) and never blocks.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentTool, ToolPack } from '../../shared/types.ts';
import {
  assembleToolPack,
  bool,
  closest,
  defineTool,
  fetchText,
  obj,
  rank,
  resolveFetch,
  str,
  type NetworkOptions,
  type ToolPackOptions,
} from '../toolkit/index.ts';
import {
  expandCompactSchema,
  formatIssues,
  reduceIntrospection,
  schemaFromText,
  validateDocument,
  type ReducedSchema,
} from '../toolkit/graphql.ts';

export type ShopifyToolPackOptions = ToolPackOptions & {
  /** Where live introspection results are cached. Defaults to os.tmpdir(); null disables the cache. */
  schemaCacheDir?: string | null;
  /** Clock for version status (tests). */
  now?: () => Date;
};

const DATA_DIR = new URL('./tools-data/', import.meta.url);
const PROXY = 'https://shopify.dev/admin-graphql-direct-proxy';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const VERSION_RE = /^(\d{4})-(\d{2})$/;

function readData<T>(name: string): T {
  return JSON.parse(readFileSync(fileURLToPath(new URL(name, DATA_DIR)), 'utf8')) as T;
}

// ---------------------------------------------------------------------------
// API versions

type VersionEntry = {
  version: string;
  released: string;
  accessibleUntil: string;
  status: string;
  source: string;
  highlights?: string;
  notesUrl?: string;
};

type VersionsData = {
  source: string[];
  retrieved: string;
  cadence: { summary: string; support: string; types: Record<string, string>; source: string };
  fallForward: { summary: string; webhooks: string; source: string };
  versions: VersionEntry[];
  deadlines: { date: string; title: string; source: string; confidence?: string }[];
};

let versionsCache: VersionsData | undefined;
function versionsData(): VersionsData {
  versionsCache ??= readData<VersionsData>('api-versions.json');
  return versionsCache;
}

type Status = 'unsupported' | 'stable' | 'latest stable' | 'release candidate' | 'future';

/** Status of each listed version on `now`, computed from the snapshot's release and end dates. */
export function versionStatuses(now: Date): (VersionEntry & { computed: Status })[] {
  const data = versionsData().versions;
  const t = now.getTime();
  const out = data.map((v): VersionEntry & { computed: Status } => {
    let computed: Status;
    if (Date.parse(v.accessibleUntil) <= t) computed = 'unsupported';
    else if (Date.parse(`${v.released}T17:00:00Z`) > t) computed = 'future';
    else computed = 'stable';
    return { ...v, computed };
  });
  const stable = out.filter((v) => v.computed === 'stable');
  if (stable.length) stable[stable.length - 1].computed = 'latest stable';
  const firstFuture = out.find((v) => v.computed === 'future');
  if (firstFuture) firstFuture.computed = 'release candidate';
  return out;
}

export function latestStable(now: Date): string {
  const statuses = versionStatuses(now);
  return (
    statuses.find((v) => v.computed === 'latest stable')?.version ??
    statuses[statuses.length - 1].version
  );
}

function oldestAccessible(now: Date): string | undefined {
  return versionStatuses(now).find((v) => v.computed === 'stable' || v.computed === 'latest stable')
    ?.version;
}

const day = (iso: string) => iso.slice(0, 10);
const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86_400_000);

function createApiVersionsTool(network: NetworkOptions, now: () => Date): AgentTool {
  return defineTool({
    name: 'shopify_api_versions',
    description:
      'Shopify Admin API version info: which versions are supported, latest stable, release candidate and unsupported, with release and end-of-access dates, what happens to a pinned version that falls out of support (it falls forward), and dated platform deadlines (REST legacy, Scripts, checkout.liquid, expiring tokens). Pass a version like "2025-07" to get its status and next steps.',
    inputSchema: {
      type: 'object',
      properties: {
        version: {
          type: 'string',
          description: 'Optional Admin API version, e.g. "2025-10", "2026-04" or "unstable".',
        },
        live: {
          type: 'boolean',
          description:
            'Also probe whether the version is accessible right now via shopify.dev (default true when online).',
        },
      },
    },
    run: async (input) => {
      const data = versionsData();
      const today = now();
      const statuses = versionStatuses(today);
      const raw = str(input, 'version') ?? str(input, 'query');
      const version = raw?.replace(/^v/i, '').replace('_', '-');
      const lines: string[] = [];
      const table = statuses.map(
        (v) =>
          `- ${v.version}: ${v.computed}; released ${v.released}, accessible until ${day(v.accessibleUntil)}${v.computed !== v.status ? ` (snapshot listed it as ${v.status})` : ''}`,
      );
      const footer = [
        '',
        `Cadence: ${data.cadence.summary} ${data.cadence.support}`,
        `Fall forward: ${data.fallForward.summary}`,
        `Sources: ${data.source.join(', ')} (snapshot ${data.retrieved}; statuses computed for ${day(today.toISOString())}). Check the versioning page for changes since the snapshot.`,
      ];

      if (!version) {
        lines.push(
          `Shopify Admin API versions (computed for ${day(today.toISOString())}):`,
          ...table,
        );
        lines.push('', 'Dated platform deadlines:');
        for (const d of data.deadlines) {
          lines.push(
            `- ${d.date}: ${d.title}${d.confidence ? ` [${d.confidence}]` : ''} (${d.source})`,
          );
        }
        return [...lines, ...footer].join('\n');
      }

      if (version.toLowerCase() === 'unstable') {
        lines.push(
          `"unstable": ${data.cadence.types.unstable} Don't pin production code to it; pin the latest stable (${latestStable(today)}) instead.`,
          '',
          'Versions:',
          ...table,
        );
        return [...lines, ...footer].join('\n');
      }

      const match = VERSION_RE.exec(version);
      if (!match) {
        lines.push(
          `"${raw}" doesn't look like a Shopify API version. Versions are dated YYYY-MM with MM in 01, 04, 07 or 10 (e.g. ${latestStable(today)}), or "unstable". Look for the version in the request URL (/admin/api/<version>/graphql.json), apiVersion / ApiVersion in the SDK config, or api_version in shopify.app.toml.`,
          '',
          'Versions:',
          ...table,
        );
        return [...lines, ...footer].join('\n');
      }

      const entry = statuses.find((v) => v.version === version);
      const latest = latestStable(today);
      const oldest = oldestAccessible(today);
      if (!['01', '04', '07', '10'].includes(match[2])) {
        lines.push(
          `${version} is not a release month: Shopify ships versions in January, April, July and October. A request with this version is probably rejected or treated as unsupported; use ${latest}.`,
        );
      } else if (entry) {
        lines.push(
          `${version}: ${entry.computed}. Released ${entry.released}; accessible until ${day(entry.accessibleUntil)} 15:00 UTC.`,
        );
        const left = daysBetween(today, new Date(entry.accessibleUntil));
        if (entry.computed === 'unsupported') {
          lines.push(
            `It is no longer accessible. Requests pinned to it fall forward to the oldest accessible stable version${oldest ? ` (${oldest} today)` : ''}, so the app already runs on newer behaviour it was never tested against. Check the X-Shopify-API-Version response header to confirm.`,
          );
        } else if (entry.computed === 'release candidate' || entry.computed === 'future') {
          lines.push(
            `It is not released yet (${data.cadence.types['release candidate']}). Use ${latest} in production.`,
          );
        } else if (left <= 120) {
          lines.push(
            `About ${left} days of access left. Plan the upgrade now; after that date requests fall forward to the oldest accessible stable version.`,
          );
        } else {
          lines.push(`About ${left} days of access left.`);
        }
        if (entry.highlights)
          lines.push(`Release notes summary for ${version}: ${entry.highlights}`);
      } else {
        const earliest = statuses[0];
        if (version < earliest.version) {
          lines.push(
            `${version} is older than every version in the snapshot (earliest ${earliest.version}, which is itself ${earliest.computed}). Each version is supported for about 12 months, so ${version} is long unsupported: requests fall forward to the oldest accessible stable version${oldest ? ` (${oldest} today)` : ''}.`,
          );
        } else {
          lines.push(
            `${version} is newer than the snapshot's versions. It may be a future release; check https://shopify.dev/docs/api/usage/versioning.`,
          );
        }
      }

      // Versions between the pinned one and the latest stable: release notes to read.
      const between = statuses.filter(
        (v) => v.version > version && v.version <= latest && v.notesUrl,
      );
      if (between.length && version < latest) {
        lines.push(
          '',
          `Moving from ${version} to ${latest}: read the release notes of every version in between (breaking changes accumulate):`,
        );
        for (const v of between)
          lines.push(`- ${v.version}: ${v.notesUrl}${v.highlights ? ` - ${v.highlights}` : ''}`);
        lines.push(
          `- Developer changelog filtered by "Action required": https://shopify.dev/changelog`,
        );
      }

      const live = bool(input, 'live') ?? true;
      if (live && resolveFetch(network)) {
        const probe = await fetchText(`${PROXY}/${version}`, {
          ...network,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: '{ __typename }' }),
        });
        if (probe.ok)
          lines.push(
            '',
            `Live check: shopify.dev accepted a request for ${version} just now, so it is currently accessible.`,
          );
        else if (probe.error === 'HTTP 400')
          lines.push(
            '',
            `Live check: shopify.dev rejected ${version} as an invalid API version just now, so it is not accessible (or not released).`,
          );
        else lines.push('', `Live check failed (${probe.error}); relying on the snapshot.`);
      }

      lines.push(
        '',
        'Next steps: find every place the version is pinned (REST/GraphQL URLs, SDK apiVersion/ApiVersion config, shopify.app.toml [webhooks] api_version, extension TOML api_version), bump them together, then validate GraphQL documents against the new version with shopify_validate_graphql and read the playbook for api-version.',
        '',
        'All versions:',
        ...table,
      );
      return [...lines, ...footer].join('\n');
    },
  });
}

// ---------------------------------------------------------------------------
// GraphQL validation

const INTROSPECTION_QUERY =
  'query { __schema { queryType { name } mutationType { name } subscriptionType { name } types { kind name fields(includeDeprecated: true) { name isDeprecated deprecationReason args(includeDeprecated: true) { name type { ...T } defaultValue isDeprecated deprecationReason } type { ...T } } inputFields(includeDeprecated: true) { name type { ...T } defaultValue isDeprecated deprecationReason } enumValues(includeDeprecated: true) { name } possibleTypes { name } interfaces { name } } } } fragment T on __Type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } }';

type Snapshot = { version: string; retrieved: string; schema: ReducedSchema };

let snapshotsCache: Snapshot[] | undefined;
export function offlineSnapshots(): Snapshot[] {
  if (snapshotsCache) return snapshotsCache;
  const dir = fileURLToPath(DATA_DIR);
  snapshotsCache = readdirSync(dir)
    .filter((f) => /^admin-schema-\d{4}-\d{2}\.json$/.test(f))
    .map((f) => {
      const json = readData<Record<string, unknown>>(f);
      return {
        version: String(json.version),
        retrieved: String(json.retrieved),
        schema: expandCompactSchema(json),
      };
    })
    .sort((a, b) => (a.version < b.version ? 1 : -1));
  return snapshotsCache;
}

type ResolvedSchema = { schema: ReducedSchema; label: string; notes: string[] };

async function liveSchema(
  version: string,
  network: NetworkOptions,
  cacheDir: string | null,
  now: Date,
): Promise<ResolvedSchema | { error: string }> {
  const cacheFile = cacheDir
    ? join(cacheDir, `aptitude-shopify-admin-schema-${version}.json`)
    : undefined;
  if (cacheFile && existsSync(cacheFile)) {
    try {
      const age = now.getTime() - statSync(cacheFile).mtimeMs;
      if (age < CACHE_TTL_MS) {
        const schema = JSON.parse(readFileSync(cacheFile, 'utf8')) as ReducedSchema;
        return {
          schema,
          label: `live introspection of ${version} cached at ${statSync(cacheFile).mtime.toISOString().slice(0, 10)} (${cacheFile})`,
          notes: [],
        };
      }
    } catch {
      // A broken cache file is ignored and refetched.
    }
  }
  if (!resolveFetch(network)) return { error: 'offline' };
  const result = await fetchText(`${PROXY}/${version}`, {
    ...network,
    timeoutMs: network.timeoutMs ?? 30_000,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: INTROSPECTION_QUERY }),
  });
  if (!result.ok) return { error: result.error };
  let schema: ReducedSchema;
  try {
    schema = reduceIntrospection(JSON.parse(result.text));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const notes: string[] = [];
  if (cacheFile) {
    try {
      mkdirSync(cacheDir!, { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(schema));
    } catch (error) {
      notes.push(
        `Could not cache the schema (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  }
  return {
    schema,
    label: `live introspection of ${version} from ${PROXY}/${version} (fetched now)`,
    notes,
  };
}

function schemaFromPath(path: string, repoDir: string): ResolvedSchema | { error: string } {
  const base = resolve(repoDir || '.');
  const full = isAbsolute(path) ? resolve(path) : resolve(base, path);
  const rel = relative(base, full);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return {
      error: `schemaPath ${path} is outside the repository (${base}); only files inside it are read`,
    };
  }
  if (!existsSync(full)) return { error: `schemaPath ${rel} does not exist` };
  try {
    return {
      schema: schemaFromText(readFileSync(full, 'utf8')),
      label: `schema file ${rel}`,
      notes: [],
    };
  } catch (error) {
    return {
      error: `could not read schemaPath ${rel}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function createValidateTool(
  network: NetworkOptions,
  cacheDir: string | null,
  now: () => Date,
): AgentTool {
  return defineTool({
    name: 'shopify_validate_graphql',
    description:
      'Check a Shopify Admin GraphQL document (query or mutation, with fragments, variables, aliases and inline fragments) against the schema of an Admin API version. Reports syntax errors with line/column, unknown fields and arguments with "did you mean" suggestions, fields removed since an older version, deprecated fields with the deprecation reason, missing required arguments and unknown fragment types. Uses live introspection when online (cached), a schema file from the repo if you pass schemaPath, or an offline excerpt. Informational only.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The GraphQL document text (strip JS template interpolations first).',
        },
        version: {
          type: 'string',
          description: 'Admin API version, e.g. "2026-10". Defaults to the latest stable.',
        },
        variables: {
          type: 'object',
          description: 'Optional variables you plan to send, to spot missing required ones.',
        },
        schemaPath: {
          type: 'string',
          description:
            'Optional introspection JSON or SDL file in the repo (relative to the repo root) to validate against instead.',
        },
        live: {
          type: 'boolean',
          description: 'Fetch the live schema for the version when online (default true).',
        },
      },
      required: ['query'],
    },
    run: async (input, context) => {
      const query = str(input, 'query') ?? str(input, 'document') ?? str(input, 'graphql');
      if (!query)
        return 'Pass the GraphQL document as "query" (and optionally "version", "variables", "schemaPath").';
      const today = now();
      const requested = str(input, 'version')?.replace(/^v/i, '');
      const version =
        requested && (VERSION_RE.test(requested) || requested === 'unstable')
          ? requested
          : latestStable(today);
      const notes: string[] = [];
      if (requested && requested !== version) {
        notes.push(`"${requested}" is not a valid version string; used ${version}.`);
      }

      let resolved: ResolvedSchema | undefined;
      const schemaPath = str(input, 'schemaPath');
      if (schemaPath) {
        const fromFile = schemaFromPath(schemaPath, context.repoDir);
        if ('error' in fromFile) notes.push(`${fromFile.error}; falling back.`);
        else resolved = fromFile;
      }
      const snapshots = offlineSnapshots();
      if (!resolved && (bool(input, 'live') ?? true)) {
        const live = await liveSchema(version, network, cacheDir, today);
        if ('error' in live) {
          if (live.error !== 'offline')
            notes.push(
              `Live schema for ${version} unavailable (${live.error}); using the offline excerpt.`,
            );
        } else {
          resolved = live;
          notes.push(...live.notes);
        }
      }
      if (!resolved) {
        const exact = snapshots.find((s) => s.version === version);
        const chosen = exact ?? snapshots[0];
        resolved = {
          schema: chosen.schema,
          label: `offline excerpt of ${chosen.version} (snapshot ${chosen.retrieved}; covers products, variants, options, media, collections, orders, line items, customers, metafields, inventory, locations, fulfillments and shop)`,
          notes: [],
        };
        if (!exact) {
          notes.push(
            `No offline excerpt for ${version}; checked against ${chosen.version} instead, so results are approximate. Run online for the exact schema.`,
          );
        }
      }
      const history = snapshots
        .filter((s) => s.version < version && s.schema !== resolved!.schema)
        .map((s) => ({ label: `${s.version} (offline excerpt)`, schema: s.schema }));

      const variables = obj(input, 'variables');
      const result = validateDocument(query, resolved.schema, { variables, history });
      const errors = result.issues.filter((i) => i.severity === 'error').length;
      const warnings = result.issues.filter((i) => i.severity === 'warning').length;
      const infos = result.issues.filter((i) => i.severity === 'info').length;
      const ops = (result.document?.definitions ?? [])
        .filter((d) => d.kind === 'Operation')
        .map((d) =>
          'name' in d && d.name ? d.name : `(anonymous ${'operation' in d ? d.operation : ''})`,
        );

      const lines = [
        `Checked ${ops.length ? ops.join(', ') : 'the document'} against Shopify Admin API ${version} using ${resolved.label}.`,
        `Result: ${errors} error(s), ${warnings} warning(s), ${infos} note(s); ${result.checkedFields} field(s) checked.`,
      ];
      if (result.issues.length) lines.push('', ...formatIssues(result.issues).map((l) => `- ${l}`));
      else lines.push('', 'No problems found in the checked fields.');
      if (notes.length) lines.push('', ...notes.map((n) => `Note: ${n}`));
      if (result.issues.some((i) => /\$\{/.test(i.message)) || /\$\{/.test(query)) {
        lines.push(
          'Note: the document contains ${...} template interpolation; inline the fragments or values and check again.',
        );
      }
      lines.push(
        '',
        `This is a static check: it doesn't run the query, check access scopes, query cost or runtime userErrors. Reference: https://shopify.dev/docs/api/admin-graphql/${version}. For a field that was removed or renamed, search its name with shopify_search_docs or the changelog (https://shopify.dev/changelog).`,
      );
      return lines.join('\n');
    },
  });
}

// ---------------------------------------------------------------------------
// REST -> GraphQL mapping

type RestEndpoint = { method: string; path: string; graphql: string[] };
type RestResource = {
  resource: string;
  aliases?: string[];
  graphqlType: string;
  docs: string;
  deprecation?: string;
  endpoints: RestEndpoint[];
  fields?: { rest: string; graphql: string; note?: string }[];
  notes?: string[];
  source: string;
};
type RestData = {
  source: string[];
  retrieved: string;
  general: { text: string; source: string }[];
  resources: RestResource[];
};

let restCache: RestData | undefined;
function restData(): RestData {
  restCache ??= readData<RestData>('rest-to-graphql.json');
  return restCache;
}

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];

/** Normalize a REST path: drop host, query, /admin/api/<version>/, .json; ids become {id}. */
export function normalizeRestPath(raw: string): { segments: string[]; ids: string[] } {
  let path = raw.trim().replace(/^[a-z]+:\/\/[^/]+/i, '');
  path = path.replace(/[?#].*$/, '');
  path = path.replace(/^\/?admin\/api\/[^/]+\//i, '/').replace(/^\/?admin\//i, '/');
  path = path.replace(/\.json$/i, '');
  const ids: string[] = [];
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((s) => {
      if (/^\d+$/.test(s)) {
        ids.push(s);
        return '{id}';
      }
      if (/^\{owner\}$/.test(s)) return '*';
      if (/^(\{[^}]*\}|:[a-z_]+|<[^>]+>|\$\{[^}]*\})$/i.test(s)) return '{id}';
      return s.toLowerCase();
    });
  return { segments, ids };
}

function pathMatches(input: string[], template: string[]): boolean {
  if (input.length !== template.length) return false;
  return template.every(
    (seg, i) => seg === '*' || seg === input[i] || (seg === '{id}' && input[i] === '{id}'),
  );
}

function formatResource(r: RestResource, endpoints: RestEndpoint[], ids: string[]): string[] {
  const lines = [`Resource: ${r.resource} -> GraphQL type ${r.graphqlType}`];
  if (r.deprecation) lines.push(`REST status: ${r.deprecation}`);
  lines.push('Endpoint mapping (as listed on the REST reference):');
  for (const e of endpoints) {
    lines.push(
      `- ${e.method} ${e.path} -> ${e.graphql.length ? e.graphql.join(', ') : 'no GraphQL equivalent listed; check the GraphQL reference'}`,
    );
  }
  if (r.fields?.length) {
    lines.push('Field differences:');
    for (const f of r.fields)
      lines.push(`- ${f.rest} -> ${f.graphql}${f.note ? ` (${f.note})` : ''}`);
  }
  if (r.notes?.length) lines.push('Notes:', ...r.notes.map((n) => `- ${n}`));
  const singleType = /^[A-Z][A-Za-z]+$/.test(r.graphqlType) ? r.graphqlType : undefined;
  if (ids.length && singleType) {
    lines.push(
      `ID: ${ids[ids.length - 1]} becomes gid://shopify/${singleType}/${ids[ids.length - 1]} (if the id in the path belongs to ${singleType}; parent ids map to their own types, e.g. gid://shopify/Product/<id>).`,
    );
  }
  const getOne = endpoints.find(
    (e) =>
      e.method === 'GET' &&
      e.path.includes('}.json') &&
      /^[a-z][A-Za-z]+$/.test(e.graphql[0] ?? ''),
  );
  if (getOne && singleType) {
    const gid = `gid://shopify/${singleType}/${ids[ids.length - 1] ?? '123'}`;
    lines.push(
      `Example: query { ${getOne.graphql[0]}(id: "${gid}") { id } } - check it with shopify_validate_graphql.`,
    );
  }
  lines.push(`Docs: ${r.docs}`);
  return lines;
}

function createRestToGraphqlTool(): AgentTool {
  return defineTool({
    name: 'shopify_rest_to_graphql',
    description:
      'Look up the GraphQL Admin API equivalent of a Shopify REST Admin endpoint or resource, e.g. "GET /admin/api/2024-01/products/{id}.json", a full URL, or a resource name like "variants". Returns the replacement queries/mutations, field mapping differences (variants, options, images -> media, inventory moved to InventoryLevel, GIDs), REST deprecation status and docs links.',
    inputSchema: {
      type: 'object',
      properties: {
        endpoint: {
          type: 'string',
          description:
            'REST method and path or URL, e.g. "PUT /admin/api/2024-01/variants/123.json", or a resource name.',
        },
        method: { type: 'string', description: 'Optional HTTP method if not in endpoint.' },
      },
      required: ['endpoint'],
    },
    run: async (input) => {
      const raw = str(input, 'endpoint') ?? str(input, 'query') ?? str(input, 'resource');
      if (!raw)
        return 'Pass a REST endpoint (e.g. "GET /admin/api/2024-01/products/{id}.json") or a resource name as "endpoint".';
      const data = restData();
      let method = str(input, 'method')?.toUpperCase();
      let rest = raw;
      const methodMatch = /^(GET|POST|PUT|DELETE|PATCH)\s+(.+)$/i.exec(raw);
      if (methodMatch) {
        method = methodMatch[1].toUpperCase();
        rest = methodMatch[2];
      }
      if (method && !METHODS.includes(method)) method = undefined;
      const general = [
        '',
        'Across all resources:',
        ...data.general.map((g) => `- ${g.text} (${g.source})`),
        '',
        `Snapshot ${data.retrieved} from the REST reference pages (${data.source[0]}). Validate any GraphQL you write with shopify_validate_graphql, and use shopify_search_docs for details.`,
      ];

      const looksLikePath = /[/.]/.test(rest);
      const lines: string[] = [];
      if (looksLikePath) {
        const { segments, ids } = normalizeRestPath(rest);
        const hits: { resource: RestResource; endpoints: RestEndpoint[] }[] = [];
        for (const r of data.resources) {
          const matched = r.endpoints.filter((e) =>
            pathMatches(segments, normalizeRestPath(e.path).segments),
          );
          if (matched.length) hits.push({ resource: r, endpoints: matched });
        }
        if (hits.length) {
          const normalized = `/${segments.join('/')}`;
          lines.push(`REST ${method ?? '(any method)'} ${normalized}`);
          for (const hit of hits) {
            const byMethod = method
              ? hit.endpoints.filter((e) => e.method === method)
              : hit.endpoints;
            if (method && !byMethod.length) {
              lines.push(
                `No ${method} on this path in the snapshot; the path is listed with: ${hit.endpoints.map((e) => e.method).join(', ')}.`,
              );
            }
            lines.push(
              '',
              ...formatResource(hit.resource, byMethod.length ? byMethod : hit.endpoints, ids),
            );
            const others = hit.resource.endpoints.filter((e) => !hit.endpoints.includes(e));
            if (others.length)
              lines.push(
                `Other ${hit.resource.resource} endpoints: ${others.map((e) => `${e.method} ${e.path} -> ${e.graphql.join(', ') || 'none listed'}`).join('; ')}`,
              );
          }
          return [...lines, ...general].join('\n');
        }
        // No exact path: fall back to the first non-id segment as a resource name.
        const words = segments.filter((s) => s !== '{id}' && s !== 'count');
        lines.push(
          `No exact match for ${method ? `${method} ` : ''}/${segments.join('/')} in the snapshot; closest resources by name:`,
        );
        rest = words.join(' ');
      }

      const resourceText = (r: RestResource) =>
        `${r.resource.replace(/_/g, ' ')} ${(r.aliases ?? []).join(' ')} ${r.graphqlType}`.toLowerCase();
      // Snap misspelled words ("fulfilment", "varients") to the closest known resource word.
      const vocabulary = new Set(data.resources.flatMap((r) => resourceText(r).split(/[^a-z]+/)));
      const query = rest
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
        .map((w) => (vocabulary.has(w) ? w : (closest(w, vocabulary, 1)[0] ?? w)))
        .join(' ');
      const ranked = rank(query, data.resources, resourceText);
      let picks = ranked.slice(0, 2).map((x) => x.item);
      if (!picks.length) {
        const names = data.resources.flatMap((r) => [r.resource, ...(r.aliases ?? [])]);
        const near = closest(query.replace(/\s+/g, '_'), names, 2);
        picks = data.resources.filter((r) =>
          near.some((n) => n === r.resource || r.aliases?.includes(n)),
        );
      }
      if (!picks.length) {
        lines.push(
          `"${raw}" is not in the snapshot. Open the REST reference (https://shopify.dev/docs/api/admin-rest) for that resource: each endpoint links its GraphQL equivalent. Known resources: ${data.resources.map((r) => r.resource).join(', ')}.`,
        );
        return [...lines, ...general].join('\n');
      }
      for (const r of picks) {
        const endpoints = method ? r.endpoints.filter((e) => e.method === method) : r.endpoints;
        lines.push('', ...formatResource(r, endpoints.length ? endpoints : r.endpoints, []));
      }
      return [...lines, ...general].join('\n');
    },
  });
}

// ---------------------------------------------------------------------------

export function createToolPack(options?: ShopifyToolPackOptions): ToolPack {
  const network: NetworkOptions = {};
  if (options?.fetch !== undefined) network.fetch = options.fetch;
  if (options?.timeoutMs !== undefined) network.timeoutMs = options.timeoutMs;
  const cacheDir = options?.schemaCacheDir === undefined ? tmpdir() : options.schemaCacheDir;
  const now = options?.now ?? (() => new Date());
  const tools = [
    createValidateTool(network, cacheDir, now),
    createRestToGraphqlTool(),
    createApiVersionsTool(network, now),
  ];
  return assembleToolPack({
    provider: 'shopify',
    tools,
    playbooksDir: new URL('./playbooks/', import.meta.url),
    options,
  });
}

export const toolPack: ToolPack = createToolPack();
