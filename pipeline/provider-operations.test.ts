import { rm } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import {
  findBreakingOperationImpacts,
  validateProviderOperationMappings,
} from './provider-operations.ts';

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
