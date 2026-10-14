import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runPipeline } from './run.ts';
import { runWorkflow } from './workflow.ts';
import { compareOpenApi, unmappedBreakingChanges } from './openapi-diff.ts';
import { validateMigration } from './validation.ts';
import { renderWorkflowResult } from './workflow-presentation.ts';

vi.mock('./openapi-diff.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./openapi-diff.ts')>()),
  compareOpenApi: vi.fn(),
}));
vi.mock('./validation.ts', () => ({ validateMigration: vi.fn() }));

const execute = promisify(execFile);
const FIXTURE = resolve('pipeline/fixtures/endpoint-replacement');
const roots: string[] = [];
const REMOVAL = {
  id: 'api-path-removed-without-deprecation',
  text: 'api path removed without deprecation',
  level: 3,
  path: '/legacy/items/{id}',
  operation: 'GET',
};

beforeEach(() => {
  vi.mocked(compareOpenApi).mockResolvedValue({
    engine: 'oasdiff',
    version: 'mocked',
    coverage: 'Mocked contract diff.',
    changes: [REMOVAL],
  });
});

afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function inputs() {
  const root = await mkdtemp(join(tmpdir(), 'refit-endpoint-test-'));
  roots.push(root);
  const repository = join(root, 'repository');
  await cp(join(FIXTURE, 'repository'), repository, { recursive: true });
  return {
    root,
    repository,
    before: join(FIXTURE, 'before.json'),
    after: join(FIXTURE, 'after.json'),
    providerConfig: join(FIXTURE, 'provider.json'),
    apiVersion: '1',
    fullDiff: true,
  };
}

it.each([
  ['items', 'items', 'retrieve'],
  ['items', 'products', 'get'],
  ['items', 'inventory.current.products', 'get'],
  ['inventory.legacy.items', 'items', 'retrieve'],
  ['inventory.legacy.items', 'inventory.current.products', 'get'],
])(
  'replaces a shared-client call from %s with %s.%s and preserves the HTTP contract',
  async (resource, replacementResource, replacementMethod) => {
    const configuration = await inputs();
    const provider = JSON.parse(await readFile(configuration.providerConfig, 'utf8'));
    provider.operations[0].resource = resource;
    provider.operationReplacements[0].resource = resource;
    provider.operationReplacements[0].replacementResource = replacementResource;
    provider.operationReplacements[0].replacementMethod = replacementMethod;
    configuration.providerConfig = join(configuration.root, 'provider.json');
    await writeFile(configuration.providerConfig, JSON.stringify(provider));
    const sourcePath = join(configuration.repository, 'src/items.ts');
    const source = (await readFile(sourcePath, 'utf8')).replace(
      'catalog.items.retrieveLegacy',
      `catalog.${resource}.retrieveLegacy`,
    );
    await writeFile(sourcePath, source);
    const check = (mode: string) =>
      execute(process.execPath, ['--experimental-strip-types', 'simulator/check.mjs', mode], {
        cwd: configuration.repository,
      });
    expect((await check('before')).stdout).toContain('success, options, and propagated 404');
    await expect(check('after')).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Endpoint retired'),
    });
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const report = await runPipeline({
      ...configuration,
      proposePatch: true,
      aiPatch: { apiKey: 'unused', model: 'unused' },
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(report.operationChanges).toMatchObject([
      { supported: true, usages: [{ method: `${resource}.retrieveLegacy`, file: 'src/items.ts' }] },
    ]);
    expect(report.operationImpacts).toEqual([]);
    expect(
      unmappedBreakingChanges(
        report.specificationDiff,
        report.changes,
        report.findings,
        report.operationChanges,
      ),
    ).toEqual([]);
    expect(report.patch).toMatchObject({
      generator: 'deterministic',
      status: 'proposed',
      edits: 1,
      unresolvedFindings: 0,
    });
    if (!('diff' in report.patch)) throw new Error('Expected endpoint patch');
    expect(report.patch.diff).toContain(
      `+  const item = await catalog.${replacementResource}.${replacementMethod}(id, options);`,
    );
    expect(await readFile(join(configuration.repository, 'src/items.ts'), 'utf8')).toBe(source);
    const patch = join(configuration.root, 'migration.patch');
    await writeFile(patch, report.patch.diff);
    await execute('git', ['apply', '--check', patch], { cwd: configuration.repository });
    await execute('git', ['apply', patch], { cwd: configuration.repository });
    expect((await check('after')).stdout).toContain('success, options, and propagated 404');
  },
);

it.each([
  [
    'an escaped client',
    'register(catalog);\nexport async function label(id) { return await catalog.items.retrieveLegacy(id); }',
    'items',
  ],
  [
    'an optional invocation',
    'export async function label(id) { return await catalog.items.retrieveLegacy?.(id); }',
    'items',
  ],
  [
    'an escaped nested resource',
    'register(catalog.inventory.legacy.items);\nexport async function label(id) { return await catalog.inventory.legacy.items.retrieveLegacy(id); }',
    'inventory.legacy.items',
  ],
  [
    'an optional nested resource',
    'export async function label(id) { return await catalog.inventory?.legacy.items.retrieveLegacy(id); }',
    'inventory.legacy.items',
  ],
])('keeps %s for review and never starts AI or validation', async (_label, code, resource) => {
  const configuration = await inputs();
  const provider = JSON.parse(await readFile(configuration.providerConfig, 'utf8'));
  provider.operations[0].resource = resource;
  provider.operationReplacements[0].resource = resource;
  configuration.providerConfig = join(configuration.root, 'provider.json');
  await writeFile(configuration.providerConfig, JSON.stringify(provider));
  await writeFile(
    join(configuration.repository, 'src/items.ts'),
    `import { catalog } from './client.ts';\n${code}\n`,
  );
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const report = await runPipeline({ ...configuration, proposePatch: true });
  expect(report.operationChanges).toMatchObject([{ supported: false }]);
  expect(report.findings).toMatchObject([{ confidence: 'review' }]);
  expect(report.patch).toMatchObject({ status: 'unsupported', unresolvedFindings: 1 });
  const result = await runWorkflow({
    ...configuration,
    output: join(configuration.root, 'run'),
    image: 'unused',
    command: ['node', 'unused'],
    aiPatch: { apiKey: 'unused', model: 'unused' },
  });
  expect(result.manifest.status).toBe('needs-review');
  expect(validateMigration).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});

it('maps nested SDK callers to an unhandled removed operation and stops before AI or checks', async () => {
  const configuration = await inputs();
  const provider = JSON.parse(await readFile(configuration.providerConfig, 'utf8'));
  delete provider.operationReplacements;
  provider.operations[0].resource = 'inventory.legacy.items';
  configuration.providerConfig = join(configuration.root, 'provider.json');
  await writeFile(configuration.providerConfig, JSON.stringify(provider));
  const source = join(configuration.repository, 'src/items.ts');
  await writeFile(
    source,
    (await readFile(source, 'utf8')).replace(
      'catalog.items.retrieveLegacy',
      'catalog.inventory.legacy.items.retrieveLegacy',
    ),
  );
  const report = await runPipeline(configuration);
  expect(report.operationImpacts).toMatchObject([
    { usages: [{ method: 'inventory.legacy.items.retrieveLegacy' }] },
  ]);
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const result = await runWorkflow({
    ...configuration,
    output: join(configuration.root, 'run'),
    image: 'unused',
    command: ['node', 'unused'],
    aiPatch: { apiKey: 'unused', model: 'unused' },
  });
  expect(result.manifest.status).toBe('needs-review');
  expect(validateMigration).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});

it('does not publish a partial endpoint migration when another client usage requires review', async () => {
  const configuration = await inputs();
  await writeFile(
    join(configuration.repository, 'src/items.ts'),
    `import { Catalog } from '@example/catalog';
const safe = new Catalog({ baseUrl: 'http://localhost' });
const risky = new Catalog({ baseUrl: 'http://localhost' });
register(risky);
export async function safeLabel(id) { return await safe.items.retrieveLegacy(id); }
export async function riskyLabel(id) { return await risky.items.retrieveLegacy(id); }
`,
  );
  const report = await runPipeline({ ...configuration, proposePatch: true });
  expect(report.operationChanges).toMatchObject([{ supported: false, usages: [{}, {}] }]);
  expect(report.patch).toMatchObject({ status: 'proposed', edits: 1, unresolvedFindings: 1 });
  const result = await runWorkflow({
    ...configuration,
    output: join(configuration.root, 'run'),
    image: 'unused',
    command: ['node', 'unused'],
  });
  expect(result.manifest.status).toBe('needs-review');
  expect(validateMigration).not.toHaveBeenCalled();
});

it('keeps unrelated or non-removal breaking changes behind the workflow gate', async () => {
  const configuration = await inputs();
  vi.mocked(compareOpenApi).mockResolvedValue({
    engine: 'oasdiff',
    version: 'mocked',
    coverage: 'Mocked contract diff.',
    changes: [
      REMOVAL,
      {
        id: 'response-property-type-changed',
        text: 'another unresolved change',
        level: 3,
        path: REMOVAL.path,
        operation: 'GET',
      },
    ],
  });
  const result = await runWorkflow({
    ...configuration,
    output: join(configuration.root, 'run'),
    image: 'unused',
    command: ['node', 'unused'],
  });
  expect(result.manifest.status).toBe('needs-review');
  expect(validateMigration).not.toHaveBeenCalled();
  const terminal = await renderWorkflowResult(result);
  expect(terminal).toContain('items.retrieveLegacy → items.retrieve');
  expect(terminal).toContain('another unresolved change');
});
