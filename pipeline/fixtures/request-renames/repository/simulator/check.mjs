import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const LOOPBACK = '127.0.0.1';
const SUCCESS = 200;
const BAD_REQUEST = 400;
const UNAVAILABLE = 503;
const MODE = process.argv[2];
const REQUEST_FIELD = MODE === 'before' ? 'legacy_name' : 'display_name';
const ITEM_NAME = 'Coffee beans';
const FAILURE_NAME = 'unavailable';
const QUANTITY = 2;
const REQUEST_ID = 'req_item';
const API_VERSION = '1';
if (!['before', 'after'].includes(MODE)) throw new TypeError('Expected before or after.');
const requests = [];
const nodeModules = fileURLToPath(new URL('../node_modules', import.meta.url));
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requests.push({
    method: request.method,
    path: request.url,
    body,
    requestId: request.headers['x-request-id'],
    apiVersion: request.headers['x-catalog-version'],
  });
  const status = !Object.hasOwn(body, REQUEST_FIELD)
    ? BAD_REQUEST
    : body[REQUEST_FIELD] === FAILURE_NAME
      ? UNAVAILABLE
      : SUCCESS;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify(
      status === SUCCESS
        ? { id: 'item_1' }
        : {
            message: status === BAD_REQUEST ? 'Missing required item name' : 'Catalog unavailable',
          },
    ),
  );
});
let ownsNodeModules = false;
try {
  await mkdir(nodeModules);
  ownsNodeModules = true;
  await mkdir(new URL('../node_modules/@example', import.meta.url));
  await symlink(
    '../../simulator/catalog-sdk',
    new URL('../node_modules/@example/catalog', import.meta.url),
    'dir',
  );
  server.listen(0, LOOPBACK);
  await once(server, 'listening');
  process.env.CATALOG_BASE_URL = `http://${LOOPBACK}:${server.address().port}`;
  const { createItem } = await import('../src/items.ts');
  assert.equal(await createItem(ITEM_NAME, QUANTITY, REQUEST_ID), 'item_1');
  await assert.rejects(
    () => createItem(FAILURE_NAME, QUANTITY, REQUEST_ID),
    (error) =>
      error.name === 'CatalogRequestError' &&
      error.status === UNAVAILABLE &&
      error.message === 'Catalog unavailable',
  );
  assert.deepEqual(
    requests,
    [ITEM_NAME, FAILURE_NAME].map((name) => ({
      method: 'POST',
      path: '/items',
      body: { [REQUEST_FIELD]: name, quantity: QUANTITY },
      requestId: REQUEST_ID,
      apiVersion: API_VERSION,
    })),
  );
  console.log(
    `Simulated request contract passed (${MODE}): exact body values, options, version and propagated 503.`,
  );
} finally {
  if (server.listening) {
    const closed = new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    server.closeAllConnections();
    await closed;
  }
  if (ownsNodeModules) await rm(nodeModules, { recursive: true, force: true });
}
