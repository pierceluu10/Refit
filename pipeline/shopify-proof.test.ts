import { buildSchema } from 'graphql';
import { expect, it, vi } from 'vitest';
import type { Repository } from './types.ts';

const requestStructuredOutput = vi.fn();
vi.mock('./openai.ts', async (load) => ({
  ...(await load<typeof import('./openai.ts')>()),
  requestStructuredOutput: (...args: unknown[]) => requestStructuredOutput(...args),
}));

const { codegenPinFiles, shopifyGrade, shopifyProof, shopifySchemaProof } =
  await import('./shopify-proof.ts');
const { liveShopifyProof, shopifyAccessToken, shopifyTestStore } =
  await import('./shopify-live-proof.ts');

// An Admin-like schema per version: `legacyCode` is removed, `publishedAt` changes type, the
// `ProductInput` gains a required field and `ProductStatus` gains a value in the after version.
const SCHEMA = (version: 'before' | 'after') =>
  buildSchema(`
  scalar Date
  scalar DateTime
  enum ProductStatus { ACTIVE DRAFT ${version === 'after' ? 'UNLISTED' : ''} }
  type Product {
    id: ID!
    title: String!
    status: ProductStatus!
    publishedAt: ${version === 'before' ? 'Date' : 'DateTime'}
    ${version === 'before' ? 'legacyCode: String' : ''}
  }
  input ProductInput { title: String ${version === 'after' ? 'vendor: String!' : ''} }
  input TagInput { name: String }
  type Shop { name: String! }
  type ProductPayload { product: Product }
  type QueryRoot { product(id: ID!): Product shop: Shop! }
  type Mutation {
    productCreate(input: ProductInput!): ProductPayload
    tagCreate(input: TagInput!): ProductPayload
  }
  schema { query: QueryRoot mutation: Mutation }
`);
const before = { version: '2026-01', schema: SCHEMA('before') };
const after = { version: '2026-10', schema: SCHEMA('after') };

const repository = (files: Record<string, string>): Repository => ({
  root: '/repository',
  files: Object.entries(files).map(([path, content]) => ({ path, content })),
  dependencies: [],
  lockfiles: [],
  warnings: [],
});
const route = (document: string) =>
  repository({
    'app/routes/product.ts': `export async function loader({ admin }) {\n  return admin.graphql(\`#graphql\n${document}\`);\n}\n`,
  });
const prove = (document: string, extra: Record<string, string> = {}) => {
  const files = {
    ...route(document).files.reduce((all, file) => ({ ...all, [file.path]: file.content }), {}),
    ...extra,
  };
  return shopifySchemaProof({
    original: repository(files),
    patched: repository(files),
    before,
    after,
  });
};

it('proves a version move when every document validates at the target and nothing it uses changes', () => {
  const proof = prove('query { shop { name } product(id: "1") { id title } }');
  expect(proof).toMatchObject({
    status: 'proven',
    checked: { original: 1, patched: 1 },
    failures: [],
  });
  expect(proof.reason).toContain('validates against the Admin API 2026-10 schema');
});

it('fails on a removed field, a changed output type and a variable input type that gains a required field', () => {
  expect(prove('query { product(id: "1") { legacyCode } }')).toMatchObject({
    status: 'failed',
    failures: [{ file: 'app/routes/product.ts', line: 3, version: '2026-10' }],
  });
  expect(prove('query { product(id: "1") { publishedAt } }').failures[0].text).toBe(
    'Product.publishedAt changes from Date to DateTime',
  );
  expect(
    prove(
      'mutation Create($input: ProductInput!) { productCreate(input: $input) { product { id } } }',
    ).failures[0].text,
  ).toBe('ProductInput.vendor is a new required field');
});

it('stays unproven when the code sends a document Refit cannot read', () => {
  const proof = shopifySchemaProof({
    original: repository({}),
    patched: repository({
      'app/routes/product.ts':
        "export async function loader({ admin, request }) {\n  return admin.graphql('query { ' + request.field + ' }');\n}\n",
    }),
    before,
    after,
  });
  expect(proof.status).toBe('unproven');
});

it('validates an AI reconstruction of that document at its call, and fails one that breaks', () => {
  const patched = repository({
    'app/routes/product.ts':
      "export async function loader({ admin, request }) {\n  return admin.graphql('query { ' + request.field + ' }');\n}\n",
  });
  const read = (document: string, line = 2) =>
    shopifySchemaProof({
      original: repository({}),
      patched,
      before,
      after,
      reconstructed: [{ file: 'app/routes/product.ts', line, document }],
    });
  const proof = read('query { shop { name } }');
  expect(proof).toMatchObject({ status: 'proven', checked: { patched: 1 } });
  expect(proof.reason).toContain('1 read by AI');
  expect(read('query { product(id: "1") { legacyCode } }')).toMatchObject({
    status: 'failed',
    failures: [{ file: 'app/routes/product.ts', line: 2 }],
  });
  // A reconstruction for another line proves nothing about this call.
  expect(read('query { shop { name } }', 3).status).toBe('unproven');
});

it('trusts committed codegen types only when nothing the documents select widens', () => {
  const codegen = {
    '.graphqlrc.ts': "import { shopifyApiProject } from '@shopify/api-codegen-preset';\n",
    'app/types/admin.generated.d.ts':
      "declare module '@shopify/admin-api-client' {\n  interface AdminQueries {}\n}\n",
  };
  expect(prove('query { shop { name } }', codegen)).toMatchObject({
    status: 'proven',
    codegen: { current: true },
  });
  expect(prove('query { product(id: "1") { status } }', codegen)).toMatchObject({
    status: 'unproven',
    codegen: { current: false },
  });
  // Generated types the repository does not commit never reached the type check.
  expect(
    prove('query { product(id: "1") { status } }', { '.graphqlrc.ts': codegen['.graphqlrc.ts'] }),
  ).not.toHaveProperty('codegen');
  // Without codegen an added enum value is not a schema-proof failure.
  expect(prove('query { product(id: "1") { status } }').status).toBe('proven');
});

it('inlines fragments defined in another file or a .graphql document', () => {
  const files = {
    'app/fragments.ts': 'export const SHOP = `#graphql\nfragment ShopName on Shop { name }`;\n',
  };
  expect(prove('query { shop { ...ShopName } }', files)).toMatchObject({
    status: 'proven',
    checked: { patched: 2 },
  });
  const graphql = [
    { path: 'app/legacy.graphql', content: 'fragment Legacy on Product { legacyCode }' },
  ];
  const proof = shopifyProof({
    original: route('query { product(id: "1") { ...Legacy } }'),
    patched: route('query { product(id: "1") { ...Legacy } }'),
    before,
    after,
    own: undefined,
    diff: '',
    summary: '',
    warnings: [],
    graphql: { original: graphql, patched: graphql },
    environment: {},
  });
  return expect(proof).resolves.toMatchObject({ record: { schema: { status: 'failed' } } });
});

it('proves a move for code that sends no Admin request, unless it registers webhooks in code', () => {
  const server = {
    'app/shopify.server.ts':
      "import { shopifyApp, ApiVersion } from '@shopify/shopify-app-react-router/server';\nexport default shopifyApp({ apiVersion: ApiVersion.January26 });\n",
  };
  const proof = shopifySchemaProof({
    original: repository(server),
    patched: repository(server),
    before,
    after,
  });
  expect(proof).toMatchObject({ status: 'proven', checked: { patched: 0 } });
  expect(proof.reason).toContain('sends no Admin API request');
  const webhooks = repository({
    'app/shopify.server.ts': `${server['app/shopify.server.ts']}export const webhooks = { APP_UNINSTALLED: { deliveryMethod: DeliveryMethod.Http } };\n`,
  });
  expect(shopifySchemaProof({ original: webhooks, patched: webhooks, before, after }).status).toBe(
    'unproven',
  );
});

it('leaves a codegen configuration changed only in its version pin to the codegen evidence', () => {
  const config = (pin: string, extra = '') =>
    `import { ApiVersion } from '@shopify/shopify-app-react-router/server';\nimport { shopifyApiProject } from '@shopify/api-codegen-preset';\nexport default { projects: { default: shopifyApiProject({ apiVersion: ${pin}${extra} }) } };\n`;
  const original = repository({ '.graphqlrc.ts': config('ApiVersion.October25') });
  expect(
    codegenPinFiles(original, repository({ '.graphqlrc.ts': config('ApiVersion.January26') })),
  ).toEqual(['.graphqlrc.ts']);
  expect(
    codegenPinFiles(
      original,
      repository({ '.graphqlrc.ts': config('ApiVersion.January26', ', outputDir: "x"') }),
    ),
  ).toEqual([]);
  const typeCheck = { letter: 'C' as const, level: 'type-check' as const, reason: 'tsc.' };
  expect(
    shopifyGrade(typeCheck, prove('query { shop { name } }'), undefined, ['.graphqlrc.ts']),
  ).toMatchObject({ letter: 'C', reason: expect.stringContaining('version pin of .graphqlrc.ts') });
});

it('grades Shopify proof: D without schema proof, A with a live pass, else the checks’ B or C', () => {
  const proven = prove('query { shop { name } }');
  const failed = prove('query { product(id: "1") { legacyCode } }');
  const typeCheck = {
    letter: 'C' as const,
    level: 'type-check' as const,
    reason: 'tsc covers it.',
  };
  expect(shopifyGrade(typeCheck, failed).letter).toBe('D');
  expect(shopifyGrade(typeCheck, proven)).toMatchObject({ letter: 'C' });
  expect(shopifyGrade(undefined, proven).letter).toBe('D');
  expect(shopifyGrade(undefined, proven, { status: 'passed', reason: 'Live.' }).letter).toBe('A');
  expect(shopifyGrade(typeCheck, failed, { status: 'passed', reason: 'Live.' }).letter).toBe('D');
});

it('refuses malformed test store settings without echoing them', () => {
  expect(shopifyTestStore({})).toBeUndefined();
  expect(
    shopifyTestStore({
      SHOPIFY_TEST_STORE: 'https://evil.example',
      SHOPIFY_TEST_TOKEN: 'shpat_abcdefghijklmnopqrstuvwxyz',
    }),
  ).toEqual({
    refused: expect.not.stringContaining('evil'),
  });
  expect(
    shopifyTestStore({
      SHOPIFY_TEST_STORE: 'refit-dev.myshopify.com',
      SHOPIFY_TEST_TOKEN: 'secret value',
    }),
  ).toEqual({
    refused: expect.not.stringContaining('secret'),
  });
});

const TOKEN = 'shpat_0123456789abcdef0123456789abcdef';
const store = { store: 'refit-dev.myshopify.com', token: TOKEN };

// A fake store: answers the development-store check, counts products it creates and echoes the
// token back in an error so tests can show it never reaches a record.
function fakeStore(options: { development?: boolean; failOn?: string } = {}) {
  const calls: { url: string; query: string; variables: Record<string, unknown> }[] = [];
  let next = 1;
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    expect((init.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe(TOKEN);
    const { query, variables } = JSON.parse(String(init.body));
    calls.push({ url, query, variables });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (query.includes('partnerDevelopment'))
      return json({
        data: { shop: { plan: { partnerDevelopment: options.development ?? true } } },
      });
    if (options.failOn && url.includes(options.failOn))
      return json({ errors: [{ message: `Field is gone (token ${TOKEN})` }] });
    if (query.includes('productCreate'))
      return json({
        data: { productCreate: { product: { id: `gid://shopify/Product/${next++}` } } },
      });
    if (query.includes('productDelete'))
      return json({ data: { productDelete: { deletedProductId: variables.id } } });
    return json({ data: { shop: { name: 'Refit' } } });
  });
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
}
const versions = { before: '2026-01', after: '2026-10' };

it('sends nothing but the development-store check to a store that is not a development store', async () => {
  const fake = fakeStore({ development: false });
  const proof = await liveShopifyProof({
    store,
    versions,
    documents: [{ id: 'a.ts:1', original: null, patched: 'query { shop { name } }' }],
    fetch: fake.fetch,
  });
  expect(proof.status).toBe('not-run');
  expect(fake.calls).toHaveLength(1);
});

it('runs read-only queries on both versions and records failures without the token', async () => {
  const passing = fakeStore();
  const documents = [{ id: 'a.ts:1', original: null, patched: 'query Shop { shop { name } }' }];
  expect(
    await liveShopifyProof({ store, versions, documents, fetch: passing.fetch }),
  ).toMatchObject({
    status: 'passed',
  });
  expect(passing.calls.map((call) => call.url)).toEqual([
    'https://refit-dev.myshopify.com/admin/api/2026-10/graphql.json',
    'https://refit-dev.myshopify.com/admin/api/2026-01/graphql.json',
    'https://refit-dev.myshopify.com/admin/api/2026-10/graphql.json',
  ]);
  const failing = await liveShopifyProof({
    store,
    versions,
    documents,
    fetch: fakeStore({ failOn: '2026-10/graphql' }).fetch,
  });
  expect(failing.status).not.toBe('passed');
  expect(JSON.stringify(failing)).not.toContain(TOKEN);
});

const CREATE = 'mutation { productCreate(input: { title: "Refit" }) { product { id } } }';
const DELETE = 'mutation Delete($id: ID!) { productDelete(id: $id) { deletedProductId } }';
const UPDATE = 'mutation Update($id: ID!) { productUpdate(id: $id) { product { id } } }';

it('runs a mutation only on objects the run created, and cleans them up', async () => {
  const fake = fakeStore();
  const cases = [
    {
      document: 'a.ts:1',
      operationName: 'Update',
      variables: { id: { $ref: 'setup.0.productCreate.product.id' } },
      setup: [{ document: CREATE, variables: {} }],
      cleanup: [
        { document: DELETE, variables: { id: { $ref: 'setup.0.productCreate.product.id' } } },
      ],
    },
  ];
  const proof = await liveShopifyProof({
    store,
    versions,
    documents: [{ id: 'a.ts:1', original: null, patched: UPDATE }],
    cases,
    fetch: fake.fetch,
  });
  expect(proof.status).toBe('passed');
  expect(proof.created).toEqual([
    { id: 'gid://shopify/Product/1', deleted: true },
    { id: 'gid://shopify/Product/2', deleted: true },
  ]);
  expect(
    fake.calls.filter((call) => call.query === UPDATE).map((call) => call.variables.id),
  ).toEqual(['gid://shopify/Product/1', 'gid://shopify/Product/2']);
});

it('refuses mutations without a case or on objects the run did not create', async () => {
  const fake = fakeStore();
  const documents = [{ id: 'a.ts:1', original: null, patched: UPDATE }];
  expect(await liveShopifyProof({ store, versions, documents, fetch: fake.fetch })).toMatchObject({
    status: 'not-run',
  });
  const foreign = await liveShopifyProof({
    store,
    versions,
    documents,
    cases: [
      {
        document: 'a.ts:1',
        operationName: 'Update',
        variables: { id: 'gid://shopify/Product/999' },
        setup: [],
        cleanup: [],
      },
    ],
    fetch: fake.fetch,
  });
  expect(foreign.status).toBe('not-run');
  expect(foreign.reason).toContain('which this run did not create');
  expect(fake.calls.some((call) => call.query === UPDATE)).toBe(false);
});

it('records the AI second opinion and its cost without changing the grade', async () => {
  requestStructuredOutput.mockResolvedValueOnce({
    model: 'gpt-test',
    budget: { costUsd: 0.012, spentUsd: 0.012, limitUsd: 5 },
    usage: null,
    content: JSON.stringify({
      verdict: 'concerns',
      concerns: [
        { file: 'app/shopify.server.ts', line: 2, concern: 'Webhook API version unchanged.' },
      ],
    }),
  });
  const files = route('query { shop { name } }');
  const result = await shopifyProof({
    original: files,
    patched: files,
    before,
    after,
    own: { letter: 'C', level: 'type-check', reason: 'tsc covers it.' },
    diff: '',
    summary: 'Move the pin.',
    warnings: [],
    ai: { apiKey: 'k', model: 'gpt-test' },
    environment: {},
  });
  expect(result.grade.letter).toBe('C');
  expect(result.record.review).toMatchObject({
    advisory: true,
    verdict: 'concerns',
    costUsd: 0.012,
  });
  expect(result.record.aiCostUsd).toBe(0.012);
  expect(result.record.live).toBeUndefined();
});

it('keeps only AI-written live cases whose setup and cleanup validate at both versions', async () => {
  const { writeShopifyLiveCases } = await import('./shopify-ai.ts');
  const step = (document: string) => ({ document, variablesJson: '{}' });
  requestStructuredOutput.mockResolvedValueOnce({
    model: 'gpt-test',
    budget: null,
    usage: null,
    content: JSON.stringify({
      cases: [
        {
          document: 'a.ts:1',
          operationName: 'Create',
          variablesJson: '{"input":{"title":"Refit","vendor":"Refit"}}',
          setup: [],
          cleanup: [],
        },
        {
          document: 'b.ts:1',
          operationName: '',
          variablesJson: '{}',
          setup: [step('mutation { productCreate(input: {}) { product { legacyCode } } }')],
          cleanup: [],
        },
      ],
    }),
  });
  const written = await writeShopifyLiveCases({
    ai: { apiKey: 'k', model: 'gpt-test' },
    documents: [
      {
        id: 'a.ts:1',
        text: 'mutation Create($input: ProductInput!) { productCreate(input: $input) { product { id } } }',
      },
    ],
    schemas: [before.schema, after.schema],
  });
  expect(written.cases.map((entry) => entry.document)).toEqual(['a.ts:1']);
  expect(written.record).toMatchObject({
    status: 'completed',
    costUsd: null,
    dropped: [expect.stringContaining('b.ts:1')],
  });
});

it('counts only the created object, never an existing one the payload selects, and sends operationName', async () => {
  const calls: { query: string; operationName?: string; variables: Record<string, unknown> }[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push(body);
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (body.query.includes('partnerDevelopment'))
      return json({ data: { shop: { plan: { partnerDevelopment: true } } } });
    if (body.query.includes('productCreate'))
      return json({
        data: {
          productCreate: {
            product: {
              id: 'gid://shopify/Product/1',
              location: { id: 'gid://shopify/Location/9' },
            },
          },
        },
      });
    return json({ data: {} });
  }) as unknown as typeof globalThis.fetch;
  const proof = await liveShopifyProof({
    store,
    versions,
    documents: [
      { id: 'a.ts:1', original: null, patched: `${UPDATE}\nquery Other { shop { name } }` },
    ],
    cases: [
      {
        document: 'a.ts:1',
        operationName: 'Update',
        variables: { id: { $ref: 'setup.0.productCreate.product.location.id' } },
        setup: [
          {
            document: 'mutation { productCreate(input: {}) { product { id location { id } } } }',
            variables: {},
          },
        ],
        cleanup: [],
      },
    ],
    fetch,
  });
  expect(proof.created.map((entry) => entry.id)).toEqual(['gid://shopify/Product/1']);
  expect(proof.operations.find((entry) => entry.operationName === 'Update')).toMatchObject({
    status: 'not-run',
  });
  expect(
    calls.find((call) => call.query.includes('Other') && call.operationName === 'Other'),
  ).toBeDefined();
});

it('grades D when the development store shows the document breaks, and catches a lost input default', () => {
  const proven = prove('query { shop { name } }');
  const typeCheck = { letter: 'C' as const, level: 'type-check' as const, reason: 'tsc.' };
  expect(shopifyGrade(typeCheck, proven, { status: 'failed', reason: 'Gone.' }).letter).toBe('D');
  const schema = (defaulted: boolean) =>
    buildSchema(`input Page { first: Int! ${defaulted ? '= 10' : ''} }
      type Q { items(page: Page!): Int } schema { query: Q }`);
  const document = 'query Items($page: Page!) { items(page: $page) }';
  const files = route(document);
  expect(
    shopifySchemaProof({
      original: files,
      patched: files,
      before: { version: '2026-01', schema: schema(true) },
      after: { version: '2026-10', schema: schema(false) },
    }).failures[0].text,
  ).toBe('Page.first loses its default and is required');
});

it('prefers a ready token and otherwise exchanges client credentials without leaking them', async () => {
  const secret = 'shpss_0123456789abcdef0123456789abcdef';
  const environment = {
    SHOPIFY_TEST_STORE: 'refit-dev.myshopify.com',
    SHOPIFY_TEST_CLIENT_ID: 'client0123456789abcdef',
    SHOPIFY_TEST_CLIENT_SECRET: secret,
  };
  expect(shopifyTestStore({ ...environment, SHOPIFY_TEST_TOKEN: TOKEN })).toEqual(store);
  const settings = shopifyTestStore(environment)!;
  expect(settings).toMatchObject({ store: 'refit-dev.myshopify.com', clientSecret: secret });
  const requests: { url: string; init: RequestInit }[] = [];
  const grant = (status: number, body: unknown) =>
    (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof globalThis.fetch;
  if ('refused' in settings) throw new Error('refused');
  expect(
    await shopifyAccessToken(
      settings,
      grant(200, { access_token: TOKEN, scope: 'read_products', expires_in: 86399 }),
    ),
  ).toEqual(store);
  expect(requests[0].url).toBe('https://refit-dev.myshopify.com/admin/oauth/access_token');
  expect(Object.fromEntries(new URLSearchParams(String(requests[0].init.body)))).toEqual({
    grant_type: 'client_credentials',
    client_id: 'client0123456789abcdef',
    client_secret: secret,
  });
  const refused = await shopifyAccessToken(settings, grant(400, { error: 'shop_not_permitted' }));
  expect(refused).toEqual({ refused: expect.stringContaining('shop_not_permitted') });
  expect(JSON.stringify(refused)).not.toContain(secret);
});
