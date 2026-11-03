import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearFetchCache,
  loadPlaybookMeta,
  MIGRATION_KINDS,
  type FetchLike,
} from '../toolkit/index.ts';
import {
  createToolPack,
  latestStable,
  normalizeRestPath,
  offlineSnapshots,
  toolPack,
  versionStatuses,
} from './tools.ts';

const NOW = new Date('2026-11-01T12:00:00Z');
const ctx = { repoDir: '.' };
const offline = createToolPack({ fetch: null, schemaCacheDir: null, now: () => NOW });
const tool = (name: string, pack = offline) => {
  const found = pack.tools.find((t) => t.name === name);
  if (!found) throw new Error(`missing ${name}`);
  return found;
};

beforeEach(() => clearFetchCache());

describe('shopify tool pack', () => {
  it('exposes the tools with valid names', () => {
    expect(toolPack.provider).toBe('shopify');
    expect(offline.tools.map((t) => t.name)).toEqual([
      'shopify_validate_graphql',
      'shopify_rest_to_graphql',
      'shopify_api_versions',
      'shopify_search_docs',
    ]);
    for (const t of offline.tools) expect(t.name).toMatch(/^[a-z0-9_]{1,64}$/);
  });

  it('has a playbook with front matter for every migration kind', () => {
    const meta = loadPlaybookMeta(new URL('./playbooks/', import.meta.url));
    for (const kind of MIGRATION_KINDS) {
      expect(offline.playbooks[kind], kind).toBeTruthy();
      expect(meta[kind]).toMatchObject({ provider: 'shopify', kind, reviewed: 'false' });
    }
  });

  it('keeps tools-data files small and dated', () => {
    const dir = fileURLToPath(new URL('./tools-data/', import.meta.url));
    for (const file of readdirSync(dir)) {
      expect(statSync(join(dir, file)).size, file).toBeLessThan(300 * 1024);
    }
    const snapshots = offlineSnapshots();
    expect(snapshots.map((s) => s.version)).toEqual(['2026-10', '2026-01']);
    expect(snapshots[0].schema.types.Product.fields?.title).toBeDefined();
  });
});

describe('shopify_validate_graphql (offline excerpt)', () => {
  const run = (input: Record<string, unknown>, context = ctx) =>
    tool('shopify_validate_graphql').run(input, context);

  it('reports unknown, removed and deprecated fields', async () => {
    const out = await run({
      version: '2026-10',
      query: `query P($id: ID!) {
  product(id: $id) {
    title bodyHtml
    variants(first: 5) { nodes { inventoryManagement sku } }
  }
}
mutation S($q: [InventoryQuantityInput!]!) {
  inventorySetQuantities(input: { name: "available", reason: "correction", quantities: $q, ignoreCompareQuantity: true }) {
    userErrors { message }
  }
}`,
    });
    expect(out).toContain('offline excerpt of 2026-10');
    expect(out).toMatch(
      /line 4:\d+ error: Field "inventoryManagement" does not exist on type ProductVariant/,
    );
    expect(out).toContain('Product.bodyHtml is deprecated: Use `descriptionHtml` instead.');
    expect(out).toMatch(/"ignoreCompareQuantity" does not exist .* It exists in 2026-01/);
  });

  it('suggests close names and checks required arguments', async () => {
    const out = await run({ query: '{ product { titel } }' });
    expect(out).toContain('Missing required argument');
    expect(out).toContain('Did you mean "title"');
    expect(out).toContain('Shopify Admin API 2026-10');
  });

  it('says "not checked" for types outside the excerpt', async () => {
    const out = await run({
      query: '{ product(id: "gid://shopify/Product/1") { seo { title } } shop { name } }',
    });
    expect(out).not.toMatch(/error:/);
    expect(out).toMatch(/not in the offline excerpt|No problems/);
  });

  it('reports syntax errors with line and column', async () => {
    const out = await run({ query: 'query {\n  product(id: "1" {\n    id\n  }\n}' });
    expect(out).toMatch(/line 2:\d+ error: Syntax error/);
  });

  it('falls back to the nearest excerpt for versions without one', async () => {
    const out = await run({ version: '2026-04', query: '{ shop { name } }' });
    expect(out).toContain('No offline excerpt for 2026-04');
    const bad = await run({ version: 'latest', query: '{ shop { name } }' });
    expect(bad).toContain('"latest" is not a valid version string');
  });

  it('checks variables you pass', async () => {
    const out = await run({
      query: 'query($id: ID!) { product(id: $id) { id } }',
      variables: { other: 1 },
    });
    expect(out).toContain('Required variable "$id"');
  });

  it('reads a schemaPath inside the repo and refuses paths outside it', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'shopify-repo-'));
    mkdirSync(join(repo, 'schema'));
    writeFileSync(
      join(repo, 'schema/admin.graphql'),
      'type QueryRoot { shop: Shop! } type Shop { name: String! } schema { query: QueryRoot }',
    );
    const ok = await run(
      { query: '{ shop { nme } }', schemaPath: 'schema/admin.graphql' },
      { repoDir: repo },
    );
    expect(ok).toContain('schema file schema/admin.graphql');
    expect(ok).toContain('Did you mean "name"');
    const outside = await run(
      { query: '{ shop { name } }', schemaPath: '../../etc/passwd' },
      { repoDir: repo },
    );
    expect(outside).toContain('outside the repository');
    expect(outside).toContain('offline excerpt');
    const missing = await run(
      { query: '{ shop { name } }', schemaPath: 'nope.json' },
      { repoDir: repo },
    );
    expect(missing).toContain('does not exist');
  });

  it('asks for a query when none is given', async () => {
    expect(await run({})).toContain('Pass the GraphQL document');
  });
});

describe('shopify_validate_graphql (live, stubbed)', () => {
  const introspection = JSON.stringify({
    data: {
      __schema: {
        queryType: { name: 'QueryRoot' },
        mutationType: null,
        types: [
          {
            kind: 'OBJECT',
            name: 'QueryRoot',
            fields: [
              {
                name: 'shop',
                type: { kind: 'NON_NULL', ofType: { kind: 'OBJECT', name: 'Shop' } },
                args: [],
              },
            ],
          },
          {
            kind: 'OBJECT',
            name: 'Shop',
            fields: [
              { name: 'name', type: { kind: 'SCALAR', name: 'String' }, args: [] },
              {
                name: 'liveOnly',
                type: { kind: 'SCALAR', name: 'String' },
                args: [],
                isDeprecated: true,
                deprecationReason: 'Live reason',
              },
            ],
          },
        ],
      },
    },
  });

  it('fetches the introspection, caches it and reuses the cache', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'shopify-cache-'));
    const calls: { url: string; body?: string }[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, body: init?.body });
      return { ok: true, status: 200, text: async () => introspection };
    };
    const pack = createToolPack({ fetch, schemaCacheDir: cacheDir, now: () => NOW });
    const out = await tool('shopify_validate_graphql', pack).run(
      { version: '2026-07', query: '{ shop { name liveOnly } }' },
      ctx,
    );
    expect(calls[0].url).toBe('https://shopify.dev/admin-graphql-direct-proxy/2026-07');
    expect(calls[0].body).toContain('__schema');
    expect(out).toContain('live introspection of 2026-07');
    expect(out).toContain('Shop.liveOnly is deprecated: Live reason');
    expect(existsSync(join(cacheDir, 'refit-shopify-admin-schema-2026-07.json'))).toBe(true);

    clearFetchCache();
    const again = await tool('shopify_validate_graphql', pack).run(
      { version: '2026-07', query: '{ shop { name } }' },
      ctx,
    );
    expect(calls).toHaveLength(1);
    expect(again).toContain('cached at');
  });

  it('falls back to the offline excerpt when the network fails', async () => {
    const fetch: FetchLike = async () => ({
      ok: false,
      status: 400,
      text: async () => '{"error":"Invalid API version"}',
    });
    const pack = createToolPack({ fetch, schemaCacheDir: null, now: () => NOW });
    const out = await tool('shopify_validate_graphql', pack).run(
      { version: '2026-10', query: '{ shop { name } }' },
      ctx,
    );
    expect(out).toContain('Live schema for 2026-10 unavailable (HTTP 400)');
    expect(out).toContain('offline excerpt of 2026-10');
  });

  it('skips the network when live is false', async () => {
    let called = false;
    const fetch: FetchLike = async () => {
      called = true;
      return { ok: true, status: 200, text: async () => introspection };
    };
    const pack = createToolPack({ fetch, schemaCacheDir: null, now: () => NOW });
    await tool('shopify_validate_graphql', pack).run(
      { live: false, query: '{ shop { name } }' },
      ctx,
    );
    expect(called).toBe(false);
  });
});

describe('shopify_rest_to_graphql', () => {
  const run = (input: Record<string, unknown>) => tool('shopify_rest_to_graphql').run(input, ctx);

  it('normalizes REST paths', () => {
    expect(
      normalizeRestPath(
        'https://x.myshopify.com/admin/api/2024-01/products/123/variants.json?limit=5',
      ),
    ).toEqual({
      segments: ['products', '{id}', 'variants'],
      ids: ['123'],
    });
    expect(normalizeRestPath('/admin/products/{product_id}.json').segments).toEqual([
      'products',
      '{id}',
    ]);
    expect(normalizeRestPath('/variants/:id.json').segments).toEqual(['variants', '{id}']);
  });

  it('maps a versioned endpoint with an id', async () => {
    const out = await run({ endpoint: 'GET /admin/api/2024-01/products/632910392.json' });
    expect(out).toContain('GET /products/{product_id}.json -> product');
    expect(out).toContain('gid://shopify/Product/632910392');
    expect(out).toContain('images -> media');
    expect(out).toContain('deprecated as of REST API 2024-04');
    expect(out).toContain('query { product(id: "gid://shopify/Product/632910392") { id } }');
  });

  it('maps variant updates and inventory', async () => {
    const out = await run({ endpoint: 'PUT /admin/api/2023-10/variants/808950810.json' });
    expect(out).toContain('productVariantsBulkUpdate');
    expect(out).toContain('inventory_quantity');
    const inv = await run({
      endpoint: 'https://shop.myshopify.com/admin/api/2025-01/inventory_levels/set.json',
      method: 'post',
    });
    expect(inv).toContain('inventorySetQuantities');
  });

  it('matches owner metafield paths', async () => {
    const out = await run({ endpoint: 'POST /admin/api/2024-04/products/1/metafields.json' });
    expect(out).toContain('metafieldsSet');
  });

  it('notes a method the path does not have', async () => {
    const out = await run({ endpoint: 'PATCH /admin/api/2024-01/shop.json' });
    expect(out).toContain('No PATCH on this path');
    expect(out).toContain('shop');
  });

  it('looks up resources by name, fuzzily', async () => {
    expect(await run({ endpoint: 'variants' })).toContain('ProductVariant');
    expect(await run({ endpoint: 'fulfilment orders' })).toContain('FulfillmentOrder');
    const unknownPath = await run({
      endpoint: 'GET /admin/api/2024-01/customers/1/frobnicate.json',
    });
    expect(unknownPath).toContain('No exact match');
    expect(unknownPath).toContain('customer');
  });

  it('gives a best-effort answer for unknown resources', async () => {
    const out = await run({ endpoint: 'zzqx' });
    expect(out).toContain('not in the snapshot');
    expect(out).toContain('https://shopify.dev/docs/api/admin-rest');
    expect(await run({})).toContain('Pass a REST endpoint');
  });
});

describe('shopify_api_versions', () => {
  const run = (input: Record<string, unknown>, pack = offline) =>
    tool('shopify_api_versions', pack).run(input, ctx);

  it('computes statuses from the snapshot dates', () => {
    const statuses = versionStatuses(NOW);
    expect(statuses.find((v) => v.version === '2025-10')?.computed).toBe('unsupported');
    expect(statuses.find((v) => v.version === '2026-10')?.computed).toBe('latest stable');
    expect(statuses.find((v) => v.version === '2027-01')?.computed).toBe('release candidate');
    expect(latestStable(new Date('2027-02-01T00:00:00Z'))).toBe('2027-01');
  });

  it('lists versions and deadlines without input', async () => {
    const out = await run({});
    expect(out).toContain('2026-10: latest stable');
    expect(out).toContain('2027-01-01: Public apps must use expiring offline access tokens');
    expect(out).toContain('falls forward');
  });

  it('explains an unsupported pinned version', async () => {
    const out = await run({ version: '2025-07' });
    expect(out).toContain('2025-07: unsupported');
    expect(out).toContain('fall forward to the oldest accessible stable version (2026-01 today)');
    expect(out).toContain('https://shopify.dev/changelog/release-notes/2026-04');
  });

  it('warns when a supported version is close to the end', async () => {
    const out = await run({ version: '2026-01' });
    expect(out).toContain('2026-01: stable');
    expect(out).toMatch(/About \d+ days of access left\. Plan the upgrade/);
  });

  it('handles release candidates, unstable, old, odd and invalid versions', async () => {
    expect(await run({ version: '2027-01' })).toContain('not released yet');
    expect(await run({ version: 'unstable' })).toContain('testing');
    expect(await run({ version: '2023-04' })).toContain('long unsupported');
    expect(await run({ version: '2026-02' })).toContain('not a release month');
    expect(await run({ version: 'v2' })).toContain("doesn't look like a Shopify API version");
    expect(await run({ version: '2030-01' })).toContain('newer than the snapshot');
  });

  it('probes accessibility live through the injected fetch', async () => {
    const seen: string[] = [];
    const ok: FetchLike = async (url) => {
      seen.push(url);
      return { ok: true, status: 200, text: async () => '{"data":{"__typename":"QueryRoot"}}' };
    };
    const accessible = await run(
      { version: '2026-04' },
      createToolPack({ fetch: ok, now: () => NOW }),
    );
    expect(seen).toEqual(['https://shopify.dev/admin-graphql-direct-proxy/2026-04']);
    expect(accessible).toContain('currently accessible');
    clearFetchCache();
    const bad: FetchLike = async () => ({
      ok: false,
      status: 400,
      text: async () => '{"error":"Invalid API version"}',
    });
    expect(
      await run({ version: '2025-10' }, createToolPack({ fetch: bad, now: () => NOW })),
    ).toContain('rejected 2025-10');
  });
});

describe('shopify_search_docs', () => {
  it('finds snapshot passages offline', async () => {
    const out = await tool('shopify_search_docs').run(
      { query: 'webhook HMAC signature header', live: false },
      ctx,
    );
    expect(out).toContain('https://shopify.dev/docs/apps/build/webhooks/subscribe/https');
    const tokens = await tool('shopify_search_docs').run(
      { query: 'token exchange expiring offline' },
      ctx,
    );
    expect(tokens).toContain('token-exchange');
  });
});
