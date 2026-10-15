import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { analyzeRepository } from './analyzer.ts';
import { compareApiVersion } from './api-version.ts';
import { migrationReviewReason } from './migration-review.ts';
import { parseProviderAdapter, type ProviderAdapter } from './providers.ts';
import { validateOperationReplacements } from './provider-operation-replacements.ts';
import { validateRequestPropertyRenames } from './provider-request-renames.ts';

const VERSION = 'before-v1';
const provider: ProviderAdapter = {
  id: 'catalog',
  packageName: '@example/catalog',
  defaultImport: true,
  namedExport: 'Catalog',
  operations: [{ resource: 'customers', method: 'retrieve', schema: 'customer' }],
  propertyRenames: [{ schema: 'customer', removed: 'legacy_name', replacement: 'display_name' }],
  apiVersion: { constructorArgument: 0, property: 'apiVersion', requestArguments: [1] },
};
const schemas = {
  customer: {
    type: 'object',
    properties: { legacy_name: { type: 'string' }, id: { type: 'string' } },
  },
};
const changes = [
  { id: 'name', schema: 'customer', property: 'legacy_name', pointer: '/customer/legacy_name' },
];
const imports = `import Catalog from '@example/catalog';`;
const creation = `new Catalog({ apiVersion: '${VERSION}' })`;
const helper = `async function read(sdk, id) { const value = await sdk.customers.retrieve(id); return value.legacy_name; }`;
const invoke = `export const lookup = id => read(client, id);`;
function analyze(content: string, extra: Record<string, string> = {}) {
  return analyzeRepository(
    {
      root: '/helper-fixture',
      files: [
        { path: 'service.ts', content },
        ...Object.entries(extra).map(([path, content]) => ({ path, content })),
      ],
      dependencies: [],
      lockfiles: [],
      warnings: [],
    },
    changes,
    provider,
    schemas,
  );
}

it.each([
  ['private function', `${imports} const client = ${creation}; ${helper} ${invoke}`],
  [
    'arrow function',
    `${imports} const client = ${creation}; const read = async (sdk, id) => { const value = await sdk.customers.retrieve(id); return value.legacy_name; }; ${invoke}`,
  ],
  [
    'function expression',
    `${imports} const client = ${creation}; const read = async function(sdk, id) { const value = await sdk.customers.retrieve(id); return value.legacy_name; }; ${invoke}`,
  ],
  ['inline constructor', `${imports} ${helper} export const lookup = id => read(${creation}, id);`],
  [
    'immutable alias',
    `${imports} const client = ${creation}; async function read(sdk, id) { const copy = sdk; const value = await copy.customers.retrieve(id); return value.legacy_name; } ${invoke}`,
  ],
  [
    'helper chain',
    `${imports} const client = ${creation}; ${helper} function middle(sdk, id) { return read(sdk, id); } export const lookup = id => middle(client, id);`,
  ],
  [
    'repeated calls with one origin',
    `${imports} const client = ${creation}; ${helper} ${invoke} void read(client, 'other');`,
  ],
  [
    'CommonJS origin',
    `const Catalog = require('@example/catalog'); const client = ${creation}; ${helper} void read(client, 'cus');`,
  ],
])(
  'traces a stable %s from a real SDK origin and preserves declared-version proof',
  (_name, source) => {
    const result = analyze(source);
    expect(result.sdkCalls).toHaveLength(1);
    expect(result.findings).toMatchObject([{ confidence: 'confirmed' }]);
    expect(result.findings[0].helperClient).toBeUndefined();
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0].replacement).toBe('display_name');
    expect(
      compareApiVersion(
        VERSION,
        { info: { version: VERSION } },
        { info: { version: 'after-v2' } },
        { configured: true, declarations: result.apiVersionDeclarations },
        'source-verified',
      ).source.status,
    ).toBe('verified');
  },
);

it.each([
  ['exported helper', `${imports} const client = ${creation}; export ${helper} ${invoke}`],
  ['named export', `${imports} const client = ${creation}; ${helper} export { read }; ${invoke}`],
  ['escaped helper', `${imports} const client = ${creation}; ${helper} register(read); ${invoke}`],
  [
    'unknown caller',
    `${imports} const client = ${creation}; ${helper} read(other, 'id'); ${invoke}`,
  ],
  ['missing argument', `${imports} const client = ${creation}; ${helper} read(); ${invoke}`],
  [
    'mutated parameter',
    `${imports} const client = ${creation}; ${helper.replace('const value', 'sdk = other; const value')} ${invoke}`,
  ],
  [
    'mutated resource',
    `${imports} const client = ${creation}; ${helper.replace('const value', 'sdk.customers.retrieve = other; const value')} ${invoke}`,
  ],
  [
    'escaped client',
    `${imports} const client = ${creation}; ${helper.replace('const value', 'register(sdk); const value')} ${invoke}`,
  ],
  [
    'source mutation',
    `${imports} const client = ${creation}; ${helper} client.customers.retrieve = other; ${invoke}`,
  ],
  [
    'optional invocation',
    `${imports} const client = ${creation}; ${helper} export const lookup = id => read?.(client, id);`,
  ],
  ['spread invocation', `${imports} const client = ${creation}; ${helper} read(client, ...ids);`],
  [
    'default parameter',
    `${imports} const client = ${creation}; ${helper.replace('(sdk, id)', '(sdk = other, id)')} ${invoke}`,
  ],
  [
    'multiple origins',
    `${imports} const client = ${creation}; const second = ${creation}; ${helper} read(second, 'id'); ${invoke}`,
  ],
  [
    'SDK constructor escape',
    `${imports} const client = ${creation}; expose(Catalog); ${helper} ${invoke}`,
  ],
  [
    'arguments access',
    `${imports} const client = ${creation}; ${helper.replace('const value', 'use(arguments); const value')} ${invoke}`,
  ],
  [
    'recursion',
    `${imports} const client = ${creation}; ${helper.replace('const value', "if (id) await read(sdk, ''); const value")} ${invoke}`,
  ],
])('keeps %s under review instead of authorizing a patch', (_name, source) => {
  const result = analyze(source);
  expect(result.sdkCalls).toHaveLength(1);
  expect(result.sdkCalls[0].helperClient?.stability).toBe('review');
  expect(result.findings).toMatchObject([
    { confidence: 'review', helperClient: { stability: 'review' } },
  ]);
  expect(result.edits).toEqual([]);
  expect(migrationReviewReason(result)).toContain('stable helper-client provenance');
});

it('does not infer SDK identity from a parameter annotation alone', () => {
  const result = analyze(`${imports} ${helper.replace('(sdk, id)', '(sdk: Catalog, id: string)')}`);
  expect(result.sdkCalls).toEqual([]);
  expect(result.findings.every((finding) => finding.confidence === 'review')).toBe(true);
});

it('preserves review evidence across an exported imported helper and for its original client', () => {
  const result = analyze(
    `${imports} import { read } from './reader'; const client = ${creation}; ${invoke} async function direct() { const value = await client.customers.retrieve('id'); return value.legacy_name; }`,
    {
      'reader.ts': `export ${helper}`,
    },
  );
  expect(result.sdkCalls).toHaveLength(2);
  expect(result.findings).toHaveLength(2);
  expect(result.findings.every((finding) => finding.helperClient?.stability === 'review')).toBe(
    true,
  );
});

it('blocks a mixed run while retaining the unrelated confirmed finding', () => {
  const result = analyze(`${imports} const client = ${creation}; export ${helper} ${invoke}
const separate = ${creation}; async function direct() { const value = await separate.customers.retrieve('id'); return value.legacy_name; }`);
  expect(result.findings.filter((finding) => finding.confidence === 'confirmed')).toHaveLength(1);
  expect(result.findings.some((finding) => finding.helperClient)).toBe(true);
  expect(migrationReviewReason(result)).toContain('helper');
});

it.each(
  ['request-renames', 'endpoint-replacement'].flatMap((fixture) =>
    [false, true].map((exported) => ({ fixture, exported })),
  ),
)(
  'preserves helper review gates for $fixture (exported=$exported)',
  async ({ fixture, exported }) => {
    const read = async (file: string) =>
      JSON.parse(await readFile(`pipeline/fixtures/${fixture}/${file}.json`, 'utf8'));
    const before = await read('before');
    const after = await read('after');
    const adapter = parseProviderAdapter(await read('provider'));
    const operation = adapter.operations[0];
    const argument = fixture === 'request-renames' ? "{legacy_name:'name',quantity:2}" : "'id'";
    const result = analyzeRepository(
      {
        root: '/helper-requests',
        files: [
          {
            path: 'service.ts',
            content: `import {Catalog} from '@example/catalog';
const client = new Catalog({});
${exported ? 'export ' : ''}async function read(sdk) {return await sdk.${operation.resource}.${operation.method}(${argument});}
export const lookup = () => read(client);`,
          },
        ],
        dependencies: [],
        lockfiles: [],
        warnings: [],
      },
      [],
      adapter,
      before.components.schemas,
      validateOperationReplacements(
        adapter,
        before,
        after,
        before.components.schemas,
        after.components.schemas,
      ),
      validateRequestPropertyRenames(adapter, before, after),
    );
    expect(result.findings).toMatchObject([{ confidence: exported ? 'review' : 'confirmed' }]);
    expect(result.findings[0].helperClient?.stability).toBe(exported ? 'review' : undefined);
    expect(result.edits).toHaveLength(exported ? 0 : 1);
    expect(Boolean(migrationReviewReason(result))).toBe(exported);
  },
);
