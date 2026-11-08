// OpenAI ToolPack: helpers the agent may call to check model retirements, request shapes and SDK renames.
// Every tool answers from a dated snapshot in tools-data/ and, when online, may consult the live source too.
// Tools inform; they never decide whether a change matters.

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { AgentTool, ToolPack } from '../../shared/types.ts';
import {
  assembleToolPack,
  bool,
  closest,
  defineTool,
  fetchText,
  htmlToText,
  obj,
  resolveFetch,
  str,
  type NetworkOptions,
  type ToolPackOptions,
} from '../toolkit/index.ts';

const DEPRECATIONS_URL = 'https://developers.openai.com/api/docs/deprecations';
const MODELS_URL = 'https://developers.openai.com/api/docs/models/all';

function loadJson<T>(file: string): T {
  return JSON.parse(readFileSync(new URL(`./tools-data/${file}`, import.meta.url), 'utf8')) as T;
}

// ---------- snapshot types ----------

type DeprecationRow = {
  shutdown: string | null;
  shutdownText: string;
  item: string;
  ids: string[];
  replacement: string;
  replacementIds: string[];
};

type DeprecationSection = {
  announced: string | null;
  title: string;
  link: string;
  status: 'upcoming' | 'past';
  summary: string;
  rows?: DeprecationRow[];
  timeline?: { date: string; update: string }[];
};

type DeprecationsData = {
  source: string;
  retrieved: string;
  monitoring: string;
  sections: DeprecationSection[];
};

type ModelEntry = {
  page: string;
  endpoints?: string[];
  aliases?: Record<string, string>;
  snapshots?: Record<string, string>;
};

type ModelsData = { source: string; retrieved: string; models: Record<string, ModelEntry> };

type ParamInfo = { d: string; deprecated?: boolean; note?: string; mentionsDeprecated?: string };

type EndpointParams = {
  operationId?: string;
  contentType?: string;
  deprecated: boolean;
  summary: string;
  required: string[];
  params: Record<string, ParamInfo>;
};

type ParamsData = {
  source: string;
  liveUrl: string;
  specVersion: string;
  retrieved: string;
  endpoints: Record<string, EndpointParams>;
};

type ParamNote = { replacement?: string; note: string; source: string };

type RequestNotes = {
  endpointAliases: Record<string, string>;
  endpointNotes: Record<string, { status: string; date?: string; note: string; source: string }>;
  paramNotes: Record<string, Record<string, ParamNote>>;
  reasoningModels: {
    note: string;
    unsupportedWhenReasoning: Record<string, string[]>;
    modelPattern: string;
    noNoneEffort: string[];
    source: string;
  };
  chatToResponses: {
    source: string;
    endpoint: string;
    params: Record<string, string>;
    confidence: Record<string, string>;
    output: string;
    state: string;
    pitfalls: string[];
  };
};

type SdkMigration = {
  retrieved: string;
  latest: Record<string, string>;
  majors: { sdk: string; version: string; date: string; summary: string; source: string }[];
  renames: Record<
    'python' | 'node',
    { source: string; note: string; map: Record<string, string>; removed: string[] }
  >;
};

// Loaded lazily so a broken file degrades one tool, not the whole pack.
let cache: {
  deprecations?: DeprecationsData;
  models?: ModelsData;
  params?: ParamsData;
  notes?: RequestNotes;
  sdk?: SdkMigration;
} = {};
const data = {
  deprecations: () => (cache.deprecations ??= loadJson<DeprecationsData>('deprecations.json')),
  models: () => (cache.models ??= loadJson<ModelsData>('models.json')),
  params: () => (cache.params ??= loadJson<ParamsData>('params.json')),
  notes: () => (cache.notes ??= loadJson<RequestNotes>('request-notes.json')),
  sdk: () => (cache.sdk ??= loadJson<SdkMigration>('sdk-migration.json')),
};

/** For tests: drop cached snapshots. */
export function resetOpenAiCache(): void {
  cache = {};
}

// ---------- model lookup ----------

type RowHit = { row: DeprecationRow; section: DeprecationSection };

function rowIndex(): Map<string, RowHit[]> {
  const index = new Map<string, RowHit[]>();
  for (const section of data.deprecations().sections) {
    for (const row of section.rows ?? []) {
      const keys = row.ids.length ? row.ids : [row.item];
      for (const key of keys) {
        const k = key.toLowerCase();
        const list = index.get(k) ?? [];
        list.push({ row, section });
        index.set(k, list);
      }
    }
  }
  return index;
}

type CatalogHit = { family: string; entry: ModelEntry; badge?: string; aliasOf?: string };

function catalogLookup(id: string): CatalogHit | undefined {
  const models = data.models().models;
  if (models[id]) {
    const entry = models[id];
    return {
      family: id,
      entry,
      badge: entry.snapshots?.[id],
      aliasOf: entry.aliases?.[id],
    };
  }
  for (const [family, entry] of Object.entries(models)) {
    if (entry.snapshots && id in entry.snapshots) {
      return { family, entry, badge: entry.snapshots[id], aliasOf: entry.aliases?.[id] };
    }
    if (entry.aliases && id in entry.aliases) {
      return { family, entry, aliasOf: entry.aliases[id] };
    }
  }
  return undefined;
}

function allKnownIds(): string[] {
  const ids = new Set<string>();
  for (const key of rowIndex().keys()) ids.add(key);
  for (const [family, entry] of Object.entries(data.models().models)) {
    ids.add(family);
    for (const s of Object.keys(entry.snapshots ?? {})) ids.add(s);
    for (const a of Object.keys(entry.aliases ?? {})) ids.add(a);
  }
  return [...ids];
}

function normalizeModelId(raw: string): { id: string; notes: string[] } {
  const notes: string[] = [];
  let id = raw.trim().replace(/^['"`]|['"`]$/g, '');
  if (/^openai\//i.test(id)) {
    id = id.replace(/^openai\//i, '');
    notes.push('Stripped an "openai/" router prefix.');
  }
  const ft = /^ft:([^:]+):/i.exec(id);
  if (ft) {
    notes.push(
      `"${raw}" is a fine-tuned model; fine-tuned models follow the shutdown schedule of their base model (${ft[1]}). Looking up the base model.`,
    );
    id = ft[1];
  }
  return { id: id.toLowerCase(), notes };
}

function pickRow(hits: RowHit[]): RowHit {
  // Prefer a firm date, then the most recent announcement.
  return [...hits].sort((a, b) => {
    const firm = Number(Boolean(b.row.shutdown)) - Number(Boolean(a.row.shutdown));
    if (firm) return firm;
    return (b.section.announced ?? '').localeCompare(a.section.announced ?? '');
  })[0];
}

function statusFor(row: DeprecationRow, now: string): string {
  if (!row.shutdown) return `deprecated (shutdown "${row.shutdownText}", no firm date in snapshot)`;
  return row.shutdown <= now
    ? `shut down (since ${row.shutdown})`
    : `deprecated, shutdown scheduled ${row.shutdown}`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function normalizeNow(raw: string | undefined): string {
  if (raw && /^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  return today();
}

type ModelReport = { id: string; status: string; lines: string[] };

// The replacement a row names may itself be retired by now (text-davinci-003 -> gpt-3.5-turbo-instruct,
// shut down 2026-09-28): follow the table until a model that still runs, so nobody migrates onto a dead one.
function replacementChain(
  row: DeprecationRow,
  index: ReturnType<typeof rowIndex>,
  now: string,
): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  let next = row.replacementIds?.[0]?.toLowerCase();
  while (next && !seen.has(next)) {
    seen.add(next);
    const hits = index.get(next);
    if (!hits?.length) break;
    const { row: later } = pickRow(hits);
    if (!later.shutdown || later.shutdown > now) break;
    lines.push(
      `${next} was itself shut down on ${later.shutdown}; its recommended replacement is ${later.replacement || 'not listed'}. Migrate to the end of this chain, not to ${next}.`,
    );
    next = later.replacementIds?.[0]?.toLowerCase();
  }
  return lines;
}

function describeModel(rawId: string, now: string): ModelReport {
  const { id, notes } = normalizeModelId(rawId);
  const lines: string[] = [...notes];
  const index = rowIndex();
  const catalog = catalogLookup(id);
  let hits = index.get(id) ?? [];
  let viaAlias: string | undefined;

  if (!hits.length && catalog?.aliasOf && catalog.aliasOf !== id) {
    const target = index.get(catalog.aliasOf.toLowerCase()) ?? [];
    if (target.length) {
      hits = target;
      viaAlias = catalog.aliasOf;
    }
  }

  let status = 'unknown';
  if (hits.length) {
    const { row, section } = pickRow(hits);
    status = statusFor(row, now);
    if (viaAlias) {
      lines.push(
        `"${id}" is an alias. On the snapshot date it pointed to ${viaAlias}, which has this deprecation entry. Aliases can be repointed; pin the dated snapshot you actually tested.`,
      );
    }
    lines.push(`Status (as of ${now}): ${status}`);
    lines.push(
      `Announced: ${section.announced ?? 'not dated on the page'} (${section.title}${section.status === 'past' ? ', listed under past deprecations' : ''})`,
    );
    lines.push(`Shutdown date: ${row.shutdown ?? row.shutdownText}`);
    lines.push(`Recommended replacement: ${row.replacement || 'none listed'}`);
    const chain = replacementChain(row, index, now);
    if (chain.length) lines.push(...chain);
    if (row.item && row.item.toLowerCase() !== id)
      lines.push(`Deprecations table row: ${row.item}`);
    lines.push(`Deprecations entry: ${section.link}`);
    const others = hits.filter((h) => h.row !== row);
    for (const other of others) {
      lines.push(
        `Earlier entry: ${other.section.announced ?? '?'} ${other.section.title}: shutdown ${other.row.shutdownText}, replacement ${other.row.replacement} (${other.section.link})`,
      );
    }
  } else if (catalog?.badge && catalog.badge !== 'listed') {
    status = catalog.badge.toLowerCase();
    lines.push(
      `Status (as of the ${data.models().retrieved} snapshot): ${catalog.badge} (badge on the model page; no row in the deprecations table matched this id).`,
    );
    lines.push(`Check ${DEPRECATIONS_URL} for the shutdown date and replacement.`);
  } else if (catalog) {
    status = 'active';
    lines.push(
      `Status: active as far as the snapshot shows (listed on the models page, no deprecation entry found as of ${data.deprecations().retrieved}).`,
    );
    if (catalog.aliasOf && catalog.aliasOf !== id) {
      lines.push(`"${id}" is an alias that pointed to ${catalog.aliasOf} on the snapshot date.`);
    }
  }

  if (catalog) {
    lines.push(`Model page: ${catalog.entry.page}`);
    if (catalog.entry.endpoints?.length) {
      lines.push(
        `Endpoints the model page marks as supported: ${catalog.entry.endpoints.join(', ')}`,
      );
    }
    const snaps = Object.entries(catalog.entry.snapshots ?? {});
    if (snaps.length > 1 || (snaps.length === 1 && snaps[0][0] !== id)) {
      lines.push(
        `Other ids in the ${catalog.family} family: ${snaps
          .filter(([s]) => s !== id)
          .map(([s, badge]) => `${s} (${badge})`)
          .join(', ')}`,
      );
    }
  } else if (hits.length) {
    lines.push(
      'Not on the current models catalog page (retired models are often removed from it).',
    );
  }

  if (status === 'unknown') {
    const prefix = id.split('-').slice(0, 2).join('-');
    const near = [
      ...new Set([
        ...closest(id, allKnownIds(), 5),
        ...allKnownIds()
          .filter((k) => k.startsWith(prefix) && k !== id)
          .slice(0, 5),
      ]),
    ].slice(0, 8);
    lines.push(
      `"${rawId}" is not in the snapshot (deprecations page and models catalog, ${data.deprecations().retrieved}). It may be newer, mistyped, Azure deployment names, or a non-OpenAI model.`,
    );
    if (near.length) {
      lines.push('Closest known ids:');
      for (const n of near) {
        const r = index.get(n);
        lines.push(
          r
            ? `- ${n}: ${statusFor(pickRow(r).row, now)}`
            : `- ${n}: ${catalogLookup(n)?.badge ?? 'listed'}`,
        );
      }
    }
    lines.push(`Not in snapshot; check ${DEPRECATIONS_URL} and ${MODELS_URL}.`);
  }

  return { id, status, lines };
}

async function liveDeprecationCheck(
  id: string,
  network: NetworkOptions,
): Promise<string | undefined> {
  if (!resolveFetch(network)) return undefined;
  const result = await fetchText(DEPRECATIONS_URL, network);
  if (!result.ok)
    return `Live check of ${DEPRECATIONS_URL} failed (${result.error}); relying on the snapshot.`;
  const text = /<\w+[^>]*>/.test(result.text) ? htmlToText(result.text) : result.text;
  const at = text.toLowerCase().indexOf(id.toLowerCase());
  if (at < 0) return `Live deprecations page (fetched now) does not mention "${id}".`;
  const excerpt = text
    .slice(Math.max(0, at - 200), at + 300)
    .replace(/\s+/g, ' ')
    .trim();
  return `Live deprecations page (fetched now) mentions "${id}": ...${excerpt}...`;
}

function createModelLookupTool(network: NetworkOptions): AgentTool {
  return defineTool({
    name: 'openai_model_lookup',
    description:
      'Look up an OpenAI model id as written in code (e.g. gpt-4-0314, text-davinci-003, gpt-4o, o1-preview, whisper-1, dall-e-3, ft:...): status (active / deprecated / shut down), announcement and shutdown dates, recommended replacement, endpoints the model supports, alias -> snapshot pointer, and the deprecations page link. Unknown ids get closest matches. Snapshot of the deprecations page and models catalog, optionally confirmed against the live page.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model id, alias, snapshot, or fine-tuned id.' },
        models: {
          type: 'array',
          items: { type: 'string' },
          description: 'Several model ids at once (optional).',
        },
        now: {
          type: 'string',
          description: 'ISO date used to decide deprecated vs shut down (default today).',
        },
        live: {
          type: 'boolean',
          description:
            'Also search the live deprecations page for the id (default true when online).',
        },
      },
    },
    run: async (input) => {
      const ids = [
        ...(str(input, 'model') ? [str(input, 'model') as string] : []),
        ...(Array.isArray(input.models)
          ? input.models.filter((m): m is string => typeof m === 'string' && m.trim() !== '')
          : []),
        ...(!str(input, 'model') && str(input, 'query') ? [str(input, 'query') as string] : []),
      ];
      if (!ids.length) {
        return `Pass "model" (e.g. "gpt-4-0314"). The snapshot covers ${rowIndex().size} deprecated ids and ${Object.keys(data.models().models).length} catalog models; see ${DEPRECATIONS_URL}.`;
      }
      const now = normalizeNow(str(input, 'now'));
      const live = bool(input, 'live') ?? true;
      const blocks: string[] = [];
      for (const raw of ids.slice(0, 20)) {
        const report = describeModel(raw, now);
        const block = [`## ${raw}`, ...report.lines];
        if (live) {
          const liveLine = await liveDeprecationCheck(report.id, network);
          if (liveLine) block.push(liveLine);
        }
        blocks.push(block.join('\n'));
      }
      blocks.push(
        `Snapshot: ${DEPRECATIONS_URL} and ${MODELS_URL}, retrieved ${data.deprecations().retrieved}. ${data.deprecations().monitoring} Replacements are OpenAI's suggestions; behavior differs between models, so re-test prompts, parameters (reasoning models reject some sampling params; see openai_check_request) and output parsing.`,
      );
      return blocks.join('\n\n');
    },
  });
}

// ---------- request check ----------

function resolveEndpoint(raw: string, known: string[]): { path?: string; note?: string } {
  const notes = data.notes();
  let value = raw.trim();
  const alias = notes.endpointAliases[value.toLowerCase()];
  if (alias) return { path: alias };
  value = value
    .replace(/^(GET|POST|PUT|PATCH|DELETE)\s+/i, '')
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/\?.*$/, '')
    .replace(/^\/?(openai\/)?v1(?=\/)/, '')
    .replace(/\/+$/, '');
  if (!value.startsWith('/')) value = `/${value.replace(/\./g, '/')}`;
  if (known.includes(value)) return { path: value };
  // Match concrete ids against templates, e.g. /threads/thread_abc/runs -> /threads/{thread_id}/runs.
  const parts = value.split('/');
  for (const template of known) {
    const t = template.split('/');
    if (t.length !== parts.length) continue;
    if (t.every((seg, i) => seg.startsWith('{') || seg === parts[i])) return { path: template };
  }
  return { note: value };
}

type LiveSpec = { endpoints: Record<string, EndpointParams>; source: string };

const SPEC_CACHE_FILE = 'refit-openai-openapi.json';
const SPEC_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type Schema = Record<string, unknown>;

function extractEndpoint(spec: Schema, path: string): EndpointParams | undefined {
  const paths = spec.paths as Record<string, Record<string, Schema>> | undefined;
  const op = paths?.[path]?.post;
  if (!op) return undefined;
  const schemas = ((spec.components as Schema | undefined)?.schemas ?? {}) as Record<
    string,
    Schema
  >;
  const deref = (s: unknown, seen: string[] = []): Schema => {
    let cur = s as Schema;
    while (cur && typeof cur === 'object' && typeof cur.$ref === 'string') {
      const name = (cur.$ref as string).split('/').pop() as string;
      if (seen.includes(name)) return {};
      seen = [...seen, name];
      cur = schemas[name] ?? {};
    }
    return cur ?? {};
  };
  const props: Record<string, Schema> = {};
  const required = new Set<string>();
  const collect = (s: unknown, depth = 0): void => {
    const d = deref(s);
    if (depth > 20) return;
    for (const sub of (d.allOf as unknown[]) ?? []) collect(sub, depth + 1);
    for (const [k, v] of Object.entries((d.properties as Record<string, Schema>) ?? {})) {
      props[k] ??= v;
    }
    for (const r of (d.required as string[]) ?? []) required.add(r);
  };
  const content = ((op.requestBody as Schema | undefined)?.content ?? {}) as Record<string, Schema>;
  const contentType = Object.keys(content)[0];
  if (!contentType) return undefined;
  collect(content[contentType].schema);
  const params: Record<string, ParamInfo> = {};
  for (const [k, v] of Object.entries(props)) {
    const dv = deref(v);
    let desc = (v.description as string) ?? (dv.description as string) ?? '';
    if (!desc) {
      for (const alt of ((v.anyOf ?? v.oneOf ?? dv.anyOf ?? dv.oneOf) as unknown[]) ?? []) {
        const a = deref(alt);
        if (typeof a.description === 'string') {
          desc = a.description;
          break;
        }
      }
    }
    const flat = desc.replace(/\s+/g, ' ').trim();
    const info: ParamInfo = { d: (/^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat).slice(0, 160) };
    if (v.deprecated || dv.deprecated) {
      info.deprecated = true;
      info.note = flat.slice(0, 400);
    } else if (/\bdeprecated\b/i.test(flat)) {
      info.mentionsDeprecated = flat.slice(0, 400);
    }
    params[k] = info;
  }
  return {
    operationId: op.operationId as string | undefined,
    contentType,
    deprecated: Boolean(op.deprecated),
    summary: String(op.summary ?? ''),
    required: [...required].sort(),
    params,
  };
}

async function loadLiveSpec(
  network: NetworkOptions,
  path: string,
  cacheDir: string,
): Promise<LiveSpec | undefined> {
  const url = data.params().liveUrl;
  const SPEC_CACHE = join(cacheDir, SPEC_CACHE_FILE);
  let text: string | undefined;
  let source = `${url} (cached copy in ${SPEC_CACHE})`;
  try {
    if (existsSync(SPEC_CACHE) && Date.now() - statSync(SPEC_CACHE).mtimeMs < SPEC_MAX_AGE_MS) {
      text = readFileSync(SPEC_CACHE, 'utf8');
    }
  } catch {
    text = undefined;
  }
  if (!text) {
    if (!resolveFetch(network)) return undefined;
    const result = await fetchText(url, { timeoutMs: 30_000, ...network });
    if (!result.ok) return undefined;
    text = result.text;
    source = `${url} (fetched now)`;
    const parsed = JSON.parse(text) as Schema;
    if (!parsed.paths) return undefined;
    try {
      writeFileSync(SPEC_CACHE, text);
    } catch {
      // Cache is optional.
    }
  }
  const spec = JSON.parse(text) as Schema;
  const endpoint = extractEndpoint(spec, path);
  return endpoint ? { endpoints: { [path]: endpoint }, source } : undefined;
}

function endpointNoteFor(path: string) {
  const notes = data.notes().endpointNotes;
  const key = Object.keys(notes)
    .filter((k) => path === k || path.startsWith(`${k}/`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? notes[key] : undefined;
}

function isReasoningModel(model: string | undefined): boolean {
  if (!model) return false;
  return new RegExp(data.notes().reasoningModels.modelPattern, 'i').test(model.replace(/^ft:/, ''));
}

function checkRequest(
  path: string,
  spec: EndpointParams,
  body: Record<string, unknown>,
  model: string | undefined,
  now: string,
  migrateTo: string | undefined,
): string[] {
  const notes = data.notes();
  const out: string[] = [];
  const endpointNote = endpointNoteFor(path);
  if (endpointNote) {
    out.push(
      `Endpoint note (${endpointNote.status}${endpointNote.date ? `, ${endpointNote.date}` : ''}): ${endpointNote.note} Source: ${endpointNote.source}`,
    );
  } else if (spec.deprecated) {
    out.push(
      `The spec marks this operation (${spec.operationId}) deprecated. Check ${DEPRECATIONS_URL}.`,
    );
  }

  const known = Object.keys(spec.params);
  const extraNotes = notes.paramNotes[path] ?? {};
  const unknown: string[] = [];
  const deprecated: string[] = [];
  for (const key of Object.keys(body)) {
    const info = spec.params[key];
    const note = extraNotes[key];
    if (!info) {
      if (note) {
        deprecated.push(
          `- ${key}: not in the current spec. ${note.note}${note.replacement ? ` Use: ${note.replacement}.` : ''} (${note.source})`,
        );
      } else {
        const guess = closest(key, known, 3);
        const chatMapping = path === '/responses' ? notes.chatToResponses.params[key] : undefined;
        unknown.push(
          chatMapping
            ? `- ${key}: a Chat Completions parameter, not a Responses one. In Responses: ${chatMapping} (${notes.chatToResponses.source})`
            : `- ${key}: not a top-level parameter of POST ${path} in the spec${guess.length ? `; did you mean ${guess.join(', ')}?` : '.'}`,
        );
      }
      continue;
    }
    if (info.deprecated || note || info.mentionsDeprecated) {
      const detail = note
        ? `${note.note}${note.replacement ? ` Use: ${note.replacement}.` : ''} (${note.source})`
        : (info.note || info.mentionsDeprecated || info.d) + ' (spec)';
      deprecated.push(`- ${key}: ${info.deprecated ? 'deprecated in spec. ' : ''}${detail}`);
    }
  }
  const missing = spec.required.filter((r) => !(r in body) && !(r === 'model' && model));
  out.push(
    deprecated.length
      ? `Deprecated or legacy parameters:\n${deprecated.join('\n')}`
      : 'Deprecated parameters: none found.',
  );
  out.push(
    unknown.length ? `Unknown parameters:\n${unknown.join('\n')}` : 'Unknown parameters: none.',
  );
  out.push(
    missing.length
      ? `Required by the spec but missing: ${missing.join(', ')}`
      : `Required parameters present (${spec.required.join(', ') || 'none required by the spec'}).`,
  );

  const effectiveModel = model ?? (typeof body.model === 'string' ? body.model : undefined);
  if (effectiveModel) {
    const report = describeModel(effectiveModel, now);
    out.push(
      `Model ${effectiveModel}: ${report.status === 'unknown' ? 'not in snapshot (see openai_model_lookup for closest matches)' : report.status}. Run openai_model_lookup for replacement and dates.`,
    );
    if (isReasoningModel(effectiveModel)) {
      const effortRaw =
        path === '/responses'
          ? (obj(body, 'reasoning')?.effort as string | undefined)
          : (body.reasoning_effort as string | undefined);
      const effort = typeof effortRaw === 'string' ? effortRaw : undefined;
      const blocked = (notes.reasoningModels.unsupportedWhenReasoning[path] ?? []).filter(
        (p) => p in body,
      );
      if (blocked.length && effort !== 'none') {
        out.push(
          `Reasoning model: ${blocked.join(', ')} ${blocked.length > 1 ? 'are' : 'is'} not supported when reasoning effort is not none (effort here: ${effort ?? 'model default'}). ${notes.reasoningModels.source}`,
        );
      }
      if ('max_tokens' in body) {
        out.push(
          `Reasoning model: max_tokens is not compatible with o-series/reasoning models; use ${path === '/responses' ? 'max_output_tokens' : 'max_completion_tokens'} and leave room for reasoning tokens. https://developers.openai.com/api/docs/guides/reasoning`,
        );
      }
      if (effort === 'none' && notes.reasoningModels.noNoneEffort.includes(effectiveModel)) {
        out.push(
          `${effectiveModel} does not support reasoning effort "none" (the docs say use low). ${notes.reasoningModels.source}`,
        );
      }
      if (path === '/chat/completions' && ('tools' in body || 'functions' in body)) {
        out.push(
          'Tool calling with newer reasoning models on Chat Completions is limited (GPT-5.4+: only with reasoning_effort none; GPT-6 Astra / 6.1 Sol / 6.1 Terra: Responses only). https://developers.openai.com/api/docs/guides/latest-model',
        );
      }
    }
  }

  if (path === '/chat/completions' || migrateTo === 'responses') {
    const map = notes.chatToResponses;
    const present = Object.keys(body).filter((k) => k in map.params);
    const lines = present.map(
      (k) => `- ${k} -> ${map.params[k]}${map.confidence[k] ? ` [${map.confidence[k]}]` : ''}`,
    );
    out.push(
      [
        `If moving this call to Responses (${map.endpoint}):`,
        ...(lines.length ? lines : ['- (no mapped parameters present in this body)']),
        `- output: ${map.output}`,
        `- state: ${map.state}`,
        `Common pitfalls: ${map.pitfalls.join('; ')}.`,
        `Source: ${map.source}`,
      ].join('\n'),
    );
  }
  return out;
}

function createCheckRequestTool(network: NetworkOptions, cacheDir: string): AgentTool {
  return defineTool({
    name: 'openai_check_request',
    description:
      "Check an OpenAI request body against the endpoint's parameter list (public OpenAPI spec snapshot, optionally the live spec): unknown params with did-you-mean, deprecated params and their replacements (functions -> tools, max_tokens -> max_completion_tokens, user -> safety_identifier...), missing required params, reasoning-model parameter limits, endpoint status (Assistants sunset, Completions legacy, ...), and the Chat Completions -> Responses parameter mapping.",
    inputSchema: {
      type: 'object',
      properties: {
        endpoint: {
          type: 'string',
          description:
            'chat.completions, responses, embeddings, images, audio.transcriptions, completions, assistants, threads..., or a path like /v1/chat/completions.',
        },
        body: { type: 'object', description: 'The JSON request body (or SDK kwargs) to check.' },
        model: { type: 'string', description: 'Model id if not in the body.' },
        migrate_to: {
          type: 'string',
          description: 'Set to "responses" to include the Chat Completions -> Responses mapping.',
        },
        now: { type: 'string', description: 'ISO date for model status (default today).' },
        live: {
          type: 'boolean',
          description:
            'Use the live OpenAPI spec (cached 24h in the OS temp dir) instead of the snapshot when online. Default false.',
        },
      },
      required: ['endpoint'],
    },
    run: async (input) => {
      const snapshot = data.params();
      const notes = data.notes();
      const endpointRaw = str(input, 'endpoint') ?? str(input, 'path') ?? str(input, 'query');
      const body = obj(input, 'body') ?? {};
      const known = Object.keys(snapshot.endpoints);
      const allPaths = [...new Set([...known, ...Object.keys(notes.endpointNotes)])];
      if (!endpointRaw) {
        return `Pass "endpoint" (e.g. "chat.completions" or "/v1/responses") and "body". Endpoints in the snapshot: ${known.join(', ')}.`;
      }
      const { path, note } = resolveEndpoint(endpointRaw, allPaths);
      const now = normalizeNow(str(input, 'now'));
      if (!path) {
        const guesses = closest(note ?? endpointRaw, allPaths, 4);
        return [
          `"${endpointRaw}" is not an endpoint in the snapshot (${snapshot.source}, spec ${snapshot.specVersion}, ${snapshot.retrieved}).`,
          guesses.length ? `Closest: ${guesses.join(', ')}` : `Known: ${known.join(', ')}`,
          'Not in snapshot; check https://developers.openai.com/api/reference/overview.',
        ].join('\n');
      }
      let spec = snapshot.endpoints[path];
      let source = `${snapshot.source} (snapshot, spec ${snapshot.specVersion}, retrieved ${snapshot.retrieved})`;
      if (bool(input, 'live')) {
        const live = await loadLiveSpec(network, path, cacheDir).catch(() => undefined);
        if (live?.endpoints[path]) {
          spec = live.endpoints[path];
          source = live.source;
        } else {
          source += '; live spec unavailable, used the snapshot';
        }
      }
      const header = `POST /v1${path}${spec?.operationId ? ` (${spec.operationId})` : ''}`;
      if (!spec) {
        const endpointNote = endpointNoteFor(path);
        return [
          header,
          endpointNote
            ? `Endpoint note (${endpointNote.status}${endpointNote.date ? `, ${endpointNote.date}` : ''}): ${endpointNote.note} Source: ${endpointNote.source}`
            : 'No parameter list in the snapshot for this endpoint.',
          'No request-body parameter list is available for this path; check the API reference.',
        ].join('\n');
      }
      const lines = checkRequest(
        path,
        spec,
        body,
        str(input, 'model'),
        now,
        str(input, 'migrate_to'),
      );
      return [
        header,
        ...lines,
        `Source: ${source}. Only top-level body keys are checked; nested shapes (messages, tools, text.format) are not validated, so confirm in the API reference or with openai_search_docs.`,
      ].join('\n\n');
    },
  });
}

// ---------- SDK migration ----------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const EXTRA_PATTERNS: { sdk: 'python' | 'node'; pattern: RegExp; note: string; source: string }[] =
  [
    {
      sdk: 'python',
      pattern: /\bopenai\.api_key\s*=/,
      note: 'Module-level api key (v0 style). v1+ prefers client = OpenAI() (reads OPENAI_API_KEY).',
      source: 'https://github.com/openai/openai-python/discussions/742',
    },
    {
      sdk: 'python',
      pattern: /\[\s*['"]choices['"]\s*\]/,
      note: 'Dict-style access to a response. v1+ responses are pydantic models: use completion.choices[0]..., or .model_dump().',
      source: 'https://github.com/openai/openai-python/discussions/742',
    },
    {
      sdk: 'python',
      pattern:
        /\b(httpx\.(Async)?Client|DefaultHttpxClient|DefaultAsyncHttpxClient|http_client\s*=)/,
      note: 'Custom httpx client. openai-python v3.0.0 made HTTPX2 the default and no longer installs httpx; move custom clients/transports to HTTPX2 equivalents (see httpx2.md).',
      source: 'https://github.com/openai/openai-python/releases/tag/v3.0.0',
    },
    {
      sdk: 'node',
      pattern: /\.data\.choices\b/,
      note: 'v3 response unwrapping (.data). v4+ returns the body directly: completion.choices.',
      source: 'https://github.com/openai/openai-node/discussions/217',
    },
    {
      sdk: 'node',
      pattern: /\.del\s*\(/,
      note: 'del() methods were renamed to delete() in openai-node v5.',
      source: 'https://github.com/openai/openai-node/blob/main/MIGRATION.md',
    },
    {
      sdk: 'node',
      pattern: /\bhttpAgent\b/,
      note: 'httpAgent was removed in openai-node v5 in favor of fetchOptions.',
      source: 'https://github.com/openai/openai-node/blob/main/MIGRATION.md',
    },
    {
      sdk: 'node',
      pattern: /\.beta\.chat\./,
      note: 'The beta.chat namespace was removed in openai-node v5 (helpers such as parse moved to chat.completions).',
      source: 'https://github.com/openai/openai-node/blob/main/MIGRATION.md',
    },
    {
      sdk: 'node',
      pattern: /\.runFunctions\s*\(/,
      note: 'runFunctions was removed in openai-node v5; use runTools.',
      source: 'https://github.com/openai/openai-node/blob/main/MIGRATION.md',
    },
    {
      sdk: 'node',
      pattern: /from\s+['"]openai\/src\//,
      note: 'openai/src imports were removed in openai-node v5.',
      source: 'https://github.com/openai/openai-node/blob/main/MIGRATION.md',
    },
    {
      sdk: 'python',
      pattern: /\.beta\.(assistants|threads)\b/,
      note: 'Assistants API calls. The Assistants API was shut down 2026-08-26; migrate to responses + conversations.',
      source: 'https://developers.openai.com/api/docs/assistants/migration',
    },
    {
      sdk: 'node',
      pattern: /\.beta\.(assistants|threads)\b/,
      note: 'Assistants API calls. The Assistants API was shut down 2026-08-26; migrate to responses + conversations.',
      source: 'https://developers.openai.com/api/docs/assistants/migration',
    },
  ];

function readRepoFile(repoDir: string, path: string): string | undefined {
  const base = resolve(repoDir || '.');
  const full = isAbsolute(path) ? path : resolve(base, path);
  const rel = relative(base, full);
  if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
  if (!existsSync(full)) return undefined;
  return readFileSync(full, 'utf8').slice(0, 400_000);
}

function createSdkMigrationTool(): AgentTool {
  return defineTool({
    name: 'openai_sdk_migration',
    description:
      'Find old OpenAI SDK call shapes in a code snippet or repo file and show their replacements: openai-python v0 -> v1 (openai.ChatCompletion.create -> client.chat.completions.create, ...), openai-node v3 -> v4 (createChatCompletion -> chat.completions.create, ...), plus breaking changes in later majors (python v2/v3 HTTPX2, node v5 fetch/del->delete, v6, v7 Node 22).',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Code snippet or a single symbol to check.' },
        path: { type: 'string', description: 'A file path inside the repo to scan instead.' },
        sdk: { type: 'string', description: '"python" or "node" (default: both).' },
      },
    },
    run: async (input, context) => {
      const sdkData = data.sdk();
      const path = str(input, 'path');
      let code = str(input, 'code') ?? str(input, 'query') ?? '';
      const notes: string[] = [];
      if (path) {
        const fileText = readRepoFile(context.repoDir, path);
        if (fileText === undefined)
          notes.push(`Could not read ${path} inside the repo; checked the code input only.`);
        else code = `${code}\n${fileText}`;
      }
      const want = str(input, 'sdk')?.toLowerCase();
      const sdks: ('python' | 'node')[] =
        want === 'python' || want === 'py'
          ? ['python']
          : want === 'node' || want === 'js' || want === 'ts' || want === 'typescript'
            ? ['node']
            : ['python', 'node'];
      const findings: string[] = [];
      if (code.trim()) {
        for (const sdk of sdks) {
          const renames = sdkData.renames[sdk];
          for (const [from, to] of Object.entries(renames.map)) {
            const short = sdk === 'python' ? from.replace(/^openai\./, '') : from;
            const re =
              sdk === 'python'
                ? new RegExp(`(^|[^\\w.])(openai\\.)?${escapeRegExp(short)}\\b`)
                : new RegExp(`\\b${escapeRegExp(short)}\\b`);
            if (re.test(code)) findings.push(`- [${sdk}] ${from} -> ${to} (${renames.source})`);
          }
          for (const removed of renames.removed) {
            const short = sdk === 'python' ? removed.replace(/^openai\./, '') : removed;
            const re =
              sdk === 'python'
                ? new RegExp(`\\bopenai\\.${escapeRegExp(short)}\\b`)
                : new RegExp(`\\b${escapeRegExp(short)}\\s*\\(`);
            if (re.test(code))
              findings.push(`- [${sdk}] ${removed}: removed in the rewrite (${renames.source})`);
          }
          for (const extra of EXTRA_PATTERNS.filter((e) => e.sdk === sdk)) {
            if (extra.pattern.test(code))
              findings.push(`- [${sdk}] ${extra.note} (${extra.source})`);
          }
        }
      }
      const majors = sdkData.majors
        .filter((m) =>
          sdks.some((s) => (s === 'python' ? m.sdk === 'openai-python' : m.sdk === 'openai-node')),
        )
        .map((m) => `- ${m.sdk} ${m.version} (${m.date}): ${m.summary} ${m.source}`);
      return [
        ...notes,
        code.trim()
          ? findings.length
            ? `Old SDK shapes found:\n${[...new Set(findings)].join('\n')}`
            : 'No known old-SDK call shapes matched. That is not proof the code is current: the patterns are a hint list, so read the imports and calls yourself.'
          : 'No code given; here are the SDK majors to compare against.',
        `SDK majors (latest on ${sdkData.retrieved}: ${Object.entries(sdkData.latest)
          .filter(([k]) => k !== 'source')
          .map(([k, v]) => `${k} ${v}`)
          .join(', ')}):\n${majors.join('\n')}`,
        'Renames change call shapes only; parameters and models may also need changes (openai_check_request, openai_model_lookup). The grit-based `openai migrate` (python) / `npm exec openai migrate` (node) codemods were the official v1/v4 helpers.',
      ].join('\n\n');
    },
  });
}

// ---------- pack ----------

export type OpenAiToolPackOptions = ToolPackOptions & {
  /** Where the live OpenAPI spec is cached (default: the OS temp dir). */
  specCacheDir?: string;
};

export function createToolPack(options?: OpenAiToolPackOptions): ToolPack {
  const network: NetworkOptions = {};
  if (options?.fetch !== undefined) network.fetch = options.fetch;
  if (options?.timeoutMs !== undefined) network.timeoutMs = options.timeoutMs;
  return assembleToolPack({
    provider: 'openai',
    tools: [
      createModelLookupTool(network),
      createCheckRequestTool(network, options?.specCacheDir ?? tmpdir()),
      createSdkMigrationTool(),
    ],
    playbooksDir: new URL('./playbooks/', import.meta.url),
    options,
  });
}

export const toolPack: ToolPack = createToolPack();
