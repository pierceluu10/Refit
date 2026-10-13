import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const LOOPBACK = '127.0.0.1';
const LEGACY_ITEMS_PATH = '/legacy/items';
const CURRENT_ITEMS_PATH = '/items';
const SUCCESS = 200;
const NOT_FOUND = 404;
const GONE = 410;
const HTTP_METHOD = 'GET';
const mode = process.argv[2];
if (!['before', 'after'].includes(mode))
  throw new TypeError('Expected before or after simulator mode.');
const expectedPath = mode === 'before' ? LEGACY_ITEMS_PATH : CURRENT_ITEMS_PATH;
const nodeModules = fileURLToPath(new URL('../node_modules', import.meta.url));
const requests = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, `http://${LOOPBACK}`);
  requests.push({
    method: request.method,
    path: url.pathname,
    locale: url.searchParams.get('locale'),
    requestId: request.headers['x-request-id'],
  });
  const id = decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf('/') + 1));
  const status = !url.pathname.startsWith(`${expectedPath}/`)
    ? GONE
    : id === 'missing'
      ? NOT_FOUND
      : SUCCESS;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify(
      status === SUCCESS
        ? { id, label: `Item ${id}` }
        : { message: status === GONE ? 'Endpoint retired' : 'Item not found' },
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
  const { itemLabel } = await import('../src/items.ts');
  const options = { requestId: 'req_contract', locale: 'fr' };
  assert.equal(await itemLabel('item_1', options), 'Item item_1');
  assert.deepEqual(requests[0], {
    method: HTTP_METHOD,
    path: `${expectedPath}/item_1`,
    locale: options.locale,
    requestId: options.requestId,
  });
  await assert.rejects(
    () => itemLabel('missing', options),
    (error) =>
      error.name === 'CatalogRequestError' &&
      error.status === NOT_FOUND &&
      error.message === 'Item not found',
  );
  assert.deepEqual(requests[1], {
    method: HTTP_METHOD,
    path: `${expectedPath}/missing`,
    locale: options.locale,
    requestId: options.requestId,
  });
  console.log(
    `Simulated endpoint contract passed (${mode}): success, options, and propagated 404.`,
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
