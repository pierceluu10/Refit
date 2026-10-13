import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { readProviderAdapter } from './providers.ts';
import { runPipeline } from './run.ts';
import { findRemovedProperties } from './specifications.ts';

const execute = promisify(execFile);
const FIXTURE = resolve('pipeline/fixtures/catalog');
const INPUTS = {
  repository: join(FIXTURE, 'repository'),
  before: join(FIXTURE, 'before.json'),
  after: join(FIXTURE, 'after.json'),
  providerConfig: join(FIXTURE, 'provider.json'),
};
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

it('accepts dotted resources, schema-less request checks, and optional response schemas', async () => {
  const provider = await readProviderAdapter(resolve('pipeline/fixtures/openai/provider.json'));
  expect(provider.operations).toEqual([
    {
      resource: 'completions',
      method: 'create',
      requestChecks: [{ argument: 'model', kind: 'model-id' }],
    },
    {
      resource: 'chat.completions',
      method: 'create',
      requestChecks: [{ argument: 'model', kind: 'model-id' }],
    },
  ]);
  expect((await readProviderAdapter(INPUTS.providerConfig)).operations[0].schema).toBe('item');
});

it.each([
  { resource: '.chat.completions', method: 'create', schema: 'Result' },
  { resource: 'chat..completions', method: 'create', schema: 'Result' },
  { resource: 'chat.completions.', method: 'create', schema: 'Result' },
  { resource: 'chat.completions', method: 'create' },
  { resource: 'chat.completions', method: 'create', schema: null },
  { resource: 'chat.completions', method: 'create', requestChecks: [] },
  {
    resource: 'chat.completions',
    method: 'create',
    requestChecks: [{ argument: 'model', kind: 'other' }],
  },
  {
    resource: 'chat.completions',
    method: 'create',
    requestChecks: [{ argument: 'model', kind: 'model-id', extra: true }],
  },
  {
    resource: 'chat.completions',
    method: 'create',
    requestChecks: [
      { argument: 'model', kind: 'model-id' },
      { argument: 'model', kind: 'model-id' },
    ],
  },
  { resource: 'chat.completions', method: 'create', schema: 'Result', extra: true },
])('rejects malformed provider operation shapes: %j', async (operation) => {
  const root = await mkdtemp(join(tmpdir(), 'refit-provider-operation-'));
  directories.push(root);
  const provider = await readProviderAdapter(INPUTS.providerConfig);
  const config = join(root, 'provider.json');
  await writeFile(config, JSON.stringify({ ...provider, operations: [operation] }));
  await expect(readProviderAdapter(config)).rejects.toThrow(
    /provider operation|provider request check|request check arguments/,
  );
});
