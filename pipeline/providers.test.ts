import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { readProviderAdapter } from './providers.ts';
import { runPipeline } from './run.ts';
import { findRemovedProperties } from './specifications.ts';
import { validateMigration } from './validation.ts';

const execute = promisify(execFile);
const FIXTURE = resolve('pipeline/fixtures/catalog');
const INPUTS = {
  repository: join(FIXTURE, 'repository'),
  before: join(FIXTURE, 'before.json'),
  after: join(FIXTURE, 'after.json'),
  providerConfig: join(FIXTURE, 'provider.json'),
};
const RENAME_INPUTS = {
  ...INPUTS,
  providerConfig: join(FIXTURE, 'provider-renames.json'),
};
const DOCKER_IMAGE = process.env.REFIT_DOCKER_IMAGE;
const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function nestedProviderInputs(source: string) {
  const root = await mkdtemp(join(tmpdir(), 'refit-nested-provider-'));
  directories.push(root);
  const repository = join(root, 'repository');
  await mkdir(repository);
  await writeFile(
    join(repository, 'package.json'),
    JSON.stringify({ dependencies: { '@example/catalog': '1.0.0' } }),
  );
  await writeFile(join(repository, 'catalog.ts'), source);
  const before = {
    openapi: '3.0.3',
    paths: {},
    components: {
      schemas: {
        Customer: {
          type: 'object',
          properties: { address: { $ref: '#/components/schemas/Address' } },
        },
        Address: {
          type: 'object',
          properties: { location: { $ref: '#/components/schemas/City' } },
        },
        City: { type: 'object', properties: { legacy_city: { type: 'string' } } },
      },
    },
  };
  const after = {
    openapi: '3.0.3',
    paths: {},
    components: {
      schemas: {
        Customer: {
          type: 'object',
          properties: { address: { $ref: '#/components/schemas/Address' } },
        },
        Address: {
          type: 'object',
          properties: { location: { $ref: '#/components/schemas/City' } },
        },
        City: { type: 'object', properties: { display_city: { type: 'string' } } },
      },
    },
  };
  const beforePath = join(root, 'before.json');
  const afterPath = join(root, 'after.json');
  const providerConfig = join(root, 'provider.json');
  await writeFile(beforePath, JSON.stringify(before));
  await writeFile(afterPath, JSON.stringify(after));
  await writeFile(
    providerConfig,
    JSON.stringify({
      id: 'catalog-example',
      packageName: '@example/catalog',
      defaultImport: false,
      namedExport: 'Catalog',
      operations: [{ resource: 'customers', method: 'retrieve', schema: 'Customer' }],
      propertyRenames: [{ schema: 'City', removed: 'legacy_city', replacement: 'display_city' }],
    }),
  );
  return { repository, before: beforePath, after: afterPath, providerConfig, proposePatch: true };
}

async function arrayProviderInputs(source: string) {
  const input = await nestedProviderInputs(source);
  for (const path of [input.before, input.after]) {
    const specification = JSON.parse(await readFile(path, 'utf8'));
    specification.components.schemas.CityCollection = {
      type: 'array',
      items: { $ref: '#/components/schemas/City' },
    };
    specification.components.schemas.Customer.properties.places = {
      $ref: '#/components/schemas/CityCollection',
    };
    await writeFile(path, JSON.stringify(specification));
  }
  return input;
}

async function seedRepository(root: string, files: Map<string, string>) {
  for (const [path, content] of files) await writeFile(join(root, path), `${content}\n`);
  await execute('git', ['init', root]);
  await execute('git', ['-C', root, 'add', '--force', '.']);
  await execute('git', [
    '-C',
    root,
    '-c',
    'user.name=Refit Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'test: seed configured provider repository',
  ]);
}

it('scans a second configured SDK through the CLI and distinguishes response schemas', async () => {
  const { stdout } = await execute(process.execPath, [
    '--import',
    'tsx',
    'pipeline/cli.ts',
    '--repository',
    INPUTS.repository,
    '--before',
    INPUTS.before,
    '--after',
    INPUTS.after,
    '--provider-config',
    INPUTS.providerConfig,
    '--propose-patch',
  ]);
  const report = JSON.parse(stdout);
  expect(report.provider).toBe('catalog-example');
  expect(report.providerDetected).toBe(true);
  expect(report.stripeDetected).toBe(false);
  expect(report.repository.dependencies).toHaveLength(1);
  expect(report.findings).toHaveLength(1);
  expect(report.findings[0]).toMatchObject({
    line: 7,
    expression: '.legacy_label',
    confidence: 'confirmed',
  });
  expect(report.patch).toMatchObject({ status: 'unsupported', edits: 0, diff: '', source: null });
  expect(report.patch.summary).not.toContain('Charges');
});

it('rejects an SDK operation mapping whose response schema is missing from the baseline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-provider-mapping-'));
  directories.push(root);
  const provider = await readProviderAdapter(INPUTS.providerConfig);
  provider.operations[0].schema = 'missing_response';
  const providerConfig = join(root, 'provider.json');
  await writeFile(providerConfig, JSON.stringify(provider));

  await expect(runPipeline({ ...INPUTS, providerConfig })).rejects.toThrow(
    'Provider operation items.retrieve maps to schema "missing_response", which is missing or unsupported in the before specification.',
  );
});

it('accepts a local schema alias in a configured SDK mapping', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-provider-schema-alias-'));
  directories.push(root);
  const provider = await readProviderAdapter(INPUTS.providerConfig);
  provider.operations[0].schema = 'ItemResponse';
  const providerConfig = join(root, 'provider.json');
  await writeFile(providerConfig, JSON.stringify(provider));

  const before = JSON.parse(await readFile(INPUTS.before, 'utf8'));
  before.components.schemas.ItemResponse = { $ref: '#/components/schemas/item' };
  const beforePath = join(root, 'before.json');
  await writeFile(beforePath, JSON.stringify(before));

  const report = await runPipeline({ ...INPUTS, before: beforePath, providerConfig });
  expect(report.findings).toMatchObject([{ expression: '.legacy_label', confidence: 'confirmed' }]);
});

it('proposes only an explicitly configured, schema-matched property rename', async () => {
  const report = await runPipeline({ ...RENAME_INPUTS, proposePatch: true });
  expect(report.adapter.propertyRenames).toEqual([
    { schema: 'item', removed: 'legacy_label', replacement: 'display_label' },
  ]);
  expect(report.patch).toMatchObject({
    status: 'proposed',
    edits: 1,
    unresolvedFindings: 0,
  });
  if (!('diff' in report.patch)) throw new Error('Expected deterministic patch');
  expect(report.patch.diff).toContain('-  return item.legacy_label;');
  expect(report.patch.diff).toContain('+  return item.display_label;');
  expect(report.patch.diff).toContain('+  return order.legacy_label;');
  expect(report.patch.warnings.join(' ')).toContain('operator-authored');
});

it('does not treat an unawaited SDK promise as the mapped response object', async () => {
  const input = await nestedProviderInputs(`import { Catalog } from '@example/catalog';
const catalog = new Catalog();
export function city(id: string) {
  const customer = catalog.customers.retrieve(id);
  return customer.address.location.legacy_city;
}`);
  const report = await runPipeline(input);
  expect(report.calls).toMatchObject([{ method: 'customers.retrieve' }]);
  expect(report.findings).toMatchObject([{ expression: '.legacy_city', confidence: 'review' }]);
  expect(report.patch).toMatchObject({ status: 'unsupported', edits: 0 });
});

it.each([
  ['a direct response chain', 'return customer.address.location.legacy_city;'],
  [
    'immutable nested aliases',
    'const address = customer.address; const location = address.location; return location.legacy_city;',
  ],
  [
    'nested destructured aliases',
    'const { address } = customer; const { location } = address; return location.legacy_city;',
  ],
  ['a string-indexed reference', "return customer['address'].location.legacy_city;"],
])('traces a nested OpenAPI $ref through %s', async (_label, read) => {
  const input = await nestedProviderInputs(`import { Catalog } from '@example/catalog';
const catalog = new Catalog();
export async function city(id: string) {
  const customer = await catalog.customers.retrieve(id);
  ${read}
}`);
  const report = await runPipeline(input);
  expect(report.findings).toMatchObject([
    {
      expression: '.legacy_city',
      confidence: 'confirmed',
      reason: expect.stringContaining('City'),
    },
  ]);
  expect(report.patch).toMatchObject({ status: 'proposed', edits: 1, unresolvedFindings: 0 });
  if (!('diff' in report.patch)) throw new Error('Expected deterministic patch');
  expect(report.patch.diff).toContain('display_city');
  expect(
    report.patch.diff
      .split('\n')
      .some((line) => line.startsWith('+') && line.includes('legacy_city')),
  ).toBe(false);
});

it.each([
  ['a literal numeric index', 'return customer.places[0].legacy_city;'],
  [
    'immutable array and item aliases',
    'const places = customer.places; const place = places[0]; return place.legacy_city;',
  ],
  [
    'object destructuring of an array field',
    'const { places } = customer; return places[0].legacy_city;',
  ],
  [
    'array destructuring of a response item',
    'const [place] = customer.places; return place.legacy_city;',
  ],
  ['const for-of iteration', 'for (const place of customer.places) return place.legacy_city;'],
  ['an inline map callback', 'return customer.places.map(place => place.legacy_city);'],
  [
    'an inline filter callback',
    "return customer.places.filter(place => place.legacy_city === 'Toronto');",
  ],
  [
    'an immutable alias in an inline callback',
    'return customer.places.map(place => { const city = place; return city.legacy_city; });',
  ],
])('traces local OpenAPI array item refs through %s', async (_label, read) => {
  const input = await arrayProviderInputs(`import { Catalog } from '@example/catalog';
const catalog = new Catalog();
export async function city(id: string) {
  const customer = await catalog.customers.retrieve(id);
  ${read}
}`);
  const report = await runPipeline(input);
  expect(report.findings).toMatchObject([
    {
      expression: '.legacy_city',
      confidence: 'confirmed',
      reason: expect.stringContaining('City'),
    },
  ]);
  expect(report.patch).toMatchObject({ status: 'proposed', edits: 1, unresolvedFindings: 0 });
  if (!('diff' in report.patch)) throw new Error('Expected deterministic patch');
  expect(report.patch.diff).toContain('display_city');
});

it.each([
  ['a dynamic index', 'return customer.places[index].legacy_city;'],
  ['mutable for-of iteration', 'for (let place of customer.places) return place.legacy_city;'],
  [
    'a mutable array destructuring binding',
    'let [place] = customer.places; return place.legacy_city;',
  ],
])('keeps %s at review', async (_label, read) => {
  const input = await arrayProviderInputs(`import { Catalog } from '@example/catalog';
const catalog = new Catalog();
export async function city(id: string, index: number) {
  const customer = await catalog.customers.retrieve(id);
  ${read}
}`);
  const report = await runPipeline(input);
  expect(report.findings).toMatchObject([{ expression: '.legacy_city', confidence: 'review' }]);
  expect(report.patch).toMatchObject({ status: 'unsupported', edits: 0, unresolvedFindings: 1 });
});

it.each([
  [
    'a named callback',
    'function readCity(place: unknown) { return place.legacy_city; } return customer.places.map(readCity);',
  ],
  [
    'a callback with an index parameter',
    'return customer.places.map((place, index) => place.legacy_city);',
  ],
])('keeps %s at review', async (_label, read) => {
  const input = await arrayProviderInputs(`import { Catalog } from '@example/catalog';
const catalog = new Catalog();
export async function city(id: string) {
  const customer = await catalog.customers.retrieve(id);
  ${read}
}`);
  const report = await runPipeline(input);
  expect(report.findings).toMatchObject([{ expression: '.legacy_city', confidence: 'review' }]);
  expect(report.patch).toMatchObject({ status: 'unsupported', edits: 0, unresolvedFindings: 1 });
});

it('keeps array callback findings confirmed when an item escapes to a call', async () => {
  const input = await arrayProviderInputs(`import { Catalog } from '@example/catalog';
const catalog = new Catalog();
export async function city(id: string) {
  const customer = await catalog.customers.retrieve(id);
  customer.places.forEach(place => normalize(place));
  return customer.places[0].legacy_city;
}`);
  const report = await runPipeline(input);
  expect(report.findings).toMatchObject([{ expression: '.legacy_city', confidence: 'confirmed' }]);
  expect(report.patch).toMatchObject({ status: 'proposed', edits: 1, unresolvedFindings: 0 });
});

it('keeps inline array item schemas at review', async () => {
  const input = await nestedProviderInputs(`import { Catalog } from '@example/catalog';
const catalog = new Catalog();
export async function city(id: string) {
  const customer = await catalog.customers.retrieve(id);
  return customer.places[0].legacy_city;
}`);
  for (const path of [input.before, input.after]) {
    const specification = JSON.parse(await readFile(path, 'utf8'));
    specification.components.schemas.Customer.properties.places = {
      type: 'array',
      items: { type: 'object', properties: { legacy_city: { type: 'string' } } },
    };
    await writeFile(path, JSON.stringify(specification));
  }
  const report = await runPipeline(input);
  expect(report.findings).toMatchObject([{ expression: '.legacy_city', confidence: 'review' }]);
  expect(report.patch).toMatchObject({ status: 'unsupported', edits: 0, unresolvedFindings: 1 });
});

it.each([
  [
    'tuple-style arrays',
    {
      type: 'array',
      prefixItems: [{ $ref: '#/components/schemas/City' }],
      items: { $ref: '#/components/schemas/City' },
    },
  ],
  [
    'external item references',
    {
      type: 'array',
      items: { $ref: 'https://api.example.test/openapi.json#/components/schemas/City' },
    },
  ],
])('keeps %s at review', async (_label, placesSchema) => {
  const input = await nestedProviderInputs(`import { Catalog } from '@example/catalog';
const catalog = new Catalog();
export async function city(id: string) {
  const customer = await catalog.customers.retrieve(id);
  return customer.places[0].legacy_city;
}`);
  for (const path of [input.before, input.after]) {
    const specification = JSON.parse(await readFile(path, 'utf8'));
    specification.components.schemas.Customer.properties.places = placesSchema;
    await writeFile(path, JSON.stringify(specification));
  }
  const report = await runPipeline(input);
  expect(report.findings).toMatchObject([{ expression: '.legacy_city', confidence: 'review' }]);
  expect(report.patch).toMatchObject({ status: 'unsupported', edits: 0, unresolvedFindings: 1 });
});

it('keeps mutable destructured response aliases at review', async () => {
  const input = await nestedProviderInputs(`import { Catalog } from '@example/catalog';
const catalog = new Catalog();
export async function city(id: string) {
  const customer = await catalog.customers.retrieve(id);
  let { address } = customer;
  return address.location.legacy_city;
}`);
  const report = await runPipeline(input);
  expect(report.findings).toMatchObject([{ expression: '.legacy_city', confidence: 'review' }]);
  expect(report.patch).toMatchObject({ status: 'unsupported', edits: 0, unresolvedFindings: 1 });
});

it('keeps nested reads confirmed when a response alias escapes to a call', async () => {
  const input = await nestedProviderInputs(`import { Catalog } from '@example/catalog';
const catalog = new Catalog();
export async function city(id: string) {
  const customer = await catalog.customers.retrieve(id);
  const { address } = customer;
  const { location } = address;
  normalize(location);
  return location.legacy_city;
}`);
  const report = await runPipeline(input);
  expect(report.findings).toMatchObject([{ expression: '.legacy_city', confidence: 'confirmed' }]);
  expect(report.patch).toMatchObject({ status: 'proposed', edits: 1, unresolvedFindings: 0 });
});

it.each(['string', 'integer', 'number', 'boolean'])(
  'accepts matching %s scalar types in a configured rename',
  async (type) => {
    const root = await mkdtemp(join(tmpdir(), 'refit-provider-rename-type-'));
    directories.push(root);
    const before = JSON.parse(await readFile(INPUTS.before, 'utf8'));
    const after = JSON.parse(await readFile(INPUTS.after, 'utf8'));
    before.components.schemas.item.properties.legacy_label.type = type;
    after.components.schemas.item.properties.display_label.type = type;
    const beforePath = join(root, 'before.json');
    const afterPath = join(root, 'after.json');
    await writeFile(beforePath, JSON.stringify(before));
    await writeFile(afterPath, JSON.stringify(after));

    const report = await runPipeline({
      ...RENAME_INPUTS,
      before: beforePath,
      after: afterPath,
      proposePatch: true,
    });
    expect(report.patch).toMatchObject({ status: 'proposed', edits: 1, unresolvedFindings: 0 });
  },
);

it('rejects configured renames whose replacement is absent, pre-existing or a different type', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-provider-rename-'));
  directories.push(root);
  const after = JSON.parse(await readFile(INPUTS.after, 'utf8'));
  after.components.schemas.item.properties.display_label.type = 'boolean';
  const incompatibleAfter = join(root, 'incompatible-after.json');
  await writeFile(incompatibleAfter, JSON.stringify(after));
  await expect(runPipeline({ ...RENAME_INPUTS, after: incompatibleAfter })).rejects.toThrow(
    /requires a newly added replacement field with the same/,
  );

  delete after.components.schemas.item.properties.display_label;
  const missingAfter = join(root, 'missing-after.json');
  await writeFile(missingAfter, JSON.stringify(after));
  await expect(runPipeline({ ...RENAME_INPUTS, after: missingAfter })).rejects.toThrow(
    /requires a newly added replacement field with the same/,
  );

  const before = JSON.parse(await readFile(INPUTS.before, 'utf8'));
  before.components.schemas.item.properties.display_label = { type: 'string' };
  const existingBefore = join(root, 'existing-before.json');
  await writeFile(existingBefore, JSON.stringify(before));
  await expect(runPipeline({ ...RENAME_INPUTS, before: existingBefore })).rejects.toThrow(
    /requires a newly added replacement field with the same/,
  );
});

it('leaves indexed field reads for review because the mapping only edits direct property access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-provider-rename-index-'));
  directories.push(root);
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ dependencies: { '@example/catalog': '1.0.0' } }),
  );
  const source = await readFile(join(INPUTS.repository, 'catalog.ts'), 'utf8');
  await writeFile(
    join(root, 'catalog.ts'),
    source.replace('item.legacy_label', "item['legacy_label']"),
  );
  const report = await runPipeline({ ...RENAME_INPUTS, repository: root, proposePatch: true });
  expect(report.findings).toMatchObject([{ confidence: 'confirmed', expression: '.legacy_label' }]);
  expect(report.patch).toMatchObject({ status: 'unsupported', edits: 0, unresolvedFindings: 1 });
});

it.skipIf(!DOCKER_IMAGE)(
  'validates a configured property rename against controlled old and new contracts in offline Docker',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'refit-configured-rename-docker-'));
    directories.push(root);
    await mkdir(join(root, 'node_modules/@example/catalog'), { recursive: true });
    const files = new Map([
      [
        'package.json',
        JSON.stringify({ type: 'module', dependencies: { '@example/catalog': '1.0.0' } }),
      ],
      [
        'catalog.js',
        [
          "import { Catalog as CatalogClient } from '@example/catalog';",
          'const catalog = new CatalogClient();',
          'export async function itemLabel(id) {',
          '  const item = await catalog.items.retrieve(id);',
          '  return item.legacy_label;',
          '}',
        ].join('\n'),
      ],
      [
        'contract.js',
        [
          "import assert from 'node:assert/strict';",
          'process.env.API_CONTRACT = process.argv[2];',
          "const { itemLabel } = await import('./catalog.js');",
          "assert.equal(await itemLabel('item_1'), 'Stable label');",
        ].join('\n'),
      ],
      [
        'node_modules/@example/catalog/package.json',
        JSON.stringify({ name: '@example/catalog', type: 'module', exports: './index.js' }),
      ],
      [
        'node_modules/@example/catalog/index.js',
        [
          'export class Catalog {',
          "  items = { retrieve: async () => process.env.API_CONTRACT === 'before'",
          "    ? { id: 'item_1', legacy_label: 'Stable label' }",
          "    : { id: 'item_1', display_label: 'Stable label' } };",
          '}',
        ].join('\n'),
      ],
    ]);
    await seedRepository(root, files);

    const report = await validateMigration({
      repository: root,
      before: RENAME_INPUTS.before,
      after: RENAME_INPUTS.after,
      providerConfig: RENAME_INPUTS.providerConfig,
      image: DOCKER_IMAGE!,
      baselineCommand: ['node', 'contract.js', 'before'],
      command: ['node', 'contract.js', 'after'],
    });
    expect(report.patch.generator).toBe('deterministic');
    expect(report.validation.baseline.status).toBe('passed');
    expect(report.validation.patched.status).toBe('passed');
    expect(report.validation.status).toBe('passed');
  },
  60_000,
);

it.skipIf(!DOCKER_IMAGE)(
  'validates an array-item configured rename against controlled contracts in offline Docker',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'refit-nested-rename-docker-'));
    directories.push(root);
    const repository = join(root, 'repository');
    await mkdir(join(repository, 'node_modules/@example/catalog'), { recursive: true });
    const providerConfig = join(root, 'provider.json');
    const beforePath = join(root, 'before.json');
    const afterPath = join(root, 'after.json');
    const before = {
      openapi: '3.0.3',
      paths: {},
      components: {
        schemas: {
          Customer: {
            type: 'object',
            properties: {
              places: { type: 'array', items: { $ref: '#/components/schemas/City' } },
            },
          },
          City: { type: 'object', properties: { legacy_city: { type: 'string' } } },
        },
      },
    };
    const after = {
      openapi: '3.0.3',
      paths: {},
      components: {
        schemas: {
          Customer: {
            type: 'object',
            properties: {
              places: { type: 'array', items: { $ref: '#/components/schemas/City' } },
            },
          },
          City: { type: 'object', properties: { display_city: { type: 'string' } } },
        },
      },
    };
    await writeFile(beforePath, JSON.stringify(before));
    await writeFile(afterPath, JSON.stringify(after));
    await writeFile(
      providerConfig,
      JSON.stringify({
        id: 'catalog-example',
        packageName: '@example/catalog',
        defaultImport: false,
        namedExport: 'Catalog',
        operations: [{ resource: 'customers', method: 'retrieve', schema: 'Customer' }],
        propertyRenames: [{ schema: 'City', removed: 'legacy_city', replacement: 'display_city' }],
      }),
    );
    await seedRepository(
      repository,
      new Map([
        [
          'package.json',
          JSON.stringify({ type: 'module', dependencies: { '@example/catalog': '1.0.0' } }),
        ],
        [
          'catalog.js',
          [
            "import { Catalog } from '@example/catalog';",
            'const catalog = new Catalog();',
            'export async function city(id) {',
            '  const customer = await catalog.customers.retrieve(id);',
            '  return customer.places.map(place => place.legacy_city)[0];',
            '}',
          ].join('\n'),
        ],
        [
          'contract.js',
          [
            "import assert from 'node:assert/strict';",
            'process.env.API_CONTRACT = process.argv[2];',
            "const { city } = await import('./catalog.js');",
            "assert.equal(await city('customer_1'), 'Toronto');",
          ].join('\n'),
        ],
        [
          'node_modules/@example/catalog/package.json',
          JSON.stringify({ name: '@example/catalog', type: 'module', exports: './index.js' }),
        ],
        [
          'node_modules/@example/catalog/index.js',
          [
            'export class Catalog {',
            "  customers = { retrieve: async () => process.env.API_CONTRACT === 'before'",
            "    ? { places: [{ legacy_city: 'Toronto' }] }",
            "    : { places: [{ display_city: 'Toronto' }] } };",
            '}',
          ].join('\n'),
        ],
      ]),
    );

    const report = await validateMigration({
      repository,
      before: beforePath,
      after: afterPath,
      providerConfig,
      image: DOCKER_IMAGE!,
      baselineCommand: ['node', 'contract.js', 'before'],
      command: ['node', 'contract.js', 'after'],
    });
    expect(report.patch.generator).toBe('deterministic');
    expect(report.patch.diff).toContain('place.display_city');
    expect(report.validation.baseline.status).toBe('passed');
    expect(report.validation.patched.status).toBe('passed');
    expect(report.validation.status).toBe('passed');
  },
  60_000,
);

it('includes provider identity in change IDs and adapter mappings in run IDs', async () => {
  const schemas = [{ thing: { properties: { removed: {} } } }, { thing: { properties: {} } }];
  expect(findRemovedProperties(schemas[0], schemas[1], 'one')[0].id).not.toBe(
    findRemovedProperties(schemas[0], schemas[1], 'two')[0].id,
  );
  const root = await mkdtemp(join(tmpdir(), 'refit-provider-'));
  directories.push(root);
  const provider = await readProviderAdapter(INPUTS.providerConfig);
  const config = join(root, 'provider.json');
  await writeFile(
    config,
    JSON.stringify({
      ...provider,
      operations: [...provider.operations, { resource: 'items', method: 'update', schema: 'item' }],
    }),
  );
  const original = await runPipeline(INPUTS);
  const changed = await runPipeline({ ...INPUTS, providerConfig: config });
  expect(changed.runId).not.toBe(original.runId);
});

it.each([
  { id: 'stripe' },
  { operations: [] },
  { defaultImport: false, namedExport: null },
  { extra: true },
])('rejects invalid custom adapter %j', async (change) => {
  const root = await mkdtemp(join(tmpdir(), 'refit-provider-'));
  directories.push(root);
  const config = join(root, 'provider.json');
  await writeFile(
    config,
    JSON.stringify({ ...(await readProviderAdapter(INPUTS.providerConfig)), ...change }),
  );
  await expect(readProviderAdapter(config)).rejects.toThrow(/Invalid provider configuration/);
});

it('rejects ambiguous configured property renames', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-provider-config-'));
  directories.push(root);
  const config = join(root, 'provider.json');
  const provider = await readProviderAdapter(INPUTS.providerConfig);
  const candidates = [
    [{ schema: 'item', removed: 'same', replacement: 'same' }],
    [
      { schema: 'item', removed: 'first', replacement: 'label' },
      { schema: 'item', removed: 'second', replacement: 'label' },
    ],
    [
      { schema: 'item', removed: 'legacy_label', replacement: 'display_label' },
      { schema: 'item', removed: 'legacy_label', replacement: 'name' },
    ],
  ];
  for (const propertyRenames of candidates) {
    await writeFile(config, JSON.stringify({ ...provider, propertyRenames }));
    await expect(readProviderAdapter(config)).rejects.toThrow();
  }
});
