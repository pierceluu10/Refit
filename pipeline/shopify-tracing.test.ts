import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSchema, introspectionFromSchema } from 'graphql';
import { afterEach, expect, it, vi } from 'vitest';
import { readRepository } from './repository.ts';
import { scanShopify } from './shopify-analysis.ts';
import {
  loadShopifyDocumentRules,
  rewriteDocument,
  variableRules,
  type ShopifyDocumentRule,
} from './shopify-document-rules.ts';
import { digest, shopifySchemaUrl } from './specifications.ts';

// The pipeline reads its rules from data/rules/shopify; tests supply theirs.
const rules = vi.hoisted(() => ({ current: [] as unknown[] }));
vi.mock('./shopify-document-rules.ts', async (actual) => ({
  ...(await actual<typeof import('./shopify-document-rules.ts')>()),
  loadShopifyDocumentRules: () => rules.current,
}));
const { runPipeline } = await import('./run.ts');

const roots: string[] = [];
afterEach(async () => {
  rules.current = [];
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

// `bodyHtml` is renamed `descriptionHtml`, the `sortKey` argument `sort`, the enum value
// `TITLE` `NAME` and the input field `bodyHtml` `descriptionHtml` in the after version; `vendor`
// becomes `vendorName` with another type.
const SCHEMA = (version: 'before' | 'after') => {
  const after = version === 'after';
  return `
  enum ProductSortKeys { ${after ? 'NAME' : 'TITLE'} ID }
  type Vendor { name: String! }
  type Product {
    id: ID!
    title: String!
    ${after ? 'descriptionHtml: String!' : 'bodyHtml: String!'}
    ${after ? 'vendorName: Vendor' : 'vendor: String'}
  }
  input ProductInput { title: String ${after ? 'descriptionHtml' : 'bodyHtml'}: String }
  type ProductCreatePayload { product: Product }
  type Shop { name: String! }
  type QueryRoot {
    product(id: ID!): Product
    products(${after ? 'sort' : 'sortKey'}: ProductSortKeys): [Product!]!
    shop: Shop!
  }
  type Mutation { productCreate(input: ProductInput!): ProductCreatePayload }
  schema { query: QueryRoot mutation: Mutation }
`;
};

async function snapshots(root: string) {
  const write = async (name: string, version: string, sdl: string) => {
    const content = JSON.stringify({ data: introspectionFromSchema(buildSchema(sdl)) });
    const path = join(root, `${name}.json`);
    await writeFile(
      path,
      JSON.stringify({
        formatVersion: 1,
        kind: 'refit-graphql-snapshot',
        provider: 'shopify',
        version,
        url: shopifySchemaUrl(version),
        hash: digest(content),
        content,
      }),
    );
    return path;
  };
  // The fallback reads the versions in between beside the target snapshot; they have the target's
  // schema here.
  await write('2026-01', '2026-01', SCHEMA('before'));
  await write('2026-04', '2026-04', SCHEMA('after'));
  await write('2026-07', '2026-07', SCHEMA('after'));
  return {
    before: await write('before', '2026-01', SCHEMA('before')),
    after: await write('after', '2026-10', SCHEMA('after')),
  };
}

const MANIFEST = JSON.stringify({
  name: 'app',
  dependencies: { '@shopify/shopify-api': '^11.0.0' },
});

const SOURCE = 'https://shopify.dev/changelog/example';
// Rules as the tables write them (pipeline/shopify-rules.ts), all `auto`.
const TABLE_RULES = [
  {
    rule: 'shopify-product-body-html',
    coordinate: 'Product.bodyHtml',
    replacement: 'Product.descriptionHtml',
  },
  {
    rule: 'shopify-products-sort-key',
    coordinate: 'QueryRoot.products(sortKey:)',
    replacement: 'QueryRoot.products(sort:)',
  },
  { rule: 'shopify-product-sort-title', coordinate: 'ProductSortKeys.TITLE', replacement: 'NAME' },
  {
    rule: 'shopify-product-input-body-html',
    coordinate: 'ProductInput.bodyHtml',
    replacement: 'descriptionHtml',
  },
].map((entry) => ({ ...entry, family: 'graphql-rename', status: 'auto', source: SOURCE }));

async function tableRules(entries: unknown[], version = '2026-04', api = 'admin') {
  const actual = await vi.importActual<typeof import('./shopify-document-rules.ts')>(
    './shopify-document-rules.ts',
  );
  const root = await directory({
    [`${api}-${version}.json`]: JSON.stringify({
      formatVersion: 1,
      provider: 'shopify',
      api,
      version,
      previous: '2026-01',
      rules: entries,
    }),
  });
  return actual.loadShopifyDocumentRules('2026-10', pathToFileURL(`${root}/`));
}

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

it('rewrites a breaking document by documented rules and keeps response keys with an alias', async () => {
  rules.current = await tableRules(TABLE_RULES);
  const root = await directory({
    'package.json': MANIFEST,
    'app/shopify.server.ts': `import { shopifyApi, ApiVersion } from '@shopify/shopify-api';
export const shopify = shopifyApi({ apiVersion: '2026-01' });
`,
    'app/routes/products.ts': `export async function loader(admin) {
  const response = await admin.graphql(\`#graphql
    query { products(sortKey: TITLE) { id bodyHtml } }\`);
  const created = await admin.graphql(\`#graphql
    mutation { productCreate(input: { title: "a", bodyHtml: "<p>b</p>" }) { product { id html: bodyHtml } } }\`);
  return [response, created];
}
`,
    'app/graphql/ProductFields.graphql': 'fragment ProductFields on Product { id bodyHtml }\n',
    'app/graphql/Product.graphql': 'query Product { product(id: "1") { ...ProductFields } }\n',
  });
  const report = (await runPipeline({
    repository: root,
    ...(await snapshots(root)),
    proposePatch: true,
  })) as any;
  expect(report.patch.status).toBe('proposed');
  expect(report.shopify.ruleEdits).toBe(6);
  expect(report.findings.filter((entry: any) => entry.contractReview)).toEqual([]);
  const diff: string = report.patch.diff;
  expect(diff).toContain('+    query { products(sort: NAME) { id bodyHtml: descriptionHtml } }`);');
  expect(diff).toContain(
    '+    mutation { productCreate(input: { title: "a", descriptionHtml: "<p>b</p>" }) { product { id html: descriptionHtml } } }`);',
  );
  expect(diff).toContain('+fragment ProductFields on Product { id bodyHtml: descriptionHtml }');
  expect(diff).toContain("+export const shopify = shopifyApi({ apiVersion: '2026-10' });");
  expect(diff).not.toContain('Product.graphql');
});

it('refuses a rename whose field changes type and keeps the document stopped', async () => {
  const before = buildSchema(SCHEMA('before'));
  const after = buildSchema(SCHEMA('after'));
  const vendor: ShopifyDocumentRule = {
    rule: 'vendor',
    family: 'graphql-field-rename',
    type: 'Product',
    member: 'vendor',
    replacement: 'vendorName',
    source: SOURCE,
  };
  const rewrite = rewriteDocument('query { product(id: "1") { vendor } }', before, after, [vendor]);
  expect(rewrite).toMatchObject({ refusal: expect.stringContaining('change shape') });
  expect(
    rewriteDocument('query { shop { name } }', before, after, await tableRules(TABLE_RULES)),
  ).toBeUndefined();
});

it('loads only auto Admin rules it can make in place, up to the target version', async () => {
  const loaded = await tableRules([
    TABLE_RULES[0],
    { ...TABLE_RULES[1], status: 'review-only' },
    { ...TABLE_RULES[2], family: 'rest-to-graphql' },
    { ...TABLE_RULES[3], replacement: 'not a name' },
    {
      ...TABLE_RULES[0],
      rule: 'moved',
      coordinate: 'Shop.draftOrders',
      replacement: 'QueryRoot.draftOrders',
    },
    {
      ...TABLE_RULES[1],
      rule: 'drop',
      family: 'graphql-argument-drop',
      coordinate: 'QueryRoot.products(sortKey:)',
      value: 'TITLE',
    },
  ]);
  expect(loaded.map((rule) => `${rule.rule}:${rule.family}`)).toEqual([
    'shopify-product-body-html:graphql-field-rename',
    'shopify-product-body-html:graphql-input-field-rename',
    'shopify-product-body-html:graphql-enum-value-rename',
    'drop:graphql-argument-drop',
  ]);
  expect(await tableRules(TABLE_RULES, '2027-01')).toEqual([]);
  expect(await tableRules(TABLE_RULES, '2026-04', 'storefront')).toEqual([]);
  expect(loadShopifyDocumentRules).not.toBe(
    (
      await vi.importActual<typeof import('./shopify-document-rules.ts')>(
        './shopify-document-rules.ts',
      )
    ).loadShopifyDocumentRules,
  );
});

it('drops an argument only when the document sends the value the rule names', async () => {
  const [drop] = await tableRules([
    {
      ...TABLE_RULES[1],
      rule: 'drop',
      family: 'graphql-argument-drop',
      coordinate: 'QueryRoot.products(sortKey:)',
      value: 'TITLE',
    },
  ]);
  const before = buildSchema(SCHEMA('before'));
  const afterSchema = buildSchema(
    SCHEMA('before').replace('products(sortKey: ProductSortKeys)', 'products'),
  );
  expect(
    rewriteDocument('query { products(sortKey: TITLE) { id } }', before, afterSchema, [drop]),
  ).toMatchObject({
    text: 'query { products { id } }',
  });
  expect(
    rewriteDocument('query { products(sortKey: ID) { id } }', before, afterSchema, [drop]),
  ).toBeUndefined();
});

it('fixes documents that already fail on the oldest supported version and stops on variables a change reaches', async () => {
  rules.current = await tableRules([
    ...TABLE_RULES,
    {
      ...TABLE_RULES[2],
      rule: 'relevance',
      coordinate: 'ProductSortKeys.RELEVANCE',
      replacement: 'ProductSortKeys.ID',
    },
  ]);
  const server = `import { shopifyApi } from '@shopify/shopify-api';
export const shopify = shopifyApi({ apiVersion: '2026-01' });
`;
  const root = await directory({
    'package.json': MANIFEST,
    'app/shopify.server.ts': server,
    'app/routes/products.ts': `export const loader = (admin) =>
  admin.graphql(\`#graphql
    query { products(sortKey: RELEVANCE) { id } }\`);
`,
  });
  const fixed = (await runPipeline({
    repository: root,
    ...(await snapshots(root)),
    proposePatch: true,
  })) as any;
  expect(fixed.patch.status).toBe('proposed');
  expect(fixed.patch.diff).toContain('+    query { products(sort: ID) { id } }`);');

  const variables = await directory({
    'package.json': MANIFEST,
    'app/shopify.server.ts': server,
    'app/routes/create.ts': `export const action = (admin, input) =>
  admin.graphql(\`#graphql
    mutation Create($input: ProductInput!) { productCreate(input: $input) { product { id } } }\`, { variables: { input } });
`,
  });
  const stopped = (await runPipeline({
    repository: variables,
    ...(await snapshots(variables)),
    proposePatch: true,
  })) as any;
  expect(stopped.patch.status).toBe('not-generated');
  expect(
    stopped.findings.find((entry: any) => entry.changeId.startsWith('shopify-graphql-input:')),
  ).toMatchObject({
    expression: 'ProductInput.bodyHtml was removed',
    contractReview: expect.stringContaining('Refit cannot see the values the code sends'),
  });
});

it('drops an argument whose rule value is JSON, and names rules a variable reaches', async () => {
  const [drop] = await tableRules([
    {
      ...TABLE_RULES[1],
      rule: 'drop-flag',
      family: 'graphql-argument-drop',
      coordinate: 'QueryRoot.product(id:)',
      value: '1',
    },
  ]);
  const before = buildSchema(SCHEMA('before'));
  expect(
    rewriteDocument('query { product(id: "1") { id } }', before, before, [drop]),
  ).toMatchObject({ refusal: expect.stringContaining('Field "product" argument "id"') });
  expect(
    variableRules(
      'query ($sort: ProductSortKeys) { products(sortKey: $sort) { id } }',
      await tableRules(TABLE_RULES),
    ).map((rule) => rule.rule),
  ).toEqual(['shopify-product-sort-title']);
});

it('treats pins Shopify serves as the same version as one pin', async () => {
  const root = await directory({
    'package.json': MANIFEST,
    'app/shopify.server.ts': `import { shopifyApi } from '@shopify/shopify-api';
export const shopify = shopifyApi({ apiVersion: '2025-01' });
`,
    'scripts/sync.ts': `export const sync = (shop: string) =>
  fetch(\`https://\${shop}/admin/api/2024-01/graphql.json\`, { method: 'POST', body: JSON.stringify({ query: \`query { shop { name } }\` }) });
`,
  });
  const report = (await runPipeline({
    repository: root,
    ...(await snapshots(root)),
    proposePatch: true,
  })) as any;
  expect(report.patch.status).toBe('proposed');
  expect(report.apiVersion).toMatchObject({
    application: '2026-01',
    applicability: 'matches-before',
  });
  expect(report.patch.diff).toContain(
    "+export const shopify = shopifyApi({ apiVersion: '2026-10' });",
  );
  expect(report.patch.diff).toContain('/admin/api/2026-10/graphql.json');
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

it('moves the Admin pin past a Storefront document it cannot read', async () => {
  const root = await directory({
    'package.json': MANIFEST,
    'app/shopify.server.ts': `import { shopifyApi } from '@shopify/shopify-api';
import { createStorefrontApiClient } from '@shopify/storefront-api-client';
export const shopify = shopifyApi({ apiVersion: '2026-01' });
const storefront = createStorefrontApiClient({ storeDomain: 'x', apiVersion: '2024-04', publicAccessToken: 't' });
export const search = (term: string) => storefront.request(term);
export const shop = (admin: any) => admin.graphql(\`query { shop { name } }\`);
`,
  });
  const report = (await runPipeline({
    repository: root,
    ...(await snapshots(root)),
    proposePatch: true,
  })) as any;
  expect(report.patch.status).toBe('proposed');
  expect(report.shopify.storefrontDocuments).toEqual(['app/shopify.server.ts:5']);
  expect(report.patch.warnings.join('\n')).toContain(
    'Refit could not read app/shopify.server.ts:5.',
  );
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

it('moves defaults in code, and notes environment-only and unstable versions without stopping', async () => {
  const root = await directory({
    'package.json': MANIFEST,
    'app/shopify.server.ts': `import { shopifyApi } from '@shopify/shopify-api';
export const create = (options: { apiVersion?: string }) =>
  shopifyApi({ apiVersion: options.apiVersion || '2025-01' });
export const fromEnvironment = shopifyApi({ apiVersion: process.env.SHOPIFY_API_VERSION });
export const preview = shopifyApi({ apiVersion: 'unstable' });
`,
  });
  const report = (await runPipeline({
    repository: root,
    ...(await snapshots(root)),
    proposePatch: true,
  })) as any;
  expect(report.patch.status).toBe('proposed');
  expect(report.patch.diff).toContain(
    "+  shopifyApi({ apiVersion: options.apiVersion || '2026-10' });",
  );
  expect(report.patch.diff).toContain(
    "+export const preview = shopifyApi({ apiVersion: 'unstable' });",
  );
  const warnings = report.patch.warnings.join('\n');
  expect(warnings).toContain('`options.apiVersion` overrides it where it is set');
  expect(warnings).toContain('environment variable SHOPIFY_API_VERSION, with no default in code');
  expect(warnings).toContain('The unstable Admin API version changes without notice');
});
