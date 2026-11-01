import { describe, expect, it } from 'vitest';
import { scanShopify } from './shopify-analysis.ts';
import { loadShopifyRestRules, rewriteRestCalls } from './shopify-rest-rewrite.ts';

function trace(content: string, file = 'app/shop.ts') {
  const repository = {
    root: '/repo',
    files: [{ path: file, content }],
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
  return rewriteRestCalls({ file, content, entries: scanShopify(repository).rest });
}

const reads = (result: ReturnType<typeof trace>[number]) =>
  result.trace?.reads.map((read) => read.path.join('.'));

describe('Shopify REST call tracing for the contract check', () => {
  it('traces a fetch of shop.json and the fields the code reads', () => {
    const [result] = trace(`export async function shopName(shop: string, token: string) {
  const response = await fetch(\`https://\${shop}/admin/api/2024-07/shop.json\`, {
    method: 'GET',
    headers: { 'X-Shopify-Access-Token': token },
  });
  if (!response.ok) throw new Error('failed');
  const data = await response.json();
  return \`\${data.shop.name} \${data.shop.id}\`;
}
`);
    expect(result).toMatchObject({
      status: 'stopped',
      reason: 'Traced for the contract check.',
      trace: { method: 'GET', path: 'shop.json' },
    });
    expect(reads(result)).toEqual(['shop.name', 'shop.id']);
  });

  it('follows for-of elements and ignores a same-named variable in a nested function', () => {
    const [result] = trace(`export async function titles(shop: string, token: string) {
  const response = await fetch(\`https://\${shop}/admin/api/2024-07/products.json\`, { headers: { 'X-Shopify-Access-Token': token } });
  const helper = (response: { plan_name: string }) => response.plan_name;
  const { products } = await response.json();
  const out: string[] = [];
  for (const product of products) out.push(product.vendor_code);
  return [out, helper];
}
`);
    expect(reads(result)).toEqual(['products.[].vendor_code']);
  });

  it('traces a write without rewriting it', () => {
    const [result] = trace(`export async function rename(shop: string, token: string) {
  await fetch(\`https://\${shop}/admin/api/2024-07/products/1.json\`, {
    method: 'PUT',
    headers: { 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ product: { title: 'New' } }),
  });
}
`);
    expect(result.trace).toMatchObject({ method: 'PUT', body: [['product', 'title']] });
  });
});

// The mapping table is now the agent fixer's context for REST hand-offs (docs/GUT-PLAN.md).
describe('the shipped REST → GraphQL mappings', () => {
  it('quote Shopify for every mapping', () => {
    const rules = loadShopifyRestRules();
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.rest?.url).toMatch(/^https:\/\/shopify\.dev\/docs\/api\/admin-rest\//);
      expect(rule.graphql?.url).toMatch(/^https:\/\/shopify\.dev\/docs\/api\/admin-graphql\//);
      expect(rule.rest!.quote.length).toBeGreaterThan(10);
      expect(rule.graphql!.quote.length).toBeGreaterThan(10);
    }
  });
});
