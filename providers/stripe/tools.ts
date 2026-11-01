// Stripe ToolPack: API version info, request-param checks against the OpenAPI spec, webhook event
// lookup, and docs search. Every tool returns information for the agent; none of them blocks or decides.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

export type StripeToolPackOptions = ToolPackOptions & {
  /** Where live OpenAPI specs are cached. Defaults to os.tmpdir()/aptitude-stripe-openapi. `null` disables disk caching. */
  specCacheDir?: string | null;
};

// ---------------------------------------------------------------------------------------------
// Snapshot data

type BreakingEntry = { title: string; url: string; products: string; category?: string };

export type VersionEntry = {
  version: string;
  date: string;
  release?: string;
  kind: 'major' | 'monthly' | 'legacy';
  breaking: BreakingEntry[];
  breakingCount: number;
  nonBreakingCount: number;
  changelogUrl: string;
};

type SdkMajor = {
  major: number;
  released: string;
  apiVersionAtRelease: string | null;
  latestApiVersionInMajor?: string;
  lastRelease: string;
  lastReleaseDate: string;
};

type SdkLibrary = {
  repo: string;
  package: string;
  pinsApiVersionSince: string;
  source: string;
  majors: SdkMajor[];
};

type TagEntry = {
  apiVersion: string;
  lastTag: string | null;
  lastTagDate?: string;
  specInfoVersion?: string;
  verified?: boolean;
  note?: string;
};

export type ApiVersionsData = {
  retrieved: string;
  source: string[];
  note: string;
  currentVersion: string;
  releases: {
    name: string;
    firstVersion: string;
    date: string;
    changelogUrl: string;
    versions: string[];
  }[];
  versions: VersionEntry[];
  knownVersions: { source: string; values: string[] };
  sdks: { source: string; note: string; libraries: Record<string, SdkLibrary> };
  openapiTags: { source: string; note: string; versions: TagEntry[] };
};

export type ParamSpec = {
  type: string;
  required?: true;
  enum?: string[];
  /** Set when the enum was too long to keep; holds the original length. */
  enumTruncated?: number;
  /** The param also accepts "" (Stripe uses it to unset a value). */
  emptyAllowed?: true;
  deprecated?: true;
  /** Free-form object such as metadata: any keys allowed. */
  freeform?: true;
  /** Nested properties exist but are not kept at this depth. */
  deeper?: true;
  props?: Record<string, ParamSpec>;
};

export type OperationSpec = {
  operationId?: string;
  deprecated?: true;
  params: Record<string, ParamSpec>;
  pathParams: string[];
  responseObject?: string;
  expandable?: string[];
};

export type SpecExcerpt = {
  retrieved: string;
  source: string;
  specInfoVersion: string;
  note: string;
  operations: Record<string, OperationSpec>;
};

type EventsData = {
  retrieved: string;
  source: string[];
  note: string;
  events: { type: string; objects: string[] }[];
  specEnabledEvents: string[];
};

const dataCache = new Map<string, unknown>();

function loadData<T>(name: string): T | undefined {
  if (dataCache.has(name)) return dataCache.get(name) as T;
  try {
    const value = JSON.parse(
      readFileSync(new URL(`./tools-data/${name}`, import.meta.url), 'utf8'),
    ) as T;
    dataCache.set(name, value);
    return value;
  } catch {
    return undefined;
  }
}

export const loadApiVersions = (): ApiVersionsData | undefined =>
  loadData<ApiVersionsData>('api-versions.json');
/**
 * Compact on-disk form of a ParamSpec, so the excerpt stays small even when pretty-printed:
 * a leaf is a string "type[!] [flags] [= a,b,c]" ("!" = required); an object with properties is
 * { "$": "<leaf string>", child: ... }; "@d3" / "@d3!" points at a shared subtree in `defs`.
 */
export type EncodedParam = string | { [key: string]: EncodedParam };

export function encodeParam(spec: ParamSpec & { ref?: string }): EncodedParam {
  if (spec.ref) return `@${spec.ref}${spec.required ? '!' : ''}`;
  const flags = [
    spec.deprecated ? 'deprecated' : '',
    spec.emptyAllowed ? 'empty-ok' : '',
    spec.freeform ? 'freeform' : '',
    spec.deeper ? 'deeper' : '',
    spec.enumTruncated ? `enum#${spec.enumTruncated}` : '',
  ].filter(Boolean);
  const head = `${spec.type}${spec.required ? '!' : ''}${flags.length ? ` ${flags.join(' ')}` : ''}${
    spec.enum ? ` = ${spec.enum.join(',')}` : ''
  }`;
  if (!spec.props) return head;
  const out: { [key: string]: EncodedParam } = { $: head };
  for (const [name, child] of Object.entries(spec.props)) out[name] = encodeParam(child);
  return out;
}

export function decodeParam(
  encoded: EncodedParam,
  defs: Record<string, EncodedParam> = {},
): ParamSpec {
  if (typeof encoded === 'string' && encoded.startsWith('@')) {
    const required = encoded.endsWith('!');
    const id = encoded.slice(1).replace(/!$/, '');
    const base = defs[id] !== undefined ? decodeParam(defs[id], defs) : { type: 'any' };
    delete base.required;
    if (required) base.required = true;
    return base;
  }
  const head = typeof encoded === 'string' ? encoded : String(encoded.$ ?? 'any');
  const [left, enumPart] = head.split(' = ');
  const [typeToken, ...flags] = left.split(' ');
  const spec: ParamSpec = { type: typeToken.replace(/!$/, '') };
  if (typeToken.endsWith('!')) spec.required = true;
  for (const flag of flags) {
    if (flag === 'deprecated') spec.deprecated = true;
    else if (flag === 'empty-ok') spec.emptyAllowed = true;
    else if (flag === 'freeform') spec.freeform = true;
    else if (flag === 'deeper') spec.deeper = true;
    else if (flag.startsWith('enum#')) spec.enumTruncated = Number(flag.slice(5));
  }
  if (enumPart !== undefined) spec.enum = enumPart.split(',');
  if (typeof encoded !== 'string') {
    spec.props = {};
    for (const [name, child] of Object.entries(encoded)) {
      if (name !== '$') spec.props[name] = decodeParam(child, defs);
    }
  }
  return spec;
}

type RawExcerpt = Omit<SpecExcerpt, 'operations'> & {
  defs?: Record<string, EncodedParam>;
  operations: Record<
    string,
    Omit<OperationSpec, 'params'> & { params: Record<string, EncodedParam> }
  >;
};

export function expandExcerpt(raw: RawExcerpt): SpecExcerpt {
  const defs = raw.defs ?? {};
  const operations: Record<string, OperationSpec> = {};
  for (const [key, op] of Object.entries(raw.operations)) {
    operations[key] = {
      ...op,
      params: Object.fromEntries(
        Object.entries(op.params).map(([name, value]) => [name, decodeParam(value, defs)]),
      ),
    };
  }
  return {
    retrieved: raw.retrieved,
    source: raw.source,
    specInfoVersion: raw.specInfoVersion,
    note: raw.note,
    operations,
  };
}

let expandedExcerpt: SpecExcerpt | undefined;
export const loadSpecExcerpt = (): SpecExcerpt | undefined => {
  if (expandedExcerpt) return expandedExcerpt;
  const raw = loadData<RawExcerpt>('openapi-excerpt.json');
  expandedExcerpt = raw ? expandExcerpt(raw) : undefined;
  return expandedExcerpt;
};
const loadEvents = (): EventsData | undefined => loadData<EventsData>('events.json');

const CHANGELOG = 'https://docs.stripe.com/changelog';
const UPGRADES = 'https://docs.stripe.com/upgrades';
const VERSIONING = 'https://docs.stripe.com/api/versioning';
const API_REF = 'https://docs.stripe.com/api';

// ---------------------------------------------------------------------------------------------
// Versions

const VERSION_RE = /^(\d{4}-\d{2}-\d{2})(?:\.([a-z]+))?$/;

export type ResolvedVersion =
  | { status: 'found'; entry: VersionEntry; note?: string }
  | { status: 'known'; version: string; note: string }
  | { status: 'unknown'; input: string; note: string; nearest?: VersionEntry };

export function resolveVersion(input: string, data: ApiVersionsData): ResolvedVersion {
  const raw = input.trim().replace(/^v(?=\d)/, '');
  const lower = raw.toLowerCase();
  if (lower === 'latest' || lower === 'current') {
    return { status: 'found', entry: data.versions[data.versions.length - 1] };
  }
  const exact = data.versions.find((v) => v.version === raw);
  if (exact) return { status: 'found', entry: exact };
  const release = data.releases.find((r) => r.name === lower);
  if (release) {
    const entry = data.versions.find((v) => v.version === release.firstVersion);
    if (entry) {
      return {
        status: 'found',
        entry,
        note: `"${raw}" is a major release name; using its first (breaking) version ${entry.version}. Monthly versions in ${release.name}: ${release.versions.join(', ')}.`,
      };
    }
  }
  const match = VERSION_RE.exec(raw);
  if (match) {
    const sameDate = data.versions.find((v) => v.date === match[1]);
    if (sameDate) {
      const note =
        match[2] === 'preview'
          ? `${raw} is a public-preview track (not in this snapshot). Its GA sibling is ${sameDate.version}; preview versions can include preview-only breaking changes, see ${CHANGELOG}.`
          : match[2] && match[2] !== sameDate.release
            ? `"${raw}" has suffix .${match[2]} but the version released on ${match[1]} is ${sameDate.version}.`
            : undefined;
      return { status: 'found', entry: sameDate, note };
    }
    if (data.knownVersions.values.includes(raw)) {
      return {
        status: 'known',
        version: raw,
        note: `${raw} is a valid Stripe API version (it is in the OpenAPI api_version enum) but has no changelog entries in this snapshot. Check ${CHANGELOG}.`,
      };
    }
    const nearest = [...data.versions].reverse().find((v) => v.date <= match[1]);
    return {
      status: 'unknown',
      input: raw,
      nearest,
      note: `${raw} is not in the snapshot (retrieved ${data.retrieved}). It may be newer than the snapshot or mistyped; check ${CHANGELOG}.`,
    };
  }
  const suggestions = closest(raw, [
    ...data.versions.map((v) => v.version),
    ...data.releases.map((r) => r.name),
  ]);
  return {
    status: 'unknown',
    input: raw,
    note: `"${raw}" does not look like a Stripe API version (they look like 2024-06-20 or 2025-03-31.basil).${suggestions.length ? ` Did you mean ${suggestions.join(', ')}?` : ''}`,
  };
}

/** Versions after `from` up to and including `to` (by date). */
export function versionsBetween(data: ApiVersionsData, from: string, to: string): VersionEntry[] {
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return data.versions.filter((v) => v.date > lo.slice(0, 10) && v.date <= hi.slice(0, 10));
}

function sdkPinsFor(data: ApiVersionsData, version: string): string[] {
  const out: string[] = [];
  for (const [name, lib] of Object.entries(data.sdks.libraries)) {
    for (const m of lib.majors) {
      const lo = m.apiVersionAtRelease ?? '';
      const hi = m.latestApiVersionInMajor ?? lo;
      if (lo === version) out.push(`stripe-${name} v${m.major}.0.0 pins it`);
      else if (lo && lo < version && version <= hi) {
        out.push(`stripe-${name} v${m.major}.x (a minor release) pins it`);
      }
    }
  }
  return out;
}

function describeVersion(data: ApiVersionsData, entry: VersionEntry): string[] {
  const kindText =
    entry.kind === 'major'
      ? `first version of the ${entry.release} major release: it carries the breaking changes for ${entry.release}`
      : entry.kind === 'monthly'
        ? `monthly ${entry.release} release: no breaking changes by Stripe's release policy (${VERSIONING})`
        : 'pre-acacia dated version: every version before 2024-09-30.acacia could contain breaking changes';
  const lines = [
    `${entry.version} — released ${entry.date}; ${kindText}.`,
    `Changelog: ${entry.changelogUrl} (${entry.breakingCount} breaking, ${entry.nonBreakingCount} non-breaking entries in the snapshot).`,
  ];
  const pins = sdkPinsFor(data, entry.version);
  if (pins.length) lines.push(`SDK pins: ${pins.join('; ')}.`);
  return lines;
}

function formatBreaking(entries: { v: VersionEntry; e: BreakingEntry }[], max: number): string[] {
  const lines = entries
    .slice(0, max)
    .map(
      ({ v, e }) =>
        `- [${v.version}] ${e.title} (${e.products}${e.category ? `, ${e.category}` : ''}) ${e.url}`,
    );
  if (entries.length > max) {
    lines.push(
      `- ... ${entries.length - max} more. Narrow with "query" (e.g. "checkout", "subscription") or read ${CHANGELOG}.`,
    );
  }
  return lines;
}

function parseSdk(input: string): { lib?: string; major?: number } {
  const m =
    /(?:stripe[-_ ]?)?(node|python|ruby|go|java|php|dotnet|\.net|net)(?:[@ v]*(\d+))?/i.exec(input);
  if (!m) return {};
  let lib = m[1].toLowerCase();
  if (lib === '.net' || lib === 'net') lib = 'dotnet';
  return { lib, major: m[2] ? Number(m[2]) : undefined };
}

function sdkReport(data: ApiVersionsData, input: string): string[] {
  const { lib, major } = parseSdk(input);
  const libs = data.sdks.libraries;
  if (!lib || !libs[lib]) {
    return [
      `SDK "${input}" not recognised. Known: ${Object.keys(libs)
        .map((l) => `stripe-${l}`)
        .join(', ')}.`,
    ];
  }
  const info = libs[lib];
  const lines = [
    `stripe-${lib} (${info.package}) — pins an API version since ${info.pinsApiVersionSince}. Source: ${info.source}`,
  ];
  const rows =
    major !== undefined ? info.majors.filter((m) => m.major === major) : info.majors.slice(-8);
  if (major !== undefined && rows.length === 0) {
    const known = info.majors.map((m) => m.major);
    lines.push(
      `v${major} is not in the snapshot table (majors from 2022-08 on: ${known.join(', ')}). Check ${info.source} or ${info.repo}/wiki.`,
    );
  }
  for (const m of rows) {
    lines.push(
      `- v${m.major} (${m.released}): pins ${m.apiVersionAtRelease ?? 'unknown'}${
        m.latestApiVersionInMajor && m.latestApiVersionInMajor !== m.apiVersionAtRelease
          ? `; later minors move up to ${m.latestApiVersionInMajor}`
          : ''
      }; last release ${m.lastRelease} (${m.lastReleaseDate}).`,
    );
  }
  lines.push(
    `Migration guides per major live in ${info.repo}/wiki (see https://docs.stripe.com/sdks/versioning).`,
  );
  return lines;
}

export function apiVersionsReport(
  data: ApiVersionsData,
  input: { version?: string; target?: string; sdk?: string; query?: string; max?: number },
): string {
  const out: string[] = [];
  const max = input.max ?? 25;
  if (!input.version && !input.target && !input.sdk) {
    out.push(
      `Current Stripe API version in the snapshot: ${data.currentVersion} (retrieved ${data.retrieved}).`,
    );
    out.push(
      'Since 2024-09-30.acacia Stripe releases a non-breaking version every month and two major releases a year; the first version of each major release holds its breaking changes. Before acacia, any dated version could break.',
    );
    out.push('Major releases:');
    for (const r of data.releases) {
      const first = data.versions.find((v) => v.version === r.firstVersion);
      out.push(
        `- ${r.name}: starts ${r.firstVersion} (${first?.breakingCount ?? '?'} breaking entries); versions ${r.versions.join(', ')}. ${r.changelogUrl}`,
      );
    }
    out.push(
      `How the version is chosen: the Stripe-Version header per request; otherwise the SDK's pinned version (stripe-node v12+, stripe-python v6+, stripe-ruby v9+, stripe-php v11+, and always for Go/Java/.NET); otherwise the account default set in Workbench. Webhook endpoints render events at their own api_version (or the account default). ${VERSIONING} ${UPGRADES}`,
    );
    out.push(
      'Pass "version" (and optionally "target") for details and the breaking changes between them, or "sdk" (e.g. "stripe-node@17") for SDK pins.',
    );
    return out.join('\n');
  }

  let fromKey: string | undefined;
  if (input.version) {
    const r = resolveVersion(input.version, data);
    if (r.status === 'found') {
      fromKey = r.entry.version;
      if (r.note) out.push(r.note);
      out.push(...describeVersion(data, r.entry));
    } else if (r.status === 'known') {
      fromKey = r.version;
      out.push(r.note);
    } else {
      out.push(r.note);
      if (r.nearest) {
        out.push(`Nearest earlier version in the snapshot: ${r.nearest.version}.`);
        fromKey = r.nearest.version;
      }
    }
  }

  const targetInput = input.target;
  let toEntry: VersionEntry | undefined;
  if (targetInput) {
    const r = resolveVersion(targetInput, data);
    if (r.status === 'found') {
      toEntry = r.entry;
      if (r.note) out.push(r.note);
      if (!fromKey) out.push(...describeVersion(data, r.entry));
    } else {
      out.push(r.note);
    }
  }

  if (fromKey && (toEntry || targetInput === undefined)) {
    const to = toEntry?.version ?? data.currentVersion;
    if (fromKey === to) {
      out.push(`From and target are the same version (${to}); nothing to migrate.`);
    } else {
      const between = versionsBetween(data, fromKey, to);
      const downgrade = fromKey > to;
      let entries = between.flatMap((v) => v.breaking.map((e) => ({ v, e })));
      const majors = between.filter((v) => v.kind === 'major').map((v) => v.version);
      const legacy = between.filter((v) => v.kind === 'legacy').length;
      if (!toEntry) {
        out.push(
          `${fromKey} → current ${to}: ${entries.length} breaking entries across ${between.length} versions (${majors.length} major release start(s)${legacy ? `, ${legacy} legacy dated versions` : ''}). Pass "target" to pick another version.`,
        );
      } else {
        out.push(
          `${downgrade ? 'Downgrade' : 'Upgrade'} ${fromKey} → ${to}: ${entries.length} breaking entries across ${between.length} versions.${majors.length ? ` Major release starts crossed: ${majors.join(', ')}.` : ' No major release start is crossed, so by policy there should be no breaking changes.'}`,
        );
        if (downgrade) {
          out.push(
            'These are the changes you would be undoing; code written for the newer shape may break on the older version.',
          );
        }
      }
      if (input.query) {
        const ranked = rank(input.query, entries, ({ e }) => `${e.title} ${e.products}`);
        out.push(`Filtered by "${input.query}": ${ranked.length} of ${entries.length} entries.`);
        entries = ranked.map((r) => r.item);
      }
      if (entries.length) {
        out.push('Breaking changes (each link has the details and upgrade steps):');
        out.push(...formatBreaking(entries, max));
      }
    }
  }

  if (input.sdk) out.push(...sdkReport(data, input.sdk));

  const tag = fromKey ? data.openapiTags.versions.find((t) => t.apiVersion === fromKey) : undefined;
  if (tag?.lastTag) {
    out.push(
      `OpenAPI spec for ${fromKey}: github.com/stripe/openapi tag ${tag.lastTag} (${tag.lastTagDate}), openapi/spec3.json. stripe_check_params uses it when online.`,
    );
  }
  out.push(
    `Snapshot ${data.retrieved} from ${CHANGELOG}. Check the linked entries before relying on a summary; for webhooks also check each endpoint's api_version (${UPGRADES}).`,
  );
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// OpenAPI reduction (used live and by the offline excerpt generator)

type Schema = Record<string, unknown>;
type OpenApi = {
  info?: { version?: string };
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, Schema> };
};

const MAX_ENUM = 160;
const HTTP_METHODS = ['get', 'post', 'delete'];

function asSchema(value: unknown): Schema | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Schema)
    : undefined;
}

function deref(spec: OpenApi, schema: Schema | undefined): Schema | undefined {
  const ref = schema?.$ref;
  if (typeof ref === 'string' && ref.startsWith('#/components/schemas/')) {
    return spec.components?.schemas?.[ref.slice('#/components/schemas/'.length)];
  }
  return schema;
}

function isEmptyString(s: Schema): boolean {
  return Array.isArray(s.enum) && s.enum.length === 1 && s.enum[0] === '' && s.type === 'string';
}

export function reduceSchema(
  spec: OpenApi,
  input: Schema | undefined,
  depth: number,
  maxDepth = 2,
): ParamSpec {
  const schema = deref(spec, input) ?? {};
  const variants =
    Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)
      ? ((schema.anyOf ?? schema.oneOf) as unknown[]).map((v) => deref(spec, asSchema(v)) ?? {})
      : [schema];
  const real = variants.filter((v) => !isEmptyString(v));
  const out: ParamSpec = { type: '' };
  if (real.length < variants.length) out.emptyAllowed = true;
  const types = new Set<string>();
  const enums = new Set<string>();
  let enumComplete = true;
  for (const v of real) {
    let type = typeof v.type === 'string' ? v.type : v.properties ? 'object' : 'any';
    let target = v;
    if (type === 'array') {
      const items = deref(spec, asSchema(v.items)) ?? {};
      target = items;
      const itemType =
        typeof items.type === 'string' ? items.type : items.properties ? 'object' : 'any';
      type = `array<${itemType}>`;
    }
    types.add(type);
    if (Array.isArray(target.enum)) {
      for (const e of target.enum) if (typeof e === 'string' && e !== '') enums.add(e);
    } else if (target.type === 'string' || target.type === undefined) {
      enumComplete = false;
    }
    const props = asSchema(target.properties);
    if (props) {
      if (depth >= maxDepth) out.deeper = true;
      else {
        const required = new Set(
          Array.isArray(target.required) ? (target.required as string[]) : [],
        );
        out.props = out.props ?? {};
        for (const [name, child] of Object.entries(props)) {
          const reduced = reduceSchema(spec, asSchema(child), depth + 1, maxDepth);
          if (required.has(name)) reduced.required = true;
          out.props[name] = reduced;
        }
      }
    } else if (
      (target.type === 'object' || type === 'object') &&
      target.additionalProperties !== false
    ) {
      out.freeform = true;
    }
    if (v.deprecated === true || target.deprecated === true) out.deprecated = true;
  }
  if (schema.deprecated === true) out.deprecated = true;
  out.type = [...types].join('|') || 'any';
  // Only keep enums when every string-ish variant is an enum; otherwise free strings are allowed too.
  if (enums.size && enumComplete) {
    const list = [...enums];
    if (list.length > MAX_ENUM) out.enumTruncated = list.length;
    else out.enum = list;
  }
  if (out.props && out.freeform) delete out.freeform;
  return out;
}

export function reduceOperation(
  spec: OpenApi,
  path: string,
  method: string,
  maxDepth = 2,
): OperationSpec | undefined {
  const op = asSchema(spec.paths?.[path]?.[method.toLowerCase()]);
  if (!op) return undefined;
  const params: Record<string, ParamSpec> = {};
  const pathParams: string[] = [];
  for (const p of (Array.isArray(op.parameters) ? op.parameters : []) as Schema[]) {
    if (p.in === 'path' && typeof p.name === 'string') pathParams.push(p.name);
    if (p.in === 'query' && typeof p.name === 'string') {
      const reduced = reduceSchema(spec, asSchema(p.schema), 0, maxDepth);
      if (p.required === true) reduced.required = true;
      if (p.deprecated === true) reduced.deprecated = true;
      params[p.name] = reduced;
    }
  }
  const body = asSchema(
    asSchema(asSchema(asSchema(op.requestBody)?.content)?.['application/x-www-form-urlencoded'])
      ?.schema,
  );
  const bodySchema = deref(spec, body);
  if (bodySchema?.properties) {
    const required = new Set(
      Array.isArray(bodySchema.required) ? (bodySchema.required as string[]) : [],
    );
    for (const [name, child] of Object.entries(bodySchema.properties as Record<string, unknown>)) {
      const reduced = reduceSchema(spec, asSchema(child), 0, maxDepth);
      if (required.has(name)) reduced.required = true;
      params[name] = reduced;
    }
  }
  const result: OperationSpec = { params, pathParams };
  if (typeof op.operationId === 'string') result.operationId = op.operationId;
  if (op.deprecated === true) result.deprecated = true;
  const response = deref(
    spec,
    asSchema(
      asSchema(asSchema(asSchema(asSchema(op.responses)?.['200'])?.content)?.['application/json'])
        ?.schema,
    ),
  );
  let objectSchema = response;
  const responseVariants = response?.anyOf ?? response?.oneOf;
  if (Array.isArray(responseVariants)) {
    objectSchema = responseVariants
      .map((v) => deref(spec, asSchema(v)))
      .find((v) => v && typeof v['x-resourceId'] === 'string');
  }
  let isList = false;
  const dataItems = asSchema(asSchema(asSchema(response?.properties)?.data)?.items);
  if (dataItems) {
    objectSchema = deref(spec, dataItems);
    isList = true;
  }
  if (objectSchema) {
    const id = objectSchema['x-resourceId'];
    if (typeof id === 'string') result.responseObject = isList ? `list of ${id}` : id;
    const expandable = objectSchema['x-expandableFields'];
    if (Array.isArray(expandable) && expandable.length) {
      result.expandable = (expandable as string[]).map((f) => (isList ? `data.${f}` : f));
    }
  }
  return result;
}

export function listOperations(spec: OpenApi): string[] {
  const keys: string[] = [];
  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS)
      if (ops && method in ops) keys.push(`${method.toUpperCase()} ${path}`);
  }
  return keys;
}

/** Resource path prefixes kept in the offline excerpt (most used Stripe v1 operations). */
export const EXCERPT_PREFIXES = [
  'customers',
  'payment_intents',
  'setup_intents',
  'payment_methods',
  'charges',
  'refunds',
  'checkout/sessions',
  'subscriptions',
  'subscription_items',
  'invoices',
  'invoiceitems',
  'prices',
  'products',
  'coupons',
  'promotion_codes',
  'webhook_endpoints',
  'billing_portal/sessions',
  'accounts',
  'account_links',
  'transfers',
  'payouts',
  'balance_transactions',
  'events',
];

// ---------------------------------------------------------------------------------------------
// Operation resolution

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

type KeyShape = { key: string; method: string; segs: { lit?: string; param?: string }[] };

function shapeOf(key: string): KeyShape {
  const [method, path] = key.split(' ');
  const segs = path
    .split('/')
    .filter(Boolean)
    .slice(1)
    .map((s) => (s.startsWith('{') ? { param: s.slice(1, -1) } : { lit: s }));
  return { key, method, segs };
}

export function parseHttpOperation(input: string): { method: string; path: string } | undefined {
  const m = /^\s*(GET|POST|DELETE|PUT|PATCH)\s+(\S+)\s*$/i.exec(input);
  if (!m) return undefined;
  let path = m[2].replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  if (!path.startsWith('/')) path = `/${path}`;
  if (!/^\/v\d\//.test(path)) path = `/v1${path}`;
  return { method: m[1].toUpperCase(), path: path.replace(/\/$/, '') };
}

function matchHttp(method: string, path: string, keys: string[]): string | undefined {
  const parts = path.split('/').filter(Boolean).slice(1);
  let best: { key: string; literal: number } | undefined;
  for (const key of keys) {
    const shape = shapeOf(key);
    if (shape.method !== method || shape.segs.length !== parts.length) continue;
    if (key.split(' ')[1].split('/')[1] !== path.split('/')[1]) continue;
    let literal = 0;
    let ok = true;
    shape.segs.forEach((seg, i) => {
      if (seg.lit === undefined) return; // a path param matches any concrete id
      if (seg.lit === parts[i]) literal++;
      else ok = false;
    });
    if (ok && (!best || literal > best.literal)) best = { key, literal };
  }
  return best?.key;
}

const SDK_PREFIXES = new Set([
  'stripe',
  'client',
  'stripeclient',
  'v1',
  'self',
  'this',
  'api',
  'sdk',
]);
const METHOD_ALIASES: Record<string, string> = {
  new: 'create',
  get: 'retrieve',
  all: 'list',
  delete: 'del',
  remove: 'del',
  listautopaging: 'list',
  autopagingiterator: 'list',
};

/** Resolve an SDK-style operation (paymentIntents.create, stripe.Checkout.Session.create, $stripe->invoices->pay). */
export function matchSdkOperation(input: string, keys: string[]): string[] {
  const segments = input
    .replace(/\(.*?\)/g, '')
    .split(/->|::|\.|\s+/)
    .map((s) => s.replace(/^\$/, ''))
    .filter(Boolean);
  while (segments.length > 2 && SDK_PREFIXES.has(norm(segments[0]))) segments.shift();
  if (segments.length && SDK_PREFIXES.has(norm(segments[0])) && segments.length > 2)
    segments.shift();
  if (segments.length < 2) return [];
  const rawMethod = norm(segments[segments.length - 1]);
  const method = METHOD_ALIASES[rawMethod] ?? rawMethod;
  const resource = segments.slice(0, -1).map(norm);
  const last = resource[resource.length - 1];
  const variants = [
    resource,
    [...resource.slice(0, -1), `${last}s`],
    [...resource.slice(0, -1), `${last}es`],
  ];
  const shapes = keys.map(shapeOf);
  const out: string[] = [];
  for (const res of variants) {
    for (const shape of shapes) {
      const lits = shape.segs.map((s) => (s.lit !== undefined ? norm(s.lit) : '{}'));
      const startsWith = res.every((r, i) => lits[i] === r);
      if (!startsWith) continue;
      const rest = lits.slice(res.length);
      const restKey = rest.join('/');
      let ok = false;
      if (method === 'create') ok = shape.method === 'POST' && restKey === '';
      else if (method === 'update') ok = shape.method === 'POST' && restKey === '{}';
      else if (method === 'retrieve')
        ok = shape.method === 'GET' && (restKey === '{}' || restKey === '');
      else if (method === 'list') ok = shape.method === 'GET' && restKey === '';
      else if (method === 'del') ok = shape.method === 'DELETE' && restKey === '{}';
      else if (method === 'search') ok = shape.method === 'GET' && restKey === 'search';
      else ok = restKey === `{}/${method}` || restKey === method;
      if (ok && !out.includes(shape.key)) out.push(shape.key);
    }
    if (out.length) break;
  }
  // Prefer exact item/collection shapes: retrieve on a collection key only when no item key exists.
  if (method === 'retrieve' && out.length > 1) {
    const item = out.filter((k) => shapeOf(k).segs.at(-1)?.param !== undefined);
    if (item.length) return item;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Param checks

export type CheckReport = {
  unknown: { path: string; suggestions: string[] }[];
  deprecated: string[];
  missingRequired: string[];
  enumMismatch: { path: string; value: string; allowed: string[]; suggestions: string[] }[];
  typeNotes: string[];
  unchecked: string[];
  pathParams: string[];
  expandNotes: string[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function checkValue(name: string, value: unknown, spec: ParamSpec, report: CheckReport): void {
  if (spec.deprecated) report.deprecated.push(name);
  if (value === null || value === undefined) return;
  if (value === '' && spec.emptyAllowed) return;
  const isArrayType = spec.type.includes('array');
  const isObjectType = spec.type.includes('object') || spec.freeform || !!spec.props;
  if (Array.isArray(value)) {
    if (!isArrayType && !spec.type.includes('any')) {
      report.typeNotes.push(`${name}: got an array; the spec type is ${spec.type}.`);
      return;
    }
    value.forEach((item, i) => {
      if (isPlainObject(item) && spec.props) checkObject(`${name}[${i}]`, item, spec.props, report);
      else if (typeof item === 'string' && spec.enum && !spec.enum.includes(item)) {
        report.enumMismatch.push({
          path: `${name}[${i}]`,
          value: item,
          allowed: spec.enum,
          suggestions: closest(item, spec.enum),
        });
      }
    });
    return;
  }
  if (isPlainObject(value)) {
    if (spec.freeform) return;
    if (!isObjectType && !spec.type.includes('any')) {
      report.typeNotes.push(`${name}: got an object; the spec type is ${spec.type}.`);
      return;
    }
    if (spec.props) checkObject(name, value, spec.props, report);
    else if (spec.deeper)
      report.unchecked.push(`${name}.* (nested deeper than the spec excerpt keeps)`);
    return;
  }
  if (isObjectType && !spec.type.match(/string|integer|number|boolean|any/)) {
    report.typeNotes.push(`${name}: got a ${typeof value}; the spec expects ${spec.type}.`);
    return;
  }
  if (typeof value === 'string' && spec.enum && !spec.enum.includes(value)) {
    report.enumMismatch.push({
      path: name,
      value,
      allowed: spec.enum,
      suggestions: closest(value, spec.enum),
    });
  }
}

function checkObject(
  prefix: string,
  value: Record<string, unknown>,
  specs: Record<string, ParamSpec>,
  report: CheckReport,
): void {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const spec = specs[key];
    if (!spec) {
      report.unknown.push({ path, suggestions: closest(key, Object.keys(specs)) });
      continue;
    }
    checkValue(path, child, spec, report);
  }
  for (const [key, spec] of Object.entries(specs)) {
    if (spec.required && !(key in value))
      report.missingRequired.push(prefix ? `${prefix}.${key}` : key);
  }
}

export function checkParams(op: OperationSpec, params: Record<string, unknown>): CheckReport {
  const report: CheckReport = {
    unknown: [],
    deprecated: [],
    missingRequired: [],
    enumMismatch: [],
    typeNotes: [],
    unchecked: [],
    pathParams: [],
    expandNotes: [],
  };
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (op.pathParams.includes(key) || key === 'id') report.pathParams.push(key);
    else body[key] = value;
  }
  checkObject('', body, op.params, report);
  const expand = body.expand;
  if (Array.isArray(expand) && op.expandable) {
    const roots = new Set(op.expandable.map((f) => f.replace(/^data\./, '')));
    for (const item of expand) {
      if (typeof item !== 'string') continue;
      const stripped = item.replace(/^data\./, '');
      const root = stripped.split('.')[0];
      if (!roots.has(root)) {
        report.expandNotes.push(
          `expand "${item}": "${root}" is not in this response's x-expandableFields${closest(root, roots).length ? ` (did you mean ${closest(root, roots).join(', ')}?)` : ''}. Deeper paths are checked only at the first level.`,
        );
      }
    }
  }
  return report;
}

// ---------------------------------------------------------------------------------------------
// Live spec

const SPEC_RAW = 'https://raw.githubusercontent.com/stripe/openapi';
const specMemory = new Map<string, OpenApi>();

export function specUrl(ref: string): string {
  return `${SPEC_RAW}/${ref}/openapi/spec3.json`;
}

/** Pick the stripe/openapi ref (tag) whose openapi/spec3.json describes `version`, or master. */
export function specRefFor(
  data: ApiVersionsData | undefined,
  version?: string,
): { ref: string; note: string } {
  if (!data || !version) return { ref: 'master', note: 'latest spec (master)' };
  const resolved = resolveVersion(version, data);
  const key = resolved.status === 'found' ? resolved.entry.version : version;
  const tag = data.openapiTags.versions.find((t) => t.apiVersion === key);
  if (tag?.lastTag && key !== data.currentVersion) {
    return {
      ref: tag.lastTag,
      note: `tag ${tag.lastTag}, the last spec whose info.version was ${key}`,
    };
  }
  if (key < '2022-08-01') {
    return {
      ref: 'master',
      note: `no tag mapped for ${key} (table starts at 2022-08-01); using master`,
    };
  }
  return { ref: 'master', note: 'latest spec (master)' };
}

async function loadLiveSpec(
  ref: string,
  network: NetworkOptions,
  cacheDir: string | null,
): Promise<{ spec?: OpenApi; error?: string; from?: string }> {
  const memo = specMemory.get(ref);
  if (memo) return { spec: memo, from: 'memory' };
  const file = cacheDir ? join(cacheDir, `${ref.replace(/[^\w.-]/g, '_')}-spec3.json`) : undefined;
  if (file && existsSync(file)) {
    const fresh = ref !== 'master' || Date.now() - statSync(file).mtimeMs < 24 * 3600 * 1000;
    if (fresh) {
      try {
        const spec = JSON.parse(readFileSync(file, 'utf8')) as OpenApi;
        specMemory.set(ref, spec);
        return { spec, from: file };
      } catch {
        // Corrupt cache: fall through to a fresh fetch.
      }
    }
  }
  if (!resolveFetch(network)) return { error: 'offline' };
  const result = await fetchText(specUrl(ref), {
    ...network,
    timeoutMs: network.timeoutMs ?? 60_000,
  });
  if (!result.ok) return { error: result.error };
  let spec: OpenApi;
  try {
    spec = JSON.parse(result.text) as OpenApi;
  } catch {
    return { error: 'spec was not valid JSON' };
  }
  if (!spec.paths) return { error: 'spec has no paths' };
  specMemory.set(ref, spec);
  if (file && cacheDir) {
    try {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(file, result.text);
    } catch {
      // Cache is best effort.
    }
  }
  return { spec, from: specUrl(ref) };
}

export function clearSpecMemory(): void {
  specMemory.clear();
}

// ---------------------------------------------------------------------------------------------
// check_params report

function resourceWords(key: string): string {
  return key
    .split(' ')[1]
    .split('/')
    .filter((s) => s && !s.startsWith('{') && s !== 'v1')
    .join(' ')
    .replace(/_/g, ' ');
}

function apiRefLink(key: string): string {
  const shape = shapeOf(key);
  const lits = shape.segs.filter((s) => s.lit).map((s) => s.lit as string);
  const hasParam = shape.segs.some((s) => s.param);
  const base = `${API_REF}/${lits.slice(0, 2).join('/')}`;
  if (shape.method === 'POST' && !hasParam && lits.length <= 2) return `${base}/create`;
  if (shape.method === 'GET' && !hasParam && lits.length <= 2) return `${base}/list`;
  return base;
}

function removalHints(data: ApiVersionsData | undefined, name: string): string[] {
  if (!data) return [];
  const leaf =
    name
      .replace(/\[\d+\]/g, '')
      .split('.')
      .pop() ?? name;
  const phrase = leaf.replace(/_/g, ' ').toLowerCase();
  if (phrase.length < 4) return [];
  const hits: string[] = [];
  for (const v of data.versions) {
    for (const e of v.breaking) {
      const title = e.title.toLowerCase();
      if (title.includes(phrase) || title.includes(leaf.toLowerCase()))
        hits.push(`[${v.version}] ${e.title} ${e.url}`);
    }
  }
  return hits.slice(-3);
}

export type CheckInput = {
  operation?: string;
  method?: string;
  path?: string;
  params: Record<string, unknown>;
  apiVersion?: string;
  live?: boolean;
};

export async function checkParamsReport(
  input: CheckInput,
  network: NetworkOptions & { specCacheDir?: string | null },
): Promise<string> {
  const out: string[] = [];
  const data = loadApiVersions();
  const excerpt = loadSpecExcerpt();
  const opText =
    input.operation ?? (input.method && input.path ? `${input.method} ${input.path}` : input.path);
  if (!opText) {
    return 'Pass "operation" as "POST /v1/payment_intents" or an SDK call like "paymentIntents.create" (or "method" + "path"), plus "params".';
  }

  // Choose the spec: live (tag for the version, or master) when online, otherwise the excerpt.
  let source = '';
  let specVersion = excerpt?.specInfoVersion ?? 'unknown';
  let keys: string[] = excerpt ? Object.keys(excerpt.operations) : [];
  let getOp: (key: string) => OperationSpec | undefined = (key) => excerpt?.operations[key];
  let liveNote = '';
  const cacheDir =
    network.specCacheDir === undefined
      ? join(tmpdir(), 'aptitude-stripe-openapi')
      : network.specCacheDir;
  if (input.live !== false && resolveFetch(network)) {
    const { ref, note } = specRefFor(data, input.apiVersion);
    const live = await loadLiveSpec(ref, network, cacheDir);
    if (live.spec) {
      const spec = live.spec;
      keys = listOperations(spec);
      getOp = (key) => {
        const [method, path] = key.split(' ');
        return reduceOperation(spec, path, method, 3);
      };
      specVersion = spec.info?.version ?? 'unknown';
      source = `live stripe/openapi ${note}: ${specUrl(ref)} (info.version ${specVersion})`;
    } else {
      liveNote = `Live spec unavailable (${live.error}); using the offline excerpt.`;
    }
  }
  if (!source) {
    source = excerpt
      ? `offline excerpt of openapi/spec3.json (info.version ${excerpt.specInfoVersion}, retrieved ${excerpt.retrieved}; request params only, nested to depth 2)`
      : 'no spec available (offline and no excerpt)';
  }

  const http = parseHttpOperation(opText);
  let key: string | undefined;
  let candidates: string[] = [];
  if (http) key = matchHttp(http.method, http.path, keys);
  else {
    candidates = matchSdkOperation(opText, keys);
    key = candidates[0];
  }

  if (liveNote) out.push(liveNote);
  out.push(`Spec: ${source}.`);
  if (!key) {
    const pathGuess = http?.path ?? opText;
    const near = rank(pathGuess.replace(/[/_{}.]/g, ' '), keys, (k) =>
      k.replace(/[/_{}]/g, ' '),
    ).slice(0, 5);
    out.push(
      `Operation "${opText}" was not found in this spec${source.startsWith('offline') ? ' excerpt (it keeps ~23 common resources)' : ''}.`,
    );
    if (near.length) out.push(`Closest operations: ${near.map((n) => n.item).join(', ')}.`);
    out.push(
      `Check the API reference: ${API_REF}${source.startsWith('offline') ? ', or rerun online to use the full live spec' : ''}. It may also have been removed in a newer API version; stripe_api_versions with a "query" can search breaking changes.`,
    );
    return out.join('\n');
  }
  const op = getOp(key);
  if (!op) return [...out, `Could not read ${key} from the spec.`].join('\n');
  if (candidates.length > 1)
    out.push(`"${opText}" matched ${candidates.join(', ')}; checking ${key}.`);
  out.push(
    `Operation: ${key}${op.operationId ? ` (${op.operationId})` : ''}. Reference: ${apiRefLink(key)}`,
  );
  if (op.deprecated)
    out.push(
      'The spec marks this whole operation as deprecated. Look for its replacement in the API reference and changelog.',
    );

  const report = checkParams(op, input.params);
  const issues =
    report.unknown.length +
    report.deprecated.length +
    report.missingRequired.length +
    report.enumMismatch.length +
    report.typeNotes.length;
  if (report.unknown.length) {
    out.push('Unknown params (not in the spec for this operation):');
    for (const u of report.unknown) {
      const hints = removalHints(data, u.path);
      out.push(
        `- ${u.path}${u.suggestions.length ? ` — did you mean ${u.suggestions.join(', ')}?` : ''}${hints.length ? `\n  Changelog mentions: ${hints.join(' | ')}` : ''}`,
      );
    }
  }
  if (report.missingRequired.length)
    out.push(`Required params missing: ${report.missingRequired.join(', ')}.`);
  if (report.deprecated.length)
    out.push(`Deprecated in the spec: ${report.deprecated.join(', ')}.`);
  for (const m of report.enumMismatch) {
    const allowed =
      m.allowed.length > 25
        ? `${m.allowed.slice(0, 25).join(', ')}, ... (${m.allowed.length} values)`
        : m.allowed.join(', ');
    out.push(
      `Enum mismatch: ${m.path} = "${m.value}" is not one of [${allowed}]${m.suggestions.length ? `; closest: ${m.suggestions.join(', ')}` : ''}.`,
    );
  }
  for (const note of report.typeNotes) out.push(`Type note: ${note}`);
  if (report.pathParams.length)
    out.push(`Path params (not checked as body params): ${report.pathParams.join(', ')}.`);
  if (report.unchecked.length) out.push(`Not checked: ${report.unchecked.join('; ')}.`);
  if (!issues) out.push('No problems found against this spec for the params given.');
  for (const note of report.expandNotes) out.push(note);
  if (op.expandable?.length) {
    out.push(
      `Response: ${op.responseObject ?? 'object'}. Expandable fields (pass in expand[]): ${op.expandable.slice(0, 30).join(', ')}${op.expandable.length > 30 ? ', ...' : ''}. Unexpanded they are IDs; see https://docs.stripe.com/api/expanding_objects`,
    );
  }

  // Version context: the spec describes one API version; the caller may target another.
  if (data && input.apiVersion) {
    const r = resolveVersion(input.apiVersion, data);
    const target =
      r.status === 'found' ? r.entry.version : r.status === 'known' ? r.version : undefined;
    if (!target) out.push(r.status === 'unknown' ? r.note : '');
    else if (target.slice(0, 10) !== specVersion.slice(0, 10)) {
      const between = versionsBetween(data, target, specVersion);
      const entries = between.flatMap((v) => v.breaking.map((e) => ({ v, e })));
      const relevant = rank(
        resourceWords(key),
        entries,
        ({ e }) => `${e.title} ${e.products}`,
      ).slice(0, 8);
      out.push(
        `Version gap: you target ${target} but this spec describes ${specVersion}. Params ${target < specVersion ? 'removed or renamed since your version show up as unknown here, and params added later are accepted here but not by your version' : 'added after this spec are not known here'}. ${entries.length} breaking entries lie between them.`,
      );
      if (relevant.length) {
        out.push('Most relevant to this operation:');
        out.push(
          ...formatBreaking(
            relevant.map((r2) => r2.item),
            8,
          ),
        );
      }
    }
  } else if (!input.apiVersion) {
    out.push(
      `No apiVersion given: checked against ${specVersion}. Pass the version the code pins (Stripe-Version header or SDK pin) for a version-aware check.`,
    );
  }
  out.push(
    'This is a static check of names, required fields and simple enums; runtime rules (conditional requirements, account capabilities) are not covered. Confirm in the API reference or with a test-mode request.',
  );
  return out.filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------------------------
// Webhook events

export function webhookEventsReport(input: { type?: string; apiVersion?: string }): string {
  const data = loadEvents();
  if (!data) return 'Event snapshot missing. See https://docs.stripe.com/api/events/types';
  const out: string[] = [];
  const type = input.type?.trim();
  const footer = `Snapshot ${data.retrieved}: ${data.source.join(' and ')}. Snapshot event payloads are rendered at the webhook endpoint's api_version (or the account default if none was set); Go/Java/.NET SDKs need the endpoint version to match their pinned version (https://docs.stripe.com/webhooks/versioning).`;
  if (!type) {
    return [
      `${data.events.length} v1 snapshot event types in the snapshot. Pass "type" (e.g. invoice.payment_succeeded) or a prefix (e.g. "invoice.").`,
      footer,
    ].join('\n');
  }
  if (type.startsWith('v2.')) {
    return [
      `${type} is a thin (v2) event type. Thin event notifications are unversioned and carry the event type plus a related_object reference; fetch the full event or object from the API. Catalog: https://docs.stripe.com/api/v2/core/events/event-types. Migration from snapshot to thin: https://docs.stripe.com/webhooks/migrate-snapshot-to-thin-events`,
      'Thin event types are not in this snapshot; check the catalog.',
    ].join('\n');
  }
  const exact = data.events.find((e) => e.type === type);
  const inSpec = data.specEnabledEvents.includes(type);
  if (exact) {
    out.push(
      `${type}: documented. data.object is one of: ${exact.objects.join(', ') || '(not listed)'}.`,
    );
    out.push(
      inSpec
        ? 'Also accepted in enabled_events by the OpenAPI spec (webhook_endpoints create).'
        : 'Not in the OpenAPI enabled_events enum of the spec snapshot; check the docs page before relying on it.',
    );
    const object = exact.objects[0];
    if (object)
      out.push(
        `Object reference: ${API_REF}/${object === 'subscription' ? 'subscriptions' : `${object}s`}/object (shape follows the endpoint api_version).`,
      );
  } else if (type.endsWith('.') || type.endsWith('*')) {
    const prefix = type.replace(/\*$/, '');
    const matches = data.events.filter((e) => e.type.startsWith(prefix));
    out.push(
      matches.length
        ? `Event types starting with "${prefix}":`
        : `No documented event types start with "${prefix}".`,
    );
    for (const m of matches.slice(0, 60)) out.push(`- ${m.type} → ${m.objects.join(', ')}`);
  } else {
    out.push(
      inSpec
        ? `${type} is in the OpenAPI enabled_events enum but not on the docs event list snapshot. It probably exists (e.g. Treasury events); check https://docs.stripe.com/api/events/types.`
        : `${type} is not in the snapshot (docs list or spec enum). It may be misspelled, renamed, removed or newer than ${data.retrieved}.`,
    );
    const suggestions = closest(type, [
      ...new Set([...data.events.map((e) => e.type), ...data.specEnabledEvents]),
    ]);
    if (suggestions.length) out.push(`Did you mean: ${suggestions.join(', ')}?`);
    const hints = loadApiVersions() ? removalHints(loadApiVersions(), type) : [];
    if (hints.length) out.push(`Changelog mentions: ${hints.join(' | ')}`);
  }
  if (input.apiVersion) {
    out.push(
      `For ${input.apiVersion}: create or check the endpoint with api_version=${input.apiVersion} (only settable at creation; upgrade by creating a new endpoint and switching over, see https://docs.stripe.com/webhooks/versioning). Use stripe_api_versions to list payload-shape breaking changes between versions.`,
    );
  }
  out.push(footer);
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Tools

function createApiVersionsTool(): AgentTool {
  return defineTool({
    name: 'stripe_api_versions',
    description:
      'Stripe API version info from a dated changelog snapshot: release date, named major release (acacia, basil, clover, dahlia, endive...), whether a version is a breaking major start or a non-breaking monthly, the breaking changes between two versions (with changelog links), and which stripe-node/python/ruby/go/java/php/dotnet majors pin which version.',
    inputSchema: {
      type: 'object',
      properties: {
        version: {
          type: 'string',
          description:
            'API version the code uses now, e.g. 2020-08-27, 2024-06-20, 2025-03-31.basil, or a release name like basil.',
        },
        target: {
          type: 'string',
          description:
            'Version to move to (default: current). Breaking changes in between are listed.',
        },
        sdk: {
          type: 'string',
          description: 'Optional SDK and major, e.g. "stripe-node@17", "python 12", "go v82".',
        },
        query: {
          type: 'string',
          description:
            'Optional filter for breaking changes, e.g. "checkout", "subscription period".',
        },
        max: { type: 'number', description: 'Max breaking entries to list (default 25).' },
      },
    },
    run: async (input) => {
      const data = loadApiVersions();
      if (!data) return `Version snapshot missing; read ${CHANGELOG} and ${VERSIONING}.`;
      const maxValue = input.max;
      return apiVersionsReport(data, {
        version: str(input, 'version') ?? str(input, 'from') ?? str(input, 'query_version'),
        target: str(input, 'target') ?? str(input, 'to'),
        sdk: str(input, 'sdk'),
        query: str(input, 'query'),
        max: typeof maxValue === 'number' ? maxValue : undefined,
      });
    },
  });
}

function createCheckParamsTool(options: StripeToolPackOptions): AgentTool {
  const network: NetworkOptions & { specCacheDir?: string | null } = {};
  if (options.fetch !== undefined) network.fetch = options.fetch;
  if (options.timeoutMs !== undefined) network.timeoutMs = options.timeoutMs;
  if (options.specCacheDir !== undefined) network.specCacheDir = options.specCacheDir;
  return defineTool({
    name: 'stripe_check_params',
    description:
      "Check Stripe request params against the OpenAPI spec (live github.com/stripe/openapi at the tag for your API version when online, else a committed excerpt of ~23 common resources). Reports unknown params with did-you-mean, deprecated params, missing required params, simple enum mismatches, expandable fields, and breaking changes between your version and the spec's.",
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          description:
            'e.g. "POST /v1/payment_intents", "GET /v1/customers/cus_123", or an SDK call like "paymentIntents.create", "stripe.checkout.Session.create".',
        },
        method: { type: 'string', description: 'HTTP method, if not part of "operation".' },
        path: { type: 'string', description: 'Request path, if not part of "operation".' },
        params: {
          type: 'object',
          description:
            'Request params as a nested object, e.g. {"amount":1000,"currency":"usd","automatic_payment_methods":{"enabled":true}}.',
        },
        apiVersion: {
          type: 'string',
          description: 'API version the code sends (Stripe-Version or SDK pin).',
        },
        live: { type: 'boolean', description: 'Use the live spec when online (default true).' },
      },
      required: ['operation'],
    },
    run: async (input) =>
      checkParamsReport(
        {
          operation: str(input, 'operation') ?? str(input, 'endpoint') ?? str(input, 'query'),
          method: str(input, 'method'),
          path: str(input, 'path'),
          params: obj(input, 'params') ?? {},
          apiVersion:
            str(input, 'apiVersion') ?? str(input, 'api_version') ?? str(input, 'version'),
          live: bool(input, 'live'),
        },
        network,
      ),
  });
}

function createWebhookEventsTool(): AgentTool {
  return defineTool({
    name: 'stripe_webhook_events',
    description:
      'Look up a Stripe event type (e.g. invoice.payment_succeeded, or a prefix like "customer.subscription."): whether it is documented and in the spec, its data.object type, and how the payload version is chosen (endpoint api_version vs account default; thin v2 events).',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Event type or prefix ending in "." .' },
        apiVersion: {
          type: 'string',
          description: 'Optional API version the webhook endpoint uses or should use.',
        },
      },
    },
    run: async (input) =>
      webhookEventsReport({
        type: str(input, 'type') ?? str(input, 'event') ?? str(input, 'query'),
        apiVersion: str(input, 'apiVersion') ?? str(input, 'api_version'),
      }),
  });
}

export function createToolPack(options: StripeToolPackOptions = {}): ToolPack {
  const { specCacheDir: _specCacheDir, ...packOptions } = options;
  void _specCacheDir;
  return assembleToolPack({
    provider: 'stripe',
    tools: [createApiVersionsTool(), createCheckParamsTool(options), createWebhookEventsTool()],
    playbooksDir: new URL('./playbooks/', import.meta.url),
    options: packOptions,
  });
}

export const toolPack: ToolPack = createToolPack();
