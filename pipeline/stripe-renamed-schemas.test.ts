import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { STRIPE } from './providers.ts';
import { runPipeline } from './run.ts';
import { findRemovedProperties } from './specifications.ts';
import { withoutRenamedSchemaRemovals } from './stripe-field-moves.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const ref = (schema: string) => ({ $ref: `#/components/schemas/${schema}` });
const name = (description: string) => ({ description, maxLength: 5000, type: 'string' });

// Reduced from the product, product_feature and product_marketing_feature schemas of Stripe's
// 2023-10-16 and 2026-09-30.endive OpenAPI documents (stripe/openapi v603 and v2526), plus the
// Checkout Session's customer_details.name, which shares the property name.
function schemas(after: boolean): Record<string, unknown> {
  return {
    product: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        ...(after
          ? { marketing_features: { type: 'array', items: ref('product_marketing_feature') } }
          : { features: { type: 'array', items: ref('product_feature') } }),
      },
    },
    product_feature: after
      ? {
          title: 'ProductFeature',
          type: 'object',
          required: ['entitlement_feature', 'id', 'livemode', 'object'],
          properties: {
            entitlement_feature: { type: 'object' },
            id: { type: 'string' },
            livemode: { type: 'boolean' },
            object: { enum: ['product_feature'], type: 'string' },
          },
        }
      : {
          title: 'ProductFeature',
          type: 'object',
          required: ['name'],
          properties: { name: name("The feature's name. Up to 80 characters long.") },
        },
    ...(after
      ? {
          product_marketing_feature: {
            title: 'ProductMarketingFeature',
            type: 'object',
            properties: { name: name('The marketing feature name. Up to 80 characters long.') },
          },
        }
      : {}),
  };
}

it('drops product_feature.name, which moved with its schema to product_marketing_feature', () => {
  const removed = findRemovedProperties(schemas(false), schemas(true));
  expect(removed.map((change) => `${change.schema}.${change.property}`)).toEqual([
    'product.features',
    'product_feature.name',
  ]);
  expect(
    withoutRenamedSchemaRemovals(removed, schemas(false), schemas(true)).map(
      (change) => `${change.schema}.${change.property}`,
    ),
  ).toEqual(['product.features']);
});

it('keeps product_feature.name when the rename is not the documented one', () => {
  const before = schemas(false);
  const removed = findRemovedProperties(before, schemas(true));
  // The renamed schema's name changed shape.
  const changed = schemas(true);
  changed.product_marketing_feature = {
    type: 'object',
    properties: { name: { type: 'integer' } },
  };
  expect(withoutRenamedSchemaRemovals(removed, before, changed)).toHaveLength(2);
  // marketing_features lists another schema.
  const other = schemas(true);
  other.product = {
    type: 'object',
    properties: { marketing_features: { type: 'array', items: ref('product_feature') } },
  };
  expect(withoutRenamedSchemaRemovals(removed, before, other)).toHaveLength(2);
  // The target keeps product.features.
  const kept = schemas(true);
  kept.product = schemas(false).product;
  expect(withoutRenamedSchemaRemovals(removed, before, kept)).toHaveLength(2);
});

it('no longer flags same-named reads, and still reports product.features', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-renamed-schemas-'));
  roots.push(root);
  // UmerGitNinja/Mart-X app/api/webhook/route.ts:30 and samarbadriddin0v/notion-clone
  // app/api/stripe/subscription/route.ts:78 (both 2023-10-16), with a product.features read.
  await writeFile(
    join(root, 'billing.js'),
    `import Stripe from 'stripe';
const stripe = new Stripe('sk', { apiVersion: '2023-10-16' });
export function customer(session) {
  return { name: session?.customer_details?.name || '' };
}
export async function features(id) {
  const product = await stripe.products.retrieve(id);
  return product.features.map((feature) => feature.name);
}
`,
  );
  const contract = (version: string, after: boolean) => ({
    openapi: '3.0.3',
    info: { title: 'Simulated Stripe contract', version },
    paths: {},
    components: { schemas: schemas(after) },
  });
  await writeFile(join(root, 'before.json'), JSON.stringify(contract('2023-10-16', false)));
  await writeFile(join(root, 'after.json'), JSON.stringify(contract('2026-09-30.endive', true)));
  await writeFile(
    join(root, 'provider.json'),
    JSON.stringify({
      ...STRIPE,
      id: 'stripe-products',
      operations: [{ resource: 'products', method: 'retrieve', schema: 'product' }],
    }),
  );
  const report = await runPipeline({
    repository: root,
    before: join(root, 'before.json'),
    after: join(root, 'after.json'),
    providerConfig: join(root, 'provider.json'),
    apiVersion: '2023-10-16',
  });
  expect(report.findings.map((finding) => [finding.line, finding.expression])).toEqual([
    [8, expect.stringContaining('features')],
  ]);
});
