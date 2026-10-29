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
