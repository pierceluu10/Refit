import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import { applySourceEdits } from './patches.ts';
import { parseProviderAdapter } from './providers.ts';
import { validateRequestPropertyRenames } from './provider-request-renames.ts';
import type { Repository } from './types.ts';

const fixture = 'pipeline/fixtures/request-renames';
const before = JSON.parse(await readFile(`${fixture}/before.json`, 'utf8'));
const after = JSON.parse(await readFile(`${fixture}/after.json`, 'utf8'));
const adapter = JSON.parse(await readFile(`${fixture}/provider.json`, 'utf8'));
const CLIENT =
  "import { Catalog } from '@example/catalog'; const catalog = new Catalog({ baseUrl: 'http://127.0.0.1' });";

function analyze(source: string, argumentIndex = 0) {
  const provider = parseProviderAdapter({
    ...adapter,
    requestPropertyRenames: adapter.requestPropertyRenames.map((rule: Record<string, unknown>) => ({
      ...rule,
      argumentIndex,
    })),
  });
  const renames = validateRequestPropertyRenames(provider, before, after);
  const repository: Repository = {
    root: '/application',
    files: [{ path: 'billing.ts', content: source }],
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
  const result = analyzeRepository(
    repository,
    [],
    provider,
    before.components.schemas,
    [],
    renames,
  );
  return {
    ...result,
    source: applySourceEdits(source, result.edits),
    provider,
    renames,
    repository,
  };
}

it.each([
  ['ordinary property', 'legacy_name: name, quantity: 2', 'display_name: name, quantity: 2'],
  [
    'quoted property',
    "'legacy_name': nextName(), quantity: 2",
    '"display_name": nextName(), quantity: 2',
  ],
  ['shorthand property', 'legacy_name, quantity: 2', 'display_name: legacy_name, quantity: 2'],
  [
    'comments and effects',
    '/* key */ legacy_name: nextName(), quantity: nextQuantity()',
    '/* key */ display_name: nextName(), quantity: nextQuantity()',
  ],
])('changes only the %s name and preserves value evaluation', (_name, original, expected) => {
  const source = `${CLIENT} async function create(legacy_name: string, name: string) { return await catalog.items.create({ ${original} }, { requestId: 'same' }); }`;
  const result = analyze(source);
  expect(result.findings).toMatchObject([
    { confidence: 'confirmed', expression: 'items.create argument[0].legacy_name' },
  ]);
  expect(result.edits).toHaveLength(1);
  expect(result.source).toBe(source.replace(original, expected));
  expect(analyze(result.source).findings).toEqual([]);
});

it('respects a configured body position and leaves positional arguments and options intact', () => {
  const source = `${CLIENT} catalog.items.create('account_1', { legacy_name: 'Item', quantity: 2 }, { requestId: 'same' });`;
  const result = analyze(source, 1);
  expect(result.source).toBe(source.replace('legacy_name:', 'display_name:'));
  expect(result.edits).toHaveLength(1);
});

it.each([
  ['spread before', "{ ...defaults, legacy_name: 'item' }"],
  ['spread after', "{ legacy_name: 'item', ...defaults }"],
  ['computed source', "{ ['legacy_name']: 'item' }"],
  ['computed unrelated key', "{ legacy_name: 'item', [key]: 2 }"],
  ['duplicate source', "{ legacy_name: 'first', legacy_name: 'second' }"],
  ['duplicate unrelated field', "{ legacy_name: 'item', quantity: 1, quantity: 2 }"],
  ['source and target both supplied', "{ legacy_name: 'item', display_name: 'other' }"],
  ['accessor', "{ get legacy_name() { return 'item'; } }"],
  ['method', "{ legacy_name() { return 'item'; } }"],
  ['immutable alias', 'body'],
  ['typed assertion', "{ legacy_name: 'item' } as ItemInput"],
  ['conditional body', "ready ? { legacy_name: 'item' } : {}"],
])('keeps %s requests for review instead of editing', (_name, body) => {
  const result = analyze(
    `${CLIENT} const body = { legacy_name: 'item' }; catalog.items.create(${body});`,
  );
  expect(result.findings).toMatchObject([{ confidence: 'review' }]);
  expect(result.edits).toEqual([]);
});

it.each([
  'catalog.items?.create({ legacy_name: "item" });',
  'catalog.items.create?.({ legacy_name: "item" });',
  'catalog.items.create = replacement; catalog.items.create({ legacy_name: "item" });',
  'consume(catalog); catalog.items.create({ legacy_name: "item" });',
])('refuses unsafe client calls: %s', (call) => {
  const result = analyze(`${CLIENT} ${call}`);
  expect(result.findings).toMatchObject([{ confidence: 'review' }]);
  expect(result.edits).toEqual([]);
});

it('does not touch absent fields, replacement-only calls or another method', () => {
  const result = analyze(
    `${CLIENT} catalog.items.create({ quantity: 2 }); catalog.items.create({ display_name: 'already' }); catalog.items.update({ legacy_name: 'unmapped' });`,
  );
  expect(result.findings).toEqual([]);
  expect(result.edits).toEqual([]);
});

it('covers imported shared clients and nested SDK resources through the shared resolver', () => {
  const configured = parseProviderAdapter({
    ...adapter,
    operations: [{ ...adapter.operations[0], resource: 'inventory.items' }],
    requestPropertyRenames: [{ ...adapter.requestPropertyRenames[0], resource: 'inventory.items' }],
  });
  const repository: Repository = {
    root: '/application',
    dependencies: [],
    lockfiles: [],
    warnings: [],
    files: [
      { path: 'client.ts', content: CLIENT.replace('const catalog', 'export const catalog') },
      {
        path: 'billing.ts',
        content:
          "import { catalog as client } from './client.js'; export async function create(name: string) { return await client.inventory.items.create({ legacy_name: name }); }",
      },
    ],
  };
  const result = analyzeRepository(
    repository,
    [],
    configured,
    before.components.schemas,
    [],
    validateRequestPropertyRenames(configured, before, after),
  );
  expect(result.findings).toMatchObject([{ file: 'billing.ts', confidence: 'confirmed' }]);
  expect(result.edits).toMatchObject([{ file: 'billing.ts', replacement: 'display_name' }]);
});
