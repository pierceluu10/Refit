import { expect, it } from 'vitest';
import { proveShopifyRest } from './shopify-rest-contract.ts';

const versions = { before: '2026-01', after: '2026-10' };

// Proves every REST entry of one file, located by the `/*@*/` marker before each expression.
function prove(
  content: string,
  entries: { expression: string; method?: string; path?: string; resource?: string }[],
  others: { path: string; content: string }[] = [],
) {
  const file = 'app/route.ts';
  const marks = [...content.matchAll(/\/\*@\*\//g)].map((match) => match.index!);
  const text = content.replaceAll('/*@*/', '');
  const located = entries.map((entry, index) => {
    const at = marks[index] - index * '/*@*/'.length;
    const before = text.slice(0, at).split('\n');
    return { file, line: before.length, column: before.at(-1)!.length + 1, ...entry };
  });
  return proveShopifyRest(
    { files: [{ path: file, content: text }, ...others] },
    { rest: located },
    versions,
  ).map((item) => item.proof);
}

it('proves a resource record built, filled and saved in one scope', () => {
  const [proof] = prove(
    `export async function action(admin, session) {
  const page = /*@*/new admin.rest.resources.Page({ session });
  page.title = 'Store Locator';
  page.body_html = '<p>Hi</p>';
  await page.save({ update: true });
  console.log('saved', page);
  return json({ id: page.id, page });
}`,
    [{ expression: 'admin.rest.resources.Page', resource: 'new Page' }],
  );
  expect(proof).toMatchObject({ status: 'proven' });
});

it('stops a record whose fields Refit cannot see or the contract does not list', () => {
  const record = (lines: string, options = '{ session }') =>
    prove(
      `export async function action(admin, session) {
  const page = /*@*/new admin.rest.resources.Page(${options});
  ${lines}
}`,
      [{ expression: 'admin.rest.resources.Page', resource: 'new Page' }],
    )[0];
  expect(record('page.secret = 1;\n  await page.save();')).toMatchObject({
    reason: expect.stringContaining('`page.secret`, which the 2026-01 contract does not list'),
  });
  expect(record('page.title = "x";\n  return page;')).toMatchObject({
    reason: expect.stringContaining('The record is passed on (`return page;`)'),
  });
  expect(record('helper(page);')).toMatchObject({
    reason: expect.stringContaining('The record is passed on'),
  });
  expect(record('await page.delete();')).toMatchObject({
    reason: expect.stringContaining('`page.delete()`'),
  });
  expect(record('await page.save();', '{ session, fromData: input }')).toMatchObject({
    reason: expect.stringContaining('options other than `session`'),
  });
});

it('proves a fetch body held in a const filled by property writes, and the errors key', () => {
  const [proof] = prove(
    `export async function create(shop, token, title) {
  const pageData = { page: { title } };
  pageData.page.body_html = '<p>Hi</p>';
  console.log(pageData);
  const response = await fetch(/*@*/\`https://\${shop}/admin/api/2025-01/pages.json\`, {
    method: 'POST',
    body: JSON.stringify(pageData),
  });
  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  if (data.errors) return null;
  return data.page.id;
}`,
    [{ expression: 'fetch', method: 'POST', path: 'pages.json' }],
  );
  expect(proof).toMatchObject({ status: 'proven' });
  const [held] = prove(
    `export async function create(shop) {
  const pageData = { page: { title: 'x' } };
  mutate(pageData);
  await fetch(/*@*/\`https://\${shop}/admin/api/2025-01/pages.json\`, { method: 'POST', body: JSON.stringify(pageData) });
}`,
    [{ expression: 'fetch', method: 'POST', path: 'pages.json' }],
  );
  expect(held).toMatchObject({ reason: expect.stringContaining('not an object literal') });
});

it('tells apart clients that two functions declare under the same name', () => {
  const proofs = prove(
    `async function shop(shopify, session) {
  const client = /*@*/new shopify.clients.Rest({ session });
  const response = await /*@*/client.get({ path: 'shop' });
  return response.body.shop.name;
}
async function pages(shopify, session) {
  const client = /*@*/new shopify.clients.Rest({ session });
  const response = await /*@*/client.get({ path: 'pages' });
  return response.body.pages.length;
}`,
    [
      { expression: 'shopify.clients.Rest' },
      { expression: 'client.get', method: 'GET', path: 'shop' },
      { expression: 'shopify.clients.Rest' },
      { expression: 'client.get', method: 'GET', path: 'pages' },
    ],
  );
  expect(proofs.map((proof) => proof.status)).toEqual(['proven', 'proven', 'proven', 'proven']);
});

const PROVIDER = `import shopify from './shopify';
const graphqlClient = async ({ session }) => ({ client: new shopify.clients.Graphql({ session }) });
const restClient = async ({ session }) => {
  const client = /*@*/new shopify.clients.Rest({ session });
  return { client, session };
};
const offline = {
  graphqlClient,
  restClient: async ({ session }) => ({ client: /*@*/new shopify.clients.Rest({ session }) }),
};
const clientProvider = { graphqlClient, restClient, offline };
export default clientProvider;`;
const restEntries = [
  { expression: 'shopify.clients.Rest' },
  { expression: 'shopify.clients.Rest' },
];

it('proves a REST client only a provider no file calls returns', () => {
  const caller = {
    path: 'pages/api/proxy.ts',
    content: `import provider from '../../app/route';
export default async function handler(req) {
  const { client } = await provider.offline.graphqlClient({ session: req.session });
  return client;
}`,
  };
  expect(prove(PROVIDER, restEntries, [caller]).map((proof) => proof.status)).toEqual([
    'proven',
    'proven',
  ]);
  const called = {
    path: 'pages/api/proxy.ts',
    content: `import provider from '../../app/route';
export default async function handler(req) {
  const { client } = await provider.offline.restClient({ session: req.session });
  return client.get({ path: 'shop' });
}`,
  };
  expect(prove(PROVIDER, restEntries, [called])[1]).toMatchObject({
    reason: expect.stringContaining('it reads `provider.offline.restClient`'),
  });
  const passed = {
    path: 'server/index.ts',
    content: `import provider from '../app/route';\nregister(provider);`,
  };
  expect(prove(PROVIDER, restEntries, [passed])[0]).toMatchObject({
    reason: expect.stringContaining('it is used as `register(provider)`'),
  });
});

it('does not follow a provider a framework may call by convention', () => {
  const [proof] = prove(
    `import shopify from './shopify';
export const RestProvider = {
  provide: 'SHOPIFY_REST_CLIENT',
  useFactory: async (session) => /*@*/new shopify.clients.Rest({ session }),
};`,
    [{ expression: 'shopify.clients.Rest' }],
    [
      {
        path: 'app.module.ts',
        content: `@Module({ providers: [RestProvider] })\nexport class AppModule {}`,
      },
    ],
  );
  expect(proof).toMatchObject({
    reason: expect.stringContaining('it is used as `[RestProvider]`'),
  });
});
