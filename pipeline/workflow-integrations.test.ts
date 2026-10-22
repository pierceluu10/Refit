import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import {
  MAX_REPOSITORY_INTEGRATIONS,
  parseWorkflowConfiguration,
  parseWorkflowConfigurations,
  readWorkflowConfiguration,
} from './workflow-configuration.ts';

const execute = promisify(execFile);
const bin = resolve('bin/refit.mjs');
const roots: string[] = [];
const stripe = {
  id: 'stripe',
  before: './stripe/before.json',
  after: './stripe/current.json',
  apiVersion: '2022-08-01',
  image: 'stripe-checks',
  command: ['npm', 'test'],
};
const catalog = {
  id: 'catalog',
  before: './catalog/before.json',
  after: './catalog/current.json',
  providerConfig: './catalog/adapter.json',
  apiVersion: '1',
  apiVersionPolicy: 'source-verified',
  image: 'catalog-checks',
  command: ['node', 'contract.mjs'],
};
const path = '/application/.refit.json';
const collection = (integrations: unknown[]) => JSON.stringify({ formatVersion: 2, integrations });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('selects distinct provider inputs, checks and version policies from one repository profile', () => {
  const content = collection([stripe, catalog]);
  expect(parseWorkflowConfigurations(content, path).workflows.map(({ id }) => id)).toEqual([
    'stripe',
    'catalog',
  ]);
  expect(parseWorkflowConfiguration(content, path, 'stripe')).toMatchObject({
    integration: 'stripe',
    before: '/application/stripe/before.json',
    command: ['npm', 'test'],
  });
  expect(parseWorkflowConfiguration(content, path, 'catalog')).toMatchObject({
    integration: 'catalog',
    providerConfig: '/application/catalog/adapter.json',
    apiVersionPolicy: 'source-verified',
    command: ['node', 'contract.mjs'],
  });
});

it.each([undefined, 'unknown', '../stripe'])(
  'requires an explicit valid integration selector %s',
  (selector) => {
    expect(() => parseWorkflowConfiguration(collection([stripe, catalog]), path, selector)).toThrow(
      /integration/,
    );
  },
);

it.each(
  [
    [],
    [stripe, stripe],
    [{ ...stripe, id: 'Stripe' }],
    [{ ...stripe, id: '../outside' }],
    [{ ...stripe, id: 'x'.repeat(65) }],
    [{ ...stripe, formatVersion: 1 }],
    [{ ...stripe, repository: '../another-repo' }],
    [{ ...stripe, apiKey: 'must-not-be-accepted' }],
    [{ ...stripe, publishDraft: true }],
    Array.from({ length: MAX_REPOSITORY_INTEGRATIONS + 1 }, (_, index) => ({
      ...stripe,
      id: `api-${index}`,
    })),
  ].map((integrations) => ({ integrations })),
)('rejects ambiguous, excessive or unsafe integration collections %j', ({ integrations }) => {
  expect(() => parseWorkflowConfigurations(collection(integrations), path)).toThrow();
});

it('validates every integration rather than hiding malformed siblings behind a selected one', () => {
  expect(() =>
    parseWorkflowConfiguration(collection([stripe, { ...catalog, command: [] }]), path, 'stripe'),
  ).toThrow(/command/);
  expect(() =>
    parseWorkflowConfiguration(
      JSON.stringify({ formatVersion: 2, integrations: [stripe], repository: '/another' }),
      path,
      'stripe',
    ),
  ).toThrow(/outside the file/);
  expect(() =>
    parseWorkflowConfiguration(
      JSON.stringify({ ...stripe, id: undefined, formatVersion: 1 }),
      path,
      'stripe',
    ),
  ).toThrow(/no named integrations/);
});

it('executes selected CLI scans from outside the checkout without mixing provider inputs or requesting AI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-multi-workflows-'));
  roots.push(root);
  const fixture = resolve('pipeline/fixtures');
  const config = join(root, '.refit.json');
  const common = { image: 'unused-image', command: ['node', '--version'] };
  const integrations = [
    {
      ...common,
      id: 'stripe',
      before: relative(root, join(fixture, 'before.json')),
      after: relative(root, join(fixture, 'before.json')),
      apiVersion: '2022-08-01',
    },
    {
      ...common,
      id: 'catalog',
      before: relative(root, join(fixture, 'catalog/before.json')),
      after: relative(root, join(fixture, 'catalog/before.json')),
      providerConfig: relative(root, join(fixture, 'catalog/provider.json')),
      apiVersion: '1.0.0',
    },
  ];
  await writeFile(config, collection(integrations));
  expect((await readWorkflowConfiguration(config, 'catalog')).providerConfig).toBe(
    join(fixture, 'catalog/provider.json'),
  );
  for (const integration of ['stripe', 'catalog']) {
    const output = join(root, `${integration}-run`);
    await expect(
      execute(
        process.execPath,
        [
          bin,
          'run',
          '--repository',
          join(fixture, 'repository'),
          '--config',
          config,
          '--integration',
          integration,
          '--output',
          output,
          '--json',
        ],
        { cwd: tmpdir() },
      ),
    ).rejects.toMatchObject({ code: 2 });
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
    const scan = JSON.parse(await readFile(join(output, 'scan.json'), 'utf8'));
    expect(manifest).toMatchObject({ integration, status: 'needs-review', stage: 'scan' });
    expect(scan.provider).toBe(integration === 'stripe' ? 'stripe' : 'catalog-example');
    expect(manifest.files.some(({ path }: { path: string }) => path === 'report.json')).toBe(false);
  }
  await expect(
    execute(process.execPath, [bin, 'run', '--config', config, '--output', join(root, 'missing')]),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('integrations; choose one with --integration:'),
  });
  await expect(readFile(join(root, 'missing/manifest.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  // Starts the CLI several times; loaded runners can exceed the default 5s timeout.
}, 30_000);
