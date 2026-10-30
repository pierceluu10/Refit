import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse, validate } from 'graphql';
import { afterEach, expect, it } from 'vitest';
import { readRepository } from './repository.ts';
import { scanShopify } from './shopify-analysis.ts';
import {
  loadShopifyMigrationRules,
  migrateDocument,
  removeUnusedVariables,
} from './shopify-migrations.ts';
import { shopifyGrade } from './shopify-proof.ts';
import { pinnedShopifySchema } from './shopify-schemas.ts';

const after = pinnedShopifySchema('admin', '2026-10').schema;
const rules = loadShopifyMigrationRules('2026-10');

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Shopify's Remix app template before commit bd7c2efd, which every affected repository copied.
const TEMPLATE = ({
  productSelection = 'id\n            title',
  input = 'id: variantId,\n          price: Math.random() * 100,',
  read = 'variantResponseJson!.data!.productVariantUpdate!.productVariant',
} = {}) => `import { authenticate } from "../shopify.server";
export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const response = await admin.graphql(
    \`#graphql
      mutation populateProduct($input: ProductInput!) {
        productCreate(input: $input) {
          product {
            ${productSelection}
            variants(first: 10) {
              edges {
                node {
                  id
                  price
                }
              }
            }
          }
        }
      }\`,
    { variables: { input: { title: "Snowboard" } } },
  );
  const responseJson = await response.json();
  const variantId =
    responseJson.data!.productCreate!.product!.variants.edges[0]!.node!.id!;
  const variantResponse = await admin.graphql(
    \`#graphql
      mutation shopifyRemixTemplateUpdateVariant($input: ProductVariantInput!) {
        productVariantUpdate(input: $input) {
          productVariant {
            id
            price
          }
        }
      }\`,
    {
      variables: {
        input: {
          ${input}
        },
      },
    },
  );
  const variantResponseJson = await variantResponse.json();
  return {
    product: responseJson!.data!.productCreate!.product,
    variant: ${read},
  };
};
`;

async function migrate(source: string) {
  const root = await mkdtemp(join(tmpdir(), 'refit-shopify-migrations-'));
  roots.push(root);
  const files = {
    'package.json': JSON.stringify({ dependencies: { '@shopify/shopify-app-remix': '^3.0.0' } }),
    'app/routes/app._index.tsx': source,
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const scan = scanShopify(await readRepository(root, '@shopify/shopify-app-remix'));
  const document = scan.documents.find((entry) => entry.text.includes('productVariantUpdate'))!;
  const result = migrateDocument({ document, source, after, rules });
  const patched =
    result && 'edits' in result
      ? [...result.edits]
          .sort((a, b) => b.start - a.start)
          .reduce(
            (text, edit) => text.slice(0, edit.start) + edit.replacement + text.slice(edit.end),
            source,
          )
      : undefined;
  return { result, patched };
}

it('loads the documented productVariantUpdate migration', () => {
  expect(rules.map((rule) => rule.rule)).toContain('shopify-product-variant-update-to-bulk-update');
});

it('moves productVariantUpdate to productVariantsBulkUpdate with the variables and reads', async () => {
  const { result, patched } = await migrate(TEMPLATE());
  expect(result && 'edits' in result).toBe(true);
  expect(patched).toContain(
    'mutation shopifyRemixTemplateUpdateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {',
  );
  expect(patched).toContain(
    'productVariantsBulkUpdate(productId: $productId, variants: $variants) {\n          productVariants {',
  );
  expect(patched).toContain(
    'productId: responseJson.data!.productCreate!.product!.id,\n        variants: [{\n          id: variantId,\n          price: Math.random() * 100,\n        }],',
  );
  expect(patched).toContain(
    'variant: variantResponseJson!.data!.productVariantsBulkUpdate!.productVariants[0],',
  );
  const migrated = result as Exclude<typeof result, { refusal: string } | undefined>;
  expect(validate(after, parse(migrated.text))).toEqual([]);
  expect(migrated.liveCases).toEqual([
    expect.objectContaining({
      operationName: 'shopifyRemixTemplateUpdateVariant',
      variables: {
        productId: { $ref: 'setup.0.productCreate.product.id' },
        variants: [
          { id: { $ref: 'setup.0.productCreate.product.variants.nodes.0.id' }, price: 42.5 },
        ],
      },
    }),
  ]);
});

it('keeps optional chaining on the variant read', async () => {
  const { patched } = await migrate(
    TEMPLATE({ read: 'variantResponseJson?.data?.productVariantUpdate?.productVariant' }),
  );
  expect(patched).toContain(
    'variantResponseJson?.data?.productVariantsBulkUpdate?.productVariants?.[0]',
  );
});

it('refuses when the product ID is not selected in the response the variant came from', async () => {
  const { result } = await migrate(TEMPLATE({ productSelection: 'title' }));
  expect(result).toEqual({ refusal: expect.stringContaining('which product the variant') });
});

it('refuses when the code reads the whole payload', async () => {
  const { result } = await migrate(
    TEMPLATE({ read: 'variantResponseJson!.data!.productVariantUpdate' }),
  );
  expect(result).toEqual({
    refusal: expect.stringContaining('whole productVariantUpdate payload'),
  });
});

it('refuses input fields that moved off the variant', async () => {
  const { result } = await migrate(TEMPLATE({ input: 'id: variantId,\n          sku: "A1",' }));
  expect(result).toEqual({ refusal: expect.stringContaining('sends sku') });
});

it('writes no live case where the code computes a value Refit cannot stand in for', async () => {
  const { result } = await migrate(
    TEMPLATE({ input: 'id: variantId,\n          price: request.headers.get("x"),' }),
  );
  expect(result && 'edits' in result && result.liveCases).toEqual([]);
  expect(result && 'edits' in result && result.uncovered).toEqual([
    'shopifyRemixTemplateUpdateVariant',
  ]);
});

it('removes unused variable definitions', () => {
  const text =
    'query A($id: ID!, $first: Int) { shop { name } products(first: $first) { nodes { id } } }';
  const [edit] = removeUnusedVariables(text);
  expect(text.slice(0, edit.start) + edit.replacement + text.slice(edit.end)).toBe(
    'query A($first: Int) { shop { name } products(first: $first) { nodes { id } } }',
  );
  const only = 'query B($id: ID!) { shop { name } }';
  const [all] = removeUnusedVariables(only);
  expect(only.slice(0, all.start) + all.replacement + only.slice(all.end)).toBe(
    'query B { shop { name } }',
  );
});

it('sends a query the removed variables to show they are ignored', async () => {
  const source = `export async function read(admin, shopGid) {
  const res = await admin.graphql(
    \`#graphql
    query ShopName($id: ID!) {
      shop { name }
    }\`,
    { variables: { id: shopGid } },
  );
  return (await res.json()).data.shop.name;
}
`;
  const root = await mkdtemp(join(tmpdir(), 'refit-shopify-migrations-'));
  roots.push(root);
  await writeFile(
    join(root, 'package.json'),
    '{"dependencies":{"@shopify/shopify-app-remix":"3.0.0"}}',
  );
  await writeFile(join(root, 'read.js'), source);
  const scan = scanShopify(await readRepository(root, '@shopify/shopify-app-remix'));
  const result = migrateDocument({ document: scan.documents[0], source, after, rules });
  expect(result && 'edits' in result && result.text).toContain('query ShopName {');
  expect(result && 'edits' in result && result.liveCases).toEqual([
    { operationName: 'ShopName', variables: { id: 'unused' }, setup: [], cleanup: [] },
  ]);
});

it('grades a patch whose changed variables the store did not run as D', () => {
  const schema = {
    status: 'proven' as const,
    reason: 'Every document validates.',
    checked: { original: 1, patched: 1 },
    failures: [],
    originalFailures: [],
    otherApi: [],
  };
  const own = { letter: 'C' as const, level: 'type-check' as const, reason: 'tsc passed.' };
  expect(shopifyGrade(own, schema, undefined, [], ['app/a.tsx:3 (Update)']).letter).toBe('D');
  expect(shopifyGrade(own, schema, undefined, [], []).letter).toBe('C');
});
