// Test doubles a behaviour test may hand to node:test's mock.module for the application's own
// dependencies: a database, a signed-in session, a Next.js request context, an Express app that is
// not exported. The test imports them from HARNESS_SPECIFIER. None of them answers for Stripe: the
// writer's parser refuses a mock of the stripe package, of a module that imports it, or of Node's
// network modules (behaviour-test-writer.ts), so every Stripe call still reaches stripe-mock or test
// mode through the real SDK. Each helper covers a library, never one repository.
export const HARNESS_SPECIFIER = 'refit-behaviour/harness';
export const HARNESS_FILE = 'behaviour-harness.mjs';

export const BEHAVIOUR_HARNESS = `import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const root = process.env.REFIT_GENERATED_ROOT ?? '/workspace/';
const used = (globalThis.__refitStandIns ??= new Set());

export const testUser = { id: 'user_refit_test', email: 'refit-test@example.com', name: 'Refit Test' };

// A value that works both when called synchronously and when awaited (Next.js 15 made these async).
const awaitable = (value, plain) => Object.defineProperty(value, 'then', { value: (resolve) => resolve(plain), enumerable: false });

// next/headers outside a request: headers() and cookies() answer from the values given here.
export function nextHeaders({ headers = {}, cookies = {} } = {}) {
  used.add('next/headers');
  const jar = new Map(Object.entries(cookies).map(([name, value]) => [name, String(value)]));
  const store = () => {
    const list = () => [...jar].map(([name, value]) => ({ name, value }));
    const self = {
      get: (name) => (jar.has(typeof name === 'object' ? name.name : name) ? { name, value: jar.get(typeof name === 'object' ? name.name : name) } : undefined),
      getAll: (name) => list().filter((cookie) => !name || cookie.name === name),
      has: (name) => jar.has(name),
      set: (name, value) => { typeof name === 'object' ? jar.set(name.name, String(name.value)) : jar.set(name, String(value)); return self; },
      delete: (name) => { jar.delete(typeof name === 'object' ? name.name : name); return self; },
      get size() { return jar.size; },
      toString: () => list().map((cookie) => cookie.name + '=' + cookie.value).join('; '),
      [Symbol.iterator]: () => list().map((cookie) => [cookie.name, cookie])[Symbol.iterator](),
    };
    return self;
  };
  const draft = () => ({ isEnabled: false, enable() {}, disable() {} });
  return {
    namedExports: {
      headers: () => awaitable(new Headers(headers), new Headers(headers)),
      cookies: () => awaitable(store(), store()),
      draftMode: () => awaitable(draft(), draft()),
    },
  };
}

// A NextRequest when the repository installs next, otherwise a Request with nextUrl.
export async function nextRequest(url, init) {
  try {
    const path = createRequire(root + 'package.json').resolve('next/server');
    const { NextRequest } = await import(pathToFileURL(path).href);
    return new NextRequest(url, init);
  } catch {
    return Object.assign(new Request(url, init), { nextUrl: new URL(url) });
  }
}

// next-auth: getServerSession (v4) and the NextAuth() result (v5) report this session; null signs out.
export function nextAuth(session = { user: { ...testUser, image: null }, expires: '2099-01-01T00:00:00.000Z' }) {
  used.add('next-auth');
  const getServerSession = async () => session;
  const NextAuth = () => ({ auth: getServerSession, handlers: { GET: async () => new Response(null), POST: async () => new Response(null) }, signIn: async () => {}, signOut: async () => {} });
  return { defaultExport: NextAuth, namedExports: { getServerSession, default: NextAuth } };
}

// @clerk/nextjs and @clerk/nextjs/server: auth() and currentUser() for this user; null signs out.
export function clerk(user = testUser) {
  used.add('clerk');
  const session = { userId: user?.id ?? null, sessionId: user ? 'sess_refit_test' : null, orgId: null, getToken: async () => (user ? 'refit_test_token' : null), has: () => Boolean(user), protect: () => session, redirectToSignIn: () => { throw new Error('redirectToSignIn'); } };
  const email = user && { id: 'idn_refit_test', emailAddress: user.email };
  const clerkUser = user && { id: user.id, firstName: 'Refit', lastName: 'Test', username: null, imageUrl: '', emailAddresses: [email], primaryEmailAddressId: email.id, primaryEmailAddress: email, publicMetadata: {}, privateMetadata: {}, unsafeMetadata: {} };
  const users = { getUser: async () => clerkUser, updateUserMetadata: async () => clerkUser, updateUser: async () => clerkUser };
  return {
    namedExports: {
      auth: () => Object.assign(Promise.resolve(session), session),
      currentUser: async () => clerkUser,
      clerkClient: Object.assign(async () => ({ users }), { users }),
      clerkMiddleware: (handler) => handler ?? (() => undefined),
      createRouteMatcher: () => () => false,
    },
  };
}

// @kinde-oss/kinde-auth-nextjs/server: getKindeServerSession() for this user; null signs out.
export function kinde(user = { id: 'kp_refit_test', email: testUser.email, given_name: 'Refit', family_name: 'Test', picture: null }) {
  used.add('kinde');
  const session = { getUser: async () => user, isAuthenticated: async () => Boolean(user), getPermission: async () => ({ isGranted: Boolean(user) }), getPermissions: async () => ({ permissions: [] }), getOrganization: async () => null, getUserOrganizations: async () => null, getAccessToken: async () => null, getIdToken: async () => null, getClaim: async () => null, getFlag: async () => null, getRoles: async () => [] };
  return { namedExports: { getKindeServerSession: () => session } };
}

// @auth0/nextjs-auth0: getSession() for this user; null signs out.
export function auth0(user = { sub: 'auth0|refit_test', email: testUser.email, name: testUser.name }) {
  used.add('auth0');
  const getSession = async () => (user ? { user } : null);
  const pass = (handler) => handler;
  return { namedExports: { getSession, withApiAuthRequired: pass, withPageAuthRequired: pass, getAccessToken: async () => ({ accessToken: user ? 'refit_test_token' : undefined }) } };
}

// Rows that match every filter; a filter is [column, test].
const matching = (rows, filters) => rows.filter((row) => filters.every(([column, test]) => test(row?.[column])));
const same = (left, right) => (left instanceof Date ? left.getTime() : left) === (right instanceof Date ? right.getTime() : right);

// supabase-js, @supabase/ssr and the auth helpers: one client over in-memory tables (arrays of rows,
// changed in place, so a test can read what the code wrote) and this signed-in user; null signs out.
export function supabase({ user = { ...testUser, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} }, tables = {} } = {}) {
  used.add('supabase');
  const from = (table) => {
    const rows = (tables[table] ??= []);
    const state = { operation: 'select', values: null, filters: [], single: null, limit: Infinity, conflict: 'id', returning: false };
    const filter = (column, test) => { state.filters.push([column, test]); return builder; };
    const run = () => {
      const found = matching(rows, state.filters);
      let data;
      if (state.operation === 'insert') {
        data = [state.values].flat().map((value) => ({ ...value }));
        rows.push(...data);
      } else if (state.operation === 'upsert') {
        data = [state.values].flat().map((value) => {
          const existing = rows.find((row) => same(row[state.conflict], value[state.conflict]));
          if (existing) return Object.assign(existing, value);
          rows.push({ ...value });
          return rows[rows.length - 1];
        });
      } else if (state.operation === 'update') data = found.map((row) => Object.assign(row, state.values));
      else if (state.operation === 'delete') {
        data = found;
        for (const row of found) rows.splice(rows.indexOf(row), 1);
      } else data = found;
      data = data.slice(0, state.limit);
      if (state.operation !== 'select' && !state.returning) return { data: null, error: null, count: data.length, status: 204 };
      if (state.single === 'single')
        return data.length === 1 ? { data: data[0], error: null, status: 200 } : { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: null, hint: null }, status: 406 };
      if (state.single === 'maybe') return { data: data[0] ?? null, error: null, status: 200 };
      return { data, error: null, count: data.length, status: 200 };
    };
    const builder = {
      select: () => { if (state.operation !== 'select') state.returning = true; return builder; },
      insert: (values) => { state.operation = 'insert'; state.values = values; return builder; },
      upsert: (values, options) => { state.operation = 'upsert'; state.values = values; state.conflict = options?.onConflict ?? 'id'; return builder; },
      update: (values) => { state.operation = 'update'; state.values = values; return builder; },
      delete: () => { state.operation = 'delete'; return builder; },
      eq: (column, value) => filter(column, (cell) => same(cell, value)),
      neq: (column, value) => filter(column, (cell) => !same(cell, value)),
      is: (column, value) => filter(column, (cell) => (cell ?? null) === value),
      in: (column, values) => filter(column, (cell) => values.some((value) => same(cell, value))),
      gt: (column, value) => filter(column, (cell) => cell > value),
      gte: (column, value) => filter(column, (cell) => cell >= value),
      lt: (column, value) => filter(column, (cell) => cell < value),
      lte: (column, value) => filter(column, (cell) => cell <= value),
      match: (values) => { for (const [column, value] of Object.entries(values)) filter(column, (cell) => same(cell, value)); return builder; },
      order: () => builder,
      range: () => builder,
      returns: () => builder,
      limit: (count) => { state.limit = count; return builder; },
      single: () => { state.single = 'single'; return builder; },
      maybeSingle: () => { state.single = 'maybe'; return builder; },
      then: (resolve, reject) => Promise.resolve().then(run).then(resolve, reject),
    };
    return builder;
  };
  const session = () => (user ? { user, access_token: 'refit_test_token', refresh_token: 'refit_test_refresh', token_type: 'bearer', expires_in: 3600 } : null);
  const signedOut = { name: 'AuthSessionMissingError', message: 'Auth session missing!', status: 400 };
  const auth = {
    getUser: async () => ({ data: { user }, error: user ? null : signedOut }),
    getSession: async () => ({ data: { session: session() }, error: null }),
    exchangeCodeForSession: async () => ({ data: { session: session(), user }, error: null }),
    signOut: async () => ({ error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    admin: { getUserById: async () => ({ data: { user }, error: null }) },
  };
  const client = { from, auth, rpc: async () => ({ data: null, error: null }), schema: () => client, channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {} };
  const create = () => client;
  return {
    namedExports: {
      createClient: create,
      createServerClient: create,
      createBrowserClient: create,
      createRouteHandlerClient: create,
      createServerComponentClient: create,
      createServerActionClient: create,
      createClientComponentClient: create,
      createMiddlewareClient: create,
      createPagesServerClient: create,
    },
  };
}

// A Prisma client over in-memory tables keyed by delegate name ({ user: [rows] }), changed in place.
// where matches by equality, { in }, { not } and { equals }; relations are not followed.
export function prisma(tables = {}) {
  used.add('prisma');
  const test = (condition) =>
    condition !== null && typeof condition === 'object' && !(condition instanceof Date)
      ? (cell) => ('equals' in condition ? same(cell, condition.equals) : true) && ('in' in condition ? condition.in.some((value) => same(cell, value)) : true) && ('not' in condition ? !same(cell, condition.not) : true)
      : (cell) => same(cell, condition);
  const where = (rows, clause = {}) =>
    matching(rows, Object.entries(clause).flatMap(([column, condition]) =>
      condition !== null && typeof condition === 'object' && !(condition instanceof Date) && !['equals', 'in', 'not'].some((key) => key in condition)
        ? Object.entries(condition).map(([inner, value]) => [inner, test(value)])
        : [[column, test(condition)]]));
  const notFound = () => Object.assign(new Error('No record was found for a query.'), { name: 'PrismaClientKnownRequestError', code: 'P2025' });
  const delegate = (name) => {
    const rows = (tables[name] ??= []);
    const operations = {
      findUnique: async ({ where: clause } = {}) => where(rows, clause)[0] ?? null,
      findFirst: async ({ where: clause } = {}) => where(rows, clause)[0] ?? null,
      findMany: async ({ where: clause, take } = {}) => where(rows, clause).slice(0, take ?? Infinity),
      count: async ({ where: clause } = {}) => where(rows, clause).length,
      create: async ({ data }) => { const row = { ...data }; rows.push(row); return row; },
      createMany: async ({ data }) => { rows.push(...[data].flat().map((row) => ({ ...row }))); return { count: [data].flat().length }; },
      update: async ({ where: clause, data }) => { const row = where(rows, clause)[0]; if (!row) throw notFound(); return Object.assign(row, data); },
      updateMany: async ({ where: clause, data }) => { const found = where(rows, clause); for (const row of found) Object.assign(row, data); return { count: found.length }; },
      upsert: async ({ where: clause, create, update }) => { const row = where(rows, clause)[0]; if (row) return Object.assign(row, update); rows.push({ ...create }); return rows[rows.length - 1]; },
      delete: async ({ where: clause }) => { const row = where(rows, clause)[0]; if (!row) throw notFound(); rows.splice(rows.indexOf(row), 1); return row; },
      deleteMany: async ({ where: clause } = {}) => { const found = where(rows, clause); for (const row of found) rows.splice(rows.indexOf(row), 1); return { count: found.length }; },
      aggregate: async () => ({}),
      groupBy: async () => [],
    };
    operations.findUniqueOrThrow = async (args) => (await operations.findUnique(args)) ?? Promise.reject(notFound());
    operations.findFirstOrThrow = async (args) => (await operations.findFirst(args)) ?? Promise.reject(notFound());
    return operations;
  };
  const client = new Proxy({}, {
    get(_, name) {
      if (typeof name !== 'string' || name === 'then') return undefined;
      if (name === '$transaction') return async (work) => (Array.isArray(work) ? Promise.all(work) : work(client));
      if (name === '$extends') return () => client;
      if (name.startsWith('$')) return async () => (name.startsWith('$query') ? [] : undefined);
      return delegate(name);
    },
  });
  return client;
}

// @prisma/client itself, for code that constructs its own PrismaClient.
export function prismaClient(tables = {}) {
  const client = prisma(tables);
  const error = (name) => class extends Error { constructor(message, details) { super(message); this.name = name; Object.assign(this, details); } };
  const Prisma = { PrismaClientKnownRequestError: error('PrismaClientKnownRequestError'), PrismaClientValidationError: error('PrismaClientValidationError'), Decimal: Number, JsonNull: null, DbNull: null };
  return { namedExports: { PrismaClient: function PrismaClient() { return client; }, Prisma } };
}

// Firestore over in-memory collections ({ users: { [id]: data } }), changed in place.
const firestoreStore = (collections) => {
  let next = 0;
  const table = (path) => (collections[path] ??= {});
  const apply = (target, values) => {
    for (const [key, value] of Object.entries(values)) {
      if (value?.__refitIncrement !== undefined) target[key] = (Number(target[key]) || 0) + value.__refitIncrement;
      else if (value?.__refitServerTime) target[key] = new Date();
      else if (value?.__refitDelete) delete target[key];
      else target[key] = value;
    }
    return target;
  };
  const operators = { '==': (a, b) => same(a, b), '!=': (a, b) => !same(a, b), '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b, in: (a, b) => b.some((value) => same(a, value)), 'array-contains': (a, b) => Array.isArray(a) && a.some((value) => same(value, b)) };
  const select = (path, filters, limit = Infinity) =>
    Object.entries(table(path)).filter(([, data]) => filters.every(([field, op, value]) => (operators[op] ?? operators['=='])(data[field], value))).slice(0, limit);
  return {
    newId: () => 'refit_doc_' + ++next,
    get: (path, id) => table(path)[id],
    set: (path, id, data, merge) => { table(path)[id] = merge ? apply(table(path)[id] ?? {}, data) : apply({}, data); },
    update: (path, id, data) => { if (!table(path)[id]) throw Object.assign(new Error('No document to update: ' + path + '/' + id), { code: 5 }); apply(table(path)[id], data); },
    remove: (path, id) => { delete table(path)[id]; },
    select,
  };
};
const sentinels = {
  serverTimestamp: () => ({ __refitServerTime: true }),
  increment: (value) => ({ __refitIncrement: value }),
  deleteField: () => ({ __refitDelete: true }),
  arrayUnion: (...values) => values,
};
const Timestamp = { now: () => ({ toDate: () => new Date(), toMillis: () => Date.now(), seconds: Math.floor(Date.now() / 1000) }), fromDate: (date) => ({ toDate: () => date, toMillis: () => date.getTime(), seconds: Math.floor(date.getTime() / 1000) }) };

// firebase-admin/firestore (getFirestore()) and firebase-admin's default export (admin.firestore()).
export function firestoreAdmin(collections = {}) {
  used.add('firestore');
  const store = firestoreStore(collections);
  const documentRef = (path, id) => ({
    id,
    path: path + '/' + id,
    get: async () => { const data = store.get(path, id); return { id, exists: data !== undefined, data: () => (data === undefined ? undefined : { ...data }), get: (field) => data?.[field], ref: documentRef(path, id) }; },
    set: async (data, options) => store.set(path, id, data, options?.merge),
    update: async (data) => store.update(path, id, data),
    delete: async () => store.remove(path, id),
    collection: (name) => collectionRef(path + '/' + id + '/' + name),
  });
  const queryRef = (path, filters = [], limit) => ({
    where: (field, op, value) => queryRef(path, [...filters, [field, op, value]], limit),
    orderBy: () => queryRef(path, filters, limit),
    limit: (count) => queryRef(path, filters, count),
    get: async () => {
      const docs = store.select(path, filters, limit).map(([id, data]) => ({ id, exists: true, data: () => ({ ...data }), get: (field) => data[field], ref: documentRef(path, id) }));
      return { docs, empty: !docs.length, size: docs.length, forEach: (callback) => docs.forEach(callback) };
    },
  });
  const collectionRef = (path) => ({ ...queryRef(path), id: path.split('/').pop(), doc: (id = store.newId()) => documentRef(path, id), add: async (data) => { const id = store.newId(); store.set(path, id, data); return documentRef(path, id); } });
  const db = { collection: collectionRef, doc: (path) => documentRef(path.split('/').slice(0, -1).join('/'), path.split('/').pop()), batch: () => ({ set: (ref, data, options) => ref.set(data, options), update: (ref, data) => ref.update(data), delete: (ref) => ref.delete(), commit: async () => [] }), runTransaction: async (work) => work({ get: (ref) => ref.get(), set: (ref, data, options) => ref.set(data, options), update: (ref, data) => ref.update(data), delete: (ref) => ref.delete() }) };
  const FieldValue = sentinels;
  const firestore = Object.assign(() => db, { FieldValue, Timestamp });
  const app = { name: '[DEFAULT]', firestore };
  const admin = { apps: [app], app: () => app, initializeApp: () => app, credential: { cert: () => ({}), applicationDefault: () => ({}) }, firestore, auth: () => ({ verifyIdToken: async () => ({ uid: testUser.id, email: testUser.email }), getUser: async () => ({ uid: testUser.id, email: testUser.email }) }) };
  return { defaultExport: admin, namedExports: { getFirestore: () => db, FieldValue, Timestamp, ...admin } };
}

// firebase/firestore's modular API (getFirestore, doc, getDoc, setDoc, query, where, ...).
export function firestore(collections = {}) {
  used.add('firestore');
  const store = firestoreStore(collections);
  const join = (parts) => parts.flatMap((part) => String(part).split('/')).filter(Boolean);
  const reference = (base, parts) => {
    const segments = [...(base?.segments ?? []), ...join(parts)];
    return segments.length % 2 ? { type: 'collection', segments, id: segments[segments.length - 1], path: segments.join('/'), filters: [] } : { type: 'document', segments, id: segments[segments.length - 1], path: segments.join('/') };
  };
  const location = (ref) => [ref.segments.slice(0, -1).join('/'), ref.segments[ref.segments.length - 1]];
  const snapshot = (ref) => { const data = store.get(...location(ref)); return { id: ref.id, ref, exists: () => data !== undefined, data: () => (data === undefined ? undefined : { ...data }), get: (field) => data?.[field] }; };
  return {
    namedExports: {
      getFirestore: () => ({ type: 'firestore', segments: [] }),
      initializeFirestore: () => ({ type: 'firestore', segments: [] }),
      collection: (base, ...parts) => reference(base, parts),
      doc: (base, ...parts) => (parts.length ? reference(base, parts) : reference(base, [store.newId()])),
      getDoc: async (ref) => snapshot(ref),
      setDoc: async (ref, data, options) => store.set(...location(ref), data, options?.merge),
      updateDoc: async (ref, data) => store.update(...location(ref), data),
      deleteDoc: async (ref) => store.remove(...location(ref)),
      addDoc: async (collectionRef, data) => { const ref = reference(collectionRef, [store.newId()]); store.set(...location(ref), data); return ref; },
      query: (collectionRef, ...constraints) => ({ ...collectionRef, filters: [...collectionRef.filters, ...constraints.filter((item) => item.type === 'where').map((item) => item.filter)], limit: constraints.find((item) => item.type === 'limit')?.count ?? collectionRef.limit }),
      where: (field, op, value) => ({ type: 'where', filter: [field, op, value] }),
      orderBy: () => ({ type: 'orderBy' }),
      limit: (count) => ({ type: 'limit', count }),
      getDocs: async (queryRef) => {
        const docs = store.select(queryRef.path, queryRef.filters, queryRef.limit).map(([id]) => snapshot(reference(queryRef, [id])));
        return { docs, empty: !docs.length, size: docs.length, forEach: (callback) => docs.forEach(callback) };
      },
      Timestamp,
      ...sentinels,
    },
  };
}

// express(): an app whose routes a test calls with request() instead of listening on a port, for an
// app module that registers routes and never exports them. Every app the code creates is in apps.
export const expressApps = [];
const segments = (path) => String(path).split('/').filter(Boolean);
// Params when the layer's path matches the request path: whole for a route, a prefix for use().
const matchPath = (layerPath, path, prefix) => {
  const want = segments(layerPath);
  const have = segments(path);
  const params = {};
  for (const [index, part] of want.entries()) {
    if (part === '*') return { params, rest: '/' };
    if (index >= have.length) return undefined;
    if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(have[index]);
    else if (part !== have[index]) return undefined;
  }
  if (!prefix && have.length !== want.length) return undefined;
  return { params, rest: '/' + have.slice(want.length).join('/') };
};
// Runs matching layers in order, like Express: next() moves on, next(error) skips to error handlers.
const dispatch = async (layers, req, res, path, error) => {
  for (const layer of layers) {
    const match = matchPath(layer.path, path, layer.use);
    if (!match || (!layer.use && layer.method !== 'all' && layer.method !== req.method.toLowerCase())) continue;
    Object.assign(req.params, match.params);
    if (layer.handler?.layers) {
      const result = await dispatch(layer.handler.layers, req, res, match.rest, error);
      if (result.stop) return result;
      error = result.error;
      continue;
    }
    if (error ? layer.handler.length !== 4 : layer.handler.length === 4) continue;
    let moved = false;
    let passed;
    try {
      const next = (value) => { moved = true; passed = value; };
      await (error ? layer.handler(error, req, res, next) : layer.handler(req, res, next));
    } catch (thrown) {
      moved = true;
      passed = thrown;
    }
    if (!moved) return { stop: true };
    error = passed && passed !== 'route' ? passed : undefined;
  }
  return { stop: false, error };
};
export function express() {
  used.add('express');
  const router = () => {
    const layers = [];
    const add = (method) => (path, ...handlers) => {
      if (typeof path !== 'string') { handlers.unshift(path); path = '/'; }
      for (const handler of handlers.flat()) layers.push({ method, path, handler, use: method === 'use' });
      return self;
    };
    const self = { layers, locals: {}, use: add('use'), all: add('all'), set: () => self, disable: () => self, enable: () => self, engine: () => self, param: () => self };
    for (const method of ['post', 'put', 'patch', 'delete', 'options', 'head']) self[method] = add(method);
    // app.get(name) reads a setting; app.get(path, handler) adds a route.
    self.get = (path, ...handlers) => (handlers.length ? add('get')(path, ...handlers) : undefined);
    self.route = (path) => {
      const route = {};
      for (const method of ['get', 'post', 'put', 'patch', 'delete', 'all']) route[method] = (...handlers) => { add(method)(path, ...handlers); return route; };
      return route;
    };
    return self;
  };
  const create = () => {
    const app = router();
    app.listen = (...args) => {
      args.find((arg) => typeof arg === 'function')?.();
      return { close: (callback) => callback?.(), address: () => ({ port: 0 }), on() { return this; } };
    };
    expressApps.push(app);
    return app;
  };
  const body = (kind) => (req, _res, next) => {
    const raw = req.rawBody;
    if (kind === 'raw') req.body = raw;
    else if (kind === 'json') req.body = req.parsedBody ?? (raw.length ? JSON.parse(raw.toString()) : {});
    else if (kind === 'urlencoded') req.body = req.parsedBody ?? Object.fromEntries(new URLSearchParams(raw.toString()));
    else req.body = raw.toString();
    next();
  };
  const passThrough = () => (_req, _res, next) => next();
  const factory = Object.assign(create, { Router: router, json: () => body('json'), raw: () => body('raw'), text: () => body('text'), urlencoded: () => body('urlencoded'), static: passThrough });
  return { defaultExport: factory, namedExports: { Router: router, json: factory.json, raw: factory.raw, text: factory.text, urlencoded: factory.urlencoded, static: passThrough } };
}

// Calls the routes of the last express() app (or the one given) and resolves with what the handler
// sent. body: an object (sent as JSON) or a string or Buffer (sent as is, for signed webhooks).
export async function request(method, path, { body, headers = {}, app = expressApps[expressApps.length - 1] } = {}) {
  if (!app) throw new Error('No express() app was created; import the module that creates it first.');
  const url = new URL(path, 'http://localhost');
  const raw = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const object = body !== undefined && typeof body === 'object' && !Buffer.isBuffer(body);
  if (object) lower['content-type'] ??= 'application/json';
  const req = { method: method.toUpperCase(), url: url.pathname + url.search, originalUrl: url.pathname + url.search, path: url.pathname, params: {}, query: Object.fromEntries(url.searchParams), headers: lower, rawBody: raw, parsedBody: object ? body : undefined, body: undefined, get: (name) => lower[name.toLowerCase()], header: (name) => lower[name.toLowerCase()] };
  const sent = { status: 200, headers: {}, body: undefined };
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const res = {
    locals: {},
    status(code) { sent.status = code; return res; },
    set(name, value) { if (typeof name === 'object') Object.assign(sent.headers, name); else sent.headers[name.toLowerCase()] = value; return res; },
    setHeader(name, value) { sent.headers[name.toLowerCase()] = value; return res; },
    header(name, value) { return res.set(name, value); },
    json(value) { sent.body = value; finish(); return res; },
    send(value) { sent.body = value; finish(); return res; },
    end(value) { if (value !== undefined) sent.body = value; finish(); return res; },
    sendStatus(code) { sent.status = code; finish(); return res; },
    redirect(status, location) { sent.status = typeof status === 'number' ? status : 302; sent.headers.location = typeof status === 'number' ? location : status; finish(); return res; },
    writeHead(code, values) { sent.status = code; Object.assign(sent.headers, values ?? {}); return res; },
    write(chunk) { sent.body = (sent.body ?? '') + chunk; return true; },
  };
  Object.defineProperty(res, 'statusCode', { get: () => sent.status, set: (code) => { sent.status = code; } });
  req.res = res;
  res.req = req;
  const result = await dispatch(app.layers, req, res, url.pathname);
  if (!result.stop) {
    if (result.error) { sent.status = 500; sent.body = String(result.error?.message ?? result.error); }
    else sent.status = 404;
    finish();
  }
  // A handler that answers after an awaited call it did not return (a callback) still finishes here.
  await done;
  return sent;
}
`;
