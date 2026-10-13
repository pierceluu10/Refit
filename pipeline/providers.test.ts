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
      'test: seed configured rename repository',
    ]);

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

it('passes the configured provider through AI generation and the rescan', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url, request) => {
      const input = JSON.parse(JSON.parse(request.body).input[0].content);
      expect(input.provider).toBe('catalog-example');
      expect(input.adapter.packageName).toBe('@example/catalog');
      return new Response(
        JSON.stringify({
          id: 'resp_catalog',
          model: 'test-model',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    summary: 'Use the new label field.',
                    uncertainties: ['Confirm the new field preserves semantics.'],
                    edits: [
                      {
                        file: 'catalog.ts',
                        original: 'item.legacy_label',
                        replacement: 'item.display_label',
                        findingId: input.findings[0].id,
                      },
                    ],
                  }),
                },
              ],
            },
          ],
        }),
      );
    }),
  );
  const report = await runPipeline({
    ...INPUTS,
    aiPatch: { apiKey: 'test-key', model: 'test-model' },
  });
  expect(report.patch).toMatchObject({ generator: 'openai', edits: 1, unresolvedFindings: 0 });
  if (!('diff' in report.patch)) throw new Error('Expected patch');
  expect(report.patch.diff).toContain('item.display_label');
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
