import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildSchema, introspectionFromSchema } from 'graphql';
import { afterEach, expect, it, vi } from 'vitest';
import { addAgents, builtInPackage, detectProviders } from './agent-catalog.ts';
import { runPipeline } from './run.ts';
import { readRepository } from './repository.ts';
import { scanShopify } from './shopify-analysis.ts';
import { renderScanResult } from './workflow-presentation.ts';
import {
  enumFromVersion,
  latestApiVersion,
  sdkHasEnumMember,
  versionFromEnum,
} from './shopify-versions.ts';
import { digest, shopifySchemaUrl } from './specifications.ts';

// Only the AI reconstruction test answers; other tests never pass aiPatch.
const reply = vi.hoisted(() => ({ document: '' }));
vi.mock('./openai.ts', async (actual) => ({
  ...(await actual<typeof import('./openai.ts')>()),
  requestStructuredOutput: async () => ({
    model: 'gpt-5.6-luna',
    usage: null,
    budget: { costUsd: 0.01 },
    content: JSON.stringify({ document: reply.document, explanation: 'FIELDS is id and title.' }),
  }),
}));

// The agent fixer (pipeline/agent-fix.ts) never runs Claude here: a test sets `agent.edit` to the
// change it makes, and the stub reports what Refit's judge says about the edited tree.
const agent = vi.hoisted(() => ({
  edit: undefined as undefined | ((repoDir: string) => Promise<void>),
  inputs: [] as { target: string; change: string; context: string }[],
}));
vi.mock('./agent-fix.ts', () => ({
  fixWithAgent: async (input: {
    repoDir: string;
    target: string;
    change: string;
    context: string;
    check: (repoDir: string) => Promise<{ passed: boolean; errors: string[] }>;
  }) => {
    agent.inputs.push(input);
    if (!agent.edit)
      return { outcome: 'failed', diff: '', errors: ['no agent'], summary: '', costUsd: 0 };
    await agent.edit(input.repoDir);
    const judged = await input.check(input.repoDir);
    return {
      outcome: judged.passed ? 'passed' : 'unproven',
      diff: '',
      errors: judged.errors,
      summary: 'Removed legacyCode from the product query.',
      costUsd: 0.5,
    };
  },
}));

const roots: string[] = [];
afterEach(async () => {
  agent.edit = undefined;
  agent.inputs.length = 0;
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
  // The fallback reads the versions in between beside the target snapshot; they have the target's
  // schema here.
  await write('2026-01', '2026-01', SCHEMA('before'));
  await write('2026-04', '2026-04', SCHEMA('after'));
  await write('2026-07', '2026-07', SCHEMA('after'));
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
  const chosen = request.flag ? SHOP : PRODUCT;
  await admin.graphql(chosen);
  const built = 'query { ' + request.field + ' }';
  await admin.graphql(built);
  await admin.rest.resources.Product.all({ session: {} });
  await fetch(\`https://shop.myshopify.com/admin/api/2025-07/products/\${request.id}.json\`);
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
  expect(scan.adminCalls).toBe(6);
  expect(scan.documents.map((document) => [document.file, document.traced])).toEqual([
    ['app/client.ts', true],
    ['app/queries.ts', true],
    ['app/routes/product.ts', true],
  ]);
  const product = scan.documents.find((document) => document.file === 'app/queries.ts')!;
  expect(product.text).toContain('fragment ProductFields on Product { id title }');
  expect(scan.unreadable).toMatchObject([{ file: 'app/routes/product.ts', line: 12 }]);
  expect(scan.rest.map((entry) => entry.line)).toEqual([13, 14, 15]);
  expect(scan.versions.map((entry) => `${entry.kind}:${entry.value}:${entry.file}`).sort()).toEqual(
    [
      'enum:2025-01:app/shopify.server.ts',
      'enum:2025-07:.graphqlrc.ts',
      'string:2025-10:app/client.ts',
      'url:2025-07:app/routes/product.ts',
      'url:2025-07:app/routes/product.ts',
    ],
  );
  expect(scan.unresolvedVersions).toMatchObject([{ file: 'app/latest.ts', line: 2 }]);
});

it('reads default-exported documents and documents passed through helper parameters', async () => {
  const root = await directory({
    'package.json': MANIFEST,
    'app/graphql/ShopQuery.ts':
      'const ShopQuery = `#graphql\n  query { shop { name } }`;\nexport default ShopQuery;\n',
    'app/graphql.server.ts': `export async function adminQuery(admin, query, variables) {
  const response = await admin.graphql(query, { variables });
  return response.json();
}
export const paginate = async (admin, document, cursor) => {
  const page = await admin.graphql(document, { variables: { cursor } });
  return cursor ? paginate(admin, document, null) : page;
};
`,
    'app/routes/shop.ts': `import ShopQuery from '../graphql/ShopQuery';
import { adminQuery, paginate as pages } from '../graphql.server';
export async function loader(admin, request) {
  await adminQuery(admin, ShopQuery);
  await pages(admin, \`query { product(id: "1") { id } }\`);
  await adminQuery(admin, 'query { ' + request.field + ' }');
  await adminQuery(admin);
}
`,
  });
  const scan = scanShopify(await readRepository(root, '@shopify/shopify-app-remix'));
  expect(scan.adminCalls).toBe(2);
  expect(scan.documents.map((document) => [document.file, document.text.trim()])).toEqual([
    ['app/graphql/ShopQuery.ts', '#graphql\n  query { shop { name } }'],
    ['app/routes/shop.ts', 'query { product(id: "1") { id } }'],
  ]);
  expect(scan.documents.every((document) => document.traced)).toBe(true);
  // The runtime-built and missing arguments stop at the caller's line, not inside the helper.
  expect(scan.unreadable.map((entry) => [entry.file, entry.line])).toEqual([
    ['app/routes/shop.ts', 6],
    ['app/routes/shop.ts', 7],
  ]);
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

it('hands removed fields, type changes and already-failing documents to the agent fixer, and falls back for SDKs without the member', async () => {
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
  // Without AI the agent does not run: the codemods' pin move is proposed and the hand-off stays for
  // review.
  const removed = await run('id legacyCode');
  expect(removed.patch).toMatchObject({ status: 'proposed', generator: 'deterministic' });
  expect(removed.patch.unresolvedFindings).toBeGreaterThan(0);
  expect(removed.shopify.agent.outcome).toBe('not-run');
  expect(removed.shopify.handoff).toEqual([
    'A Shopify GraphQL document breaks on Admin API 2026-10 and the contract names no proven replacement.',
  ]);
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
  expect(changed.shopify.handoff).toEqual([
    'A selected Shopify field changes type on Admin API 2026-10; code reading it needs review.',
  ]);
  const failing = await run('id missingEverywhere');
  expect(
    failing.findings.find((finding: any) => finding.changeId.startsWith('shopify-graphql:')).reason,
  ).toContain('already fails');
  // 12.3.0 cannot name October26 or July26, so the patch moves to April26, the newest it has.
  const oldSdk = await run('id title', '12.3.0');
  expect(oldSdk.patch.status).toBe('proposed');
  expect(oldSdk.fallback).toMatchObject({ target: '2026-10', version: '2026-04' });
  expect(oldSdk.patch.diff).toContain(
    '+export const shopify = shopifyApp({ apiVersion: ApiVersion.April26',
  );
  expect(oldSdk.patch.warnings[0]).toContain(
    'Moves to 2026-04, not 2026-10: @shopify/shopify-api 12.3.0 has no ApiVersion.October26; it first ships in 14.0.0',
  );
  expect(oldSdk.patch.warnings[0]).toContain('Shopify serves it until 2027-04-16');
  expect((await run('id title')).patch.status).toBe('proposed');
});

it('hands every stop to the agent fixer at once and keeps its patch only as the judge rates it', async () => {
  const root = await directory({
    'package.json': MANIFEST,
    'package-lock.json': LOCK('14.0.1'),
    'app/shopify.server.ts': SERVER('January26'),
    'app/routes/product.ts': `export const loader = (admin) =>\n  admin.graphql(\`\n    query { product(id: "1") { id legacyCode } }\`);\n`,
  });
  const run = async () =>
    (await runPipeline({
      repository: root,
      ...(await snapshots(root)),
      proposePatch: true,
      aiPatch: { apiKey: 'k', model: 'claude-sonnet-5-5' },
    })) as any;
  const route = join(root, 'app/routes/product.ts');
  // The agent drops the removed field: Refit's judge passes the tree with the codemods' pin move.
  agent.edit = async (repoDir) => {
    const path = join(repoDir, 'app/routes/product.ts');
    await writeFile(path, (await readFile(path, 'utf8')).replace(' legacyCode', ''));
    // An install it ran is not part of the patch.
    await mkdir(join(repoDir, 'node_modules/x'), { recursive: true });
    await writeFile(join(repoDir, 'node_modules/x/index.js'), '');
  };
  const passed = await run();
  expect(agent.inputs).toHaveLength(1);
  expect(agent.inputs[0].target).toBe('2026-10');
  expect(agent.inputs[0].context).toContain('app/routes/product.ts:3');
  expect(agent.inputs[0].change).toContain('Product.legacyCode');
  expect(passed.patch).toMatchObject({
    status: 'proposed',
    generator: 'openai',
    unresolvedFindings: 0,
  });
  expect(passed.patch.diff).toContain(
    '+export const shopify = shopifyApp({ apiVersion: ApiVersion.October26',
  );
  expect(passed.patch.diff).toContain('+    query { product(id: "1") { id } }');
  expect(passed.findings.some((finding: any) => finding.contractReview)).toBe(false);
  expect(passed.patch.diff).not.toContain('node_modules');
  expect(passed.shopify.agent).toMatchObject({ outcome: 'passed', costUsd: 0.5 });
  expect(await readFile(route, 'utf8')).toContain('legacyCode');
  // An edit the judge still rejects ships for review, with its errors in the draft.
  agent.edit = async (repoDir) => {
    const path = join(repoDir, 'app/routes/product.ts');
    await writeFile(path, (await readFile(path, 'utf8')).replace('legacyCode', 'oldCode'));
  };
  const unproven = await run();
  expect(unproven.patch).toMatchObject({ status: 'proposed', generator: 'openai' });
  expect(unproven.patch.unresolvedFindings).toBeGreaterThan(0);
  expect(unproven.patch.warnings.join('\n')).toContain(
    'Cannot query field "oldCode" on type "Product".',
  );
  expect(unproven.shopify.handoff).toHaveLength(1);
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

it('resolves LATEST_API_VERSION from the locked SDK and treats untraced other-API documents as notes', async () => {
  expect(latestApiVersion('11.13.0')).toBe('2025-04');
  expect(latestApiVersion('11.14.1')).toBe('2025-07');
  expect(latestApiVersion('12.3.0')).toBeUndefined();
  const root = await directory({
    'package.json': MANIFEST,
    // A copy nested under the app framework, as npm installs it when versions differ.
    'package-lock.json': JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/@shopify/shopify-app-remix': { version: '3.0.0' },
        'node_modules/@shopify/shopify-app-remix/node_modules/@shopify/shopify-api': {
          version: '11.14.1',
        },
      },
    }),
    'app/shopify.server.ts':
      "import { shopifyApp, LATEST_API_VERSION } from '@shopify/shopify-app-remix/server';\nexport const shopify = shopifyApp({ apiVersion: LATEST_API_VERSION });\n",
    'extensions/account/query.ts':
      'export const Q = `#graphql\n  query { customer { emailAddress } }`;\n',
    'test/admin.test.ts': 'export const run = (admin) => admin.graphql(`query { ok }`);\n',
    // Codegen configuration is not runtime: its LATEST_API_VERSION is no untraced declaration.
    '.graphqlrc.ts':
      "import { LATEST_API_VERSION } from '@shopify/shopify-api';\nexport default { apiVersion: LATEST_API_VERSION };\n",
    // A piece the code assembles at runtime: it never parses on its own.
    'app/fallback.ts': 'export const EMPTY = `#graphql\n  # not implemented\n`;\n',
  });
  const report = (await runPipeline({
    repository: root,
    ...(await snapshots(root)),
    proposePatch: true,
  })) as any;
  expect(report.shopify.sdkRelease).toBe('11.14.1');
  expect(
    report.apiVersion.source.declarations.map((entry: { file: string }) => entry.file),
  ).toEqual(['app/shopify.server.ts']);
  expect(report.shopify.otherApiDocuments).toEqual([
    'app/fallback.ts:1',
    'extensions/account/query.ts:1',
    'test/admin.test.ts:1',
  ]);
  expect(report.apiVersion).toMatchObject({
    application: '2025-07',
    applicability: 'matches-before',
  });
  expect(
    report.findings.filter((finding: { file: string }) => finding.file !== '.graphqlrc.ts'),
  ).toMatchObject([
    {
      file: 'app/shopify.server.ts',
      line: 2,
      confidence: 'confirmed',
      expression: 'LATEST_API_VERSION (2025-07 in @shopify/shopify-api 11.14.1)',
    },
  ]);
  expect(report.patch.reason).toContain('ApiVersion.October26 first ships in 14.0.0');
});

it('counts REST resource classes and the Admin REST client factory as REST calls', async () => {
  const root = await directory({
    'package.json': MANIFEST,
    'app/rest.ts': `import { createAdminRestApiClient } from '@shopify/admin-api-client';
import { shopify } from './shopify.server';
export const client = createAdminRestApiClient({ storeDomain: 'x', apiVersion: '2024-04', accessToken: 't' });
export const collections = () => shopify.api.rest.CustomCollection.all({ session: {} });
export const product = () => new shopify.rest.Product({ session: {} });
export const restricted = () => shopify.restrictions.Product;
`,
    'app/shopify.server.ts': SERVER('January25'),
  });
  const scan = scanShopify(await readRepository(root, '@shopify/shopify-app-remix'));
  expect(scan.rest.map((entry) => [entry.line, entry.expression])).toEqual([
    [3, 'createAdminRestApiClient'],
    [4, 'shopify.api.rest.CustomCollection.all'],
    [5, 'shopify.rest.Product'],
  ]);
});

it('follows documents through callbacks, closure factories, re-exports and namespace imports', async () => {
  const root = await directory({
    'package.json': MANIFEST,
    'app/queries/shop.ts': 'export const SHOP = `#graphql\n  query Shop { shop { name } }`;\n',
    'app/queries/product.ts':
      'const PRODUCT = `#graphql\n  query Product { product(id: "1") { id } }`;\nexport { PRODUCT as PRODUCT_QUERY };\n',
    'app/queries/index.ts':
      "export * from './shop';\nexport { PRODUCT_QUERY as PRODUCT } from './product';\n",
    'app/lib/collections.server.ts': `import { SHOP, PRODUCT } from '../queries';
export async function fetchShop(graphql) {
  const response = await graphql(SHOP, { variables: {} });
  return response.json();
}
export async function fetchProduct(run) {
  return run(PRODUCT);
}
`,
    'app/lib/request.server.ts': `export function createRequest(admin) {
  return async (query, variables) => {
    const response = await admin.graphql(query, { variables });
    return response.json();
  };
}
export const adminQuery = async (admin, query) => admin.graphql(query);
`,
    'app/lib/index.ts': "export * from './request.server';\n",
    'app/routes/app.ts': `import { authenticate } from '../shopify.server';
import { fetchShop, fetchProduct } from '../lib/collections.server';
import { createRequest } from '../lib';
import * as api from '../lib/request.server';
export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  await fetchShop((query, options) => admin.graphql(query, options));
  const graphql = (query, options) => admin.graphql(query, options);
  await fetchShop(graphql);
  const run = createRequest(admin);
  await fetchProduct(run);
  await createRequest(admin)(\`query Direct { shop { name } }\`);
  return api.adminQuery(admin, \`query Namespaced { shop { name } }\`);
};
`,
  });
  const scan = scanShopify(await readRepository(root, '@shopify/shopify-app-remix'));
  expect(scan.unreadable).toEqual([]);
  expect(scan.documents.map((document) => [document.file, document.line, document.traced])).toEqual(
    [
      ['app/queries/product.ts', 1, true],
      ['app/queries/shop.ts', 1, true],
      ['app/routes/app.ts', 12, true],
      ['app/routes/app.ts', 13, true],
    ],
  );
});

it('stops at the line where a function sending documents leaves what Refit can follow', async () => {
  const root = await directory({
    'package.json': MANIFEST,
    'app/lib/helpers.server.ts': `export async function runQuery(admin, query) {
  const response = await admin.graphql(query);
  return query.length > 1000 ? runQuery(admin, query) : response;
}
export async function loadLater(admin) {
  const { runQuery: run } = await import('./helpers.server');
  return run;
}
`,
    'app/routes/app.ts': `import { pRetry } from 'p-retry';
import { runQuery } from '../lib/helpers.server';
export async function loader(admin, build) {
  await runQuery(admin, \`query { shop { name } }\`);
  const graphql = (query) => admin.graphql(query);
  await build({ admin: graphql });
  await pRetry((query) => admin.graphql(query));
}
class Service {
  constructor(admin) { this.admin = admin; }
  query(query) { return this.admin.graphql(query); }
}
export const service = Service;
`,
    'app/routes/app.test.ts': `import { runQuery } from '../lib/helpers.server';
import { vi } from 'vitest';
vi.fn(runQuery);
await runQuery({}, \`query Fixture { shop { name } }\`);
`,
  });
  const scan = scanShopify(await readRepository(root, '@shopify/shopify-app-remix'));
  expect(scan.documents.map((document) => [document.file, document.line, document.traced])).toEqual(
    [
      ['app/routes/app.test.ts', 4, false],
      ['app/routes/app.ts', 4, true],
    ],
  );
  // The recursive call passes the same parameter and the test's spy reaches a mocked client; neither
  // stops, and the test's document is checked as a fixture. The function the dynamic import
  // returns to unknown callers, the object property, the third-party callee and the method stop.
  expect(scan.unreadable.map((entry) => [entry.file, entry.line, entry.reason])).toEqual([
    [
      'app/lib/helpers.server.ts',
      7,
      'A function that sends Admin GraphQL documents is returned from an exported function nothing in the repository calls, so Refit cannot follow the documents it receives.',
    ],
    [
      'app/routes/app.ts',
      6,
      'A function that sends Admin GraphQL documents is stored in an object here; Refit does not follow calls through object properties, so the documents it receives are not read.',
    ],
    [
      'app/routes/app.ts',
      7,
      'A function that sends Admin GraphQL documents is passed to pRetry, which Refit cannot follow, so the documents it receives are not read.',
    ],
    [
      'app/routes/app.ts',
      11,
      'The document is `query`, from a parameter of a function nothing in the repository calls but code outside it can (an export, a public method or a callback), so Refit cannot list the documents it receives.',
    ],
  ]);
});

it('reads every element of a constant document array and members of constant objects', async () => {
  const root = await directory({
    'package.json': MANIFEST,
    'app/queries.ts': `export const QUERIES = {
  shop: \`#graphql
  query Shop { shop { name } }\`,
};
export const TIERS = [
  { name: 'primary', query: \`query Primary { shop { name } }\` },
  { name: 'fallback', query: \`query Fallback { product(id: "1") { id } }\` },
] as const;
`,
    'app/routes/app.ts': `import { QUERIES, TIERS } from '../queries';
export async function loader(admin, extra) {
  await admin.graphql(QUERIES.shop);
  for (const tier of TIERS) await admin.graphql(tier.query);
  for (const document of [\`query One { shop { name } }\`]) await admin.graphql(document);
  for (const document of [...extra]) await admin.graphql(document);
  for (const tier of [{ name: 'x' }]) await admin.graphql(tier.query);
  await admin.graphql(QUERIES.missing);
}
`,
  });
  const scan = scanShopify(await readRepository(root, '@shopify/shopify-app-remix'));
  expect(scan.documents.map((document) => [document.file, document.line, document.traced])).toEqual(
    [
      ['app/queries.ts', 2, true],
      ['app/queries.ts', 6, true],
      ['app/queries.ts', 7, true],
      ['app/routes/app.ts', 5, true],
    ],
  );
  expect(scan.unreadable.map((entry) => [entry.line, entry.reason])).toEqual([
    [6, 'The document comes from an array Refit cannot read element by element.'],
    [7, 'An element of the array the document comes from has no static query.'],
    [
      8,
      'The document `QUERIES.missing` is built at runtime; Refit only reads literal or constant documents.',
    ],
  ]);
});

it('checks a document sent through a callback as Admin usage, not as another API', async () => {
  const root = await directory({
    'package.json': MANIFEST,
    'package-lock.json': LOCK('14.0.1'),
    'app/shopify.server.ts': SERVER('January26'),
    'app/lib/brand.server.ts': `const BRAND = \`#graphql
  query { shop { name brand } }\`;
export const brand = (graphql) => graphql(BRAND);
`,
    'app/routes/app.ts': `import { brand } from '../lib/brand.server';
export const loader = (admin) => brand((query) => admin.graphql(query));
`,
  });
  const report = (await runPipeline({
    repository: root,
    ...(await snapshots(root)),
    proposePatch: true,
  })) as any;
  expect(report.shopify.otherApiDocuments).toEqual([]);
  expect(report.shopify.handoff[0]).toContain('already fails on Admin API 2026-01');
  expect(
    report.findings.find((finding: any) => finding.changeId.startsWith('shopify-graphql:')),
  ).toMatchObject({ file: 'app/lib/brand.server.ts', line: 2, confidence: 'confirmed' });
});

it('keeps shadowed names apart and stops when a sending function is reassigned', async () => {
  const root = await directory({
    'package.json': MANIFEST,
    'app/routes/app.ts': `export async function loader(admin, other) {
  const graphql = (query) => admin.graphql(query);
  const inner = (graphql) => graphql('not a document');
  inner(other);
  await graphql(\`query Outer { shop { name } }\`);
  {
    const graphql = other;
    graphql('also not a document');
  }
  let send = (query) => admin.graphql(query);
  send = other;
  const wrapped = (query) => admin.graphql(query);
  other.handler = wrapped;
}
`,
  });
  const scan = scanShopify(await readRepository(root, '@shopify/shopify-app-remix'));
  expect(scan.documents.map((document) => document.text)).toEqual([
    'query Outer { shop { name } }',
  ]);
  expect(scan.unreadable.map((entry) => [entry.line, entry.reason.slice(0, 60)])).toEqual([
    [10, 'A function that sends Admin GraphQL documents is used here i'],
    [13, 'A function that sends Admin GraphQL documents is used here i'],
  ]);
});

it('reports each REST Admin call with its method and path where the code states them', async () => {
  const root = await directory({
    'package.json': MANIFEST,
    'package-lock.json': LOCK('14.0.1'),
    'app/shopify.server.ts': SERVER('January26'),
    'app/rest.ts': `import axios from 'axios';
import { createAdminRestApiClient } from '@shopify/admin-api-client';
import { shopify } from './shopify.server';
const METAFIELDS = 'metafields.json';
export async function sync(admin, session, shop, id, verb, url) {
  await admin.rest.get({ path: 'products/count' });
  await admin.rest.post({ path: \`products/\${id}/metafields\`, data: {} });
  const client = new shopify.clients.Rest({ session });
  await client.put({ path: METAFIELDS, data: {} });
  await client.delete({ path: url });
  const plain = createAdminRestApiClient({ storeDomain: shop, apiVersion: '2026-01', accessToken: 't' });
  await plain.get('products/1.json');
  await shopify.rest.Product.all({ session });
  await shopify.rest.Order.cancel({ session });
  await fetch(\`https://\${shop}/admin/api/2026-01/products/\${id}.json\`, { method: 'PUT', body: '{}' });
  await fetch(\`https://\${shop}/admin/api/2026-01/orders.json?status=any\`);
  await axios.post('https://x.myshopify.com/admin/api/2026-01/orders.json', {});
  const customers = \`https://\${shop}/admin/api/2026-01/customers.json\`;
  await fetch(customers, { method: verb });
  const shopUrl = \`https://\${shop}/admin/api/2026-01/shop.json\`;
  await fetch(shopUrl);
  const record = new shopify.rest.Product({ session });
  await fetch(\`https://\${shop}/admin/api/2026-01/graphql.json\`, { method: 'POST', body: '{}' });
}
`,
  });
  const scan = scanShopify(await readRepository(root, '@shopify/shopify-app-remix'));
  expect(
    scan.rest.map((entry) => [entry.line, entry.method, entry.path ?? entry.resource]),
  ).toEqual([
    [6, 'GET', 'products/count'],
    [7, 'POST', 'products/{id}/metafields'],
    [8, undefined, undefined],
    [9, 'PUT', 'metafields.json'],
    [10, 'DELETE', undefined],
    [11, undefined, undefined],
    [12, 'GET', 'products/1.json'],
    [13, 'GET', 'Product.all'],
    [14, undefined, 'Order.cancel'],
    [15, 'PUT', 'products/{id}.json'],
    [16, 'GET', 'orders.json'],
    [17, 'POST', 'orders.json'],
    [18, undefined, 'customers.json'],
    [20, 'GET', 'shop.json'],
    [22, undefined, 'new Product'],
  ]);
  // A raw request to the GraphQL endpoint is not REST; its document is unread, so it stops.
  expect(scan.unreadable).toMatchObject([{ file: 'app/rest.ts', line: 23 }]);
  const report = (await runPipeline({
    repository: root,
    ...(await snapshots(root)),
    proposePatch: true,
  })) as any;
  expect(report.patch.unresolvedFindings).toBeGreaterThan(0);
  expect(report.shopify.handoff.join('\n')).toContain('cannot read an Admin API call');
  expect(
    report.findings.some((finding: any) =>
      finding.contractReview?.includes('cannot prove this REST Admin call'),
    ),
  ).toBe(true);
  expect(report.shopify.restCalls[1]).toEqual({
    file: 'app/rest.ts',
    line: 7,
    column: 9,
    method: 'POST',
    path: 'products/{id}/metafields',
    resource: null,
    expression: 'admin.rest.post',
  });
  expect(
    report.findings
      .filter((finding: any) => finding.changeId === 'shopify-rest')
      .map((finding: any) => finding.expression)
      .slice(0, 3),
  ).toEqual(['shopify.clients.Rest', 'PUT metafields.json (client.put)', 'DELETE (client.delete)']);
  // Calls with no reads, an empty body or a listed parameter (`status`) are in both REST contracts,
  // and so is a record built with no field assigned (its save endpoints are kept).
  expect(
    report.shopify.restContract
      .filter((entry: any) => entry.status === 'proven')
      .map((entry: any) => [entry.line, entry.endpoints]),
  ).toEqual([
    [6, ['GET products/count.json']],
    [7, ['POST products/<product_id>/metafields.json']],
    [13, ['GET products.json']],
    [16, ['GET orders.json']],
    [17, ['POST orders.json']],
    [20, ['GET shop.json']],
    [22, ['POST products.json', 'PUT products/<id>.json']],
  ]);
  expect(renderScanResult(report)).toContain(
    'REST        15 REST Admin calls for review, not migrated: GET products/count at app/rest.ts:6, POST products/{id}/metafields at app/rest.ts:7, call at app/rest.ts:8, and 12 more',
  );
});

it('moves the pin when AI reads an unreadable document from the code and it validates on both versions', async () => {
  const run = async (document: string) => {
    reply.document = document;
    const root = await directory({
      'package.json': MANIFEST,
      'package-lock.json': LOCK('14.0.1'),
      'app/shopify.server.ts': SERVER('January26'),
      'app/fields.ts': "export const FIELDS = ['id', 'title', 'legacyCode'];\n",
      'app/routes/product.ts': `import { FIELDS } from '../fields';
export const loader = (admin, picked) =>
  admin.graphql('query Product { product(id: "1") { ' + FIELDS.filter(picked).join(' ') + ' } }');
`,
    });
    return (await runPipeline({
      repository: root,
      ...(await snapshots(root)),
      proposePatch: true,
      aiPatch: { apiKey: 'k', model: 'gpt-5.6-luna' },
    })) as any;
  };
  const read = await run('query Product { product(id: "1") { id title } }');
  expect(read.patch.status).toBe('proposed');
  expect(read.findings).toContainEqual(
    expect.objectContaining({ changeId: 'shopify-graphql-reconstructed', line: 3 }),
  );
  expect(read.shopify.reconstructed).toMatchObject([{ status: 'kept', line: 3 }]);
  expect(read.patch.warnings.join('\n')).toContain('AI read it from the code');
  // A reconstruction that selects the removed field goes to the agent fixer, which fails here, so
  // the codemods' patch stays for review.
  const removed = await run('query Product { product(id: "1") { id legacyCode } }');
  expect(removed.patch.unresolvedFindings).toBeGreaterThan(0);
  expect(removed.shopify.agent.outcome).toBe('failed');
  expect(
    removed.findings.find((finding: any) => finding.changeId === 'shopify-graphql:unreadable')
      .reason,
  ).toContain('AI could not read it: The reconstruction does not hold on 2026-10');
});
