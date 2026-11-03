// openapi_lookup and openapi_check: read any OpenAPI 3.x or Swagger 2.0 spec (JSON or YAML) from a
// URL, find operations, and check a request's params and body against it. They report what the spec
// says; the agent decides what to change. The check is a validator: its result counts toward proof.

import type { AgentTool } from '../../shared/types.ts';
import { fetchPage, remember, type NetworkOptions } from './fetch.ts';
import { closest, rank } from './text.ts';
import { defineTool, num, obj, str, bool } from './tool.ts';
import { parseYaml } from './yaml.ts';

type Json = Record<string, unknown>;

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];
const MAX_DEPTH = 4;
const MAX_ENUM_SHOWN = 25;

const isObject = (value: unknown): value is Json =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export type Spec = {
  url: string;
  format: 'OpenAPI 3' | 'Swagger 2';
  version: string;
  title: string;
  apiVersion: string;
  /** Path prefixes from servers (OpenAPI 3) or basePath (Swagger 2), e.g. "/v1". */
  basePaths: string[];
  doc: Json;
};

export type Operation = {
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  deprecated: boolean;
  op: Json;
  parameters: Json[];
};

const specMemory = new Map<string, Spec>();

export function clearSpecMemory(): void {
  specMemory.clear();
}

/** Parse spec text (JSON or YAML) into a Spec, or say why it is not one. */
export function parseSpec(text: string, url: string): Spec | string {
  let doc: unknown;
  try {
    doc = /^\s*[{[]/.test(text) ? JSON.parse(text) : parseYaml(text);
  } catch (error) {
    return `could not parse it as JSON or YAML (${error instanceof Error ? error.message : String(error)})`;
  }
  if (!isObject(doc) || (!doc.openapi && !doc.swagger)) {
    return 'it is not an OpenAPI or Swagger document (no "openapi" or "swagger" field)';
  }
  const info = isObject(doc.info) ? doc.info : {};
  const basePaths = new Set<string>();
  if (doc.swagger && typeof doc.basePath === 'string') basePaths.add(doc.basePath);
  for (const server of Array.isArray(doc.servers) ? doc.servers : []) {
    if (!isObject(server) || typeof server.url !== 'string') continue;
    const variables = isObject(server.variables) ? server.variables : {};
    const filled = server.url.replace(/\{(\w+)\}/g, (_m, name: string) => {
      const variable = variables[name];
      return isObject(variable) && typeof variable.default === 'string' ? variable.default : '';
    });
    try {
      basePaths.add(new URL(filled, 'https://placeholder.invalid').pathname);
    } catch {
      // A server URL that does not parse adds no prefix.
    }
  }
  return {
    url,
    format: doc.swagger ? 'Swagger 2' : 'OpenAPI 3',
    version: String(doc.openapi ?? doc.swagger),
    title: typeof info.title === 'string' ? info.title : 'untitled API',
    apiVersion: info.version === undefined ? '?' : String(info.version),
    basePaths: [...basePaths].map((p) => p.replace(/\/+$/, '')).filter(Boolean),
    doc,
  };
}

export async function loadSpec(
  url: string,
  network: NetworkOptions,
): Promise<{ spec?: Spec; error?: string }> {
  const memo = specMemory.get(url);
  if (memo) return { spec: memo };
  const page = await fetchPage(url, {
    ...network,
    timeoutMs: network.timeoutMs ?? 60_000,
    headers: { accept: 'application/json, application/yaml, text/yaml, */*;q=0.8' },
  });
  if (!page.ok) return { error: `could not load ${url} (${page.error})` };
  const spec = parseSpec(page.text, page.url);
  if (typeof spec === 'string') return { error: `${url}: ${spec}` };
  remember(specMemory, url, spec, 20);
  return { spec };
}

/** Resolve a local "#/components/..." reference. External references are left unresolved. */
function deref(spec: Spec, value: unknown, seen = new Set<string>()): Json | undefined {
  let current = value;
  for (let i = 0; i < 20 && isObject(current) && typeof current.$ref === 'string'; i++) {
    const ref = current.$ref;
    if (!ref.startsWith('#/') || seen.has(ref)) return undefined;
    seen.add(ref);
    let node: unknown = spec.doc;
    for (const part of ref.slice(2).split('/')) {
      const key = decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~');
      node = isObject(node) ? node[key] : undefined;
    }
    current = node;
  }
  return isObject(current) ? current : undefined;
}

export function listOperations(spec: Spec): Operation[] {
  const paths = isObject(spec.doc.paths) ? spec.doc.paths : {};
  // OpenAPI 3.1 describes webhooks the provider sends as path items too; they are listed as
  // "webhook <name>" so their payloads can be looked up like request bodies.
  const webhooks = isObject(spec.doc.webhooks) ? spec.doc.webhooks : {};
  const items = [
    ...Object.entries(paths),
    ...Object.entries(webhooks).map(([name, item]) => [`webhook ${name}`, item] as const),
  ];
  const out: Operation[] = [];
  for (const [path, rawItem] of items) {
    const item = deref(spec, rawItem);
    if (!item) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const op = deref(spec, item[method]);
      if (!op) continue;
      const own = Array.isArray(op.parameters) ? op.parameters : [];
      const byKey = new Map<string, Json>();
      for (const raw of [...shared, ...own]) {
        const param = deref(spec, raw);
        if (param && typeof param.name === 'string') byKey.set(`${param.in}:${param.name}`, param);
      }
      out.push({
        method: method.toUpperCase(),
        path,
        operationId: typeof op.operationId === 'string' ? op.operationId : undefined,
        summary: typeof op.summary === 'string' ? op.summary : undefined,
        deprecated: op.deprecated === true,
        op,
        parameters: [...byKey.values()],
      });
    }
  }
  return out;
}

function templateRegex(path: string): RegExp {
  const pattern = path
    .split('/')
    .map((segment) =>
      segment
        .split(/(\{[^}]+\})/)
        .map((part) =>
          /^\{[^}]+\}$/.test(part) ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        )
        .join(''),
    )
    .join('/');
  return new RegExp(`^${pattern}/?$`);
}

/** Find the operation for "POST /v1/things/123", a full URL, a bare path, or an operationId. */
export function findOperation(
  spec: Spec,
  input: string,
  methodHint?: string,
): { operation?: Operation; candidates: Operation[]; tried: string } {
  const operations = listOperations(spec);
  const text = input.trim();
  const byId = operations.filter((op) => op.operationId && op.operationId === text);
  if (byId.length) return { operation: byId[0], candidates: byId, tried: text };
  const match = /^(GET|PUT|POST|DELETE|PATCH|HEAD|OPTIONS|TRACE)\s+(\S+)$/i.exec(text);
  const method = (match?.[1] ?? methodHint)?.toUpperCase();
  let path = (match?.[2] ?? text).replace(/^[a-z]+:\/\/[^/]+/i, '').split(/[?#]/)[0];
  if (!path.startsWith('/')) path = `/${path}`;
  const variants = new Set([path]);
  for (const base of spec.basePaths) {
    if (path.startsWith(`${base}/`)) variants.add(path.slice(base.length));
  }
  const scored: { op: Operation; literal: number }[] = [];
  for (const op of operations) {
    if (method && op.method !== method) continue;
    for (const candidate of variants) {
      if (op.path === candidate || templateRegex(op.path).test(candidate)) {
        const literal = op.path.split('/').filter((s) => s && !s.includes('{')).length;
        scored.push({ op, literal: op.path === candidate ? literal + 100 : literal });
        break;
      }
    }
  }
  scored.sort((a, b) => b.literal - a.literal);
  const candidates = scored.map((s) => s.op);
  return { operation: candidates[0], candidates, tried: `${method ?? '(any method)'} ${path}` };
}

// ---------------------------------------------------------------------------------------------
// Schema shapes

export type Shape = {
  type: string;
  props?: Record<string, Shape>;
  required?: string[];
  /** Other properties are allowed (additionalProperties, or a free-form object). */
  open?: boolean;
  enum?: string[];
  items?: Shape;
  deprecated?: boolean;
  readOnly?: boolean;
  nullable?: boolean;
  /** Nested deeper than the checker follows. */
  deeper?: boolean;
};

export function shapeOf(spec: Spec, raw: unknown, depth = 0, stack = new Set<unknown>()): Shape {
  const schema = deref(spec, raw);
  if (!schema) return { type: 'any', open: true };
  if (
    schema.type === 'null' ||
    (Array.isArray(schema.type) && schema.type.every((t) => t === 'null'))
  ) {
    return { type: 'null', nullable: true };
  }
  if (stack.has(schema) || depth > MAX_DEPTH) return { type: 'object', deeper: true, open: true };
  stack.add(schema);
  try {
    const types = new Set<string>();
    const rawType = schema.type;
    for (const t of Array.isArray(rawType) ? rawType : rawType ? [rawType] : []) {
      if (t === 'null') continue;
      types.add(String(t));
    }
    const shape: Shape = { type: '' };
    if (schema.deprecated === true) shape.deprecated = true;
    if (schema.readOnly === true) shape.readOnly = true;
    if (schema.nullable === true || (Array.isArray(rawType) && rawType.includes('null'))) {
      shape.nullable = true;
    }
    if (Array.isArray(schema.enum)) {
      shape.enum = schema.enum.filter((v) => v !== null).map((v) => String(v));
    }
    if (isObject(schema.properties)) {
      shape.props = {};
      for (const [name, child] of Object.entries(schema.properties)) {
        shape.props[name] = shapeOf(spec, child, depth + 1, stack);
      }
      types.add('object');
    }
    if (Array.isArray(schema.required)) shape.required = schema.required.map(String);
    if (schema.additionalProperties === true || isObject(schema.additionalProperties)) {
      shape.open = true;
    }
    if (schema.items !== undefined) {
      shape.items = shapeOf(spec, schema.items, depth + 1, stack);
      types.add('array');
    }
    shape.type = [...types].join('|') || 'any';
    let merged = shape;
    // allOf: every part applies, so their fields add up.
    for (const part of Array.isArray(schema.allOf) ? schema.allOf : []) {
      const variant = shapeOf(spec, part, depth, stack);
      if (variant.type === 'null') merged.nullable = true;
      else merged = mergeShapes(merged, variant, 'all');
    }
    // oneOf and anyOf: a value fits if it fits one variant, so a field is unknown only if no
    // variant has it. anyOf [X, {type: null}] is how OpenAPI 3.1 says "X or null".
    const variants = [
      ...(Array.isArray(schema.oneOf) ? schema.oneOf : []),
      ...(Array.isArray(schema.anyOf) ? schema.anyOf : []),
    ].map((part) => shapeOf(spec, part, depth, stack));
    const real = variants.filter((variant) => variant.type !== 'null');
    if (real.length < variants.length) merged.nullable = true;
    if (real.length) {
      merged = mergeShapes(
        merged,
        real.reduce((a, b) => mergeShapes(a, b, 'any')),
        'all',
      );
    }
    if (merged.type === 'any' && !merged.props && !merged.items && !merged.enum) merged.open = true;
    if (merged.type.split('|').includes('object') && !merged.props) merged.open = true;
    return merged;
  } finally {
    stack.delete(schema);
  }
}

/** Combine two shapes: 'all' when both apply (allOf), 'any' when either may (oneOf, anyOf). */
function mergeShapes(a: Shape, b: Shape, mode: 'all' | 'any'): Shape {
  const types = new Set(
    [...a.type.split('|'), ...b.type.split('|')].filter((t) => t && t !== 'any'),
  );
  const out: Shape = { type: [...types].join('|') || 'any' };
  if (a.props || b.props) {
    out.props = { ...a.props };
    for (const [name, child] of Object.entries(b.props ?? {})) {
      out.props[name] = out.props[name] ? mergeShapes(out.props[name], child, mode) : child;
    }
  }
  if (mode === 'all') {
    const required = new Set([...(a.required ?? []), ...(b.required ?? [])]);
    if (required.size) out.required = [...required];
    const enumValues =
      a.enum && b.enum ? a.enum.filter((v) => b.enum?.includes(v)) : (a.enum ?? b.enum);
    if (enumValues) out.enum = enumValues;
    if (a.open || b.open) out.open = true;
    if (a.deprecated || b.deprecated) out.deprecated = true;
  } else {
    const required = (a.required ?? []).filter((name) => b.required?.includes(name));
    if (required.length) out.required = required;
    // An enum still limits the value only when every variant has one.
    if (a.enum && b.enum) out.enum = [...new Set([...a.enum, ...b.enum])];
    const leafOpen = (s: Shape) => s.open || (s.type === 'any' && !s.props && !s.enum);
    if (leafOpen(a) || leafOpen(b)) out.open = true;
    if (a.deprecated && b.deprecated) out.deprecated = true;
  }
  if (a.items || b.items) {
    out.items = a.items && b.items ? mergeShapes(a.items, b.items, mode) : (a.items ?? b.items);
  }
  if (a.nullable || b.nullable) out.nullable = true;
  if (a.readOnly || b.readOnly) out.readOnly = true;
  if (a.deeper || b.deeper) out.deeper = true;
  return out;
}

function describeType(shape: Shape): string {
  if (shape.type.includes('array') && shape.items) return `array of ${shape.items.type}`;
  return shape.type;
}

type BodyInfo = { contentType?: string; shape?: Shape; required: boolean };

function requestBody(spec: Spec, operation: Operation): BodyInfo {
  if (spec.format === 'Swagger 2') {
    const body = operation.parameters.find((p) => p.in === 'body');
    if (body)
      return {
        contentType: 'application/json',
        shape: shapeOf(spec, body.schema),
        required: body.required === true,
      };
    const form = operation.parameters.filter((p) => p.in === 'formData');
    if (form.length) {
      const props: Record<string, Shape> = {};
      for (const p of form)
        props[String(p.name)] = shapeOf(spec, { type: p.type, enum: p.enum, items: p.items });
      return {
        contentType: 'application/x-www-form-urlencoded',
        shape: {
          type: 'object',
          props,
          required: form.filter((p) => p.required === true).map((p) => String(p.name)),
        },
        required: false,
      };
    }
    return { required: false };
  }
  const body = deref(spec, operation.op.requestBody);
  const content = isObject(body?.content) ? body.content : {};
  const types = Object.keys(content);
  const contentType =
    types.find((t) => /json/i.test(t)) ??
    types.find((t) => /x-www-form-urlencoded/i.test(t)) ??
    types.find((t) => /multipart/i.test(t)) ??
    types[0];
  if (!contentType) return { required: false };
  const media = isObject(content[contentType]) ? content[contentType] : {};
  return { contentType, shape: shapeOf(spec, media.schema), required: body?.required === true };
}

function paramShape(spec: Spec, param: Json): Shape {
  if (param.schema !== undefined) return shapeOf(spec, param.schema);
  return shapeOf(spec, { type: param.type, enum: param.enum, items: param.items });
}

// ---------------------------------------------------------------------------------------------
// Request checking

export type CheckFindings = {
  unknown: string[];
  missing: string[];
  deprecated: string[];
  enumMismatch: string[];
  typeNotes: string[];
  readOnly: string[];
  unchecked: string[];
};

function typeOfValue(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function fits(value: unknown, shape: Shape, form: boolean): boolean {
  if (shape.type === 'any' || value === null) return true;
  const types = shape.type.split('|');
  const actual = typeOfValue(value);
  if (types.includes(actual)) return true;
  if (actual === 'integer' && types.includes('number')) return true;
  // Form and query values travel as strings, so a string standing for a number or boolean is fine.
  if (form && actual === 'string') return true;
  if (actual === 'object' && types.includes('object')) return true;
  return false;
}

function checkValue(
  path: string,
  value: unknown,
  shape: Shape,
  f: CheckFindings,
  form: boolean,
): void {
  if (shape.deprecated) f.deprecated.push(path);
  if (shape.readOnly) f.readOnly.push(path);
  if (value === undefined) return;
  if (value === null) {
    if (!shape.nullable && shape.type !== 'any')
      f.typeNotes.push(`${path}: null, and the spec does not mark it nullable`);
    return;
  }
  if (!fits(value, shape, form)) {
    f.typeNotes.push(`${path}: got ${typeOfValue(value)}, the spec says ${describeType(shape)}`);
    return;
  }
  if (
    shape.enum?.length &&
    (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
  ) {
    if (!shape.enum.includes(String(value))) {
      const allowed = shape.enum.slice(0, MAX_ENUM_SHOWN).join(', ');
      const near = closest(String(value), shape.enum);
      f.enumMismatch.push(
        `${path} = ${JSON.stringify(value)} (allowed: ${allowed}${shape.enum.length > MAX_ENUM_SHOWN ? ', ...' : ''})${near.length ? `; did you mean ${near.join(', ')}?` : ''}`,
      );
    }
  }
  if (Array.isArray(value) && shape.items) {
    value.forEach((item, i) => checkValue(`${path}[${i}]`, item, shape.items as Shape, f, form));
    return;
  }
  if (isObject(value)) checkObject(path, value, shape, f, form);
}

function checkObject(
  prefix: string,
  value: Json,
  shape: Shape,
  f: CheckFindings,
  form: boolean,
): void {
  if (shape.deeper) {
    f.unchecked.push(`${prefix || '(body)'}.* (nested deeper than the checker follows)`);
    return;
  }
  const props = shape.props ?? {};
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const spec = props[key];
    if (!spec) {
      if (!shape.open) {
        const near = closest(key, Object.keys(props));
        f.unknown.push(`${path}${near.length ? ` (did you mean ${near.join(', ')}?)` : ''}`);
      }
      continue;
    }
    checkValue(path, child, spec, f, form);
  }
  for (const name of shape.required ?? []) {
    if (!(name in value)) f.missing.push(prefix ? `${prefix}.${name}` : name);
  }
}

export type RequestInput = {
  params?: Json;
  body?: unknown;
};

const TRANSPORT_HEADERS = ['authorization', 'content-type', 'accept', 'user-agent', 'cookie'];

/** Header and query names the spec's apiKey security schemes use, plus common transport headers. */
function authNames(spec: Spec): Set<string> {
  const components = isObject(spec.doc.components) ? spec.doc.components : {};
  const schemes = {
    ...(isObject(spec.doc.securityDefinitions) ? spec.doc.securityDefinitions : {}),
    ...(isObject(components.securitySchemes) ? components.securitySchemes : {}),
  };
  const names = new Set(TRANSPORT_HEADERS);
  for (const scheme of Object.values(schemes)) {
    const resolved = deref(spec, scheme);
    if (resolved?.type === 'apiKey' && typeof resolved.name === 'string') {
      names.add(resolved.name.toLowerCase());
    }
  }
  return names;
}

export function checkRequest(spec: Spec, operation: Operation, input: RequestInput): CheckFindings {
  const f: CheckFindings = {
    unknown: [],
    missing: [],
    deprecated: [],
    enumMismatch: [],
    typeNotes: [],
    readOnly: [],
    unchecked: [],
  };
  const declared = operation.parameters.filter((p) => p.in !== 'body' && p.in !== 'formData');
  const byName = new Map(declared.map((p) => [String(p.name), p]));
  const body = requestBody(spec, operation);
  const auth = authNames(spec);
  const leftover: Json = {};
  for (const [name, value] of Object.entries(input.params ?? {})) {
    const param =
      byName.get(name) ??
      [...byName.values()].find(
        (p) => String(p.name).toLowerCase() === name.toLowerCase() && p.in === 'header',
      );
    if (!param) {
      // Credentials and transport headers are set by the client, not described as params.
      if (auth.has(name.toLowerCase())) f.unchecked.push(`${name} (auth or transport header)`);
      else leftover[name] = value;
      continue;
    }
    if (param.deprecated === true) f.deprecated.push(`${param.in} param ${name}`);
    checkValue(`${param.in} param ${name}`, value, paramShape(spec, param), f, param.in !== 'body');
  }
  for (const param of declared) {
    if (
      param.required === true &&
      param.in !== 'path' &&
      param.in !== 'header' &&
      !(String(param.name) in (input.params ?? {}))
    ) {
      f.missing.push(`${param.in} param ${param.name}`);
    }
  }
  const form = !!body.contentType && !/json/i.test(body.contentType);
  const bodyValue =
    input.body !== undefined ? input.body : Object.keys(leftover).length ? leftover : undefined;
  if (input.body !== undefined && Object.keys(leftover).length) {
    f.unknown.push(
      ...Object.keys(leftover).map(
        (name) => `${name} (not a declared path, query, header or cookie param)`,
      ),
    );
  }
  if (bodyValue !== undefined) {
    if (!body.shape) {
      if (input.body === undefined) {
        f.unknown.push(
          ...Object.keys(leftover).map(
            (name) => `${name} (not a declared param, and the operation takes no body)`,
          ),
        );
      } else {
        f.typeNotes.push(
          'a body was given, but the spec declares no request body for this operation',
        );
      }
    } else if (isObject(bodyValue)) {
      checkObject('', bodyValue, body.shape, f, form);
    } else {
      checkValue('(body)', bodyValue, body.shape, f, form);
    }
  } else if (body.required && body.shape) {
    f.missing.push(`the request body (${body.contentType})`);
  }
  return f;
}

// ---------------------------------------------------------------------------------------------
// Reports

function specLine(spec: Spec): string {
  return `Spec: ${spec.title} ${spec.apiVersion} (${spec.format}, ${spec.version}) from ${spec.url}${spec.basePaths.length ? `; base paths ${spec.basePaths.join(', ')}` : ''}.`;
}

/** Search words from a path or id: "/pet/findByStatus" -> "pet find By Status". */
function words(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[/{}_.-]+/g, ' ');
}

function operationLine(op: Operation): string {
  return `${op.method} ${op.path}${op.operationId ? ` (${op.operationId})` : ''}${op.deprecated ? ' [deprecated]' : ''}`;
}

function shapeLines(shape: Shape, indent: string, depth: number, out: string[], limit = 60): void {
  const required = new Set(shape.required ?? []);
  for (const [name, child] of Object.entries(shape.props ?? {})) {
    if (out.length >= limit) {
      out.push(`${indent}...`);
      return;
    }
    const flags = [
      required.has(name) ? 'required' : '',
      child.deprecated ? 'deprecated' : '',
      child.readOnly ? 'read-only' : '',
      child.nullable ? 'nullable' : '',
    ]
      .filter(Boolean)
      .join(', ');
    const enums = child.enum?.length
      ? ` one of ${child.enum.slice(0, 12).join(' | ')}${child.enum.length > 12 ? ' | ...' : ''}`
      : '';
    out.push(`${indent}- ${name}: ${describeType(child)}${enums}${flags ? ` (${flags})` : ''}`);
    const nested = child.props ? child : child.items?.props ? child.items : undefined;
    if (nested && depth < 2) shapeLines(nested, `${indent}  `, depth + 1, out, limit);
  }
}

function responseLines(spec: Spec, op: Operation): string[] {
  const responses = isObject(op.op.responses) ? op.op.responses : {};
  const out: string[] = [];
  for (const [status, raw] of Object.entries(responses)) {
    const response = deref(spec, raw);
    let schema: unknown = response?.schema;
    if (isObject(response?.content)) {
      const content = response.content;
      const type = Object.keys(content).find((t) => /json/i.test(t)) ?? Object.keys(content)[0];
      schema = type && isObject(content[type]) ? content[type].schema : undefined;
    }
    const shape = schema === undefined ? undefined : shapeOf(spec, schema);
    const names = Object.keys(shape?.props ?? shape?.items?.props ?? {});
    out.push(
      `- ${status}: ${shape ? describeType(shape) : 'no body'}${names.length ? ` with ${names.slice(0, 20).join(', ')}${names.length > 20 ? ', ...' : ''}` : ''}`,
    );
  }
  return out;
}

export function operationDetails(spec: Spec, op: Operation): string {
  const out = [`Operation: ${operationLine(op)}`];
  if (op.summary) out.push(`Summary: ${op.summary}`);
  const params = op.parameters.filter((p) => p.in !== 'body' && p.in !== 'formData');
  if (params.length) {
    out.push('Parameters:');
    for (const p of params) {
      const shape = paramShape(spec, p);
      const flags = [
        p.required === true ? 'required' : '',
        p.deprecated === true || shape.deprecated ? 'deprecated' : '',
      ]
        .filter(Boolean)
        .join(', ');
      const enums = shape.enum?.length ? ` one of ${shape.enum.slice(0, 12).join(' | ')}` : '';
      out.push(
        `- ${p.name} (${p.in}): ${describeType(shape)}${enums}${flags ? ` (${flags})` : ''}`,
      );
    }
  }
  const body = requestBody(spec, op);
  if (body.shape) {
    out.push(
      `Request body (${body.contentType}${body.required ? ', required' : ''}): ${describeType(body.shape)}`,
    );
    const lines: string[] = [];
    shapeLines(body.shape.props ? body.shape : (body.shape.items ?? body.shape), '  ', 0, lines);
    out.push(...lines);
  }
  const responses = responseLines(spec, op);
  if (responses.length) out.push('Responses:', ...responses);
  return out.join('\n');
}

function deprecatedReport(spec: Spec): string {
  const lines: string[] = [];
  for (const op of listOperations(spec)) {
    if (op.deprecated) lines.push(`- operation ${operationLine(op)}`);
    for (const p of op.parameters) {
      if (p.deprecated === true) lines.push(`- ${op.method} ${op.path}: ${p.in} param ${p.name}`);
    }
    const body = requestBody(spec, op).shape;
    for (const [name, child] of Object.entries(body?.props ?? {})) {
      if (child.deprecated) lines.push(`- ${op.method} ${op.path}: body field ${name}`);
    }
  }
  return lines.length
    ? `Marked deprecated in this spec (${lines.length}):\n${lines.slice(0, 80).join('\n')}${lines.length > 80 ? '\n...' : ''}`
    : 'Nothing in this spec is marked deprecated.';
}

export type OpenApiLookupInput = {
  spec_url?: string;
  operation?: string;
  method?: string;
  search?: string;
  deprecated?: boolean;
  limit?: number;
};

export async function lookupReport(
  input: OpenApiLookupInput,
  network: NetworkOptions,
  defaultSpec?: string,
): Promise<string> {
  const url = input.spec_url ?? defaultSpec;
  if (!url)
    return 'Pass "spec_url": the URL of the OpenAPI or Swagger document (JSON or YAML). Providers often publish it on GitHub or under /openapi.json.';
  const { spec, error } = await loadSpec(url, network);
  if (!spec)
    return `Could not use the spec: ${error}. Try the raw file URL (raw.githubusercontent.com for GitHub), or the JSON form.`;
  const out = [specLine(spec)];
  if (input.deprecated) {
    out.push(deprecatedReport(spec));
    return out.join('\n');
  }
  if (input.operation) {
    const { operation, candidates, tried } = findOperation(spec, input.operation, input.method);
    if (!operation) {
      const near = rank(
        input.operation.replace(/[/{}_.-]/g, ' '),
        listOperations(spec),
        (op) => `${op.method} ${op.path} ${op.operationId ?? ''}`,
      ).slice(0, 8);
      out.push(`No operation matches ${tried}.`);
      if (near.length)
        out.push('Closest operations:', ...near.map((n) => `- ${operationLine(n.item)}`));
      return out.join('\n');
    }
    if (candidates.length > 1)
      out.push(`Also matched: ${candidates.slice(1, 5).map(operationLine).join('; ')}`);
    out.push(operationDetails(spec, operation));
    return out.join('\n');
  }
  const operations = listOperations(spec);
  const limit = input.limit ?? 25;
  const chosen = input.search
    ? rank(
        input.search,
        operations,
        (op) =>
          `${op.method} ${op.path} ${words(op.path)} ${words(op.operationId ?? '')} ${op.summary ?? ''}`,
      ).map((r) => r.item)
    : operations;
  out.push(
    `${operations.length} operations${input.search ? `; ${chosen.length} match "${input.search}"` : ''}. Showing ${Math.min(limit, chosen.length)}:`,
  );
  out.push(
    ...chosen
      .slice(0, limit)
      .map((op) => `- ${operationLine(op)}${op.summary ? `: ${op.summary}` : ''}`),
  );
  out.push(
    'Pass "operation" for one operation\'s params, body and responses, or "deprecated": true for everything the spec marks deprecated.',
  );
  return out.join('\n');
}

export type OpenApiCheckInput = {
  spec_url?: string;
  operation?: string;
  method?: string;
  params?: Json;
  body?: unknown;
};

export async function checkReport(
  input: OpenApiCheckInput,
  network: NetworkOptions,
  defaultSpec?: string,
): Promise<string> {
  const url = input.spec_url ?? defaultSpec;
  if (!url)
    return 'openapi_check failed to run: pass "spec_url" (the OpenAPI or Swagger document) and "operation". Nothing was checked.';
  if (!input.operation)
    return 'openapi_check failed to run: pass "operation", e.g. "POST /v1/messages" or an operationId, plus "params" and/or "body". Nothing was checked.';
  const { spec, error } = await loadSpec(url, network);
  if (!spec) return `openapi_check failed to run: ${error}. Nothing was checked.`;
  const out = [specLine(spec)];
  const { operation, candidates, tried } = findOperation(spec, input.operation, input.method);
  if (!operation) {
    const near = rank(
      input.operation.replace(/[/{}_.-]/g, ' '),
      listOperations(spec),
      (op) => `${op.method} ${op.path} ${op.operationId ?? ''}`,
    ).slice(0, 5);
    out.push('Result: 1 error(s), 0 warning(s).');
    out.push(
      `Operation not in this spec: ${tried}.${near.length ? ` Closest: ${near.map((n) => operationLine(n.item)).join('; ')}.` : ''}`,
    );
    out.push(
      'It may have been removed or renamed, or the spec may describe another version. Check the changelog for it.',
    );
    return out.join('\n');
  }
  if (candidates.length > 1)
    out.push(
      `${tried} also matched ${candidates.slice(1, 4).map(operationLine).join('; ')}; checked the most specific.`,
    );
  out.push(`Operation: ${operationLine(operation)}`);
  if (input.params === undefined && input.body === undefined) {
    out.push(
      'openapi_check failed to run: pass "params" (path, query and header values, or body fields) and/or "body" to check. Nothing was checked; openapi_lookup shows what the operation takes.',
    );
    return out.join('\n');
  }
  const f = checkRequest(spec, operation, { params: input.params, body: input.body });
  const errors =
    f.unknown.length +
    f.missing.length +
    f.enumMismatch.length +
    f.typeNotes.length +
    (operation.deprecated ? 1 : 0);
  const warnings = f.deprecated.length + f.readOnly.length;
  out.push(`Result: ${errors} error(s), ${warnings} warning(s).`);
  if (operation.deprecated)
    out.push(
      'Deprecated in the spec: the whole operation. Find its replacement in the changelog or docs.',
    );
  if (f.unknown.length) out.push(`Unknown params: ${f.unknown.join('; ')}`);
  if (f.missing.length) out.push(`Required by the spec but missing: ${f.missing.join('; ')}`);
  if (f.deprecated.length) out.push(`Deprecated in the spec: ${f.deprecated.join('; ')}`);
  if (f.enumMismatch.length) out.push(`Enum mismatch: ${f.enumMismatch.join('; ')}`);
  if (f.typeNotes.length) out.push(`Type mismatch: ${f.typeNotes.join('; ')}`);
  if (f.readOnly.length)
    out.push(`Read-only in the spec (the server sets them): ${f.readOnly.join('; ')}`);
  if (f.unchecked.length) out.push(`Not checked: ${f.unchecked.join('; ')}`);
  if (!errors && !warnings)
    out.push('No problems found: every param and field is in the spec with a fitting type.');
  out.push(
    'This checks the request against the spec only. It does not call the API or check responses.',
  );
  return out.join('\n');
}

export function createOpenApiTools(
  options: NetworkOptions & { specUrl?: string } = {},
): AgentTool[] {
  const { specUrl, ...network } = options;
  const known = specUrl ? ` Default spec: ${specUrl}.` : '';
  const lookup = defineTool({
    name: 'openapi_lookup',
    description: `Read an OpenAPI 3 or Swagger 2 spec (JSON or YAML) from its URL: search operations, show one operation's params, request body and response fields, or list everything marked deprecated. Informational.${known}`,
    inputSchema: {
      type: 'object',
      properties: {
        spec_url: {
          type: 'string',
          description: 'URL of the spec document (raw file, not a docs page).',
        },
        operation: {
          type: 'string',
          description: 'e.g. "POST /v1/messages", a full request URL, or an operationId.',
        },
        search: { type: 'string', description: 'Words to find operations by path, id or summary.' },
        deprecated: {
          type: 'boolean',
          description: 'List deprecated operations, params and body fields.',
        },
        limit: { type: 'number', description: 'Operations to list (default 25).' },
      },
    },
    run: async (input) =>
      lookupReport(
        {
          spec_url: str(input, 'spec_url') ?? str(input, 'url'),
          operation: str(input, 'operation'),
          method: str(input, 'method'),
          search: str(input, 'search') ?? str(input, 'query'),
          deprecated: bool(input, 'deprecated'),
          limit: num(input, 'limit'),
        },
        network,
        specUrl,
      ),
  });
  const check = defineTool({
    name: 'openapi_check',
    description: `Check a request against an OpenAPI 3 or Swagger 2 spec: unknown or misspelled params, missing required ones, deprecated params or operations, enum and type mismatches. A validator: run it on the changed call sites; its result counts toward proof.${known}`,
    inputSchema: {
      type: 'object',
      properties: {
        spec_url: { type: 'string', description: 'URL of the spec document.' },
        operation: {
          type: 'string',
          description: 'e.g. "POST /v1/messages", a full request URL, or an operationId.',
        },
        params: {
          type: 'object',
          description:
            'Path, query and header values the code sends; other keys are checked as body fields.',
        },
        body: {
          description: 'The JSON body the code sends, when you want it checked apart from params.',
        },
      },
      required: ['operation'],
    },
    run: async (input) =>
      checkReport(
        {
          spec_url: str(input, 'spec_url') ?? str(input, 'url'),
          operation: str(input, 'operation'),
          method: str(input, 'method'),
          params: obj(input, 'params'),
          body: typeof input.body === 'string' ? safeJson(input.body) : input.body,
        },
        network,
        specUrl,
      ),
  });
  return [lookup, check];
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
