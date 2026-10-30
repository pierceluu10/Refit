import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isObject, parseObject } from './specifications.ts';
import { hasErrorCode } from './state-files.ts';

// Stand-ins let application code in Refit's own sandbox checks (generated stripe-mock checks and
// behaviour tests) get past what it needs before its Stripe lines: a database, a signed-in user, a
// service at a placeholder address. They never enter the patch or the repository's own checks, and
// none of them answers for Stripe: the `stripe` module and api.stripe.com are never replaced, so a
// Stripe call still goes to stripe-mock exactly as before.

const MAX_SCHEMA_BYTES = 1024 * 1024;
const IDENTIFIER = /^[A-Za-z_]\w*$/;

export interface PrismaField {
  type: string;
  list?: true;
}

export interface RuntimeStandIns {
  // Models and enums of the committed Prisma schema; `@prisma/client` is served from them.
  prisma?: {
    schema: string[];
    models: Record<string, Record<string, PrismaField>>;
    enums: Record<string, string[]>;
  };
}

async function readText(path: string) {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.size > MAX_SCHEMA_BYTES) return undefined;
    return await readFile(path, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) return undefined;
    throw error;
  }
}

async function prismaFiles(directory: string, path: string): Promise<string[]> {
  if (path.endsWith('.prisma')) return [path];
  try {
    return (await readdir(join(directory, path)))
      .filter((name) => name.endsWith('.prisma'))
      .sort()
      .map((name) => `${path}/${name}`);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) return [];
    throw error;
  }
}

// Where `prisma generate` looks without --schema: package.json's prisma.schema, then
// prisma/schema.prisma, then schema.prisma, then a prisma/schema directory of .prisma files.
export async function prismaSchemaPaths(directory: string): Promise<string[]> {
  const manifest = await readText(join(directory, 'package.json'));
  const configured = manifest
    ? (() => {
        const parsed = parseObject(manifest, 'package.json');
        return isObject(parsed.prisma) && typeof parsed.prisma.schema === 'string'
          ? parsed.prisma.schema.replace(/^\.\//, '').replace(/\/$/, '')
          : undefined;
      })()
    : undefined;
  const candidates = configured
    ? configured.split('/').every((part) => part && part !== '.' && part !== '..')
      ? [configured]
      : []
    : ['prisma/schema.prisma', 'schema.prisma', 'prisma/schema'];
  for (const candidate of candidates) {
    const files = [];
    for (const file of await prismaFiles(directory, candidate))
      if ((await readText(join(directory, file))) !== undefined) files.push(file);
    if (files.length) return files;
  }
  return [];
}

// Reads model fields and enum values; attributes, defaults and relations' arguments are not needed.
export function parsePrismaSchema(content: string) {
  const models: Record<string, Record<string, PrismaField>> = {};
  const enums: Record<string, string[]> = {};
  const text = content.replace(/\/\/.*$/gm, '');
  for (const block of text.matchAll(/^\s*(model|enum)\s+(\w+)\s*\{([^}]*)\}/gm)) {
    const [, kind, name, body] = block;
    if (!IDENTIFIER.test(name)) continue;
    const lines = body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('@@'));
    if (kind === 'enum') {
      enums[name] = lines
        .map((line) => line.split(/\s+/)[0])
        .filter((value) => IDENTIFIER.test(value));
      continue;
    }
    const fields: Record<string, PrismaField> = {};
    for (const line of lines) {
      const field = /^(\w+)\s+(\w+)(\[\])?\??/.exec(line);
      if (field && IDENTIFIER.test(field[1]))
        fields[field[1]] = { type: field[2], ...(field[3] ? { list: true as const } : {}) };
    }
    models[name] = fields;
  }
  return { models, enums };
}

export async function runtimeStandIns(directory: string): Promise<RuntimeStandIns> {
  const schema = await prismaSchemaPaths(directory);
  if (!schema.length) return {};
  const models: Record<string, Record<string, PrismaField>> = {};
  const enums: Record<string, string[]> = {};
  for (const file of schema) {
    const parsed = parsePrismaSchema((await readText(join(directory, file)))!);
    Object.assign(models, parsed.models);
    Object.assign(enums, parsed.enums);
  }
  return Object.keys(models).length ? { prisma: { schema, models, enums } } : {};
}

// Session helpers replaced in their own module, keyed by import specifier: the module's other
// exports (and its default export, where it has one) still come from the installed package.
export const AUTH_STAND_INS: Record<string, { names: string[]; defaultExport: boolean }> = {
  'next-auth': { names: ['getServerSession'], defaultExport: true },
  'next-auth/next': { names: ['getServerSession'], defaultExport: true },
  '@clerk/nextjs': { names: ['auth', 'currentUser'], defaultExport: false },
  '@clerk/nextjs/server': { names: ['auth', 'currentUser'], defaultExport: false },
};

// The sandbox module behind the stand-ins (stand-ins.mjs next to the load hook). Every stand-in it
// hands out is recorded in globalThis.__refitStandIns, which the harness prints.
export const STAND_INS_RUNTIME = `const used = (globalThis.__refitStandIns ??= new Set());
const PLACEHOLDER_ORIGIN = 'http://127.0.0.1:9';
const DATE = '2026-01-01T00:00:00.000Z';
const placeholder = (name) => 'refit_placeholder_' + name;

export const standInUser = {
  id: placeholder('user'),
  email: 'refit-placeholder@example.invalid',
  name: 'Refit Placeholder',
};

// Supabase (PostgREST, auth, storage) and other services the code reaches at the placeholder URL
// Refit sets for its *_URL variables. A query answers one row with each selected column.
function columns(select) {
  const names = [];
  let depth = 0;
  let current = '';
  for (const character of select ?? '') {
    if (character === '(') depth++;
    if (character === ')') depth--;
    if (character === ',' && depth === 0) { names.push(current); current = ''; continue; }
    current += character;
  }
  names.push(current);
  return names
    .map((name) => name.trim())
    .filter((name) => name && name !== '*' && !name.includes('('))
    .map((name) => (name.includes(':') ? name.split(':')[0] : name).replace(/::.*$/, '').trim());
}

function serviceResponse(url, method, headers) {
  const json = (status, body, extra = {}) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...extra },
    });
  const path = url.pathname;
  if (path.includes('/auth/v1/')) {
    used.add('supabase-auth');
    const user = { ...standInUser, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: DATE };
    return path.endsWith('/user') ? json(200, user) : json(200, { access_token: placeholder('token'), token_type: 'bearer', expires_in: 3600, refresh_token: placeholder('refresh'), user });
  }
  if (path.includes('/rest/v1/')) {
    used.add('postgrest');
    const row = Object.fromEntries(columns(url.searchParams.get('select')).map((name) => [name, placeholder(name)]));
    const accept = headers.get('accept') ?? '';
    const prefer = headers.get('prefer') ?? '';
    const range = { 'content-range': '0-0/1' };
    if (method !== 'GET' && method !== 'HEAD' && !prefer.includes('return=representation'))
      return json(method === 'POST' ? 201 : 204, undefined, range);
    return json(200, accept.includes('vnd.pgrst.object') ? row : [row], range);
  }
  used.add('placeholder-service');
  return json(200, {});
}

const originalFetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const request = input instanceof Request ? input : undefined;
  let url;
  try { url = new URL(request ? request.url : String(input)); } catch { return originalFetch.call(this, input, init); }
  if (url.origin !== PLACEHOLDER_ORIGIN) return originalFetch.call(this, input, init);
  const method = String(init?.method ?? request?.method ?? 'GET').toUpperCase();
  const headers = new Headers(init?.headers ?? request?.headers);
  return Promise.resolve(serviceResponse(url, method, headers));
};

// A Prisma client with each model's delegate answering from placeholder records typed by the
// committed schema; nothing reaches a database or a query engine.
export function prismaModule({ models, enums }) {
  const value = (field, { type, list }) => {
    const one = enums[type]
      ? enums[type][0]
      : { String: placeholder(field), Int: 1, Float: 1, Decimal: 1, BigInt: 1n, Boolean: false, DateTime: new Date(DATE), Json: {}, Bytes: new Uint8Array() }[type];
    return one === undefined ? undefined : list ? [one] : one;
  };
  const record = (model) => {
    const result = {};
    for (const [field, definition] of Object.entries(models[model] ?? {})) {
      const scalar = value(field, definition);
      if (scalar !== undefined) result[field] = scalar;
    }
    return result;
  };
  const written = (data) =>
    Object.fromEntries(Object.entries(data ?? {}).filter(([, item]) => item === null || item instanceof Date || typeof item !== 'object'));
  const included = (model, include) => {
    const result = {};
    for (const [field, wanted] of Object.entries(include ?? {})) {
      const relation = models[model]?.[field];
      if (!wanted || !relation || !models[relation.type]) continue;
      result[field] = relation.list ? [record(relation.type)] : record(relation.type);
    }
    return result;
  };
  const answer = (model, operation, args = {}) => {
    const one = () => ({ ...record(model), ...included(model, args.include), ...written(args.data ?? args.create) });
    switch (operation) {
      case 'findMany': return [one()];
      case 'count': return 1;
      case 'createMany': case 'createManyAndReturn': case 'updateMany': case 'deleteMany': return operation === 'createManyAndReturn' ? [one()] : { count: 1 };
      case 'aggregate': return {};
      case 'groupBy': return [];
      default: return one();
    }
  };
  const delegate = (model) =>
    new Proxy({}, {
      get: (_, operation) =>
        typeof operation === 'string'
          ? (args) => { used.add('prisma'); return Promise.resolve(answer(model, operation, args)); }
          : undefined,
    });
  class PrismaClient {
    constructor() {
      for (const model of Object.keys(models)) this[model[0].toLowerCase() + model.slice(1)] = delegate(model);
    }
    $connect() { return Promise.resolve(); }
    $disconnect() { return Promise.resolve(); }
    $on() {}
    $use() {}
    $extends() { return this; }
    $transaction(operations) { used.add('prisma'); return Array.isArray(operations) ? Promise.all(operations) : Promise.resolve(operations(this)); }
    $queryRaw() { used.add('prisma'); return Promise.resolve([]); }
    $queryRawUnsafe() { return this.$queryRaw(); }
    $executeRaw() { used.add('prisma'); return Promise.resolve(0); }
    $executeRawUnsafe() { return this.$executeRaw(); }
  }
  const error = (name) => class extends Error { constructor(message, details) { super(message); this.name = name; Object.assign(this, details); } };
  const Prisma = {
    PrismaClientKnownRequestError: error('PrismaClientKnownRequestError'),
    PrismaClientUnknownRequestError: error('PrismaClientUnknownRequestError'),
    PrismaClientValidationError: error('PrismaClientValidationError'),
    PrismaClientInitializationError: error('PrismaClientInitializationError'),
    ModelName: Object.fromEntries(Object.keys(models).map((model) => [model, model])),
    JsonNull: null, DbNull: null, AnyNull: null,
    Decimal: Number,
    validator: () => (value) => value,
    sql: (strings, ...values) => ({ strings, values }),
    raw: (value) => value,
    join: (values) => values,
    empty: '',
  };
  return {
    PrismaClient,
    Prisma,
    enums: Object.fromEntries(
      Object.entries(enums).map(([name, values]) => [name, Object.fromEntries(values.map((item) => [item, item]))]),
    ),
  };
}

// Session helpers that report a signed-in stand-in user. Clerk's auth() is synchronous before v6
// and asynchronous after, so it returns a promise carrying the same fields.
export const authStandIns = {
  getServerSession: async () => { used.add('next-auth'); return { user: { ...standInUser, image: null }, expires: DATE }; },
  auth: () => {
    used.add('clerk');
    const session = { userId: standInUser.id, sessionId: placeholder('session'), orgId: null, orgRole: null, getToken: async () => placeholder('token'), has: () => true, protect: () => session, redirectToSignIn: () => { throw new Error('redirectToSignIn'); } };
    return Object.assign(Promise.resolve(session), session);
  },
  currentUser: async () => {
    used.add('clerk');
    const email = { id: placeholder('email'), emailAddress: standInUser.email };
    return { id: standInUser.id, firstName: 'Refit', lastName: 'Placeholder', username: null, imageUrl: '', emailAddresses: [email], primaryEmailAddressId: email.id, primaryEmailAddress: email, publicMetadata: {}, privateMetadata: {}, unsafeMetadata: {} };
  },
};
`;
