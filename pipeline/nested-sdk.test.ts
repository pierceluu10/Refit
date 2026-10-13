import { expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import { collectSdkMethodCandidates } from './adapter-suggestions.ts';
import { applySourceEdits } from './patches.ts';
import { MAX_SDK_RESOURCE_LENGTH, parseProviderAdapter } from './providers.ts';
import { findRemovedProperties } from './specifications.ts';
import type { Repository } from './types.ts';

const RESOURCE = 'inventory.legacy.items';
const BEFORE = { Item: { type: 'object', properties: { legacy_label: { type: 'string' } } } };
const AFTER = { Item: { type: 'object', properties: { display_label: { type: 'string' } } } };
const ADAPTER = {
  id: 'nested-catalog',
  packageName: '@example/catalog',
  defaultImport: false,
  namedExport: 'Catalog',
  operations: [{ resource: RESOURCE, method: 'retrieve', schema: 'Item', operationId: 'getItem' }],
  propertyRenames: [{ schema: 'Item', removed: 'legacy_label', replacement: 'display_label' }],
};
const CLIENT = `import { Catalog } from '@example/catalog';
export const catalog = new Catalog();`;

function repository(source: string): Repository {
  return {
    root: '/virtual/nested-sdk',
    files: [
      { path: 'application.ts', content: source },
      { path: 'client.ts', content: CLIENT },
    ],
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
}

function analyze(source: string) {
  return analyzeRepository(
    repository(source),
    findRemovedProperties(BEFORE, AFTER, ADAPTER.id),
    parseProviderAdapter(ADAPTER),
    BEFORE,
  );
}

it('accepts dotted resource paths in response mappings and endpoint replacements', () => {
  const adapter = parseProviderAdapter({
    ...ADAPTER,
    operationReplacements: [
      {
        resource: RESOURCE,
        method: 'retrieve',
        replacementResource: 'inventory.current.products',
        replacementMethod: 'get',
        replacementOperationId: 'getProduct',
      },
    ],
  });
  expect(adapter.operations[0].resource).toBe(RESOURCE);
  expect(adapter.operationReplacements?.[0].replacementResource).toBe('inventory.current.products');
});

it.each([
  '.items',
  'items.',
  'inventory..items',
  'inventory/items',
  'inventory?.items',
  'inventory["items"]',
  ' inventory.items',
  'inventory.items ',
  'x'.repeat(MAX_SDK_RESOURCE_LENGTH + 1),
])('rejects a non-static or excessive configured resource path: %s', (resource) => {
  expect(() =>
    parseProviderAdapter({ ...ADAPTER, operations: [{ ...ADAPTER.operations[0], resource }] }),
  ).toThrow('resource path');
  expect(() =>
    parseProviderAdapter({
      ...ADAPTER,
      operationReplacements: [
        {
          resource: RESOURCE,
          method: 'retrieve',
          replacementResource: resource,
          replacementMethod: 'get',
          replacementOperationId: 'getProduct',
        },
      ],
    }),
  ).toThrow('resource/method');
});

it('traces a shared imported client through nested resources and edits only its response field', () => {
  const source = `import { catalog as client } from './client.ts';
export async function label(id: string) {
  const item = await client.inventory.legacy.items.retrieve(id);
  return item.legacy_label;
}`;
  const result = analyze(source);
  expect(result.calls).toMatchObject([{ method: `${RESOURCE}.retrieve` }]);
  expect(result.findings).toMatchObject([{ expression: '.legacy_label', confidence: 'confirmed' }]);
  expect(result.edits).toHaveLength(1);
  const updated = applySourceEdits(source, result.edits);
  expect(updated).toContain('client.inventory.legacy.items.retrieve(id)');
  expect(updated).toContain('return item.display_label;');
});

it('carries a transparent wrapper response and immutable aliases across nested SDK calls', () => {
  const source = `import { catalog } from './client.ts';
export async function retrieve(id: string) {
  return catalog.inventory.legacy.items.retrieve(id);
}
export async function label(id: string) {
  const item = await retrieve(id);
  const alias = item;
  return alias.legacy_label;
}`;
  expect(analyze(source).findings).toMatchObject([
    { expression: '.legacy_label', confidence: 'confirmed' },
  ]);
});

it('reconstructs nested SDK inventory without arguments, comments or AST internals', () => {
  const source = `import { catalog as client } from './client.ts';
await client.inventory /* private comment */ .legacy.items.retrieve('private argument');`;
  const inventory = collectSdkMethodCandidates(repository(source), ADAPTER);
  expect(inventory).toMatchObject([
    {
      resource: RESOURCE,
      method: 'retrieve',
      callCount: 1,
      samples: [{ expression: 'client.inventory.legacy.items.retrieve' }],
    },
  ]);
  const evidence = JSON.stringify(inventory);
  expect(evidence).not.toContain('private');
  expect(evidence).not.toContain('properties');
});

it.each([
  'catalog.inventory.legacy.items.retrieve = other;',
  'delete catalog.inventory.legacy.items;',
  'inspect(catalog.inventory.legacy.items);',
  'const resource = catalog.inventory.legacy; resource.items = other;',
  'const resource = catalog.inventory.legacy.items; inspect(resource);',
  'export function exposed() { return catalog.inventory.legacy.items; }',
  'export const exposed = () => catalog.inventory.legacy.items;',
])('downgrades mutation or escape at every nested client level: %s', (mutation) => {
  const result = analyze(`import { catalog } from './client.ts';
${mutation}
export async function label(id: string) {
  const item = await catalog.inventory.legacy.items.retrieve(id);
  return item.legacy_label;
}`);
  expect(result.findings).toMatchObject([{ expression: '.legacy_label', confidence: 'review' }]);
  expect(result.edits).toEqual([]);
});

it.each([
  'catalog?.inventory.legacy.items.retrieve(id)',
  'catalog.inventory?.legacy.items.retrieve(id)',
  'catalog.inventory.legacy?.items.retrieve(id)',
  'catalog.inventory.legacy.items?.retrieve(id)',
  'catalog.inventory.legacy.items.retrieve?.(id)',
])('keeps optional invocations and their response aliases review-only: %s', (call) => {
  const result = analyze(`import { catalog } from './client.ts';
export async function label(id: string) {
  const item = await ${call};
  const alias = item;
  return alias.legacy_label;
}`);
  expect(result.calls).toMatchObject([{ method: `${RESOURCE}.retrieve` }]);
  expect(result.findings).toMatchObject([{ expression: '.legacy_label', confidence: 'review' }]);
  expect(result.edits).toEqual([]);
});

it('does not confirm an inline nested response after its SDK method is replaced', () => {
  const result = analyze(`import { catalog } from './client.ts';
catalog.inventory.legacy.items.retrieve = other;
export async function label(id: string) {
  return (await catalog.inventory.legacy.items.retrieve(id)).legacy_label;
}`);
  expect(result.findings).toMatchObject([{ expression: '.legacy_label', confidence: 'review' }]);
  expect(result.edits).toEqual([]);
});

it('does not confuse nested SDK resource names with removed response fields', () => {
  const result = analyze(`import { catalog } from './client.ts';
await catalog.inventory.legacy_label.retrieve('item_1');`);
  expect(result.sdkCalls).toMatchObject([
    { resource: 'inventory.legacy_label', method: 'retrieve' },
  ]);
  expect(result.findings).toEqual([]);
});

it('does not treat an unawaited nested call as a response', () => {
  const result = analyze(`import { catalog } from './client.ts';
const item = catalog.inventory.legacy.items.retrieve('item_1');
const alias = item;
alias.legacy_label;`);
  expect(result.findings).toMatchObject([{ expression: '.legacy_label', confidence: 'review' }]);
  expect(result.edits).toEqual([]);
});

it.each([
  'catalog.inventory["legacy"].items.retrieve(id)',
  'catalog.inventory[resource].items.retrieve(id)',
  'catalog.inventory.legacy.items[method](id)',
])('leaves computed SDK resource access unsupported: %s', (call) => {
  const result = analyze(`import { catalog } from './client.ts';
export async function label(id: string) {
  const item = await ${call};
  return item.legacy_label;
}`);
  expect(result.calls).toEqual([]);
  expect(result.findings).toMatchObject([{ expression: '.legacy_label', confidence: 'review' }]);
  expect(result.edits).toEqual([]);
});
