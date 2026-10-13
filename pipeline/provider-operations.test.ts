import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { compareOpenApi } from './openapi-diff.ts';
import {
  findBreakingOperationImpacts,
  validateProviderOperationMappings,
} from './provider-operations.ts';
import { runPipeline } from './run.ts';
import { runWorkflow } from './workflow.ts';
import { renderWorkflowResult } from './workflow-presentation.ts';
import { validateMigration } from './validation.ts';

vi.mock('./openapi-diff.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('./openapi-diff.ts')>();
  return { ...original, compareOpenApi: vi.fn() };
});
vi.mock('./validation.ts', () => ({ validateMigration: vi.fn() }));

const roots: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('requires each configured operationId to resolve once in the before contract', () => {
  const provider = {
    id: 'catalog-example',
    packageName: '@example/catalog',
    defaultImport: false,
    namedExport: 'Catalog',
    operations: [
      {
        resource: 'customers',
        method: 'retrieve',
        schema: 'Customer',
        operationId: 'retrieveCustomer',
      },
    ],
  };
  expect(
    validateProviderOperationMappings(provider, {
      paths: {
        '/customers/{id}': { get: { operationId: 'retrieveCustomer' } },
        '/customers': { get: { operationId: 'listCustomers' } },
      },
    }),
  ).toMatchObject([
    {
      operationId: 'retrieveCustomer',
      path: '/customers/{id}',
      httpMethod: 'GET',
    },
  ]);
  expect(() => validateProviderOperationMappings(provider, { paths: {} })).toThrow(
    /resolves to 0 operations/,
  );
  expect(() =>
    validateProviderOperationMappings(provider, {
      paths: {
        '/customers/{id}': { get: { operationId: 'retrieveCustomer' } },
        '/customer/{id}': { get: { operationId: 'retrieveCustomer' } },
      },
    }),
  ).toThrow(/resolves to 2 operations/);
});

it.each(['api-path-removed-with-deprecation', 'api-removed-with-deprecation'])(
  'reports a removed operation even when the contract marked it deprecated first (%s)',
  (id) => {
    expect(
      findBreakingOperationImpacts(
        {
          engine: 'oasdiff',
          changes: [
            {
              id,
              text: 'api removed with deprecation',
              level: 1,
              operation: 'GET',
              operationId: 'retrieveCustomer',
              path: '/customers/{id}',
            },
          ],
        },
        [
          {
            file: 'billing.ts',
            line: 4,
            column: 24,
            method: 'customers.retrieve',
            operationId: 'retrieveCustomer',
          },
        ],
        [
          {
            resource: 'customers',
            method: 'retrieve',
            schema: 'Customer',
            operationId: 'retrieveCustomer',
            path: '/customers/{id}',
            httpMethod: 'GET',
          },
        ],
      ),
    ).toMatchObject([
      {
        operationId: 'retrieveCustomer',
        httpMethod: 'GET',
        changes: [{ id, level: 1 }],
        usages: [{ method: 'customers.retrieve' }],
      },
    ]);
  },
);

it('maps unresolved breaking changes by their baseline path and HTTP method', () => {
  const change = {
    id: 'response-property-type-changed',
    text: 'changed the response property type',
    level: 3,
    operation: 'get',
    path: '/customers/{id}',
  };
  expect(
    findBreakingOperationImpacts(
      { engine: 'oasdiff', changes: [change] },
      [
        {
          file: 'billing.ts',
          line: 4,
          column: 24,
          method: 'customers.retrieve',
          operationId: 'retrieveCustomer',
        },
      ],
      [
        {
          resource: 'customers',
          method: 'retrieve',
          schema: 'Customer',
          operationId: 'retrieveCustomer',
          path: '/customers/{id}',
          httpMethod: 'GET',
        },
      ],
      [change],
    ),
  ).toMatchObject([
    {
      operationId: 'retrieveCustomer',
      changes: [{ id: 'response-property-type-changed', level: 3 }],
      usages: [{ file: 'billing.ts', line: 4 }],
    },
  ]);
});

it('finds SDK call sites for a removed mapped OpenAPI operation and blocks paid or executable work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-provider-operation-test-'));
  roots.push(root);
  const repository = join(root, 'repository');
  await mkdir(repository);
  await writeFile(
    join(repository, 'package.json'),
    JSON.stringify({ dependencies: { '@example/catalog': '1.0.0' } }),
  );
  await writeFile(
    join(repository, 'catalog.ts'),
    "import { Catalog } from '@example/catalog';\nconst catalog = new Catalog();\nexport async function customer(id: string) {\n  return await catalog.customers.retrieve(id);\n}\n",
  );

  const before = join(root, 'before.json');
  const after = join(root, 'after.json');
  const providerConfig = join(root, 'provider.json');
  const beforeSpecification = {
    openapi: '3.0.3',
    info: { title: 'Catalog API', version: '1.0.0' },
    paths: {
      '/customers/{id}': {
        get: {
          operationId: 'retrieveCustomer',
          responses: { '200': { description: 'Customer' } },
        },
      },
    },
    components: {
      schemas: { Customer: { type: 'object', properties: { id: { type: 'string' } } } },
    },
  };
  const afterSpecification = {
    ...beforeSpecification,
    info: { title: 'Catalog API', version: '2.0.0' },
    paths: {},
  };
  await writeFile(before, JSON.stringify(beforeSpecification));
  await writeFile(after, JSON.stringify(afterSpecification));
  await writeFile(
    providerConfig,
    JSON.stringify({
      id: 'catalog-example',
      packageName: '@example/catalog',
      defaultImport: false,
      namedExport: 'Catalog',
      operations: [
        {
          resource: 'customers',
          method: 'retrieve',
          schema: 'Customer',
          operationId: 'retrieveCustomer',
        },
      ],
    }),
  );
  vi.mocked(compareOpenApi).mockResolvedValue({
    engine: 'oasdiff',
    version: 'test',
    coverage: 'Tested operation removal.',
    changes: [
      {
        id: 'api-removed-without-deprecation',
        text: 'api removed without deprecation',
        level: 3,
        operation: 'GET',
        operationId: 'retrieveCustomer',
        path: '/customers/{id}',
      },
    ],
  });
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);

  const direct = await runPipeline({
    repository,
    before,
    after,
    providerConfig,
    apiVersion: '1.0.0',
    fullDiff: true,
    aiPatch: { apiKey: 'unused', model: 'unused' },
  });
  expect(direct.patch).toMatchObject({
    status: 'not-generated',
    reason: expect.stringContaining('AI generation is blocked'),
  });
  expect(fetcher).not.toHaveBeenCalled();

  const output = join(root, 'run');
  const result = await runWorkflow({
    repository,
    before,
    after,
    providerConfig,
    apiVersion: '1.0.0',
    fullDiff: true,
    output,
    image: 'node:22-alpine',
    command: ['npm', 'test'],
    aiPatch: { apiKey: 'unused', model: 'unused' },
  });

  expect(result.manifest).toMatchObject({ status: 'needs-review', stage: 'scan' });
  expect(result.manifest.reason).toContain(
    'traced 1 SDK call site to unresolved breaking OpenAPI changes',
  );
  expect(validateMigration).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
  const scan = JSON.parse(await readFile(join(output, 'scan.json'), 'utf8'));
  expect(scan).toMatchObject({
    status: 'affected',
    operationImpacts: [
      {
        operationId: 'retrieveCustomer',
        path: '/customers/{id}',
        httpMethod: 'GET',
        changes: [{ id: 'api-removed-without-deprecation', level: 3 }],
        usages: [{ method: 'customers.retrieve', file: 'catalog.ts', line: 4 }],
      },
    ],
    patch: { status: 'unsupported', unresolvedFindings: 1 },
  });
  const terminal = await renderWorkflowResult(result);
  expect(terminal).toContain('GET /customers/{id} (retrieveCustomer)');
  expect(terminal).toContain('[api-removed-without-deprecation] api removed without deprecation');
  expect(terminal).toContain('catalog.ts:4');
});
