import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanDeadlines } from './deadline-exposure.ts';
import { loadDeadlineRegistry, reportOnly } from './deadline-registry.ts';
import { shopifyCheckoutUses } from './shopify-checkout-alerts.ts';

const NOW = new Date('2026-10-29T00:00:00Z');
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-shopify-checkout-'));
  roots.push(root);
  for (const [name, content] of Object.entries({
    'package.json': JSON.stringify({ name: 'theme' }),
    ...files,
  })) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

const SCRIPT = [
  '# Tiered discount',
  'Input.cart.line_items.each do |item|',
  '  item.change_line_price(item.line_price * 0.9, message: "10% off")',
  'end',
  '',
  'Output.cart = Input.cart',
].join('\n');

const FILES = {
  'layout/checkout.liquid': '\n<!doctype html>\n{{ content_for_layout }}\n',
  'scripts/discount.rb': SCRIPT,
  'lib/helper.rb': '# Output.cart = Input.cart\ndef total(cart)\n  cart.sum\nend\n',
  'test/fixtures/shipping.rb': 'Output.shipping_rates = Input.shipping_rates\n',
  'node_modules/theme/layout/checkout.liquid': '{{ content_for_layout }}',
};

describe('shopifyCheckoutUses', () => {
  it('reports checkout.liquid layouts and Shopify Scripts, with test paths kept apart', async () => {
    expect(await shopifyCheckoutUses(await repository(FILES))).toEqual([
      {
        version: 'checkout.liquid',
        file: 'layout/checkout.liquid',
        line: 2,
        use: 'live',
        text: '<!doctype html>',
      },
      {
        version: 'Shopify Scripts',
        file: 'scripts/discount.rb',
        line: 6,
        use: 'live',
        text: 'Output.cart = Input.cart',
      },
      {
        version: 'Shopify Scripts',
        file: 'test/fixtures/shipping.rb',
        line: 1,
        use: 'test',
        text: 'Output.shipping_rates = Input.shipping_rates',
      },
    ]);
  });

  it('lists both as report-only registry exposures', async () => {
    const registry = await loadDeadlineRegistry();
    const scan = await scanDeadlines(await repository(FILES), registry, NOW);
    const exposures = new Map(scan.exposures.map((item) => [item.deadline.id, item]));
    const liquid = exposures.get('shopify-2025-08-28-checkout-liquid');
    const scripts = exposures.get('shopify-2026-06-30-scripts');
    expect(liquid?.evidence.map((item) => item.file)).toEqual(['layout/checkout.liquid']);
    expect(scripts?.evidence.map((item) => item.file)).toEqual(['scripts/discount.rb']);
    expect(scripts?.nonLive.map((item) => item.file)).toEqual(['test/fixtures/shipping.rb']);
    expect(reportOnly(liquid!.deadline) && reportOnly(scripts!.deadline)).toBe(true);
  });

  it('does not treat the marker text in JavaScript as a use', async () => {
    const registry = await loadDeadlineRegistry();
    const root = await repository({ 'src/theme.ts': "export const layout = 'checkout.liquid';\n" });
    const scan = await scanDeadlines(root, registry, NOW);
    expect([...scan.exposures, ...scan.mentions].map((item) => item.deadline.id)).not.toContain(
      'shopify-2025-08-28-checkout-liquid',
    );
  });
});
