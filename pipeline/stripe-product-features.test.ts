import { expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import { applySourceEdits } from './patches.ts';
import { STRIPE, type ProviderAdapter } from './providers.ts';
import { removedRequestParameters } from './request-removals.ts';
import { findRemovedProperties } from './specifications.ts';
import { PRODUCT_MARKETING_FEATURES_RULE } from './stripe-request-moves.ts';
import {
  PRODUCT_FEATURES_HELPER,
  subscriptionPeriodHelperModule,
} from './stripe-subscription-periods.ts';

const string = { type: 'string' };
// The feature list of Stripe's 2023-10-16 and 2026-09-30.endive documents (stripe/openapi):
// `features` before, `marketing_features` after, the same list of named features.
const featureList = (description: string) => ({
  description,
  type: 'array',
  items: {
    type: 'object',
    title: 'features',
    required: ['name'],
    properties: { name: { maxLength: 5000, type: 'string' } },
  },
});
const updateList = (description: string) => ({
  anyOf: [featureList(description), { enum: [''], type: 'string' }],
  description,
});

function contract(version: string, after: boolean, list = featureList, update = updateList) {
  const key = after ? 'marketing_features' : 'features';
  const body = (properties: Record<string, unknown>) => ({
    content: {
      'application/x-www-form-urlencoded': { schema: { type: 'object', properties } },
    },
  });
  return {
    openapi: '3.0.0',
    info: { version },
    paths: {
      '/v1/products': {
        post: {
          operationId: 'PostProducts',
          requestBody: body({ name: string, [key]: list(`A list of ${key}.`) }),
        },
      },
      '/v1/products/{id}': {
        post: {
          operationId: 'PostProductsId',
          requestBody: body({ name: string, [key]: update(`A list of ${key}.`) }),
        },
      },
    },
    components: {
      schemas: {
        product: {
          type: 'object',
          properties: {
            id: string,
            name: string,
            [key]: { type: 'array', items: { $ref: '#/components/schemas/feature' } },
          },
        },
        feature: { type: 'object', properties: { name: string } },
      },
    },
  };
}
const before = contract('2023-10-16', false);
const after = contract('2026-09-30.endive', true);

const provider: ProviderAdapter = {
  ...STRIPE,
  id: 'stripe-products',
  operations: [
    { resource: 'products', method: 'create', schema: 'product', operationId: 'PostProducts' },
    { resource: 'products', method: 'update', schema: 'product', operationId: 'PostProductsId' },
    { resource: 'products', method: 'retrieve', schema: 'product' },
  ],
};

function analyze(body: string, target = after) {
  const content = `import Stripe from 'stripe';\nconst stripe = new Stripe('sk', { apiVersion: '2023-10-16' });\n${body}`;
  const result = analyzeRepository(
    {
      root: '/product-features',
      files: [{ path: 'products.ts', content }],
      dependencies: [],
      lockfiles: [],
      warnings: [],
    },
    findRemovedProperties(before.components.schemas, target.components.schemas, provider.id),
    provider,
    before.components.schemas,
    [],
    [],
    [],
    removedRequestParameters(provider, before, target),
  );
  return { ...result, patched: applySourceEdits(content, result.edits) };
}

it('renames features only when the new list has the same shape on create and update', () => {
  expect(removedRequestParameters(provider, before, after)).toEqual([
    expect.objectContaining({ operationId: 'PostProducts', move: 'marketing_features' }),
    expect.objectContaining({ operationId: 'PostProductsId', move: 'marketing_features' }),
  ]);
  // A marketing feature that also needs a field the old list never sent is not the same list.
  const wider = contract('2026-09-30.endive', true, (description) => {
    const list = featureList(description);
    return { ...list, items: { ...list.items, required: ['name', 'icon'] } };
  });
  expect(removedRequestParameters(provider, before, wider)[0].move).toBeUndefined();
});

it('reads and sends the product feature list under its new name', () => {
  // helloworld9912/Stripe-Account-Migration src/scripts/products.ts (stripe 14, 2023-10-16) reads
  // product.features from a Stripe.Product; the create call is adapted from the same script, which
  // assigns the list to its params object instead (an assignment Refit does not trace).
  const result = analyze(`function convertToProductCreateParams(
  product: Stripe.Product
): Stripe.ProductCreateParams {
  const features = product.features as Stripe.Product.Feature[];
  return { name: product.name, features: features.map((feature) => ({ name: feature.name })) };
}
export async function copy(id: string) {
  const product = await stripe.products.retrieve(id);
  await stripe.products.create({ name: product.name, features: product.features });
  await stripe.products.update(id, { 'features': '' });
}`);
  expect(result.patched).toContain(
    'const features = (getProductMarketingFeatures(product)) as Stripe.Product.Feature[];',
  );
  expect(result.patched).toContain(
    'await stripe.products.create({ name: product.name, marketing_features: (getProductMarketingFeatures(product)) });',
  );
  expect(result.patched).toContain(
    "await stripe.products.update(id, { 'marketing_features': '' });",
  );
  expect(result.patched).toContain('\nfunction getProductMarketingFeatures<T extends object>(');
  expect(result.patched).not.toContain('stripeSubscriptionPeriod');
  expect(result.edits.filter((edit) => edit.rule === PRODUCT_MARKETING_FEATURES_RULE)).toHaveLength(
    2,
  );
});

it('leaves writes and conflicting bodies for review', () => {
  const result = analyze(`export async function copy(id: string, extra: object) {
  const product = await stripe.products.retrieve(id);
  product.features = [];
  await stripe.products.create({ name: 'a', features: [], marketing_features: [] });
  await stripe.products.create({ ...extra, features: [] });
}`);
  expect(result.patched).toContain('product.features = [];');
  expect(result.edits.filter((edit) => edit.rule === PRODUCT_MARKETING_FEATURES_RULE)).toEqual([]);
  expect(
    result.findings
      .filter((finding) => finding.requestParameter)
      .map((finding) => finding.reason.split('. ')[1]),
  ).toEqual([
    'The request already sends marketing_features; merging them needs review.',
    'Request spreads, methods and computed properties require review.',
  ]);
});

it('returns the old list for old-version payloads and the new one otherwise', () => {
  const module: { exports: Record<string, (product: object) => unknown> } = { exports: {} };
  new Function('module', subscriptionPeriodHelperModule('cjs', [PRODUCT_FEATURES_HELPER]))(module);
  const read = module.exports.getProductMarketingFeatures;
  expect(read({ features: [{ name: 'old' }] })).toEqual([{ name: 'old' }]);
  expect(read({ marketing_features: [{ name: 'new' }] })).toEqual([{ name: 'new' }]);
  expect(read({})).toBeUndefined();
});
