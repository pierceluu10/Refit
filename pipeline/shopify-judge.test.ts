import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { installedShopifyApi } from './shopify-analysis.ts';
import { aiExtractShopifyRequests, type ShopifyExtraction } from './shopify-ai-rewrite.ts';
import { shopifyJudge } from './shopify-judge.ts';

const TARGET = '2026-10';
const REMIX = { dependencies: { '@shopify/shopify-app-remix': '^3.0.0' } };
const AI = { provider: 'anthropic' as const, apiKey: '', model: 'claude-sonnet-5-5' };

function repo(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'refit-judge-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

// @shopify/shopify-api type declarations as 11.x (with LATEST_API_VERSION) and 12.x and later
// (without it) ship them.
const sdk = (version: string, members: string[], latest?: string) => ({
  'package.json': JSON.stringify({ version, types: './dist/ts/lib/index.d.ts' }),
  'dist/ts/lib/types.d.ts': `export declare enum ApiVersion {\n${members
    .map(
      (member) =>
        `    ${member} = "20${member.slice(-2)}-${{ January: '01', April: '04', July: '07', October: '10' }[member.slice(0, -2)]}",`,
    )
    .join(
      '\n',
    )}\n    Unstable = "unstable"\n}\n${latest ? `export declare const LATEST_API_VERSION = ApiVersion.${latest};\n` : ''}`,
});
const installed = (prefix: string, files: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(files).map(([path, content]) => [`${prefix}/${path}`, content]),
  );

const LOADER = (document: string) => `import { authenticate } from './shopify.server';
export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  return admin.graphql(${document});
}
`;
const VALID = '`#graphql\n  query Shop { shop { name } }`';
const REMOVED =
  '`#graphql\n  mutation Update { productVariantUpdate(input: { id: "1" }) { productVariant { id } } }`';

describe('installed SDK versions', () => {
  it('reads LATEST_API_VERSION and the ApiVersion members from a copy nested under the app package', async () => {
    const root = repo(
      installed(
        'node_modules/@shopify/shopify-app-remix/node_modules/@shopify/shopify-api',
        sdk('11.0.0', ['January24', 'April24'], 'April24'),
      ),
    );
    expect(await installedShopifyApi(root)).toEqual({
      release: '11.0.0',
      latest: '2024-04',
      versions: ['2024-01', '2024-04'],
    });
  });

  it('answers null for a release without LATEST_API_VERSION and undefined for two different copies', async () => {
    const one = sdk('14.0.1', ['October26']);
    expect(
      await installedShopifyApi(repo(installed('node_modules/@shopify/shopify-api', one))),
    ).toEqual({ release: '14.0.1', latest: null, versions: ['2026-10'] });
    const two = repo({
      ...installed('node_modules/@shopify/shopify-api', one),
      ...installed(
        'node_modules/@shopify/shopify-app-remix/node_modules/@shopify/shopify-api',
        sdk('11.0.0', ['April24'], 'April24'),
      ),
    });
    expect(await installedShopifyApi(two)).toBeUndefined();
  });
});

describe('shopifyJudge versions', () => {
  const codegen = `import { LATEST_API_VERSION } from "@shopify/shopify-api";
import { shopifyApiProject, ApiType } from "@shopify/api-codegen-preset";
export default { projects: { default: shopifyApiProject({ apiType: ApiType.Admin, apiVersion: LATEST_API_VERSION }) } };
`;

  it('fails LATEST_API_VERSION when the installed SDK no longer exports it', async () => {
    const root = repo({
      'package.json': JSON.stringify(REMIX),
      '.graphqlrc.js': codegen,
      ...installed('node_modules/@shopify/shopify-api', sdk('14.0.1', ['October26'])),
    });
    const result = await shopifyJudge(root, TARGET);
    expect(result).toMatchObject({ passed: false, unjudged: [] });
    expect(result.errors).toEqual([
      ".graphqlrc.js:3: @shopify/shopify-api 14.0.1 (installed) does not export LATEST_API_VERSION (removed in 12.0.0), so it reads undefined; use ApiVersion.October26 or '2026-10'.",
    ]);
  });

  it('reads LATEST_API_VERSION from the installed release, and from the lockfile without node_modules', async () => {
    const old = await shopifyJudge(
      repo({
        'package.json': JSON.stringify(REMIX),
        '.graphqlrc.js': codegen,
        ...installed('node_modules/@shopify/shopify-api', sdk('11.0.0', ['April24'], 'April24')),
      }),
      TARGET,
    );
    expect(old.errors).toEqual([
      '.graphqlrc.js:3: LATEST_API_VERSION is 2024-04 in @shopify/shopify-api 11.0.0 (installed); the target is 2026-10.',
    ]);
    const locked = await shopifyJudge(
      repo({
        'package.json': JSON.stringify(REMIX),
        '.graphqlrc.js': codegen,
        'package-lock.json': JSON.stringify({
          packages: { 'node_modules/@shopify/shopify-api': { version: '9.0.1' } },
        }),
      }),
      TARGET,
    );
    expect(locked.sdk).toEqual({ release: '9.0.1', source: 'lockfile', latest: '2024-01' });
    expect(locked.errors[0]).toContain(
      'LATEST_API_VERSION is 2024-01 in @shopify/shopify-api 9.0.1',
    );
  });

  it('passes the target ApiVersion member only when the installed SDK defines it', async () => {
    const server = `import { shopifyApp, ApiVersion } from "@shopify/shopify-app-remix/server";
export default shopifyApp({ apiVersion: ApiVersion.October26 });
`;
    const passed = await shopifyJudge(
      repo({
        'package.json': JSON.stringify(REMIX),
        'app/shopify.server.ts': server,
        ...installed('node_modules/@shopify/shopify-api', sdk('15.0.1', ['July26', 'October26'])),
      }),
      TARGET,
    );
    expect(passed).toMatchObject({ passed: true, errors: [] });
    const missing = await shopifyJudge(
      repo({
        'package.json': JSON.stringify(REMIX),
        'app/shopify.server.ts': server,
        ...installed('node_modules/@shopify/shopify-api', sdk('11.0.0', ['April24'], 'April24')),
      }),
      TARGET,
    );
    expect(missing.errors).toEqual([
      "app/shopify.server.ts:2: ApiVersion.October26 is not in the ApiVersion enum of @shopify/shopify-api 11.0.0 (installed), so it reads undefined; upgrade the SDK or pin the string '2026-10'.",
    ]);
  });
});

describe('shopifyJudge documents', () => {
  it('checks traced documents against the target schema, with the source line', async () => {
    const result = await shopifyJudge(
      repo({ 'package.json': JSON.stringify(REMIX), 'app/routes/a.ts': LOADER(REMOVED) }),
      TARGET,
    );
    expect(result.passed).toBe(false);
    expect(result.unjudged).toEqual([]);
    expect(result.errors[0]).toMatch(
      /^app\/routes\/a\.ts:5: .*productVariantUpdate.* \(Admin API 2026-10 schema\)$/,
    );
  });

  const runtime = LOADER("request.url.includes('a') ? 'query { shop { name } }' : await read()");
  const extraction = (document: string): ShopifyExtraction => ({
    status: 'extracted',
    model: 'stub',
    costUsd: 0.01,
    reason: 'read',
    requests: [{ document, sourceLines: [4] }],
  });

  it('cannot judge a document it cannot read without AI', async () => {
    const result = await shopifyJudge(
      repo({ 'package.json': JSON.stringify(REMIX), 'app/routes/a.ts': runtime }),
      TARGET,
    );
    expect(result.passed).toBe(false);
    expect(result.unjudged).toEqual(result.errors);
    expect(result.errors[0]).toMatch(/^app\/routes\/a\.ts:4: The document .* is built at runtime/);
  });

  it('judges the document AI extracts and marks it as extracted', async () => {
    const root = repo({ 'package.json': JSON.stringify(REMIX), 'app/routes/a.ts': runtime });
    const extract = vi.fn(async (_options: { file: string; kind: string }) =>
      extraction('query { shop { name } }'),
    );
    const passed = await shopifyJudge(root, TARGET, { extract });
    expect(passed).toMatchObject({ passed: true, costUsd: 0.01 });
    expect(passed.extracted).toEqual([
      {
        file: 'app/routes/a.ts',
        line: 4,
        kind: 'graphql',
        text: 'query { shop { name } }',
        sourceLines: [4],
      },
    ]);
    expect(extract.mock.calls[0][0]).toMatchObject({ file: 'app/routes/a.ts', kind: 'graphql' });
    const failed = await shopifyJudge(root, TARGET, {
      extract: async () =>
        extraction(
          'mutation { productVariantUpdate(input: { id: "1" }) { productVariant { id } } }',
        ),
    });
    expect(failed.unjudged).toEqual([]);
    expect(failed.errors[0]).toMatch(
      /^app\/routes\/a\.ts:4: .*productVariantUpdate.*in the document AI read from lines 4\)$/,
    );
  });
});

describe('shopifyJudge REST', () => {
  const rest = (path: string) => `import axios from 'axios';
const base = process.env.SHOP;
export async function get(phone) {
  const url = \`\${base}/admin/api/2026-10/${path}?query=\${encodeURIComponent(\`phone:\${phone}\`)}\`;
  const response = await axios.get(url, { headers: { 'X-Shopify-Access-Token': 't' } });
  return response.data.customers[0].id;
}
`;
  const request = (path: string, query: string[]): ShopifyExtraction => ({
    status: 'extracted',
    model: 'stub',
    costUsd: 0,
    reason: 'read',
    requests: [
      {
        rest: { method: 'GET', path, query, body: [], reads: [['customers', '[]', 'id']] },
        sourceLines: [4, 5, 6],
      },
    ],
  });

  it('cannot judge a computed REST URL without AI', async () => {
    const result = await shopifyJudge(
      repo({ 'package.json': JSON.stringify(REMIX), 'app/rest.ts': rest('customers/search.json') }),
      TARGET,
    );
    expect(result.passed).toBe(false);
    expect(result.unjudged).toEqual(result.errors);
  });

  it('proves the REST request AI extracts against the target contract', async () => {
    const root = repo({
      'package.json': JSON.stringify(REMIX),
      'app/rest.ts': rest('customers/search.json'),
    });
    const proven = await shopifyJudge(root, TARGET, {
      extract: async () => request('customers/search.json', ['query']),
    });
    expect(proven).toMatchObject({ passed: true, errors: [] });
    expect(proven.extracted[0]).toMatchObject({ kind: 'rest', text: 'GET customers/search.json' });
    const broken = await shopifyJudge(root, TARGET, {
      extract: async () => request('customers/search.json', ['query', 'phone']),
    });
    expect(broken.unjudged).toEqual([]);
    expect(broken.errors[0]).toMatch(
      /^app\/rest\.ts:4: GET customers\/search\.json: it sends `phone`, which the 2026-10 contract does not list .*on the request AI read from lines 4, 5, 6\)$/,
    );
  });
});

describe('aiExtractShopifyRequests', () => {
  const sources = [
    { path: 'a.ts', content: 'const q = `query { shop { name } }`;\nadmin.graphql(q);\n' },
  ];
  const answer = (requests: object[]) => async () => ({
    content: JSON.stringify({ requests, explanation: 'read' }),
    model: 'stub',
  });
  const base = { file: 'a.ts', line: 2, kind: 'graphql' as const, why: 'x', sources, ai: AI };
  const item = (document: string, sourceLines: number[]) => ({
    document,
    method: '',
    path: '',
    query: [],
    body: [],
    reads: [],
    sourceLines,
  });

  it('keeps a document whose every name the code writes', async () => {
    const result = await aiExtractShopifyRequests({
      ...base,
      request: answer([item('query { shop { name } }', [1, 2])]),
    });
    expect(result).toMatchObject({
      status: 'extracted',
      requests: [{ document: 'query { shop { name } }', sourceLines: [1, 2] }],
    });
  });

  it('refuses names the code does not contain and requests that do not cite the call', async () => {
    expect(
      await aiExtractShopifyRequests({
        ...base,
        request: answer([item('query { shop { email } }', [1, 2])]),
      }),
    ).toMatchObject({ status: 'refused', reason: expect.stringContaining('email') });
    expect(
      await aiExtractShopifyRequests({
        ...base,
        request: answer([item('query { shop { name } }', [1])]),
      }),
    ).toMatchObject({ status: 'refused', reason: "No extracted request cites the call's line 2." });
  });
});

describe('shopifyJudge live', () => {
  const environment = {
    SHOPIFY_TEST_STORE: 'refit-dev.myshopify.com',
    SHOPIFY_TEST_TOKEN: 'shpat_0123456789abcdef0123456789abcdef',
  };
  const store = (answer: () => Response) =>
    (async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(String(init.body));
      if (query.includes('partnerDevelopment'))
        return new Response(
          JSON.stringify({ data: { shop: { plan: { partnerDevelopment: true } } } }),
        );
      return answer();
    }) as unknown as typeof fetch;
  const root = () =>
    repo({ 'package.json': JSON.stringify(REMIX), 'app/routes/a.ts': LOADER(VALID) });

  it('fails when the development store rejects the document at the target', async () => {
    const fetch = store(
      () => new Response(JSON.stringify({ errors: [{ message: 'Access denied for shop' }] })),
    );
    const result = await shopifyJudge(root(), TARGET, { environment, fetch });
    expect(result.live?.status).toBe('failed');
    expect(result.errors).toEqual([
      'app/routes/a.ts:4: the development store rejected Shop at Admin API 2026-10: failed on 2026-10: Access denied for shop',
    ]);
  });

  it('passes when the store accepts it, and counts store-side failures as not run', async () => {
    const accepted = await shopifyJudge(root(), TARGET, {
      environment,
      fetch: store(() => new Response(JSON.stringify({ data: { shop: { name: 'Refit' } } }))),
    });
    expect(accepted).toMatchObject({ passed: true, live: { status: 'passed' } });
    const throttled = await shopifyJudge(root(), TARGET, {
      environment,
      fetch: store(() => new Response('{}', { status: 503 })),
    });
    expect(throttled).toMatchObject({ passed: true, live: { status: 'not-run' } });
  });
});
