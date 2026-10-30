import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scanShopify } from './shopify-analysis.ts';
import { pinnedShopifySchema } from './shopify-schemas.ts';
import {
  loadShopifyRestContract,
  loadShopifyRestRefusals,
  shopifyRestRewrites,
} from './shopify-rest-rewrite.ts';

const answer = vi.hoisted(() => ({ content: '' }));
vi.mock('./openai.ts', async (original) => ({
  ...(await original<typeof import('./openai.ts')>()),
  requestStructuredOutput: vi.fn(async () => ({
    content: answer.content,
    model: 'test-model',
    budget: { costUsd: 0.01 },
  })),
}));
const { proposeRestRule } = await import('./shopify-rest-ai.ts');

const schemas = ['2026-01', '2026-10'].map((version) => ({
  version,
  schema: pinnedShopifySchema('admin', version).schema,
}));
const ai = { apiKey: 'test', model: 'test-model' };

const source = `export async function customerEmail(shop: string, token: string, id: number) {
  const response = await fetch(\`https://\${shop}/admin/api/2024-07/customers/\${id}.json\`, { headers: { 'X-Shopify-Access-Token': token } });
  const { customer } = await response.json();
  return customer.first_name;
}
`;

async function run(content: string) {
  const repository = {
    root: '/repo',
    files: [{ path: 'app/variants.ts', content }],
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
  return shopifyRestRewrites(repository, scanShopify(repository), schemas, undefined, {
    rules: [],
    propose: (stop) =>
      proposeRestRule({
        stop,
        contract: loadShopifyRestContract(),
        refusals: loadShopifyRestRefusals(),
        schemas,
        ai,
      }),
  });
}

const mapping = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    decline: false,
    explanation: 'Product.variants lists the same variants.',
    root: 'customer',
    kind: 'single',
    arguments: [{ name: 'id', from: 'path:id', type: 'ID!', gid: 'Customer', value: '' }],
    fields: [{ rest: 'first_name', graphql: 'firstName', convert: '' }],
    ...overrides,
  });

describe('AI REST mappings', () => {
  beforeEach(() => {
    answer.content = '';
  });

  it('keeps a mapping only when Refit can rewrite the call with it', async () => {
    answer.content = mapping();
    const { results, proposals } = await run(source);
    expect(proposals).toMatchObject([{ status: 'kept', model: 'test-model', costUsd: 0.01 }]);
    expect(results).toMatchObject([
      { status: 'rewritten', rule: { origin: 'ai', root: 'customer' } },
    ]);
    const edit = (results[0] as { edits: { replacement: string }[] }).edits[0].replacement;
    expect(edit).toContain(
      'query RefitRestAiCustomerGet($id: ID!) { customer(id: $id) { firstName } }',
    );
    expect(edit).toContain('id: `gid://shopify/Customer/${id}`');
  });

  it('refuses a constant argument that could filter the records', async () => {
    answer.content = mapping({
      arguments: [{ name: 'id', from: '', type: '', gid: '', value: '"gid://shopify/Customer/1"' }],
    });
    const { proposals } = await run(source);
    expect(proposals).toMatchObject([
      { status: 'refused', reason: expect.stringContaining('constant id') },
    ]);
  });

  it('refuses a mapping whose GraphQL path does not exist', async () => {
    answer.content = mapping({
      fields: [{ rest: 'first_name', graphql: 'givenName', convert: '' }],
    });
    const { results, proposals } = await run(source);
    expect(proposals).toMatchObject([
      { status: 'refused', reason: expect.stringContaining('givenName') },
    ]);
    expect(results[0].status).toBe('stopped');
  });

  it('refuses a mapping whose value type differs from the REST resource', async () => {
    answer.content = mapping({
      fields: [{ rest: 'first_name', graphql: 'verifiedEmail', convert: '' }],
    });
    const { proposals } = await run(source);
    expect(proposals).toMatchObject([
      { status: 'refused', reason: expect.stringContaining('declares') },
    ]);
  });

  it('does not keep a mapping that leaves a read field out', async () => {
    answer.content = mapping({ fields: [{ rest: 'last_name', graphql: 'lastName', convert: '' }] });
    const { results } = await run(source);
    expect(results).toMatchObject([{ status: 'stopped' }]);
  });

  it('never asks the model about an endpoint Shopify documents as returning other rows', async () => {
    answer.content = mapping();
    const { results, proposals } = await run(
      source
        .replace('customers/${id}.json', 'orders.json')
        .replace('{ customer }', '{ orders: customer }'),
    );
    expect(proposals).toEqual([]);
    expect(results).toMatchObject([
      { status: 'stopped', reason: expect.stringContaining('open orders') },
    ]);
  });

  it.each([
    [
      'an id without gid-number',
      {
        fields: [
          { rest: 'first_name', graphql: 'firstName', convert: '' },
          { rest: 'id', graphql: 'id', convert: '' },
        ],
      },
      'gid-number',
    ],
    [
      'an enum value',
      { fields: [{ rest: 'state', graphql: 'state', convert: 'lowercase' }] },
      'enum',
    ],
    ['arguments in the root field', { root: 'customer(id: "gid://shopify/Customer/1")' }, 'root'],
    ['a dropped path placeholder', { arguments: [] }, 'path:id'],
    [
      'a nested object',
      {
        fields: [
          { rest: 'default_address', graphql: 'defaultAddress', convert: '' },
          { rest: 'default_address.city', graphql: 'city', convert: '' },
        ],
      },
      'nested',
    ],
    [
      'a field argument other than first: 250',
      { fields: [{ rest: 'first_name', graphql: 'metafield(key: "x").value', convert: '' }] },
      'arguments',
    ],
  ])('refuses %s', async (_, overrides, reason) => {
    answer.content = mapping(overrides);
    const { proposals } = await run(
      source.replace(
        'customer.first_name',
        'customer.first_name + customer.id + customer.state + customer.default_address?.city',
      ),
    );
    expect(proposals).toMatchObject([
      { status: 'refused', reason: expect.stringContaining(reason) },
    ]);
  });

  it('records a declined proposal', async () => {
    answer.content = mapping({ decline: true, explanation: 'Different rows.' });
    const { proposals } = await run(source);
    expect(proposals).toMatchObject([
      { status: 'refused', reason: 'The model declined: Different rows.' },
    ]);
  });
});
