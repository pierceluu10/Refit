import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildSchema, introspectionFromSchema } from 'graphql';
import { afterEach, expect, it } from 'vitest';
import { addAgents, builtInPackage, detectProviders } from './agent-catalog.ts';
import { runPipeline } from './run.ts';
import { readRepository } from './repository.ts';
import { scanShopify } from './shopify-analysis.ts';
import { enumFromVersion, sdkHasEnumMember, versionFromEnum } from './shopify-versions.ts';
import { digest, shopifySchemaUrl } from './specifications.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function directory(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-shopify-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

// A small Admin-like schema per version: `legacyCode` is removed, `publishedAt` changes type and
// `handle` is deprecated in the after version.
const SCHEMA = (version: 'before' | 'after') => `
  scalar Date
  scalar DateTime
  type Product {
    id: ID!
    title: String!
    handle: String! ${version === 'after' ? '@deprecated(reason: "Use `slug` instead.")' : ''}
    slug: String!
    publishedAt: ${version === 'before' ? 'Date' : 'DateTime'}
    ${version === 'before' ? 'legacyCode: String' : ''}
  }
  type Shop { name: String! }
  type QueryRoot { product(id: ID!): Product shop: Shop! }
  schema { query: QueryRoot }
`;

async function snapshots(root: string) {
  const write = async (name: string, version: string, sdl: string) => {
    const content = JSON.stringify({ data: introspectionFromSchema(buildSchema(sdl)) });
    const path = join(root, `${name}.json`);
    await writeFile(
      path,
      JSON.stringify({
        formatVersion: 1,
        kind: 'refit-graphql-snapshot',
        provider: 'shopify',
        version,
        url: shopifySchemaUrl(version),
        hash: digest(content),
        content,
      }),
    );
    return path;
  };
  return {
    before: await write('before', '2026-01', SCHEMA('before')),
    after: await write('after', '2026-10', SCHEMA('after')),
  };
}

const LOCK = (release: string) =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { '@shopify/shopify-app-remix': '^4.0.0' } },
      'node_modules/@shopify/shopify-app-remix': { version: '4.0.0' },
      'node_modules/@shopify/shopify-api': { version: release },
    },
  });
const MANIFEST = JSON.stringify({
  name: 'app',
  dependencies: { '@shopify/shopify-app-remix': '^4.0.0' },
});
const SERVER = (
  version: string,
) => `import { shopifyApp, ApiVersion } from '@shopify/shopify-app-remix/server';
export const shopify = shopifyApp({ apiVersion: ApiVersion.${version}, scopes: ['read_products'] });
`;

it('maps Shopify versions to ApiVersion members and knows which SDK release first ships each', () => {
  expect(versionFromEnum('October26')).toBe('2026-10');
  expect(enumFromVersion('2026-04')).toBe('April26');
  expect(enumFromVersion('2026-05')).toBeUndefined();
  expect(sdkHasEnumMember('12.3.0', 'April26')).toBe(true);
  expect(sdkHasEnumMember('12.3.0', 'October26')).toBe(false);
  expect(sdkHasEnumMember('14.0.1', 'October26')).toBe(true);
  expect(sdkHasEnumMember('next', 'October26')).toBe(false);
});

it('finds Admin documents through calls, constants, imports, fragments and ternaries, plus REST and pins', async () => {
  const root = await directory({
    'package.json': MANIFEST,
    'app/fragments.ts':
      'export const PRODUCT_FIELDS = `fragment ProductFields on Product { id title }`;\n',
    'app/queries.ts':
      "import { PRODUCT_FIELDS } from './fragments';\nexport const PRODUCT = `#graphql\n  query Product($id: ID!) { product(id: $id) { ...ProductFields } }\n  ${PRODUCT_FIELDS}`;\n",
    'app/routes/product.ts': `import { authenticate } from '../shopify.server';
import { PRODUCT } from '../queries';
export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const SHOP = \`query { shop { name } }\`;
  await admin.graphql(PRODUCT, { variables: { id: '1' } });
  await admin.graphql(SHOP);
  await admin.graphql(request.flag ? PRODUCT : SHOP);
  const built = 'query { ' + request.field + ' }';
  await admin.graphql(built);
  await admin.rest.resources.Product.all({ session: {} });
  return fetch('https://shop.myshopify.com/admin/api/2025-07/products.json');
}
`,
    'app/client.ts': `import { createAdminApiClient } from '@shopify/admin-api-client';
const client = createAdminApiClient({ storeDomain: 'x', apiVersion: '2025-10', accessToken: 't' });
export const run = () => client.request(\`query { shop { name } }\`);
`,
    'app/shopify.server.ts': SERVER('January25'),
    '.graphqlrc.ts':
      "import { ApiVersion } from '@shopify/shopify-app-remix/server';\nexport default { apiVersion: ApiVersion.July25 };\n",
    'app/latest.ts':
      "import { LATEST_API_VERSION } from '@shopify/shopify-api';\nexport const version = LATEST_API_VERSION;\n",
  });
  const scan = scanShopify(await readRepository(root, '@shopify/shopify-app-remix'));
  expect(scan.adminCalls).toBe(5);
  expect(scan.documents.map((document) => [document.file, document.traced])).toEqual([
    ['app/client.ts', true],
    ['app/queries.ts', true],
    ['app/routes/product.ts', true],
  ]);
  const product = scan.documents.find((document) => document.file === 'app/queries.ts')!;
  expect(product.text).toContain('fragment ProductFields on Product { id title }');
  expect(scan.unreadable).toMatchObject([{ file: 'app/routes/product.ts', line: 10 }]);
  expect(scan.rest.map((entry) => entry.line)).toEqual([11, 12]);
  expect(scan.versions.map((entry) => `${entry.kind}:${entry.value}:${entry.file}`).sort()).toEqual(
    [
      'enum:2025-01:app/shopify.server.ts',
      'enum:2025-07:.graphqlrc.ts',
      'string:2025-10:app/client.ts',
      'url:2025-07:app/routes/product.ts',
    ],
  );
  expect(scan.unresolvedVersions).toMatchObject([{ file: 'app/latest.ts', line: 2 }]);
});

it('bumps a sunset pin the SDK can name when every document validates on the target contract', async () => {
  const root = await directory({
    'package.json': MANIFEST,
    'package-lock.json': LOCK('14.0.1'),
    'app/shopify.server.ts': SERVER('January25'),
    '.graphqlrc.ts':
      "import { ApiVersion } from '@shopify/shopify-app-remix/server';\nexport default { apiVersion: ApiVersion.January25 };\n",
    'app/routes/product.ts': `export async function loader(admin) {
  return admin.graphql(\`#graphql
    query { product(id: "1") { id title handle } }\`);
}
`,
  });
  const report = (await runPipeline({
    repository: root,
    ...(await snapshots(root)),
    proposePatch: true,
  })) as any;
  expect(report.provider).toBe('shopify');
  expect(report.apiVersion).toMatchObject({
    application: '2025-01',
    applicability: 'matches-before',
  });
  expect(report.apiVersion.reason).toContain('oldest supported');
  expect(report.findings).toMatchObject([
    {
      file: 'app/shopify.server.ts',
      line: 2,
      confidence: 'confirmed',
      changeId: 'shopify-api-version',
    },
  ]);
  expect(report.findings[0].reason).toContain('no longer serves');
  expect(report.patch.status).toBe('proposed');
  expect(report.patch.diff).toContain(
    '+export const shopify = shopifyApp({ apiVersion: ApiVersion.October26',
  );
  expect(report.patch.diff).toContain('+export default { apiVersion: ApiVersion.October26 };');
  expect(report.patch.warnings.join('\n')).toContain(
    'Deprecated on 2026-10: Product.handle: Use `slug` instead.',
  );
});

it('stops for review on removed fields, type changes, already-failing documents and SDKs without the member', async () => {
  const base = {
    'package.json': MANIFEST,
    'package-lock.json': LOCK('12.3.0'),
    'app/shopify.server.ts': SERVER('January26'),
  };
  const run = async (document: string, lock = '14.0.1') => {
    const root = await directory({
      ...base,
      'package-lock.json': LOCK(lock),
      'app/routes/product.ts': `export const loader = (admin) =>\n  admin.graphql(\`\n    query { product(id: "1") { ${document} } }\`);\n`,
    });
    return (await runPipeline({
      repository: root,
      ...(await snapshots(root)),
      proposePatch: true,
    })) as any;
  };
  const removed = await run('id legacyCode');
  expect(removed.patch.status).toBe('not-generated');
  expect(
    removed.findings.find((finding: any) => finding.changeId.startsWith('shopify-graphql:')),
  ).toMatchObject({
    file: 'app/routes/product.ts',
    line: 3,
    confidence: 'confirmed',
    expression: 'Cannot query field "legacyCode" on type "Product".',
    reason: 'Valid on 2026-01, invalid on 2026-10.',
  });
  const changed = await run('id publishedAt');
  expect(
    changed.findings.find((finding: any) => finding.changeId.startsWith('shopify-graphql-type')),
  ).toMatchObject({
    expression: 'Product.publishedAt: Date → DateTime',
    line: 3,
  });
  expect(changed.patch.status).toBe('not-generated');
  const failing = await run('id missingEverywhere');
  expect(
    failing.findings.find((finding: any) => finding.changeId.startsWith('shopify-graphql:')).reason,
  ).toContain('already fails');
  const oldSdk = await run('id title', '12.3.0');
  expect(oldSdk.patch.reason).toContain(
    '@shopify/shopify-api 12.3.0 has no ApiVersion.October26; it first ships in 14.0.0',
  );
  expect((await run('id title')).patch.status).toBe('proposed');
});

it('produces every report field the OpenAPI pipeline does', async () => {
  const root = await directory({
    'package.json': MANIFEST,
    'app/shopify.server.ts': SERVER('January26'),
  });
  const shopify = await runPipeline({ repository: root, ...(await snapshots(root)) });
  const stripe = await runPipeline({
    repository: root,
    before: resolve('pipeline/fixtures/before.json'),
    after: resolve('pipeline/fixtures/after.json'),
  });
  const shared = Object.keys(stripe).filter((key) => !['adapter'].includes(key));
  expect(shared.filter((key) => !(key in shopify))).toEqual([]);
});

it('suggests the Shopify agent, scaffolds it with snapshot steps and then reports it configured', async () => {
  const root = await directory({
    'package.json': JSON.stringify({
      name: 'app',
      scripts: { test: 'vitest run' },
      dependencies: { '@shopify/shopify-app-remix': '^4.0.0' },
    }),
    'package-lock.json': LOCK('14.0.1'),
    'app/shopify.server.ts': SERVER('January26'),
  });
  const detections = await detectProviders(root);
  expect(detections.map((entry) => [entry.agent.id, entry.agent.adapter])).toEqual([
    ['shopify', { builtIn: 'shopify' }],
  ]);
  const scaffold = addAgents({
    configuration: undefined,
    v1Id: 'stripe',
    detections,
    ids: ['shopify'],
    testScript: true,
    lockfile: true,
  });
  expect(scaffold.configuration.integrations).toEqual([
    {
      id: 'shopify',
      before: './refit/shopify-before.json',
      after: './refit/shopify-after.json',
      image: 'node:22-alpine',
      prepareDependencies: true,
      command: ['npm', 'test'],
    },
  ]);
  expect(scaffold.adapterFiles).toEqual([]);
  expect(scaffold.nextSteps[0]).toContain('refit shopify-snapshot --version');
  expect(
    builtInPackage((scaffold.configuration.integrations as Record<string, unknown>[])[0]),
  ).toBe('@shopify/shopify-api');
  expect(builtInPackage({ id: 'billing', before: './refit/stripe-before.json' })).toBe('stripe');
});
