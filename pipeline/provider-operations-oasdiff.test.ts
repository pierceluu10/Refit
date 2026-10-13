import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runPipeline } from './run.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.skipIf(!process.env.REFIT_OASDIFF)(
  'correlates a real oasdiff endpoint removal with configured SDK call sites',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'refit-oasdiff-operation-test-'));
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
    await writeFile(before, JSON.stringify(beforeSpecification));
    await writeFile(
      after,
      JSON.stringify({
        ...beforeSpecification,
        info: { title: 'Catalog API', version: '2.0.0' },
        paths: {},
      }),
    );
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

    const report = await runPipeline({
      repository,
      before,
      after,
      providerConfig,
      apiVersion: '1.0.0',
      fullDiff: true,
      proposePatch: true,
    });

    expect(report.specificationDiff.changes).toContainEqual(
      expect.objectContaining({
        id: 'api-path-removed-without-deprecation',
        operationId: 'retrieveCustomer',
        path: '/customers/{id}',
      }),
    );
    expect(report.operationImpacts).toMatchObject([
      {
        operationId: 'retrieveCustomer',
        path: '/customers/{id}',
        httpMethod: 'GET',
        usages: [{ method: 'customers.retrieve', file: 'catalog.ts', line: 4 }],
      },
    ]);
    expect(report.patch).toMatchObject({ status: 'unsupported', unresolvedFindings: 1 });
  },
);
