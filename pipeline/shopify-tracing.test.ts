import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readRepository } from './repository.ts';
import { scanShopify } from './shopify-analysis.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function directory(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-shopify-tracing-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const MANIFEST = JSON.stringify({
  name: 'app',
  dependencies: { '@shopify/shopify-api': '^11.0.0' },
});

it('reads raw Admin GraphQL requests, interpolated IDs, constant and environment versions', async () => {
  const root = await directory({
    'package.json': MANIFEST,
    'app/raw.ts': `const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';
export async function shopName(shop: string, token: string) {
  const query = \`query { shop { name } }\`;
  return fetch(\`https://\${shop}/admin/api/\${API_VERSION}/graphql.json\`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query }),
  });
}
export async function product(shop: string, id: string) {
  const url = \`https://\${shop}/admin/api/2025-01/graphql.json\`;
  return fetch(url, { method: 'POST', body: JSON.stringify({ query: \`query { product(id: "gid://shopify/Product/\${id}") { title } }\` }) });
}
`,
    'app/storefront.ts': `import { createStorefrontApiClient } from '@shopify/storefront-api-client';
const client = createStorefrontApiClient({ storeDomain: 'x', apiVersion: '2024-04', publicAccessToken: 't' });
export const cart = () => client.request(\`query { cart { id } }\`);
`,
    '.graphqlrc.ts': `import { ApiType, shopifyApiProject } from '@shopify/api-codegen-preset';
export default {
  projects: {
    default: shopifyApiProject({ apiType: ApiType.Admin, apiVersion: '2025-01' }),
    storefront: shopifyApiProject({ apiType: ApiType.Storefront, apiVersion: '2024-04' }),
  },
};
`,
    'app/admin.ts': `import { shopifyApi } from '@shopify/shopify-api';
const VERSION = '2025-01';
export const shopify = shopifyApi({ apiVersion: VERSION });
`,
  });
  const scan = scanShopify(await readRepository(root, '@shopify/shopify-api'));
  expect(scan.unreadable).toEqual([]);
  expect(scan.documents.map((entry) => [entry.file, entry.text, entry.traced, entry.api])).toEqual([
    ['app/raw.ts', 'query { shop { name } }', true, undefined],
    ['app/raw.ts', 'query { product(id: "gid://shopify/Product/x") { title } }', true, undefined],
    ['app/storefront.ts', 'query { cart { id } }', true, 'storefront'],
  ]);
  expect(
    scan.versions
      .map(
        (entry) =>
          `${entry.kind}:${entry.value}:${entry.file}:${entry.line}:${entry.envFallback ?? ''}:${entry.api ?? ''}`,
      )
      .sort(),
  ).toEqual([
    'string:2024-04:.graphqlrc.ts:5::storefront',
    'string:2024-04:app/storefront.ts:2::storefront',
    'string:2025-01:.graphqlrc.ts:4::',
    'string:2025-01:app/admin.ts:2::',
    'url:2025-01:app/raw.ts:11::',
    'url:2025-01:app/raw.ts:1:SHOPIFY_API_VERSION:',
  ]);
  expect(scan.unresolvedVersions).toEqual([]);
});

it('stops on a URL whose version Refit cannot read and on a raw request with a runtime body', async () => {
  const root = await directory({
    'package.json': MANIFEST,
    'app/raw.ts': `export async function send(shop: string, version: string, body: string) {
  return fetch(\`https://\${shop}/admin/api/\${version}/graphql.json\`, { method: 'POST', body });
}
`,
  });
  const scan = scanShopify(await readRepository(root, '@shopify/shopify-api'));
  expect(scan.unreadable.map((entry) => entry.reason.slice(0, 50))).toEqual([
    'A raw request to the Admin GraphQL endpoint whose ',
  ]);
  expect(scan.unresolvedVersions.map((entry) => entry.reason)).toEqual([
    'An Admin API URL takes its version from version, which Refit cannot resolve statically.',
  ]);
});

it('reads gql tags and imported graphql() documents, never a local graphql function', async () => {
  const root = await directory({
    'package.json': MANIFEST,
    'app/documents.ts': `import gql from 'graphql-tag';
import { graphql } from './gql';
export const SHOP = gql\`query Shop { shop { name } }\`;
export const PRODUCT = graphql(\`query Product { product(id: "1") { title } }\`);
`,
    'app/local.ts': `const graphql = (query: string) => fetch(query);
graphql('not a document');
`,
  });
  const scan = scanShopify(await readRepository(root, '@shopify/shopify-api'));
  expect(scan.documents.map((entry) => [entry.text, entry.traced])).toEqual([
    ['query Shop { shop { name } }', false],
    ['query Product { product(id: "1") { title } }', false],
  ]);
});

it('reads documents folded from constants, let bindings, returned literals and options parameters', async () => {
  const root = await directory({
    'package.json': MANIFEST,
    'app/queries.ts': `const PAGE_SIZE = 50;
export const PRODUCTS = \`#graphql
query Products { products(first: \${PAGE_SIZE}, reverse: \${true}) { id } }\`;
export function productQuery(id: string) {
  const gid = \`gid://shopify/Product/\${id}\`;
  return \`query { product(id: "\${gid}") { title } }\`;
}
`,
    'app/send.ts': `import { PRODUCTS, productQuery } from './queries';
async function send({ query, variables }: { query: string; variables?: object }, admin: any) {
  return admin.graphql(query, { variables });
}
async function wrap(admin: any, options: { document: string }) {
  return admin.graphql(\`#graphql\\n\${options.document}\`);
}
async function unused(admin: any, query: string) {
  return admin.graphql(query);
}
export async function loader(admin: any, id: string, flag: boolean) {
  let query = PRODUCTS;
  if (query === PRODUCTS && flag) query = \`query Shop { shop { name } }\`;
  await admin.graphql(query);
  await admin.graphql(productQuery(id));
  await send({ query: \`query Named { shop { name } }\` }, admin);
  await wrap(admin, { document: \`query Wrapped { shop { name } }\` });
  let built = 'query { ';
  built += 'shop { name } }';
  await admin.graphql(built);
}
`,
    'app/send.test.ts': `export const fixture = (admin: any, name: string) =>
  admin.graphql(\`#graphql
query \${name} { shop { name } }\`);
`,
  });
  const scan = scanShopify(await readRepository(root, '@shopify/shopify-api'));
  expect(scan.documents.map((entry) => [entry.file, entry.text.trim(), entry.traced])).toEqual([
    [
      'app/queries.ts',
      '#graphql\nquery Products { products(first: 50, reverse: true) { id } }',
      true,
    ],
    ['app/queries.ts', 'query { product(id: "x") { title } }', true],
    ['app/send.ts', 'query Shop { shop { name } }', true],
    ['app/send.ts', 'query Named { shop { name } }', true],
    ['app/send.ts', 'query Wrapped { shop { name } }', true],
  ]);
  // `+=` builds the document at runtime; the test's fixture and the uncalled helper send nothing.
  expect(scan.unreadable.map((entry) => [entry.file, entry.line, entry.reason])).toEqual([
    [
      'app/send.ts',
      20,
      'The document `built` is built at runtime; Refit only reads literal or constant documents.',
    ],
  ]);
});

it('reads every value a substitution takes across call sites, loops, lists and returned objects', async () => {
  const root = await directory({
    'package.json': MANIFEST,
    'app/constants.ts': `export const OWNER = 'PRODUCT';\n`,
    'app/models/index.ts': `export * from '../constants';\nexport * from './uses';\n`,
    'app/models/uses.ts': `import { OWNER } from '../constants';\nexport const label = OWNER;\n`,
    'app/queries.ts': `import { OWNER } from './models';
const GROUPS = [{ id: 'a', field: 'title' }, { id: 'b', field: 'id' }];
function fieldsQuery(field: string, sort?: string) {
  return \`query Fields { products(sortKey: \${sort || 'ID'}) { \${field} } }\`;
}
export async function load(admin: any, id: string, cursor?: string, flag = false) {
  const group = GROUPS.find((entry) => entry.id === id) || null;
  await admin.graphql(fieldsQuery(group.field));
  await admin.graphql(fieldsQuery('title', 'TITLE'));
  const after = cursor ? \`, after: "\${cursor}"\` : '';
  let filter = '';
  if (flag) filter = ', reverse: true';
  await admin.graphql(\`query Page { products(first: \${Math.min(Number(id), 50)}\${after}\${filter}) { id } }\`);
  for (const kind of ['title', 'id'] as const) await admin.graphql(\`query Kind { products { \${kind} } }\`);
  const items = [{ title: 'A' }];
  await admin.graphql(\`mutation { productCreate(input: [\${items.map((item) => \`{ title: """\${item.title}""" }\`).join(', ')}]) { product { id } } }\`);
  await admin.graphql(\`query Owner { products(sortKey: \${OWNER === 'PRODUCT' ? 'TITLE' : 'ID'}) { id } }\`);
}
export async function built(admin: any, flag: boolean) {
  let fields = 'id';
  fields += ' title';
  if (flag) fields = \`\${fields} title\`;
  await admin.graphql(\`query Built { products { \${fields} } }\`);
}
export async function runtime(admin: any, field: string) {
  await admin.graphql(\`query Runtime { products { \${field.toUpperCase()} } }\`);
}
function handler(admin: any) {
  const send = (query: string) => admin.graphql(query);
  return { api: { send } };
}
export async function factory(admin: any) {
  const { api } = handler(admin);
  await api.send(\`query Factory { shop { name } }\`);
  await handler(admin).api.send(\`query Direct { shop { name } }\`);
}
`,
  });
  const scan = scanShopify(await readRepository(root, '@shopify/shopify-api'));
  const texts = (name: string) =>
    scan.documents
      .filter((entry) => entry.text.includes(name))
      .map((entry) => entry.text.replace(/\s+/g, ' ').trim());
  // Every call's argument, the list `find` can return, and the `||` default. Substitutions vary
  // independently, so the variants are a superset of what the calls send.
  expect(texts('Fields')).toEqual([
    'query Fields { products(sortKey: TITLE) { title } }',
    'query Fields { products(sortKey: TITLE) { id } }',
    'query Fields { products(sortKey: ID) { title } }',
    'query Fields { products(sortKey: ID) { id } }',
  ]);
  // A number stands in for `Math.min`; each optional piece is there or not, strings get `x`.
  expect(texts('Page')).toEqual([
    'query Page { products(first: 1, after: "x") { id } }',
    'query Page { products(first: 1, after: "x", reverse: true) { id } }',
    'query Page { products(first: 1) { id } }',
    'query Page { products(first: 1, reverse: true) { id } }',
  ]);
  expect(texts('Kind')).toEqual([
    'query Kind { products { title } }',
    'query Kind { products { id } }',
  ]);
  // One list element per variant; block strings take a placeholder.
  expect(texts('productCreate')).toEqual([
    'mutation { productCreate(input: [{ title: """x""" }]) { product { id } } }',
  ]);
  // `export *` from two modules that pass on the same binding resolves to it.
  expect(texts('Owner')).toEqual([
    'query Owner { products(sortKey: TITLE) { id } }',
    'query Owner { products(sortKey: ID) { id } }',
  ]);
  // The unconditional append always runs; the conditional change may.
  expect(texts('Built')).toEqual([
    'query Built { products { id title } }',
    'query Built { products { id title title } }',
  ]);
  // A member of a nested object a factory returns, through destructuring and a direct call.
  expect(texts('Factory')).toEqual(['query Factory { shop { name } }']);
  expect(texts('Direct')).toEqual(['query Direct { shop { name } }']);
  expect(scan.unreadable.map((entry) => [entry.file, entry.line, entry.reason])).toEqual([
    [
      'app/queries.ts',
      26,
      'The document interpolates `${field.toUpperCase()}`, a value Refit cannot resolve to a constant fragment.',
    ],
  ]);
});

it('stops on values a loop rebuilds, a parameter nothing calls, and too many variants', async () => {
  const root = await directory({
    'package.json': MANIFEST,
    'app/send.ts': `export async function loop(admin: any, names: string[]) {
  let fields = 'id';
  for (const name of names) fields += \` \${name}\`;
  await admin.graphql(\`query Loop { shop { \${fields} } }\`);
}
export async function open(admin: any, field: string) {
  await admin.graphql(\`query Open { shop { \${field} } }\`);
}
export async function many(admin: any, a: boolean, b: boolean, c: boolean, d: boolean, e: boolean, f: boolean, g: boolean) {
  const pick = (flag: boolean) => (flag ? 'id' : 'name');
  await admin.graphql(\`query Many { shop { \${a ? 'id' : 'name'} \${b ? 'id' : 'name'} \${c ? 'id' : 'name'} \${d ? 'id' : 'name'} \${e ? 'id' : 'name'} \${f ? 'id' : 'name'} \${g ? 'id' : 'name'} } }\`);
}
`,
  });
  const scan = scanShopify(await readRepository(root, '@shopify/shopify-api'));
  expect(scan.documents).toEqual([]);
  expect(scan.unreadable.map((entry) => [entry.line, entry.reason])).toEqual([
    [4, 'The document interpolates `${fields}`, which a loop or another function changes.'],
    [
      7,
      'The document interpolates `${field}`, from the parameter `field`, and Refit cannot list every call of its function.',
    ],
    [11, 'The document can be built in more than 64 ways; Refit checks at most 64.'],
  ]);
});

it('follows clients built for the Admin endpoint, class fields, stored wrappers and Storefront calls', async () => {
  const root = await directory({
    'package.json': MANIFEST,
    'app/clients.ts': `import { GraphQLClient } from 'graphql-request';
import { createStorefrontApiClient } from '@shopify/storefront-api-client';
const client = new GraphQLClient(\`https://\${process.env.SHOP}/admin/api/2026-01/graphql.json\`, { headers: {} });
export const clientShop = () => client.request(\`query ClientShop { shop { name } }\`);
export class Repository {
  LIST = \`query Field { shop { name } }\`;
  private async run(query: string) {
    return client.request(query);
  }
  list() {
    return this.run(this.LIST);
  }
}
async function raw(shop: string, query: string) {
  const headers = { 'Content-Type': 'application/graphql' };
  return fetch(\`https://\${shop}/admin/api/2026-01/graphql.json\`, { method: 'POST', headers, body: query });
}
export async function stored(shop: string) {
  const adminClient = { graphql: async (query: string) => raw(shop, query) };
  return adminClient.graphql(\`query Stored { shop { name } }\`);
}
export async function sendDocument(admin: any, query: string) {
  return admin.graphql(query);
}
export const rest = (shop: string, path: string) => fetch(\`https://\${shop}/admin/api/2026-01/\${path}\`);
const storefront = createStorefrontApiClient({ storeDomain: 'x', apiVersion: '2026-01', publicAccessToken: 't' });
export const search = (term: string) => storefront.request(term);
`,
    'app/lazy.ts': `export async function lazy(admin: any) {
  const { sendDocument } = await import('./clients');
  return sendDocument(admin, \`query Lazy { shop { name } }\`);
}
`,
  });
  const scan = scanShopify(await readRepository(root, '@shopify/shopify-api'));
  expect(scan.documents.map((entry) => [entry.file, entry.text])).toEqual([
    ['app/clients.ts', 'query ClientShop { shop { name } }'],
    ['app/clients.ts', 'query Field { shop { name } }'],
    ['app/clients.ts', 'query Stored { shop { name } }'],
    ['app/lazy.ts', 'query Lazy { shop { name } }'],
  ]);
  // The Storefront document stays unread but is marked, so it never stops an Admin move.
  expect(scan.unreadable).toMatchObject([{ file: 'app/clients.ts', line: 27, api: 'storefront' }]);
  expect(scan.rest).toMatchObject([{ file: 'app/clients.ts', line: 25, path: '{path}' }]);
});

it('stops on a client or loaded module Refit cannot follow, and on a field code may reassign', async () => {
  const root = await directory({
    'package.json': MANIFEST,
    'app/clients.ts': `import { createGraphQLClient } from '@shopify/graphql-client';
export function adminClient(shop: string) {
  return createGraphQLClient({ url: \`https://\${shop}/admin/api/2026-01/graphql.json\` });
}
export class Repository {
  LIST = \`query Field { shop { name } }\`;
  constructor(admin: any) {
    this.admin = admin;
  }
  list() {
    return this.admin.graphql(this.LIST);
  }
}
export async function sendDocument(admin: any, query: string) {
  return admin.graphql(query);
}
`,
    'app/use.ts': `import { Repository } from './clients';
export async function use(admin: any) {
  const repository = new Repository(admin);
  repository.LIST = 'query Other { shop { name } }';
  const module = await import('./clients');
  return module.sendDocument(admin, 'query Lazy { shop { name } }');
}
`,
  });
  const scan = scanShopify(await readRepository(root, '@shopify/shopify-api'));
  expect(
    scan.unreadable.map((entry) => [entry.file, entry.line, entry.reason.slice(0, 60)]),
  ).toEqual([
    ['app/clients.ts', 3, 'A GraphQL client for the Admin endpoint is used here in a wa'],
    ['app/clients.ts', 11, 'The document `this.LIST` is built at runtime; Refit only rea'],
    ['app/use.ts', 5, 'A module defining a function that sends Admin GraphQL docume'],
  ]);
});

it('never drops a document an Admin call can still send', async () => {
  const URL = 'https://x.myshopify.com/admin/api/2026-01/graphql.json';
  const cases: Record<string, string> = {
    // A client member Refit does not read.
    'app/fetch.ts': `import { createGraphQLClient } from '@shopify/graphql-client';
const client = createGraphQLClient({ url: '${URL}' });
export const shop = () => client.fetch('query { shop { name } }');
`,
    // A literal both a Storefront and an Admin call send counts as Admin.
    'app/shared.ts': `const Q = \`query { shop { name \${dyn} } }\`;
export const a = (storefront: any) => storefront.query(Q);
export const b = (admin: any) => admin.graphql(Q);
`,
    // A readonly field the constructor can replace.
    'app/field.ts': `export class Repository {
  readonly q = 'query { shop { name } }';
  constructor(admin: any, q?: string) {
    if (q) this.q = q;
    this.admin = admin;
  }
  run() {
    return this.admin.graphql(this.q);
  }
}
`,
    // A private method taken out of \`this\`.
    'app/private.ts': `export class Service {
  private send(q: string, admin: any) {
    return admin.graphql(q);
  }
  run(admin: any, q: string) {
    const { send } = this;
    return send(q, admin);
  }
}
`,
    // A subclass reading the client field.
    'app/subclass.ts': `import { GraphQLClient } from 'graphql-request';
class Base {
  constructor() {
    this.client = new GraphQLClient('${URL}');
  }
}
export class Child extends Base {
  go(q: string) {
    return this.client.request(q);
  }
}
`,
    // A use of the endpoint Refit cannot read beside one it can.
    'app/raw.ts': `const ENDPOINT = '${URL}';
export const one = () => fetch(ENDPOINT, { method: 'POST', body: JSON.stringify({ query: 'query { shop { name } }' }) });
export const two = (init: RequestInit) => fetch(ENDPOINT, init);
`,
  };
  for (const [file, content] of Object.entries(cases)) {
    const root = await directory({ 'package.json': MANIFEST, [file]: content });
    const scan = scanShopify(await readRepository(root, '@shopify/shopify-api'));
    const admin = scan.unreadable.filter((entry) => !entry.api);
    expect(admin.length, file).toBeGreaterThan(0);
  }
});
