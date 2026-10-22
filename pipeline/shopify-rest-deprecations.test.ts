import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkShopifyRestDeprecations,
  restPathKey,
  scanShopifyRestDeprecations,
  type ShopifyRestDeprecatedCall,
} from './shopify-rest-deprecations.ts';

const execute = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/refit.mjs', import.meta.url));
const NOW = new Date('2026-10-22T00:00:00Z');
const MANIFEST = {
  name: 'app',
  dependencies: { '@shopify/shopify-api': '^11.0.0', '@shopify/shopify-app-remix': '^3.0.0' },
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-shopify-rest-'));
  roots.push(root);
  for (const [name, content] of Object.entries({
    'package.json': JSON.stringify(MANIFEST, null, 2),
    ...files,
  })) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

function summary(calls: ShopifyRestDeprecatedCall[]) {
  return calls.map(
    (call) =>
      `${call.file}:${call.line} ${call.endpoint.method} ${call.endpoint.path} ${call.endpoint.removedIn} ${call.status}`,
  );
}

describe('matching REST calls to removed endpoints', () => {
  it('matches resource classes, REST clients and raw URLs', async () => {
    const scan = await scanShopifyRestDeprecations(
      await repository({
        'app/shopify.server.ts': `import { shopifyApi, ApiVersion } from '@shopify/shopify-api';
export const shopify = shopifyApi({ apiVersion: ApiVersion.January25 });
`,
        'app/addresses.ts': `import { shopify } from './shopify.server';
export async function addresses(session: any, customerId: number) {
  return shopify.rest.CustomerAddress.all({ session, customer_id: customerId });
}
export async function setDefault(session: any, customerId: number, id: number) {
  const client = new shopify.clients.Rest({ session });
  return client.put({ path: \`customers/\${customerId}/addresses/\${id}/default\` });
}
`,
        'app/raw.ts': `export async function legacyFulfil(shop: string, orderId: number, token: string) {
  return fetch(\`https://\${shop}/admin/api/2024-01/orders/\${orderId}/fulfillments.json\`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token },
  });
}
export async function listFulfillments(shop: string, orderId: number) {
  return fetch(\`https://\${shop}/admin/api/2024-01/orders/\${orderId}/fulfillments.json\`);
}
`,
      }),
      { now: NOW },
    );
    expect(summary(scan.calls)).toEqual([
      'app/addresses.ts:3 GET customers/<customer_id>/addresses.json 2025-07 removed',
      'app/addresses.ts:7 PUT customers/<customer_id>/addresses/<id>/default.json 2025-07 removed',
      'app/raw.ts:2 POST orders/<order_id>/fulfillments.json 2022-07 removed',
    ]);
    expect(scan.pinned).toEqual(['2024-01', '2025-01']);
    expect(scan.served).toBe('2026-01');
    const address = scan.calls[0];
    expect(address.endpoint).toMatchObject({ resource: 'CustomerAddress', lastVersion: '2025-04' });
    expect(address.deadline).toMatchObject({ id: 'shopify-admin-2025-04', date: '2026-04-16' });
    expect(address.endpoint.source).toMatch(
      /^https:\/\/registry\.npmjs\.org\/@shopify\/shopify-api\/-\/shopify-api-15\.0\.1\.tgz rest\/admin\/2025-07\//,
    );
  });

  it('reads REST paths written after a base URL from a helper', async () => {
    const scan = await scanShopifyRestDeprecations(
      await repository({
        'server/adapter.ts': `export class ShopifyAdapter {
  private baseUrl(shop: string) {
    return \`https://\${shop}/admin/api/2024-01\`;
  }
  async fulfil(shop: string, orderId: string, body: unknown) {
    await this.shopifyFetch(
      \`\${this.baseUrl(shop)}/orders/\${orderId}/fulfillments.json\`,
      { 'X-Shopify-Access-Token': 'token' },
      { method: 'POST', body: JSON.stringify(body) },
    );
  }
  async fulfillments(shop: string, orderId: string) {
    return this.shopifyFetch(\`\${this.baseUrl(shop)}/orders/\${orderId}/fulfillments.json\`, {});
  }
  async products(shop: string) {
    return fetch(\`\${this.baseUrl(shop)}/products.json?limit=250\`);
  }
  readonly manifest = 'package.json';
  readonly route = '/ai/products.json';
  private async shopifyFetch(url: string, headers: object, init: object = {}) {
    return fetch(url, { headers, ...init });
  }
}
`,
      }),
      { now: NOW },
    );
    expect(summary(scan.calls)).toEqual([
      'server/adapter.ts:7 POST orders/<order_id>/fulfillments.json 2022-07 removed',
    ]);
    expect(scan.rest.map((item) => `${item.line} ${item.method} ${item.path}`)).toEqual([
      '7 POST orders/{orderId}/fulfillments.json',
      '13 null orders/{orderId}/fulfillments.json',
      '16 null products.json',
    ]);
  });

  it('leaves calls alone when the endpoint they may send still exists', async () => {
    const scan = await scanShopifyRestDeprecations(
      await repository({
        'app/ok.ts': `import { shopifyApi, ApiVersion } from '@shopify/shopify-api';
const shopify = shopifyApi({ apiVersion: ApiVersion.October25 });
export async function run(session: any) {
  const fulfillment = new shopify.rest.Fulfillment({ session });
  await fulfillment.save({ update: true });
  await shopify.rest.Product.all({ session });
  const client = new shopify.clients.Rest({ session });
  await client.get({ path: 'orders/1/fulfillments' });
  await client.get({ path: 'customers' });
}
`,
      }),
      { now: NOW },
    );
    expect(scan.calls).toEqual([]);
    expect(scan.unmatched).toBeGreaterThan(0);
  });

  it('marks calls a newer pin has not reached yet, and tests', async () => {
    const data = {
      checkedAt: '2026-10-22',
      versions: { '2026-04': '15.0.1', '2026-07': '15.0.1' },
      endpoints: [
        {
          resource: 'Widget',
          method: 'GET',
          operation: 'get',
          path: 'widgets.json',
          lastVersion: '2026-04',
          removedIn: '2026-07',
          resourceRemoved: true,
          source: 'https://example.com/widgets',
        },
      ],
      fields: [],
      resources: { Widget: ['get GET widgets.json'] },
    };
    const root = await repository({
      'app/widgets.ts': `import { ApiVersion } from '@shopify/shopify-api';
export const version = ApiVersion.April26;
export const list = (shop: string) => fetch(\`https://\${shop}/admin/api/2026-04/widgets.json\`);
`,
      'test/widgets.test.ts': `export const list = (shop: string) => fetch(\`https://\${shop}/admin/api/2026-04/widgets.json\`);
`,
    });
    const scan = await scanShopifyRestDeprecations(root, { data, now: NOW });
    expect(scan.calls.map((call) => `${call.file} ${call.status} ${call.use}`)).toEqual([
      'app/widgets.ts upcoming live',
      'test/widgets.test.ts upcoming test',
    ]);
    expect(scan.calls[0].deadline).toMatchObject({ id: 'shopify-admin-2026-04' });
  });

  it('compares paths without a leading slash, .json, a query or segment names', () => {
    expect(restPathKey('/admin/api/2024-01/customers/123/addresses.json?limit=5')).toBe(
      'customers/*/addresses',
    );
    expect(restPathKey('customers/{customerId}/addresses')).toBe('customers/*/addresses');
    expect(restPathKey('customers/<customer_id>/addresses.json')).toBe('customers/*/addresses');
  });
});

describe('the generated list', () => {
  it('passes its own check and finds the removals the SDK resources show', async () => {
    const data = JSON.parse(
      await readFile(new URL('../data/shopify-rest-deprecations.json', import.meta.url), 'utf8'),
    );
    expect(checkShopifyRestDeprecations(data)).toEqual([]);
    expect(Object.keys(data.versions)).toHaveLength(19);
    expect(data.endpoints).toContainEqual(
      expect.objectContaining({
        method: 'POST',
        path: 'orders/<order_id>/fulfillments.json',
        lastVersion: '2022-04',
        removedIn: '2022-07',
      }),
    );
    // A resource the 2022-10 resources skip and 2023-01 restores is removed only in 2023-10.
    expect(
      data.endpoints
        .filter((item: { resource: string }) => item.resource === 'CustomerSavedSearch')
        .map((item: { removedIn: string }) => item.removedIn),
    ).toEqual(Array(7).fill('2023-10'));
    expect(data.fields).toContainEqual(
      expect.objectContaining({ resource: 'Order', field: 'gateway', removedIn: '2025-01' }),
    );
  });

  it('rejects malformed entries', () => {
    expect(
      checkShopifyRestDeprecations({
        formatVersion: 1,
        checkedAt: '2026-10-22',
        versions: { '2026-01': '15.0.1', '2026-04': '15.0.1', '2026-07': '15.0.1' },
        endpoints: [
          {
            resource: 'A',
            method: 'FETCH',
            operation: 'get',
            path: 'a.json',
            lastVersion: '2026-01',
            removedIn: '2026-07',
            source: 'npm',
          },
        ],
        fields: [],
        resources: {},
      }),
    ).toEqual([
      'endpoints[0]: removedIn must be the version right after lastVersion.',
      'endpoints[0]: source must start with an https URL.',
      'endpoints[0]: method must be GET, POST, PUT or DELETE.',
    ]);
  });
});

describe('refit shopify-rest', () => {
  it('checks the list and prints each live call', async () => {
    const check = await execute(process.execPath, [CLI, 'shopify-rest', '--check-deprecations']);
    expect(check.stdout).toContain('Shopify REST deprecations are valid');
    const root = await repository({
      'app/a.ts': `import { shopifyApi, ApiVersion } from '@shopify/shopify-api';
const shopify = shopifyApi({ apiVersion: ApiVersion.July24 });
export const list = (session: any) => shopify.rest.CustomerAddress.all({ session, customer_id: 1 });
`,
    });
    const { stdout } = await execute(process.execPath, [CLI, 'shopify-rest', '--repository', root]);
    expect(stdout).toContain(
      'app/a.ts:3  GET customers/<customer_id>/addresses.json  (CustomerAddress)',
    );
    expect(stdout).toContain(
      'Removed in 2025-07; last in 2025-04, which Shopify retires on 2026-04-16',
    );
  });
});
