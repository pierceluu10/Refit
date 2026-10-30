import { expect, it } from 'vitest';
import { loadShopifyRestDeprecations } from './shopify-rest-deprecations.ts';
import {
  checkShopifyRestContract,
  contractBodyDigest,
  loadShopifyRestVersionContract,
  proveRestCall,
  proveShopifyRest,
  referenceSections,
  restContractDiff,
  type ShopifyRestContract,
} from './shopify-rest-contract.ts';
import type { RestTrace } from './shopify-rest-rewrite.ts';

const NO_DEPRECATIONS = { endpoints: [], fields: [] };

// Two versions: Order loses `gateway` and `total_price` changes type; Customer is unchanged;
// Shop's `plan` holds an opaque object; Checkout exists only before.
const ORDER = (fields: Record<string, string>, params: string[]) => ({
  singular: 'order',
  plural: 'orders',
  endpoints: [
    { method: 'GET', operation: 'get', path: 'orders.json', params },
    { method: 'GET', operation: 'get', path: 'orders/<id>.json', params: ['fields'] },
    { method: 'PUT', operation: 'put', path: 'orders/<id>.json', params: [] },
  ],
  fields,
});
function fixture(): ShopifyRestContract {
  const body = {
    versions: { '2026-01': 'sdk', '2026-10': 'sdk' },
    resources: {
      Customer: [
        {
          versions: ['2026-01', '2026-10'],
          singular: 'customer',
          plural: 'customers',
          endpoints: [{ method: 'GET', operation: 'get', path: 'customers.json', params: [] }],
          fields: { email: 'string|null', id: 'number|null' },
        },
      ],
      Order: [
        {
          versions: ['2026-01'],
          ...ORDER(
            {
              id: 'number|null',
              gateway: 'string|null',
              total_price: 'string|null',
              customer: 'Customer|null|{[key:string]:any}',
              note: 'string|null',
            },
            ['limit', 'status'],
          ),
        },
        {
          versions: ['2026-10'],
          ...ORDER(
            {
              id: 'number|null',
              total_price: 'number|null',
              customer: 'Customer|null|{[key:string]:any}',
              note: 'string|null',
            },
            ['limit'],
          ),
        },
      ],
      Shop: [
        {
          versions: ['2026-01', '2026-10'],
          singular: 'shop',
          plural: 'shops',
          endpoints: [{ method: 'GET', operation: 'get', path: 'shop.json', params: [] }],
          fields: { name: 'string|null', plan: '{[key:string]:unknown}|null' },
        },
      ],
      Checkout: [
        {
          versions: ['2026-01'],
          singular: 'checkout',
          plural: 'checkouts',
          endpoints: [{ method: 'GET', operation: 'get', path: 'checkouts.json', params: [] }],
          fields: { token: 'string|null' },
        },
      ],
    },
  };
  return {
    formatVersion: 1,
    generatedAt: '2026-10-29',
    sources: { sdk: [], docs: [] },
    sha256: '',
    ...body,
  } as ShopifyRestContract;
}
const versions = { before: '2026-01', after: '2026-10' };
const read = (path: string, whole = true) => ({ path: path ? path.split('.') : [], whole });
const raw = (method: string, path: string, reads: string[], extra: Partial<RestTrace> = {}) =>
  proveRestCall(
    fixture(),
    versions,
    { method, path, query: [], reads: reads.map((entry) => read(entry)), ...extra },
    NO_DEPRECATIONS,
  );

it('proves a call whose endpoint, parameters and read fields are unchanged', () => {
  expect(
    raw('GET', 'orders.json', ['orders.[].id', 'orders.[].customer.email'], { query: ['limit'] }),
  ).toEqual({
    status: 'proven',
    endpoints: ['GET orders.json'],
    checked: 4,
  });
  // A whole record needs every field of it, and of the records it holds, unchanged.
  expect(raw('GET', 'customers.json', ['customers'])).toMatchObject({ status: 'proven' });
});

it('names the removed field, changed type, parameter or resource that stops a call', () => {
  expect(raw('GET', 'orders/{p0}.json', ['order.gateway'])).toEqual({
    status: 'unproven',
    reason: 'GET orders/{p0}.json: `order.gateway` is removed in 2026-10.',
  });
  expect(raw('GET', 'orders/{p0}.json', ['order.total_price'])).toMatchObject({
    reason: expect.stringContaining('changes type from string|null to number|null'),
  });
  expect(raw('GET', 'orders.json', [], { query: ['status'] })).toMatchObject({
    reason: expect.stringContaining('`status` is removed from GET orders.json in 2026-10'),
  });
  expect(raw('GET', 'orders/{p0}.json', ['order'])).toMatchObject({
    reason: expect.stringContaining('whole Order, whose `gateway` is removed'),
  });
  expect(raw('GET', 'checkouts.json', [])).toMatchObject({
    reason: 'GET checkouts.json: Checkout is removed in 2026-10.',
  });
});

it('stops on what the contract does not describe', () => {
  expect(raw('GET', 'shop.json', ['shop.plan.display_name'])).toMatchObject({
    reason: expect.stringContaining('inside `shop.plan`'),
  });
  expect(raw('GET', 'shop.json', ['shop.secret'])).toMatchObject({
    reason: expect.stringContaining('does not list for Shop'),
  });
  expect(raw('GET', 'shop.json', ['message'])).toMatchObject({
    reason: expect.stringContaining('not a key of the Shop response'),
  });
  // Every version's error responses carry `errors` (shopify.dev status and error codes).
  expect(raw('PUT', 'orders/{p0}.json', ['errors'])).toMatchObject({ status: 'proven' });
  expect(raw('GET', 'themes.json', [])).toMatchObject({
    reason: expect.stringContaining('no endpoint this call reaches'),
  });
  expect(raw('GET', 'shop.json', [], { query: ['since_id'] })).toMatchObject({
    reason: expect.stringContaining('`since_id`, which the 2026-01 contract does not list'),
  });
  expect(raw('PUT', 'orders/{p0}.json', [], { body: null })).toMatchObject({
    reason: expect.stringContaining('not an object literal'),
  });
});

it('checks body keys and resource class calls', () => {
  expect(raw('PUT', 'orders/{p0}.json', [], { body: [['order', 'note']] })).toMatchObject({
    status: 'proven',
  });
  expect(raw('PUT', 'orders/{p0}.json', [], { body: [['order', 'gateway']] })).toMatchObject({
    reason: expect.stringContaining('`order.gateway` is removed'),
  });
  const resource = (operation: string, query: string[], reads: string[]) =>
    proveRestCall(
      fixture(),
      versions,
      {
        method: 'GET',
        resource: { name: 'Order', operation },
        query,
        reads: reads.map((entry) => read(entry)),
      },
      NO_DEPRECATIONS,
    );
  expect(resource('find', ['id'], ['__record.note'])).toMatchObject({
    status: 'proven',
    endpoints: ['GET orders/<id>.json'],
  });
  expect(resource('all', ['limit'], ['[].[].gateway'])).toMatchObject({
    reason: 'Order.all: `gateway` is removed in 2026-10.',
  });
});

it('stops on a removal the deprecation list records even when the contract keeps the field', () => {
  expect(
    proveRestCall(
      fixture(),
      versions,
      { method: 'GET', path: 'customers.json', query: [], reads: [read('customers.[].email')] },
      {
        endpoints: [],
        fields: [
          {
            resource: 'Customer',
            field: 'email',
            lastVersion: '2026-07',
            removedIn: '2026-10',
            source: 'x',
          },
        ],
      },
    ),
  ).toMatchObject({ reason: expect.stringContaining('`customers.email` is removed in 2026-10') });
});

it('proves a REST client construction only when every use is a proven call', () => {
  const file = (extra: string) => ({
    files: [
      {
        path: 'app/sync.ts',
        content: `export async function sync(shopify, session) {\n  const client = new shopify.clients.Rest({ session });\n  const response = await client.get({ path: 'shop' });\n  ${extra}\n  return response.body.shop.name;\n}\n`,
      },
    ],
  });
  const entries = [
    { file: 'app/sync.ts', line: 2, column: 18, expression: 'shopify.clients.Rest' },
    {
      file: 'app/sync.ts',
      line: 3,
      column: 26,
      expression: 'client.get',
      method: 'GET',
      path: 'shop',
    },
  ];
  const contract = loadShopifyRestVersionContract();
  const proofs = proveShopifyRest(file(''), { rest: entries }, versions, contract);
  expect(proofs.map((item) => item.proof.status)).toEqual(['proven', 'proven']);
  const passed = proveShopifyRest(file('helper(client);'), { rest: entries }, versions, contract);
  expect(passed[0].proof).toMatchObject({
    status: 'unproven',
    reason: expect.stringContaining('other than calls'),
  });
});

it('keeps only the contract sections of a shopify.dev reference page', () => {
  const page = (version: string, example: string) =>
    `---\ntitle: Shop\napi_version: ${version}\n---\n\n# Shop\n\n## Endpoints\n\n* [get](https://shopify.dev/docs/api/admin-rest/${version}/resources/shop.md#get-shop)\n\n### Properties\n\nname\n\n## getRetrieve the shop\n\n### Parameters\n\nfields\n\n### Examples\n\n${example}\n`;
  expect(referenceSections(page('2026-07', '{"id": 1}'), '2026-07')).toBe(
    referenceSections(page('2026-10', '{"id": 2}'), '2026-10'),
  );
  expect(referenceSections(page('2026-10', ''), '2026-10')).not.toContain('Examples');
  expect(referenceSections('<!DOCTYPE html>', '2026-10')).toBeNull();
});

it('ships a contract whose sources and digests check, with the removals Shopify made', async () => {
  const contract = loadShopifyRestVersionContract();
  expect(checkShopifyRestContract(contract)).toEqual([]);
  expect(contract.sha256).toBe(contractBodyDigest(contract));
  expect(Object.keys(contract.versions)).toContain('2026-10');
  const diff = restContractDiff(
    contract,
    '2024-10',
    '2025-01',
    await loadShopifyRestDeprecations(),
  );
  expect(diff).toEqual(
    expect.arrayContaining([
      { kind: 'field-removed', resource: 'Customer', field: 'accepts_marketing' },
      { kind: 'field-removed', resource: 'Order', field: 'gateway' },
    ]),
  );
  const tampered = { ...contract, versions: { ...contract.versions, '2026-10': 'memory' } };
  expect(checkShopifyRestContract(tampered)[0]).toContain('digest');
});
