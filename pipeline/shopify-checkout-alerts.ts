import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { TEST_PATH } from './source-paths.ts';
import { TRACER_LIMITS } from './tree-sitter.ts';
import { PipelineInputError } from './types.ts';

// Registry markers of the two Shopify `feature` deadlines this scanner reports (data/deadlines.json).
// They live in Liquid and Ruby files, which the JavaScript and TypeScript feature match never reads.
export const CHECKOUT_LIQUID = 'checkout.liquid';
export const SHOPIFY_SCRIPTS = 'Shopify Scripts';
export const SHOPIFY_CHECKOUT_MARKERS: ReadonlySet<string> = new Set([
  CHECKOUT_LIQUID,
  SHOPIFY_SCRIPTS,
]);

const EXCLUDED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.refit',
  'vendor',
  '.bundle',
]);
const SCRIPT_INPUT = /\bInput\.(?:cart|shipping_rates|payment_gateways)\b/;
const SCRIPT_OUTPUT = /\bOutput\.(?:cart|shipping_rates|payment_gateways)\s*=(?!=)/;
const MAX_TEXT = 160;

export interface ShopifyCheckoutUse {
  version: string;
  file: string;
  line: number;
  use: 'live' | 'test';
  text: string;
}

function excerpt(line: string) {
  const text = line.trim();
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

// Report only: each `checkout.liquid` layout and each Ruby Shopify Script, never an edit. A Script
// reads a checkout input and assigns the matching output; the line reported is that assignment.
export async function shopifyCheckoutUses(directory: string): Promise<ShopifyCheckoutUse[]> {
  const root = resolve(directory);
  const uses: ShopifyCheckoutUse[] = [];
  let files = 0;
  let total = 0;
  const visit = async (path: string): Promise<void> => {
    const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry.name)) await visit(full);
      if (!entry.isFile() || (entry.name !== CHECKOUT_LIQUID && !entry.name.endsWith('.rb')))
        continue;
      const size = (await lstat(full)).size;
      if (size > TRACER_LIMITS.fileBytes) continue;
      total += size;
      files += 1;
      if (total > TRACER_LIMITS.totalBytes || files > TRACER_LIMITS.files)
        throw new PipelineInputError(
          `Liquid and Ruby files exceed scan limits (${TRACER_LIMITS.files} files, ${TRACER_LIMITS.totalBytes} bytes in total).`,
        );
      const file = relative(root, full).split('\\').join('/');
      const use = TEST_PATH.test(file) ? 'test' : 'live';
      const lines = (await readFile(full, 'utf8')).split('\n');
      if (entry.name === CHECKOUT_LIQUID) {
        const index = Math.max(
          0,
          lines.findIndex((line) => line.trim()),
        );
        uses.push({
          version: CHECKOUT_LIQUID,
          file,
          line: index + 1,
          use,
          text: excerpt(lines[index] ?? ''),
        });
        continue;
      }
      // shortcut: drops everything after `#`, so a `"#{...}"` line can hide a use; parse Ruby if that matters.
      const code = lines.map((line) => line.replace(/#.*$/, ''));
      if (!code.some((line) => SCRIPT_INPUT.test(line))) continue;
      const index = code.findIndex((line) => SCRIPT_OUTPUT.test(line));
      if (index >= 0)
        uses.push({
          version: SHOPIFY_SCRIPTS,
          file,
          line: index + 1,
          use,
          text: excerpt(lines[index]),
        });
    }
  };
  await visit(root);
  return uses;
}
