import ts from 'typescript-compiler';
import { describe, expect, it } from 'vitest';
import { scanShopify } from './shopify-analysis.ts';
import { pinnedShopifySchema } from './shopify-schemas.ts';
import {
  loadShopifyRestContract,
  loadShopifyRestRules,
  rewriteRestCalls,
  ruleProblems,
  type RestRule,
} from './shopify-rest-rewrite.ts';

const schemas = ['2026-01', '2026-10'].map((version) => ({
  version,
  schema: pinnedShopifySchema('admin', version).schema,
}));

// Fixture rules written for these tests; the shipped table is data/shopify-rest-graphql.json.
const RULES: RestRule[] = [
  {
    id: 'shop.get',
    method: 'GET',
    path: 'shop.json',
    resource: { class: 'Shop', operation: 'all' },
    kind: 'single',
    envelope: 'shop',
    root: 'shop',
    fields: {
      id: { graphql: 'id', convert: 'gid-number' },
      name: { graphql: 'name' },
      domain: { graphql: 'primaryDomain.host' },
      myshopify_domain: { graphql: 'myshopifyDomain' },
    },
  },
  {
    id: 'products.list',
    method: 'GET',
    path: 'products.json',
    resource: { class: 'Product', operation: 'all' },
    kind: 'list',
    envelope: 'products',
    root: 'products',
    fields: {
      id: { graphql: 'id', convert: 'gid-number' },
      title: { graphql: 'title' },
      status: { graphql: 'status', convert: 'lowercase' },
      tags: { graphql: 'tags', convert: 'join-comma' },
      variants: {
        graphql: 'variants(first: 250).nodes',
        fields: { id: { graphql: 'id', convert: 'gid-number' }, price: { graphql: 'price' } },
      },
    },
  },
  {
    id: 'products.get',
    method: 'GET',
    path: 'products/{product_id}.json',
    resource: { class: 'Product', operation: 'find' },
    kind: 'single',
    envelope: 'product',
    root: 'product',
    arguments: { id: { from: 'path:product_id', type: 'ID!', gid: 'Product' } },
    fields: { id: { graphql: 'id', convert: 'gid-number' }, title: { graphql: 'title' } },
  },
  {
    id: 'products.count',
    method: 'GET',
    path: 'products/count.json',
    resource: { class: 'Product', operation: 'count' },
    kind: 'count',
    envelope: 'count',
    root: 'productsCount',
    fields: {},
  },
];

const outcome = (result: { status: string; reason?: string }) => result.reason ?? result.status;

function rewrite(content: string, file = 'app/shop.ts', apiMajor?: number) {
  const repository = {
    root: '/repo',
    files: [{ path: file, content }],
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
  const scan = scanShopify(repository);
  const results = rewriteRestCalls({
    file,
    content,
    entries: scan.rest,
    rules: RULES,
    schemas,
    apiMajor,
  });
  const edits = results
    .flatMap((result) => (result.status === 'rewritten' ? result.edits : []))
    .sort((a, b) => b.start - a.start);
  let patched = content;
  for (const edit of edits)
    patched = patched.slice(0, edit.start) + edit.replacement + patched.slice(edit.end);
  const parsed = ts.createSourceFile(file, patched, ts.ScriptTarget.Latest, true);
  expect((parsed as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics).toEqual([]);
  return { results, patched };
}

// Runs the patched function against a stub transport and returns what the code saw.
async function run(patched: string, name: string, globals: Record<string, unknown>) {
  const output = ts.transpileModule(patched, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} as Record<string, (...args: unknown[]) => Promise<unknown>> };
  new Function('module', 'exports', ...Object.keys(globals), output)(
    module,
    module.exports,
    ...Object.values(globals),
  );
  return module.exports[name]();
}

describe('Shopify REST → GraphQL rewrites', () => {
  it('rewrites a fetch of shop.json and rebuilds only the fields the code reads', async () => {
    const source = `export async function shopName(shop: string, token: string) {
  const response = await fetch(\`https://\${shop}/admin/api/2024-07/shop.json\`, {
    method: 'GET',
    headers: { 'X-Shopify-Access-Token': token },
  });
  if (!response.ok) throw new Error('failed');
  const data = await response.json();
  return \`\${data.shop.name} \${data.shop.id}\`;
}
`;
    const { results, patched } = rewrite(source);
    expect(results.map(outcome)).toEqual(['rewritten']);
    expect(patched).toContain('/admin/api/2024-07/graphql.json');
    expect(patched).toContain('query RefitRestShopGet { shop { name id } }');
    expect(patched).not.toContain('2024-07/shop.json');
    const requests: unknown[] = [];
    const fetch = async (url: string, init: { body: string; headers: Record<string, string> }) => {
      requests.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return new Response(
        JSON.stringify({ data: { shop: { name: 'Demo', id: 'gid://shopify/Shop/42' } } }),
      );
    };
    const wrapped = patched.replace(
      'export async function shopName(shop: string, token: string)',
      'module.exports.shopName = async function (shop = "demo.myshopify.com", token = "t")',
    );
    await expect(run(wrapped, 'shopName', { fetch })).resolves.toBe('Demo 42');
    expect(requests).toMatchObject([
      {
        url: 'https://demo.myshopify.com/admin/api/2024-07/graphql.json',
        headers: { 'X-Shopify-Access-Token': 't', 'Content-Type': 'application/json' },
      },
    ]);
  });

  it('stops when the code reads a field the mapping does not produce', () => {
    const { results } = rewrite(`export async function plan(shop: string, token: string) {
  const response = await fetch(\`https://\${shop}/admin/api/2024-07/shop.json\`, { headers: { 'X-Shopify-Access-Token': token } });
  const { shop: info } = await response.json();
  return info.plan_name;
}
`);
    expect(results).toMatchObject([
      { status: 'stopped', reason: expect.stringContaining('shop.plan_name') },
    ]);
  });

  it('stops when the whole response leaves the function', () => {
    const { results } = rewrite(`export async function info(shop: string, token: string) {
  const response = await fetch(\`https://\${shop}/admin/api/2024-07/shop.json\`, { headers: { 'X-Shopify-Access-Token': token } });
  return response.json();
}
`);
    expect(results[0].status).toBe('stopped');
  });

  it('stops on a query parameter no GraphQL argument replaces', () => {
    const { results } = rewrite(`export async function list(shop: string, token: string) {
  const response = await fetch(\`https://\${shop}/admin/api/2024-07/products.json?vendor=acme\`, { headers: { 'X-Shopify-Access-Token': token } });
  const { products } = await response.json();
  return products.map((product: any) => product.title);
}
`);
    expect(results).toMatchObject([
      { status: 'stopped', reason: expect.stringContaining('`vendor`') },
    ]);
  });

  it('maps limit and page_info to first and after, and nested lists through their nodes', async () => {
    const source = `export async function list(shop: string, token: string, cursor: string) {
  const response = await fetch(\`https://\${shop}/admin/api/2024-07/products.json?limit=10&page_info=\${cursor}\`, { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' } });
  const { products } = await response.json();
  return products.map((product: any) => [product.title, product.status, product.tags, product.variants.map((variant: any) => variant.price)]);
}
`;
    const { results, patched } = rewrite(source);
    expect(results.map(outcome)).toEqual(['rewritten']);
    let sent: { variables: unknown } | undefined;
    const fetch = async (_: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          data: {
            products: {
              nodes: [
                {
                  title: 'Hat',
                  status: 'ACTIVE',
                  tags: ['a', 'b'],
                  variants: { nodes: [{ price: '9.50' }] },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      );
    };
    const wrapped = patched.replace(
      'export async function list(shop: string, token: string, cursor: string)',
      'module.exports.list = async function (shop = "s", token = "t", cursor = "abc")',
    );
    await expect(run(wrapped, 'list', { fetch })).resolves.toEqual([
      ['Hat', 'active', 'a, b', ['9.50']],
    ]);
    expect(sent!.variables).toEqual({ first: 10, after: 'abc' });
  });

  it('rewrites Remix admin.rest.get and keeps the Response the code reads', async () => {
    const source = `export const domain = async (admin: any) => {
  const { shop } = await admin.rest.get({ path: 'shop' }).then((response: any) => response.json());
  return shop.myshopify_domain;
};
`;
    const { results, patched } = rewrite(source);
    expect(results.map(outcome)).toEqual(['rewritten']);
    const admin = {
      graphql: async () =>
        new Response(JSON.stringify({ data: { shop: { myshopifyDomain: 'x.myshopify.com' } } })),
    };
    const wrapped = patched.replace(
      'export const domain = async (admin: any)',
      'module.exports.domain = async (admin = globalAdmin)',
    );
    await expect(run(wrapped, 'domain', { globalAdmin: admin })).resolves.toBe('x.myshopify.com');
  });

  it('rewrites a resource find with the id as a GraphQL global id', async () => {
    const source = `export async function title(admin: any, session: any) {
  const product = await admin.rest.resources.Product.find({ session, id: 7 });
  return product.title;
}
`;
    const { results, patched } = rewrite(source);
    expect(results.map(outcome)).toEqual(['rewritten']);
    let variables: unknown;
    const admin = {
      graphql: async (_: string, options: { variables: unknown }) => {
        variables = options.variables;
        return new Response(JSON.stringify({ data: { product: { title: 'Hat' } } }));
      },
    };
    const wrapped = patched.replace(
      'export async function title(admin: any, session: any)',
      'module.exports.title = async function (admin = globalAdmin, session = {})',
    );
    await expect(run(wrapped, 'title', { globalAdmin: admin })).resolves.toBe('Hat');
    expect(variables).toEqual({ id: 'gid://shopify/Product/7' });
  });

  it('removes a REST client whose every call is rewritten, using the GraphQL client of the locked release', () => {
    const source = `export async function check(session: any) {
  const client = new shopify.clients.Rest({ session });
  const { body } = await client.get({ path: 'products/count' });
  return body.count;
}
`;
    const { results, patched } = rewrite(source, 'app/check.ts', 11);
    expect(results.map(outcome)).toEqual(['rewritten']);
    expect(patched).not.toContain('clients.Rest');
    expect(patched).toContain('new shopify.clients.Graphql({ session: session })');
    expect(patched).toContain('graphql.request(');
  });

  it('keeps a REST client other calls still use, and stops on its construction', () => {
    const source = `export async function check(session: any) {
  const client = new shopify.clients.Rest({ session });
  const { body } = await client.get({ path: 'products/count' });
  await client.post({ path: 'webhooks', data: {} });
  return body.count;
}
`;
    const { results } = rewrite(source, 'app/check.ts', 11);
    expect(results.filter((result) => result.status === 'stopped').length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it('never rewrites a write', () => {
    const { results } = rewrite(`export async function create(shop: string, token: string) {
  const response = await fetch(\`https://\${shop}/admin/api/2024-07/products.json\`, { method: 'POST', headers: { 'X-Shopify-Access-Token': token }, body: '{}' });
  return response.ok;
}
`);
    expect(results).toMatchObject([
      { status: 'stopped', reason: expect.stringContaining('only REST reads') },
    ]);
  });
});

describe('the shipped REST → GraphQL rules', () => {
  const rules = loadShopifyRestRules();
  const contract = loadShopifyRestContract();

  it('quote Shopify for every rule', () => {
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.rest?.url).toMatch(/^https:\/\/shopify\.dev\/docs\/api\/admin-rest\//);
      expect(rule.graphql?.url).toMatch(/^https:\/\/shopify\.dev\/docs\/api\/admin-graphql\//);
      expect(rule.rest!.quote.length).toBeGreaterThan(10);
      expect(rule.graphql!.quote.length).toBeGreaterThan(10);
    }
  });

  it.each(schemas)(
    'select only existing fields whose types match the REST resource on $version',
    ({ schema }) => {
      expect(rules.flatMap((rule) => ruleProblems(rule, schema, contract))).toEqual([]);
    },
  );
});
